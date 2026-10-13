/**
 * chatgptBrowserBridge.ts
 *
 * ChatGPT own-account answers via UI automation in a hidden, logged-in chatgpt.com
 * window (partition persist:chatgpt-auth). We drive ChatGPT's REAL composer + send
 * button and read the streamed reply from the DOM, so ChatGPT's own page produces
 * proof-of-work / Turnstile / sentinel tokens natively. This is the ONLY approach
 * that passes OpenAI's anti-bot — a Node-side PoW gets 403 "unusual activity", and
 * importing ChatGPT's minified module does not expose the token managers.
 *
 * A temporary chat (?temporary-chat=true) means every question in one interview
 * threads into that single (unsaved) chat; resetChatGptConversation() opens a fresh
 * one at interview boundaries.
 *
 * Fragile by nature: depends on ChatGPT's DOM. If OpenAI changes the composer /
 * send-button / message-role / stop-button markup, update the selectors below.
 */
import { BrowserWindow } from 'electron'
import { isProviderUsageLimitMessage } from './providerResponse'

export interface AskResult { ok: boolean; text: string; exhausted?: boolean; error?: string }
export interface AskOptions { prompt: string; onDelta: (partial: string) => void; signal?: AbortSignal }

const CHAT_URL = 'https://chatgpt.com/'
const COMPOSER_WAIT_MS = 20_000
const GEN_TIMEOUT_MS = 90_000

let win: BrowserWindow | null = null
let loading: Promise<void> | null = null
let needsFreshChat = false

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    // backgroundThrottling off so a hidden window's timers/generation aren't slowed.
    webPreferences: { partition: 'persist:chatgpt-auth', contextIsolation: false, sandbox: false, backgroundThrottling: false },
  })
  w.on('closed', () => { if (win === w) { win = null; loading = null } })
  return w
}

/** Ensure the hidden window is loaded and the composer is present. Returns the
 *  window, or null if not logged in / composer never appeared (→ caller fails over). */
async function ensureReady(signal?: AbortSignal): Promise<BrowserWindow | null> {
  if (!win || win.isDestroyed()) {
    win = createWindow()
    loading = win.loadURL(CHAT_URL).then(() => {}).catch(() => {})
    needsFreshChat = false
  } else if (needsFreshChat) {
    loading = win.loadURL(CHAT_URL).then(() => {}).catch(() => {})
    needsFreshChat = false
  }
  if (loading) { await loading; loading = null }
  if (signal?.aborted) return null
  const w = win
  if (!w || w.isDestroyed()) return null
  const deadline = Date.now() + COMPOSER_WAIT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    const onLogin = await w.webContents.executeJavaScript(`location.href.includes('/auth/login')`).catch(() => false)
    if (onLogin === true) return null
    const hasComposer = await w.webContents.executeJavaScript(`!!document.querySelector('#prompt-textarea,main form textarea,main form [contenteditable="true"]')`).catch(() => false)
    if (hasComposer === true) return w
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500)
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
  return null
}

// Injected page scripts. SUBMIT types the prompt into ChatGPT's composer (paste
// event first — ProseMirror-friendly — with an execCommand fallback), sends it, and
// confirms a new user message appeared. READ returns the current assistant text +
// whether generation is still running.
const SUBMIT_JS = (prompt: string): string => `(async (P) => {
  const q=s=>document.querySelector(s); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const ed=q('#prompt-textarea')||q('main form [contenteditable="true"]')||q('main form textarea');
  if(!ed) return {ok:false,reason:'composer'};
  const before=document.querySelectorAll('[data-message-author-role="assistant"]').length;
  const ub=document.querySelectorAll('[data-message-author-role="user"]').length;
  ed.focus(); await sleep(60);
  try{const dt=new DataTransfer();dt.setData('text/plain',P);ed.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}catch(e){}
  await sleep(200);
  if(!(ed.innerText||ed.value||'').trim()){try{document.execCommand('insertText',false,P);}catch(e){}await sleep(150);}
  const enter=()=>ed.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
  let send=q('[data-testid="send-button"]')||q('#composer-submit-button')||q('button[aria-label*="Send" i]');
  if(send&&!send.disabled)send.click(); else enter();
  let ok=false; for(let i=0;i<10;i++){await sleep(400); if(document.querySelectorAll('[data-message-author-role="user"]').length>ub){ok=true;break;}}
  if(!ok){ed.focus();enter();for(let i=0;i<8;i++){await sleep(400);if(document.querySelectorAll('[data-message-author-role="user"]').length>ub){ok=true;break;}}}
  return {ok, index: before};
})(${JSON.stringify(prompt)})`

const READ_JS = (index: number): string => `(function(i){
  const msgs=document.querySelectorAll('[data-message-author-role="assistant"]');
  const el=msgs[i];
  const gen=!!document.querySelector('[data-testid="stop-button"]')||!!document.querySelector('button[aria-label*="Stop" i]');
  if (!el) return {text:'', gen, exists:false};
  
  const clone = el.cloneNode(true);
  clone.querySelectorAll('strong, b').forEach(n => n.replaceWith('**' + n.textContent + '**'));
  clone.querySelectorAll('em, i').forEach(n => n.replaceWith('_' + n.textContent + '_'));
  clone.querySelectorAll('code').forEach(n => {
    if (n.parentNode && n.parentNode.tagName === 'PRE') {
       n.replaceWith('\\\`\\\`\\\`\\n' + n.textContent + '\\n\\\`\\\`\\\`\\n');
    } else {
       n.replaceWith('\\\`' + n.textContent + '\\\`');
    }
  });
  clone.querySelectorAll('li').forEach(n => n.prepend('- '));
  
  const div = document.createElement('div');
  div.style.position = 'absolute'; div.style.left = '-9999px';
  div.appendChild(clone);
  document.body.appendChild(div);
  let text = div.innerText || '';
  document.body.removeChild(div);
  text = text.replace(/^[•◦▪]\\s*/gm, '').trim();
  
  return {text, gen, exists:true};
})(${index})`

// Vision submit: paste the prompt text, then attach the screenshot by pasting it as
// an image File (ChatGPT accepts a pasted image), wait for the upload preview, send.
const SUBMIT_VISION_JS = (prompt: string, dataUrl: string): string => `(async (P, URL) => {
  const q=s=>document.querySelector(s); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const ed=q('#prompt-textarea')||q('main form [contenteditable="true"]')||q('main form textarea');
  if(!ed) return {ok:false,reason:'composer'};
  const before=document.querySelectorAll('[data-message-author-role="assistant"]').length;
  const ub=document.querySelectorAll('[data-message-author-role="user"]').length;
  ed.focus(); await sleep(60);
  try{const dt=new DataTransfer();dt.setData('text/plain',P);ed.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}catch(e){}
  await sleep(200);
  if(!(ed.innerText||ed.value||'').trim()){try{document.execCommand('insertText',false,P);}catch(e){}await sleep(150);}
  try{const h=URL.split(',');const mime=(h[0].match(/data:(.*?);/)||[])[1]||'image/png';const bin=atob(h[1]);const arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);const file=new File([arr],'screen.png',{type:mime});const dt2=new DataTransfer();dt2.items.add(file);ed.focus();ed.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt2,bubbles:true,cancelable:true}));}catch(e){return {ok:false,reason:'img:'+e.message};}
  for(let i=0;i<24;i++){await sleep(500); if(q("form img[src^='blob:'],form img[src^='data:'],main form img,[data-testid*='attachment'] img"))break;}
  const enter=()=>ed.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
  let send; for(let i=0;i<16;i++){send=q('[data-testid="send-button"]')||q('#composer-submit-button')||q('button[aria-label*="Send" i]'); if(send&&!send.disabled)break; await sleep(500);}
  if(send&&!send.disabled)send.click(); else enter();
  let ok=false; for(let i=0;i<12;i++){await sleep(400); if(document.querySelectorAll('[data-message-author-role="user"]').length>ub){ok=true;break;}}
  return {ok, index: before};
})(${JSON.stringify(prompt)}, ${JSON.stringify(dataUrl)})`

/** Poll the assistant message at `index`, streaming its text via onDelta until done. */
async function pollAnswer(w: BrowserWindow, index: number, opts: { onDelta: (t: string) => void; signal?: AbortSignal }): Promise<AskResult> {
  let last = ''
  let stable = 0
  const deadline = Date.now() + GEN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) break
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 400)
      opts.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    if (opts.signal?.aborted) break
    let st: { text: string; gen: boolean; exists: boolean }
    try { st = await w.webContents.executeJavaScript(READ_JS(index)) } catch { continue }
    if (st.text && st.text !== last) {
      last = st.text
      stable = 0
      // The web app frequently renders a usage-cap message inside a normal
      // assistant bubble. Treating that bubble as a successful answer prevents
      // the Claude failover chain from ever running.
      if (isProviderUsageLimitMessage(last)) {
        return { ok: false, text: '', exhausted: true, error: last }
      }
      opts.onDelta(last)
    } else if (st.text) { stable++ }
    if (!st.gen && st.text && stable >= 2) break
  }
  if (isProviderUsageLimitMessage(last)) {
    return { ok: false, text: '', exhausted: true, error: last }
  }
  return { ok: last.length > 0, text: last, error: last ? undefined : 'ChatGPT produced no answer' }
}

/** Ask the logged-in ChatGPT UI a question, streaming the reply via onDelta. */
export async function askChatGpt(opts: AskOptions): Promise<AskResult> {
  const w = await ensureReady(opts.signal)
  if (!w) return { ok: false, text: '', error: 'ChatGPT not connected or session expired. Reconnect in Setup → AI Source.' }
  if (opts.signal?.aborted) return { ok: false, text: '', error: 'aborted' }

  let sub: { ok: boolean; reason?: string; index: number }
  try { sub = await w.webContents.executeJavaScript(SUBMIT_JS(opts.prompt)) }
  catch (e) { return { ok: false, text: '', error: 'ChatGPT submit failed: ' + (e as Error).message } }
  if (!sub || !sub.ok) return { ok: false, text: '', error: 'ChatGPT did not accept the message (UI not ready)' }
  return pollAnswer(w, sub.index, opts)
}

/** Ask ChatGPT about a screenshot (own-account vision), streaming the reply. */
export async function askChatGptVision(opts: AskOptions & { imageDataUrl: string }): Promise<AskResult> {
  const w = await ensureReady(opts.signal)
  if (!w) return { ok: false, text: '', error: 'ChatGPT not connected or session expired. Reconnect in Setup → AI Source.' }
  if (opts.signal?.aborted) return { ok: false, text: '', error: 'aborted' }
  let sub: { ok: boolean; reason?: string; index: number }
  try { sub = await w.webContents.executeJavaScript(SUBMIT_VISION_JS(opts.prompt, opts.imageDataUrl)) }
  catch (e) { return { ok: false, text: '', error: 'ChatGPT vision submit failed: ' + (e as Error).message } }
  if (!sub || !sub.ok) return { ok: false, text: '', error: 'ChatGPT did not accept the screenshot (UI not ready)' }
  return pollAnswer(w, sub.index, opts)
}

/** Open a fresh temporary chat on the next question (interview boundary). */
export function resetChatGptConversation(): void {
  needsFreshChat = true
}

/** Startup liveness probe: load/reuse the hidden window and return true only if
 *  logged in (composer present, not redirected to /auth/login). Also pre-warms. */
export async function probeChatGptSession(): Promise<boolean> {
  return !!(await ensureReady())
}

/** Tear down the hidden window (e.g. on app quit). */
export function disposeChatGptBridge(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
  loading = null
}

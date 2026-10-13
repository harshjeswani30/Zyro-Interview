/**
 * geminiBrowserBridge.ts
 *
 * Gemini own-account answers via UI automation in a hidden, logged-in
 * gemini.google.com window (partition persist:gemini-auth). We drive Gemini's
 * REAL composer + send button and read the streamed reply from the DOM — the
 * same approach used for ChatGPT. Google's anti-bot defences (cookie binding,
 * BotGuard) are satisfied natively because the real page and its scripts run.
 *
 * A fresh chat is opened at every interview boundary via resetGeminiConversation().
 * Vision is supported by simulating a clipboard paste of the screenshot image 
 * into the rich-textarea composer before clicking Send.
 *
 * Fragile by nature: depends on Gemini's DOM. If Google changes the composer /
 * send-button / message-role / stop-button markup, update the selectors below.
 */
import { BrowserWindow } from 'electron'
import { isProviderUsageLimitMessage } from './providerResponse'

export interface AskResult { ok: boolean; text: string; exhausted?: boolean; error?: string }
export interface AskOptions { prompt: string; onDelta: (partial: string) => void; signal?: AbortSignal }
export interface AskVisionOptions extends AskOptions { imageDataUrl: string }

const CHAT_URL = 'https://gemini.google.com/app'
const COMPOSER_WAIT_MS = 25_000
const GEN_TIMEOUT_MS = 90_000

let win: BrowserWindow | null = null
let loading: Promise<void> | null = null
let needsFreshChat = false

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: 'persist:gemini-auth',
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  w.on('closed', () => { if (win === w) { win = null; loading = null } })
  return w
}

/** Ensure the hidden window is loaded and the composer is ready. Returns null
 *  if not logged in or the composer never appeared (→ caller fails over). */
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
  if (signal?.aborted) {
    try {
      const html = await win?.webContents.executeJavaScript('document.documentElement.outerHTML')
      require('fs').writeFileSync('gemini-html.txt', html)
      console.log('Saved DOM on outer abort')
    } catch(e) { console.log('Outer DOM dump failed:', e) }
    return null
  }
  const w = win
  if (!w || w.isDestroyed()) return null

  const deadline = Date.now() + COMPOSER_WAIT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      try {
        const html = await w.webContents.executeJavaScript('document.documentElement.outerHTML')
        require('fs').writeFileSync('gemini-html.txt', html)
        console.log('Saved DOM on abort')
      } catch(e) { console.log('DOM dump failed:', e) }
      return null
    }
    // Redirect to login page means not signed in
    const onLogin = await w.webContents.executeJavaScript(
      `location.href.includes('/signin') || location.href.includes('accounts.google.com')`
    ).catch(() => false)
    if (onLogin === true) return null

    // Gemini's composer: rich text div or textarea
    const hasComposer = await w.webContents.executeJavaScript(
      `!!document.querySelector('rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"], textarea[placeholder], [data-testid="composer-input"]')`
    ).catch(() => false)
    if (hasComposer === true) return w

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500)
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined) }, { once: true })
    })
  }
  
  try {
    const html = await w.webContents.executeJavaScript('document.documentElement.outerHTML')
    require('fs').writeFileSync('gemini-html.txt', html)
    console.log('Saved DOM successfully')
  } catch (e) {
    console.log('Failed to save DOM:', e)
  }

  return null
}

// Submit prompt to Gemini's composer. Gemini uses a rich-text div (Quill-based).
// We paste via ClipboardEvent first (Quill-friendly), fall back to execCommand,
// then click Send or press Enter.
const SUBMIT_JS = (prompt: string): string => `(async (P) => {
  const q=s=>document.querySelector(s); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const ed = q('rich-textarea div[contenteditable="true"]')
    || q('div.ql-editor[contenteditable="true"]')
    || q('[data-testid="composer-input"]')
    || q('textarea[placeholder]');
  if(!ed) return {ok:false,reason:'composer'};
  const before = document.querySelectorAll('model-response,message-content,[data-message-author-role="model"]').length;
  const ub = document.querySelectorAll('user-query,user-message,[data-message-author-role="user"]').length;
  ed.focus(); await sleep(80);
  try {
    const dt = new DataTransfer(); dt.setData('text/plain', P);
    ed.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
  } catch(e) {}
  await sleep(250);
  if (!(ed.innerText || ed.value || '').trim()) {
    try { document.execCommand('insertText', false, P); } catch(e) {}
    await sleep(150);
  }
  const enter = () => ed.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
  let send = q('[data-testid="send-button"]')
    || q('button[aria-label*="Send" i]')
    || q('button.send-button')
    || q('button[mattooltip*="Send" i]');
  if (send && !send.disabled) send.click(); else enter();
  let ok = false;
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    if (document.querySelectorAll('user-query,user-message,[data-message-author-role="user"]').length > ub) { ok = true; break; }
  }
  if (!ok) { ed.focus(); enter(); for(let i=0;i<8;i++){await sleep(400);if(document.querySelectorAll('user-query,user-message,[data-message-author-role="user"]').length>ub){ok=true;break;}} }
  return {ok, index: before};
})(${JSON.stringify(prompt)})`

const SUBMIT_VISION_JS = (prompt: string, dataUrl: string): string => `(async (P, URL) => {
  const q=s=>document.querySelector(s); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const ed = q('rich-textarea div[contenteditable="true"]')
    || q('div.ql-editor[contenteditable="true"]')
    || q('[data-testid="composer-input"]')
    || q('textarea[placeholder]');
  if(!ed) return {ok:false,reason:'composer'};
  const before = document.querySelectorAll('model-response,message-content,[data-message-author-role="model"]').length;
  const ub = document.querySelectorAll('user-query,user-message,[data-message-author-role="user"]').length;
  ed.focus(); await sleep(80);
  
  // Paste image
  try {
    const h=URL.split(',');const mime=(h[0].match(/data:(.*?);/)||[])[1]||'image/png';const bin=atob(h[1]);
    const arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const file=new File([arr],'screen.png',{type:mime});
    const dt2=new DataTransfer();dt2.items.add(file);
    ed.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt2,bubbles:true,cancelable:true}));
  } catch(e) { return {ok:false,reason:'img:'+e.message}; }
  
  // Wait for the image preview thumbnail to appear in the DOM (Gemini uses an uploaded-image tag or similar)
  for(let i=0;i<24;i++){
    await sleep(500); 
    // Just looking for any img that looks like a thumbnail or blob, or wait 3s max
    if (i > 5) break; 
  }

  // Paste text
  try {
    const dt = new DataTransfer(); dt.setData('text/plain', P);
    ed.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
  } catch(e) {}
  await sleep(250);
  if (!(ed.innerText || ed.value || '').trim()) {
    try { document.execCommand('insertText', false, P); } catch(e) {}
    await sleep(150);
  }
  const enter = () => ed.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
  let send = q('[data-testid="send-button"]')
    || q('button[aria-label*="Send" i]')
    || q('button.send-button')
    || q('button[mattooltip*="Send" i]');
  if (send && !send.disabled) send.click(); else enter();
  let ok = false;
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    if (document.querySelectorAll('user-query,user-message,[data-message-author-role="user"]').length > ub) { ok = true; break; }
  }
  if (!ok) { ed.focus(); enter(); for(let i=0;i<8;i++){await sleep(400);if(document.querySelectorAll('user-query,user-message,[data-message-author-role="user"]').length>ub){ok=true;break;}} }
  return {ok, index: before};
})(${JSON.stringify(prompt)}, ${JSON.stringify(dataUrl)})`

// Read the latest Gemini reply. Gemini renders into <model-response> / <message-content>
// and shows a stop button while generating.
const READ_JS = (index: number): string => `(function(i) {
  const sels = ['model-response .response-content', 'message-content', '.model-response-text', 'div[data-message-author-role="model"]'];
  let el = null;
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    if (els.length > i) { el = els[i]; break; }
  }
  const gen = !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop" i], .stop-button')
    || !!document.querySelector('generating-indicator, .typing-indicator');
    
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

/** Poll the Gemini assistant message at index, streaming via onDelta until done. */
async function pollAnswer(
  w: BrowserWindow,
  index: number,
  opts: { onDelta: (t: string) => void; signal?: AbortSignal }
): Promise<AskResult> {
  let last = ''
  let stable = 0
  const deadline = Date.now() + GEN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) break
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 400)
      opts.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined) }, { once: true })
    })
    if (opts.signal?.aborted) break
    let st: { text: string; gen: boolean; exists: boolean }
    try { st = await w.webContents.executeJavaScript(READ_JS(index)) } catch { continue }
    if (st.text && st.text !== last) {
      last = st.text
      stable = 0
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
  return { ok: last.length > 0, text: last, error: last ? undefined : 'Gemini produced no answer' }
}

/** Ask the logged-in Gemini UI a question, streaming the reply via onDelta. */
export async function askGemini(opts: AskOptions): Promise<AskResult> {
  const w = await ensureReady(opts.signal)
  if (!w) return { ok: false, text: '', error: 'Gemini not connected or session expired. Reconnect in Setup → AI Source.' }
  if (opts.signal?.aborted) return { ok: false, text: '', error: 'aborted' }

  let sub: { ok: boolean; reason?: string; index: number }
  try { sub = await w.webContents.executeJavaScript(SUBMIT_JS(opts.prompt)) }
  catch (e) { return { ok: false, text: '', error: 'Gemini submit failed: ' + (e as Error).message } }
  if (!sub || !sub.ok) return { ok: false, text: '', error: 'Gemini did not accept the message (UI not ready)' }
  return pollAnswer(w, sub.index, opts)
}

/** Ask the logged-in Gemini UI a question with a screenshot. */
export async function askGeminiVision(opts: AskVisionOptions): Promise<AskResult> {
  const w = await ensureReady(opts.signal)
  if (!w) return { ok: false, text: '', error: 'Gemini not connected or session expired.' }
  if (opts.signal?.aborted) return { ok: false, text: '', error: 'aborted' }

  let sub: { ok: boolean; reason?: string; index: number }
  try { sub = await w.webContents.executeJavaScript(SUBMIT_VISION_JS(opts.prompt, opts.imageDataUrl)) }
  catch (e) { return { ok: false, text: '', error: 'Gemini vision submit failed: ' + (e as Error).message } }
  if (!sub || !sub.ok) return { ok: false, text: '', error: 'Gemini did not accept the vision message (UI not ready). Reason: ' + sub.reason }
  return pollAnswer(w, sub.index, opts)
}

/** Open a fresh chat on the next question (interview boundary). */
export function resetGeminiConversation(): void {
  needsFreshChat = true
}

/** Startup liveness probe: load/reuse the hidden window and return true only if
 *  logged in (composer present, not redirected to Google sign-in). Also pre-warms. */
export async function probeGeminiSession(): Promise<boolean> {
  return !!(await ensureReady())
}

/** Tear down the hidden window (e.g. on app quit). */
export function disposeGeminiBridge(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
  loading = null
}

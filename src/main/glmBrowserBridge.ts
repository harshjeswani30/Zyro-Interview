/**
 * glmBrowserBridge.ts
 *
 * GLM (Z.ai) own-account answers via UI automation in a hidden, logged-in
 * chat.z.ai window (partition persist:glm-auth). We drive Z.ai's REAL composer
 * + send button and read the streamed reply from the DOM — the same approach
 * used for Gemini/ChatGPT, so Z.ai's cookie / anti-bot defences are satisfied
 * natively by the running page.
 *
 * A fresh chat is opened at every interview boundary via resetGlmConversation().
 * Vision is supported by simulating a clipboard paste of the screenshot image
 * into the composer before sending.
 *
 * Fragile by nature: depends on Z.ai's DOM. If Z.ai changes the composer /
 * send-button / message markup, update the selectors below. On a miss the DOM
 * is dumped to glm-html.txt so the live markup can be inspected and the
 * selectors refined.
 */
import { BrowserWindow, session } from 'electron'
import { isProviderUsageLimitMessage } from './providerResponse'
import { isGlmLoggedIn, isGuestJwtValue } from './glmAuth'

export interface AskResult { ok: boolean; text: string; exhausted?: boolean; error?: string }
export interface AskOptions { prompt: string; onDelta: (partial: string) => void; signal?: AbortSignal }
export interface AskVisionOptions extends AskOptions { imageDataUrl: string }

const CHAT_URL = 'https://chat.z.ai/'
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
      partition: 'persist:glm-auth',
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
  if (signal?.aborted) return null
  const w = win
  if (!w || w.isDestroyed()) return null

  const deadline = Date.now() + COMPOSER_WAIT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) return null

    // Redirect to an auth/login route means not signed in.
    const onLogin = await w.webContents.executeJavaScript(
      `location.href.includes('/auth') || location.href.includes('/login') || location.href.includes('/signin')`
    ).catch(() => false)
    if (onLogin === true) return null

    // Z.ai composer: a textarea or a contenteditable rich editor.
    const hasComposer = await w.webContents.executeJavaScript(
      `!!document.querySelector('textarea[placeholder], div[contenteditable="true"], .ProseMirror[contenteditable="true"], textarea')`
    ).catch(() => false)
    if (hasComposer === true) return w

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500)
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined) }, { once: true })
    })
  }

  // Composer never appeared — dump the DOM so the live markup can be inspected.
  try {
    const html = await w.webContents.executeJavaScript('document.documentElement.outerHTML')
    require('fs').writeFileSync('glm-html.txt', html)
    console.log('[GLM] composer not found; saved DOM to glm-html.txt')
  } catch (e) {
    console.log('[GLM] DOM dump failed:', e)
  }
  return null
}

/** Remove any GUEST token from the glm-auth partition (localStorage + z.ai cookies)
 *  so Z.ai can never silently operate as a guest. */
async function purgeGuest(w: BrowserWindow): Promise<void> {
  try {
    await w.webContents.executeJavaScript(`(() => { try {
      const re=/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*/;
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k) || ''; const m = v.match(re); if (!m) continue;
        try {
          const p = JSON.parse(atob(m[0].split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
          const e = (p.email || '').toLowerCase();
          if (e.endsWith('@guest.com') || e.startsWith('guest-')) localStorage.removeItem(k);
        } catch (e) {}
      }
    } catch (e) {} })()`)
  } catch {}
  try {
    const ses = session.fromPartition('persist:glm-auth')
    const cookies = await ses.cookies.get({})
    for (const c of cookies) {
      if (!c.domain || !c.domain.includes('z.ai') || !isGuestJwtValue(c.value)) continue
      const url = `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`
      await ses.cookies.remove(url, c.name).catch(() => {})
    }
  } catch {}
}

/** Like ensureReady, but guarantees a REAL logged-in account: it purges any guest
 *  token first and returns null unless the session is a real account — so GLM is
 *  only ever used via the real account, never as a guest. */
async function ensureRealSession(signal?: AbortSignal): Promise<BrowserWindow | null> {
  const w = await ensureReady(signal)
  if (!w) return null
  await purgeGuest(w)
  try {
    const ls: string[] = await w.webContents.executeJavaScript(
      `(()=>{try{return Object.keys(localStorage).map(k=>localStorage.getItem(k)||'')}catch(e){return []}})()`
    ).catch(() => [])
    const cookies = await session.fromPartition('persist:glm-auth').cookies.get({})
    if (!isGlmLoggedIn([...cookies.map((c) => c.value), ...(Array.isArray(ls) ? ls : [])])) return null
  } catch {
    return null
  }
  return w
}
// Submit a prompt to Z.ai's composer. Paste via ClipboardEvent first (rich-editor
// friendly), fall back to execCommand / value, then click Send or press Enter.
const SUBMIT_JS = (prompt: string): string => `(async (P) => {
  const q=s=>document.querySelector(s); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const ed = q('textarea[placeholder]') || q('.ProseMirror[contenteditable="true"]')
    || q('div[contenteditable="true"]') || q('textarea');
  if(!ed) return {ok:false,reason:'composer'};
  const ub = document.querySelectorAll('[data-message-author-role="user"], [class*="user" i][class*="message" i], [data-role="user"]').length;
  const before = document.querySelectorAll('.chat-assistant').length;
  ed.focus(); await sleep(80);
  try {
    const dt = new DataTransfer(); dt.setData('text/plain', P);
    ed.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
  } catch(e) {}
  await sleep(220);
  if (!(ed.innerText || ed.value || '').trim()) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (ed.tagName === 'TEXTAREA' && setter && setter.set) { setter.set.call(ed, P); ed.dispatchEvent(new Event('input', {bubbles:true})); }
    else { try { document.execCommand('insertText', false, P); } catch(e) {} }
    await sleep(150);
  }
  const enter = () => ed.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
  let send = q('button[data-testid*="send" i]') || q('button[aria-label*="send" i]')
    || q('button[type="submit"]') || q('button.send-button');
  if (send && !send.disabled) send.click(); else enter();
  let ok = false;
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    if (document.querySelectorAll('[data-message-author-role="user"], [class*="user" i][class*="message" i], [data-role="user"]').length > ub) { ok = true; break; }
  }
  if (!ok) { ed.focus(); enter(); for(let i=0;i<8;i++){await sleep(400);if(document.querySelectorAll('[data-message-author-role="user"], [class*="user" i][class*="message" i], [data-role="user"]').length>ub){ok=true;break;}} }
  return {ok, index: before};
})(${JSON.stringify(prompt)})`
// Vision submit: paste the screenshot into the composer, then the text, then send.
const SUBMIT_VISION_JS = (prompt: string, dataUrl: string): string => `(async (P, URL) => {
  const q=s=>document.querySelector(s); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const ed = q('textarea[placeholder]') || q('.ProseMirror[contenteditable="true"]')
    || q('div[contenteditable="true"]') || q('textarea');
  if(!ed) return {ok:false,reason:'composer'};
  const ub = document.querySelectorAll('[data-message-author-role="user"], [class*="user" i][class*="message" i], [data-role="user"]').length;
  const before = document.querySelectorAll('.chat-assistant').length;
  ed.focus(); await sleep(80);

  // Paste image
  try {
    const h=URL.split(',');const mime=(h[0].match(/data:(.*?);/)||[])[1]||'image/png';const bin=atob(h[1]);
    const arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const file=new File([arr],'screen.png',{type:mime});
    const dt2=new DataTransfer();dt2.items.add(file);
    ed.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt2,bubbles:true,cancelable:true}));
  } catch(e) { return {ok:false,reason:'img:'+e.message}; }

  // Give the upload preview time to attach.
  for(let i=0;i<8;i++){ await sleep(500); }

  // Paste text
  try {
    const dt = new DataTransfer(); dt.setData('text/plain', P);
    ed.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
  } catch(e) {}
  await sleep(220);
  if (!(ed.innerText || ed.value || '').trim()) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (ed.tagName === 'TEXTAREA' && setter && setter.set) { setter.set.call(ed, P); ed.dispatchEvent(new Event('input', {bubbles:true})); }
    else { try { document.execCommand('insertText', false, P); } catch(e) {} }
    await sleep(150);
  }
  const enter = () => ed.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
  let send = q('button[data-testid*="send" i]') || q('button[aria-label*="send" i]')
    || q('button[type="submit"]') || q('button.send-button');
  if (send && !send.disabled) send.click(); else enter();
  let ok = false;
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    if (document.querySelectorAll('[data-message-author-role="user"], [class*="user" i][class*="message" i], [data-role="user"]').length > ub) { ok = true; break; }
  }
  return {ok, index: before};
})(${JSON.stringify(prompt)}, ${JSON.stringify(dataUrl)})`
// Read the GLM reply at `index`. Converts basic rich text to markdown and reports
// whether the model is still generating (a stop button / spinner is present).
const READ_JS = (index: number): string => `(function(i) {
  // Z.ai renders the assistant reply in a chat-assistant block and the user's
  // message in chat-user (both also carry markdown-prose) -- confirmed live.
  const sels = ['.chat-assistant', '[class*="assistant" i]'];
  let el = null;
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    if (els.length > i) { el = els[i]; break; }
  }
  const gen = !!document.querySelector('button[aria-label*="stop" i], button[data-testid*="stop" i], .stop-button')
    || !!document.querySelector('[class*="typing" i], [class*="generating" i]');

  if (!el) return {text:'', gen, exists:false};

  const clone = el.cloneNode(true);
  clone.querySelectorAll('.thinking-chain-container').forEach(n => n.remove());
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
/** Poll the GLM assistant message at index, streaming via onDelta until done. */
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
      if (isProviderUsageLimitMessage(last)) return { ok: false, text: '', exhausted: true, error: last }
      opts.onDelta(last)
    } else if (st.text) { stable++ }
    if (!st.gen && st.text && stable >= 2) break
  }
  if (isProviderUsageLimitMessage(last)) return { ok: false, text: '', exhausted: true, error: last }
  return { ok: last.length > 0, text: last, error: last ? undefined : 'GLM produced no answer' }
}
/** Ask the logged-in Z.ai UI a question, streaming the reply via onDelta. */
export async function askGlm(opts: AskOptions): Promise<AskResult> {
  const w = await ensureRealSession(opts.signal)
  if (!w) return { ok: false, text: '', error: 'GLM not connected or session expired. Reconnect in Setup → AI Source.' }
  if (opts.signal?.aborted) return { ok: false, text: '', error: 'aborted' }

  let sub: { ok: boolean; reason?: string; index: number }
  try { sub = await w.webContents.executeJavaScript(SUBMIT_JS(opts.prompt)) }
  catch (e) { return { ok: false, text: '', error: 'GLM submit failed: ' + (e as Error).message } }
  if (!sub || !sub.ok) return { ok: false, text: '', error: 'GLM did not accept the message (UI not ready)' }
  return pollAnswer(w, sub.index, opts)
}

/** Ask the logged-in Z.ai UI a question with a screenshot. */
export async function askGlmVision(opts: AskVisionOptions): Promise<AskResult> {
  const w = await ensureRealSession(opts.signal)
  if (!w) return { ok: false, text: '', error: 'GLM not connected or session expired.' }
  if (opts.signal?.aborted) return { ok: false, text: '', error: 'aborted' }

  let sub: { ok: boolean; reason?: string; index: number }
  try { sub = await w.webContents.executeJavaScript(SUBMIT_VISION_JS(opts.prompt, opts.imageDataUrl)) }
  catch (e) { return { ok: false, text: '', error: 'GLM vision submit failed: ' + (e as Error).message } }
  if (!sub || !sub.ok) return { ok: false, text: '', error: 'GLM did not accept the vision message (UI not ready). Reason: ' + (sub && sub.reason) }
  return pollAnswer(w, sub.index, opts)
}

/** Open a fresh chat on the next question (interview boundary). */
export function resetGlmConversation(): void {
  needsFreshChat = true
}

/** Startup liveness probe: load/reuse the hidden window and check cookies +
 *  localStorage for a real-user token. NOTE: this still uses the payload-based
 *  isGlmLoggedIn heuristic (no baseline to diff against here), so a lingering
 *  Z.ai GUEST session can read as valid until the real signal is confirmed from
 *  glm-auth-debug.txt. Also pre-warms the window. */
export async function probeGlmSession(): Promise<boolean> {
  return !!(await ensureRealSession())
}

/** Tear down the hidden window (e.g. on app quit). */
export function disposeGlmBridge(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
  loading = null
}






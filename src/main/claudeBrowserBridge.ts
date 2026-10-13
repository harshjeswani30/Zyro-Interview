/**
 * claudeBrowserBridge.ts
 *
 * Claude own-account VISION (screen-scan) via UI automation in a hidden logged-in
 * claude.ai window (partition persist:claude-auth). Claude's text answers go through
 * the fast Session.fetch API (see ownAccountExecutor), but image attachments on the
 * web have no clean documented endpoint — so for vision we drive the real composer:
 * paste the prompt, attach the screenshot through Claude's hidden file <input>
 * (Claude ignores a synthetic image paste, but accepts input.files), send, and read
 * the streamed reply from the DOM.
 *
 * Fragile: depends on claude.ai DOM (contenteditable composer, file input, send
 * button aria-label, .font-claude-message, Stop button). Update selectors if Claude
 * changes its markup.
 */
import { BrowserWindow } from 'electron'

export interface AskResult { ok: boolean; text: string; exhausted?: boolean; error?: string }
export interface VisionOptions { prompt: string; imageDataUrl: string; onDelta: (partial: string) => void; signal?: AbortSignal }

const CHAT_URL = 'https://claude.ai/new'
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
    webPreferences: { partition: 'persist:claude-auth', contextIsolation: false, sandbox: false, backgroundThrottling: false },
  })
  w.on('closed', () => { if (win === w) { win = null; loading = null } })
  return w
}

async function ensureReady(): Promise<BrowserWindow | null> {
  if (!win || win.isDestroyed()) {
    win = createWindow()
    loading = win.loadURL(CHAT_URL).then(() => {}).catch(() => {})
    needsFreshChat = false
  } else if (needsFreshChat) {
    loading = win.loadURL(CHAT_URL).then(() => {}).catch(() => {})
    needsFreshChat = false
  }
  if (loading) { await loading; loading = null }
  const w = win
  if (!w || w.isDestroyed()) return null
  const deadline = Date.now() + COMPOSER_WAIT_MS
  while (Date.now() < deadline) {
    const onLogin = await w.webContents.executeJavaScript(`location.href.includes('/login')`).catch(() => false)
    if (onLogin) return null
    const hasComposer = await w.webContents.executeJavaScript(`!!document.querySelector('div[contenteditable="true"]')`).catch(() => false)
    if (hasComposer) return w
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

// Vision submit: paste the prompt, attach the screenshot via the hidden file input
// (input.files + change event — Claude ignores a synthetic image paste), then send.
const SUBMIT_VISION_JS = (prompt: string, dataUrl: string): string => `(async (P, URL) => {
  const q=s=>document.querySelector(s); const qa=s=>Array.from(document.querySelectorAll(s)); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const ed=q('div.ProseMirror[contenteditable="true"]')||q('div[contenteditable="true"]'); if(!ed) return {ok:false,reason:'composer'};
  const before=document.querySelectorAll('.font-claude-message').length;
  ed.focus(); await sleep(80);
  try{const dt=new DataTransfer();dt.setData('text/plain',P);ed.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}catch(e){}
  await sleep(250);
  const h=URL.split(','); const mime=(h[0].match(/data:(.*?);/)||[])[1]||'image/png'; const bin=atob(h[1]); const arr=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i); const file=new File([arr],'screen.png',{type:mime});
  const setFiles=inp=>{try{const dt=new DataTransfer();dt.items.add(file);inp.files=dt.files;inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));return true;}catch(e){return false;}};
  let inp=qa('input[type=file]').find(i=>!i.accept||/image|png|\\*/i.test(i.accept))||q('input[type=file]');
  if(!inp){const ab=q('[data-testid*="attach" i]')||q('button[aria-label*="attach" i]')||q('button[aria-label*="upload" i]'); if(ab){ab.click(); await sleep(500); inp=q('input[type=file]');}}
  if(inp)setFiles(inp);
  const prev="img[src^='blob:'],img[src^='data:'],[data-testid*='file'],[data-testid*='attachment'],figure img";
  let att=false; for(let i=0;i<24;i++){await sleep(500); if(q(prev)){att=true;break;}}
  await sleep(800);
  let send; for(let i=0;i<16;i++){send=q('button[aria-label="Send message"]')||q('button[aria-label*="Send" i]')||q('[data-testid*="send" i]'); if(send&&!send.disabled)break; await sleep(500);}
  if(send&&!send.disabled)send.click(); else ed.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
  return {ok:true, index:before};
})(${JSON.stringify(prompt)}, ${JSON.stringify(dataUrl)})`

// Reads the latest Claude reply. Claude streams into div.prose / [data-is-streaming]
// before it settles into .font-claude-message, so we take the longest of several.
const READ_JS = (index: number): string => `(function(i){
  const sels=['.font-claude-message','[data-testid="chat-message-content"]','div.prose'];
  let el = null;
  for(const s of sels){const els=document.querySelectorAll(s); if(els.length){el=els[els.length-1]; break;}}
  const stream=document.querySelector('[data-is-streaming]');
  if(!el && stream) el=stream;
  const gen=!!document.querySelector('button[aria-label*="Stop" i]')||(!!stream&&stream.getAttribute('data-is-streaming')==='true');
  if(!el) return {text:'', gen};

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
  
  return {text, gen};
})(${index})`

/** Ask Claude about a screenshot (own-account vision), streaming the reply. */
export async function askClaudeVision(opts: VisionOptions): Promise<AskResult> {
  const w = await ensureReady()
  if (!w) return { ok: false, text: '', error: 'Claude not connected or session expired. Reconnect in Setup → AI Source.' }
  if (opts.signal?.aborted) return { ok: false, text: '', error: 'aborted' }

  let sub: { ok: boolean; reason?: string; index: number }
  try { sub = await w.webContents.executeJavaScript(SUBMIT_VISION_JS(opts.prompt, opts.imageDataUrl)) }
  catch (e) { return { ok: false, text: '', error: 'Claude vision submit failed: ' + (e as Error).message } }
  if (!sub || !sub.ok) return { ok: false, text: '', error: 'Claude did not accept the screenshot (UI not ready)' }

  const index = sub.index
  let last = ''
  let stable = 0
  const deadline = Date.now() + GEN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) break
    await new Promise((r) => setTimeout(r, 400))
    let st: { text: string; gen: boolean }
    try { st = await w.webContents.executeJavaScript(READ_JS(index)) } catch { continue }
    if (st.text && st.text !== last) { last = st.text; stable = 0; opts.onDelta(last) }
    else if (st.text) { stable++ }
    if (!st.gen && st.text && stable >= 2) break
  }
  return { ok: last.length > 0, text: last, error: last ? undefined : 'Claude produced no answer' }
}

/** Open a fresh chat on the next question (interview boundary). */
export function resetClaudeConversation(): void {
  needsFreshChat = true
}

/** Tear down the hidden window (e.g. on app quit). */
export function disposeClaudeBridge(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
  loading = null
}

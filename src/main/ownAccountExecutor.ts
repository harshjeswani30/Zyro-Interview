/**
 * ownAccountExecutor.ts
 *
 * Streams answers from the user's OWN ChatGPT / Claude web subscription (BYOS),
 * reusing the session cookies captured by the "Connect account" login window.
 *
 * Transport: Electron Session.fetch (Chromium network stack) bound to the same
 * persist partition the login window populated — real browser TLS fingerprint plus
 * the login's cookies (incl. Cloudflare's), so Cloudflare lets it through. Plain
 * Node/undici fetch is fingerprinted and 403s (architecture doc §2B). We never
 * override User-Agent (anti-bot cookies are bound to the login window's UA).
 *
 * Two behaviours worth knowing:
 *  - Conversation reuse: all questions in one interview thread into ONE chat
 *    (see `conv` + resetOwnAccountConversation).
 *  - Failover, NOT round-robin: streamOwnAccount walks `providers` in priority
 *    order and only moves to the next when the current one is exhausted (usage
 *    limit / 429) or errors, then cooldowns it so later questions skip it.
 */

import { session } from 'electron'
import { randomUUID } from 'crypto'
import { askChatGpt, askChatGptVision, resetChatGptConversation } from './chatgptBrowserBridge'
import { askClaudeVision, resetClaudeConversation } from './claudeBrowserBridge'
import { askGemini, askGeminiVision, resetGeminiConversation } from './geminiBrowserBridge'
import { askGlm, askGlmVision, resetGlmConversation } from './glmBrowserBridge'
import { runProviderAttempt, type ProviderAttemptResult } from './providerAttempt'
import { isProviderUsageLimitMessage } from './providerResponse'
import { drainSseEvents, SSE_DONE } from './sseParser'
import type { OwnAccountProvider } from './ownAccountProvider'

export type { OwnAccountProvider }

export interface OwnAccountOptions {
  /** Providers to try, in priority order. Failover walks this list. */
  providers: OwnAccountProvider[]
  systemPrompt: string
  userMessage: string
  /** Streaming callback — accumulated answer so far (replace semantics, not append). */
  onDelta: (partialText: string) => void
  signal?: AbortSignal
}

export interface OwnAccountResult {
  ok: boolean
  text: string
  provider?: OwnAccountProvider // which account actually answered
  error?: string // set only when every provider failed
}

/** Per-provider outcome used internally to drive failover. */
type ProviderResult = ProviderAttemptResult

type Ses = ReturnType<typeof session.fromPartition>

const FIRST_BYTE_MS = 30_000
const IDLE_MS = 25_000
const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000'
const HARD_ERROR_COOLDOWN_MS = 120_000 // skip a hard-failing provider for 2 min
const DEFAULT_EXHAUST_COOLDOWN_MS = 60 * 60_000 // ...and an exhausted one for 1h if no reset time was given

/**
 * Per-interview conversation state, so every question in ONE interview lands in
 * ONE chat (threaded) instead of a fresh chat per question. Main resets it at
 * interview start/end via resetOwnAccountConversation().
 */
interface ConvState { orgId?: string; convId?: string; parentUuid?: string }
const conv: Record<OwnAccountProvider, ConvState> = { claude: {}, chatgpt: {}, gemini: {}, glm: {} }

/** Epoch ms until which a provider is treated as unusable (usage limit / errors). */
const cooldownUntil: Record<OwnAccountProvider, number> = { chatgpt: 0, claude: 0, gemini: 0, glm: 0 }

/** Drop the stored chat so the next question starts a new one (called by main on
 *  interview start/end). Cooldowns are intentionally NOT cleared — a real usage
 *  limit outlives one interview, and expired cooldowns are ignored anyway. */
export function resetOwnAccountConversation(provider?: OwnAccountProvider): void {
  if (provider) conv[provider] = {}
  else { conv.claude = {}; conv.chatgpt = {}; conv.gemini = {}; conv.glm = {} }
  // All browser-bridge providers thread inside hidden chats — reset them so the
  // next question opens a fresh chat at each interview boundary.
  if (!provider || provider === 'chatgpt') resetChatGptConversation()
  if (!provider || provider === 'claude') resetClaudeConversation()
  if (!provider || provider === 'gemini') resetGeminiConversation()
  if (!provider || provider === 'glm') resetGlmConversation()
}

const label = (p: OwnAccountProvider): string =>
  p === 'chatgpt' ? 'ChatGPT' : p === 'claude' ? 'Claude' : p === 'gemini' ? 'Gemini' : 'GLM'

/** Reset time from a 429, when the server tells us one (Retry-After, seconds). */
function parseReset(res: Response): number | undefined {
  const ra = res.headers.get('retry-after')
  const secs = ra ? Number(ra) : NaN
  const until = Number.isFinite(secs) ? Date.now() + secs * 1000 : Date.parse(ra || '')
  return Number.isFinite(until) && until > Date.now() ? until : undefined
}

/** Merge the caller's abort signal with an internal one we can time out ourselves. */
function makeAbort(external?: AbortSignal): { signal: AbortSignal; abort: () => void; dispose: () => void } {
  const c = new AbortController()
  const abort = (): void => c.abort()
  if (external?.aborted) abort()
  else external?.addEventListener('abort', abort, { once: true })
  return { signal: c.signal, abort, dispose: () => external?.removeEventListener('abort', abort) }
}

/**
 * Reads an SSE body line-by-line, JSON-parsing each `data:` frame. Resets an idle
 * timer on every chunk so a stream that goes silent is aborted, not left hanging.
 */
async function pumpSse(res: Response, onEvent: (json: any) => void, onIdle: () => void, signal: AbortSignal): Promise<void> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const cancel = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let buffer = ''
  let idle = setTimeout(onIdle, IDLE_MS)
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      clearTimeout(idle)
      idle = setTimeout(onIdle, IDLE_MS)
      buffer += decoder.decode(value, { stream: true })
      const frames = drainSseEvents(buffer)
      buffer = frames.rest
      for (const payload of frames.events) {
        if (payload === SSE_DONE) return
        let json: any
        try { json = JSON.parse(payload) } catch { continue }
        // Do not swallow an error thrown by the consumer as malformed JSON.
        onEvent(json)
        if (json?.type === 'message_stop') return
      }
    }
  } finally {
    clearTimeout(idle)
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

// ── Claude (tested working) ─────────────────────────────────────────────────────

async function runClaude(ses: Ses, opts: OwnAccountOptions): Promise<ProviderResult> {
  const BASE = 'https://claude.ai'
  const hJson = { 'Content-Type': 'application/json', Accept: 'application/json', Origin: BASE, Referer: `${BASE}/new` }
  const hSse = { 'Content-Type': 'application/json', Accept: 'text/event-stream', Origin: BASE, Referer: `${BASE}/new` }

  const cookies = await ses.cookies.get({ url: BASE })
  if (!cookies.some((c) => c.name === 'sessionKey')) return { ok: false, text: '', error: 'Claude account not connected' }

  const { signal, abort, dispose } = makeAbort(opts.signal)
  const firstByte = setTimeout(abort, FIRST_BYTE_MS)
  let accText = ''
  try {
    const st = conv.claude
    // 1. Active org (cached). Pick the RIGHT org — the first is often stale and
    //    create-conversation then 403s "Invalid authorization for organization".
    //    Prefer the lastActiveOrg cookie, then an org with "chat" capability.
    if (!st.orgId) {
      const orgRes = await ses.fetch(`${BASE}/api/organizations`, { headers: hJson, credentials: 'include', signal })
      if (orgRes.status === 429) { clearTimeout(firstByte); return { ok: false, text: '', exhausted: true, resetAt: parseReset(orgRes) } }
      if (!orgRes.ok) { clearTimeout(firstByte); return { ok: false, text: '', error: `Claude error: HTTP ${orgRes.status}` } }
      const orgs = (await orgRes.json()) as { uuid?: string; capabilities?: string[] }[]
      const lastActive = cookies.find((c) => c.name === 'lastActiveOrg')?.value
      st.orgId = (Array.isArray(orgs) &&
        ((lastActive && orgs.find((o) => o?.uuid === lastActive)?.uuid) ||
          orgs.find((o) => o?.capabilities?.includes('chat'))?.uuid ||
          orgs.find((o) => o?.uuid)?.uuid)) || undefined
      if (!st.orgId) { clearTimeout(firstByte); return { ok: false, text: '', error: 'Claude organization not found' } }
    }
    const orgId = st.orgId

    // 2. Reuse this interview's conversation; recreate once if it vanished (404/410).
    let res: Response | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const reused = !!st.convId
      if (!st.convId) {
        const newId = randomUUID()
        const createRes = await ses.fetch(`${BASE}/api/organizations/${orgId}/chat_conversations`, {
          method: 'POST', headers: hJson, credentials: 'include', signal, body: JSON.stringify({ uuid: newId, name: '' }),
        })
        if (createRes.status === 429) { clearTimeout(firstByte); return { ok: false, text: '', exhausted: true, resetAt: parseReset(createRes) } }
        if (!createRes.ok) { clearTimeout(firstByte); return { ok: false, text: '', error: `Claude error: HTTP ${createRes.status}` } }
        st.convId = newId
        st.parentUuid = ROOT_MESSAGE_UUID
      }
      res = await ses.fetch(`${BASE}/api/organizations/${orgId}/chat_conversations/${st.convId}/completion`, {
        method: 'POST', headers: hSse, credentials: 'include', signal,
        body: JSON.stringify({
          prompt: `${opts.systemPrompt}\n\n${opts.userMessage}`,
          parent_message_uuid: st.parentUuid || ROOT_MESSAGE_UUID,
          timezone: 'Asia/Kolkata', attachments: [], files: [], sync_sources: [], rendering_mode: 'messages',
        }),
      })
      if (reused && (res.status === 404 || res.status === 410)) { st.convId = undefined; st.parentUuid = undefined; continue }
      break
    }
    clearTimeout(firstByte)
    if (res && res.status === 429) return { ok: false, text: '', exhausted: true, resetAt: parseReset(res) }
    if (!res || !res.ok || !res.body) return { ok: false, text: '', error: `Claude error: HTTP ${res?.status ?? 0}` }

    // 3. Stream + capture the assistant msg uuid so the NEXT question threads onto it.
    let assistantUuid = ''
    let streamFailure: ProviderResult | undefined
    await pumpSse(res, (json) => {
      if (json?.type === 'error' || json?.error) {
        const code = String(json.error?.type || json.error?.code || '')
        const message = String(json.error?.message || json.message || 'Claude stream failed')
        streamFailure = {
          ok: false, text: '', error: message,
          exhausted: /rate_limit|usage_limit|overloaded/.test(code) || isProviderUsageLimitMessage(message)
        }
        throw new Error(message)
      }
      if (json?.type === 'message_start' && typeof json?.message?.uuid === 'string') assistantUuid = json.message.uuid
      else if (json?.type === 'content_block_delta' && json?.delta?.type === 'text_delta') { accText += json.delta.text || ''; opts.onDelta(accText) }
      else if (typeof json?.completion === 'string') { accText += json.completion; opts.onDelta(accText) }
    }, abort, signal).catch((error: unknown) => {
      if (!streamFailure) throw error
    })
    if (streamFailure) return streamFailure
    if (assistantUuid) conv.claude.parentUuid = assistantUuid
    if (isProviderUsageLimitMessage(accText)) {
      return { ok: false, text: '', exhausted: true, error: accText }
    }
    return { ok: accText.length > 0, text: accText, error: accText ? undefined : 'Claude returned an empty answer' }
  } catch (e) {
    clearTimeout(firstByte)
    const err = e as { name?: string; message?: string }
    return { ok: false, text: '', error: err?.name === 'AbortError' ? 'Claude request timed out' : `Claude error: ${err?.message || 'network failure'}` }
  } finally {
    clearTimeout(firstByte)
    dispose()
  }
}

// ── ChatGPT (UI automation via a hidden logged-in window) ────────────────────────
// A Node-side proof-of-work gets 403 "unusual activity", and importing ChatGPT's
// minified module does not expose its token managers — so we let ChatGPT's OWN page
// do the work: chatgptBrowserBridge drives the real composer and reads the streamed
// DOM reply. That way PoW / Turnstile / sentinel are all produced natively.
async function runChatGPT(opts: OwnAccountOptions): Promise<ProviderResult> {
  const r = await askChatGpt({
    prompt: `${opts.systemPrompt}\n\n${opts.userMessage}`,
    onDelta: opts.onDelta,
    signal: opts.signal,
  })
  return { ok: r.ok, text: r.text, exhausted: r.exhausted, error: r.error }
}

// ── Gemini (UI automation via a hidden logged-in window) ─────────────────────────
// Same pattern as ChatGPT: we drive the real Gemini composer so BotGuard and
// Google's cookie defences are satisfied natively by the running page.
async function runGemini(opts: OwnAccountOptions): Promise<ProviderResult> {
  const r = await askGemini({
    prompt: `${opts.systemPrompt}\n\n${opts.userMessage}`,
    onDelta: opts.onDelta,
    signal: opts.signal,
  })
  return { ok: r.ok, text: r.text, exhausted: r.exhausted, error: r.error }
}

// ── GLM / Z.ai (UI automation via a hidden logged-in window) ─────────────────────
// Same pattern as Gemini/ChatGPT: we drive the real chat.z.ai composer so Z.ai's
// cookie/anti-bot defences are satisfied natively by the running page.
async function runGlm(opts: OwnAccountOptions): Promise<ProviderResult> {
  const r = await askGlm({
    prompt: `${opts.systemPrompt}\n\n${opts.userMessage}`,
    onDelta: opts.onDelta,
    signal: opts.signal,
  })
  return { ok: r.ok, text: r.text, exhausted: r.exhausted, error: r.error }
}

// ── Failover chain (public entry) ────────────────────────────────────────────────

/** Only attempt providers whose cooldown has expired. Retrying a known exhausted
 *  provider on every question burns time and can extend the upstream throttle. */
function orderByAvailability(providers: OwnAccountProvider[]): OwnAccountProvider[] {
  const now = Date.now()
  const seen = new Set<OwnAccountProvider>()
  const uniq = providers.filter((p) => (seen.has(p) ? false : (seen.add(p), true)))
  return uniq.filter((p) => cooldownUntil[p] <= now)
}

/**
 * Try each linked account in priority order. Move to the next ONLY when the current
 * one is exhausted (usage limit) or errors — never round-robin. An exhausted / failed
 * provider is put on cooldown so later questions in the same interview skip straight
 * to the working account instead of re-paying the failover round-trip every time.
 */
export async function streamOwnAccount(opts: OwnAccountOptions): Promise<OwnAccountResult> {
  return runFailover(opts, (provider, signal, onDelta) => {
    const attempt = { ...opts, signal, onDelta }
    if (provider === 'chatgpt') return runChatGPT(attempt)
    if (provider === 'gemini') return runGemini(attempt)
    if (provider === 'glm') return runGlm(attempt)
    return runClaude(session.fromPartition('persist:claude-auth'), attempt)
  }, 12_000)
}

export interface OwnAccountVisionOptions {
  providers: OwnAccountProvider[]
  systemPrompt: string
  imageDataUrl: string
  onDelta: (partialText: string) => void
  signal?: AbortSignal
}

/**
 * Vision (screen-scan) counterpart of streamOwnAccount. Same failover chain, but each
 * provider answers about a screenshot via its browser bridge (ChatGPT pastes the
 * image, Claude attaches it through the file input). Shares the text cooldown map —
 * an account that's rate-limited is skipped for both text and vision.
 */
export async function streamOwnAccountVision(opts: OwnAccountVisionOptions): Promise<OwnAccountResult> {
  return runFailover(opts, (provider, signal, onDelta) => {
    const args = { prompt: opts.systemPrompt, imageDataUrl: opts.imageDataUrl, onDelta, signal }
    if (provider === 'chatgpt') return askChatGptVision(args)
    if (provider === 'gemini') return askGeminiVision(args)
    if (provider === 'glm') return askGlmVision(args)
    return askClaudeVision(args)
  }, 20_000)
}

async function runFailover(
  opts: Pick<OwnAccountOptions, 'providers' | 'signal' | 'onDelta'>,
  run: (provider: OwnAccountProvider, signal: AbortSignal, onDelta: (text: string) => void) => Promise<ProviderResult>,
  firstTextMs: number
): Promise<OwnAccountResult> {
  const errors: string[] = []
  for (const provider of orderByAvailability(opts.providers)) {
    if (opts.signal?.aborted) return { ok: false, text: '', error: 'Request cancelled' }
    const r = await runProviderAttempt((signal, onDelta) => run(provider, signal, onDelta), {
      ...opts, firstTextMs
    })
    if (opts.signal?.aborted) return { ok: false, text: '', error: 'Request cancelled' }
    if (r.ok && r.text.trim()) {
      cooldownUntil[provider] = 0
      return { ok: true, text: r.text, provider }
    }
    cooldownUntil[provider] = r.exhausted
      ? r.resetAt || Date.now() + DEFAULT_EXHAUST_COOLDOWN_MS
      : Date.now() + HARD_ERROR_COOLDOWN_MS
    errors.push(r.exhausted ? `${label(provider)} usage limit reached` : `${label(provider)}: ${r.error || 'unavailable'}`)
    console.warn(`[OwnAccount] ${label(provider)} failed; trying the next linked account`)
  }
  return {
    ok: false,
    text: '',
    error: errors.length
      ? `${errors.join('; ')}. Reconnect in Setup → AI Source, or try again later.`
      : 'Linked accounts are unavailable or cooling down. Try again later, reconnect in Setup → AI Source, or choose Zyro Gateway.'
  }
}

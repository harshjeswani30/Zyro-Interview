import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { buildQuestionGeneratorPrompt } from './prompts/questionGenerator'
import { getRelevantExamplesFromBank } from './data/questionBank'
import { resumeRoutes } from './resume/routes'

interface Env {
  GROQ_KEY_1?: string
  GROQ_KEY_2?: string
  GROQ_KEY_3?: string
  GROQ_KEY_4?: string
  GROQ_KEY_5?: string
  GROQ_LLAMA_KEY_1?: string
  GROQ_LLAMA_KEY_2?: string
  GROQ_LLAMA_KEY_3?: string
  GROQ_LLAMA_KEY_4?: string
  GROQ_LLAMA_KEY_5?: string
  GROQ_WHISPER_KEY_1?: string
  GROQ_WHISPER_KEY_2?: string
  GROQ_WHISPER_KEY_3?: string
  GROQ_WHISPER_KEY_4?: string
  GROQ_WHISPER_KEY_5?: string
  // Optional. Vision rotates over the shared Groq pool by default (see extractGroqKeys);
  // set these only if you want dedicated keys for the qwen vision model.
  GROQ_VISION_KEY_1?: string
  GROQ_VISION_KEY_2?: string
  GROQ_VISION_KEY_3?: string
  GROQ_VISION_KEY_4?: string
  GROQ_VISION_KEY_5?: string
  GROQ_API_KEYS?: string
  DEEPGRAM_STT_KEY?: string
  DEEPGRAM_STT_KEY_2?: string
  DEEPGRAM_STT_KEY_3?: string
  DEEPGRAM_STT_KEY_4?: string
  DEEPGRAM_STT_KEY_5?: string
  CARTESIA_API_KEY?: string
  CARTESIA_VOICE_ID?: string
  ELEVENLABS_API_KEY?: string
  ELEVENLABS_VOICE_ID?: string
  AI?: any
  // Resume AI — OpenRouter
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
  OPENROUTER_MODEL_FALLBACK?: string
  OPENROUTER_BASE_URL?: string
  OPENROUTER_SITE_URL?: string
  OPENROUTER_APP_NAME?: string
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  // ── Gateway Auth ──
  // Shared HMAC secret between this Worker and the Supabase Edge Function.
  // Set via: npx wrangler secret put GATEWAY_HMAC_SECRET
  GATEWAY_HMAC_SECRET?: string
  // KV namespace for instant token revocation (admin can revoke any userId instantly).
  // Binding name: GATEWAY_REVOKED_KV (configured in wrangler.toml)
  GATEWAY_REVOKED_KV?: KVNamespace
}

// 5 Verified Groq API Keys (configured via Cloudflare Worker env secrets)
const DEFAULT_GROQ_KEYS: string[] = []

const DEFAULT_CARTESIA_KEY = ''
const DEFAULT_CARTESIA_VOICE_ID = 'faf0731e-dfb9-4cfc-8119-259a79b27e12'

const DEFAULT_ELEVENLABS_KEY = ''
const DEFAULT_ELEVENLABS_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL' // Bella (Premade Neural HD)

/**
 * Groq rate limits are enforced PER MODEL, not per key. whisper-large-v3-turbo has no
 * TPM budget at all, so a 429 on the STT route says nothing about that key's headroom
 * for openai/gpt-oss-120b. Cooldowns are therefore keyed by `${scope}:${apiKey}` so an
 * STT throttle can no longer sideline the same key for the LLM/analyze routes.
 *
 * `stt_dg` is a separate scope for the Deepgram key pool. Deepgram rate-limits per
 * PROJECT (all keys in one project share one concurrency pool), so rotation only buys
 * real headroom when the keys belong to different Deepgram accounts; either way this
 * scope keeps a Deepgram 429/quota-exhaustion from touching the Groq Whisper fallback.
 *
 * `vision` is its own scope for the same per-model reason: qwen/qwen3.8-27b carries a
 * TPM budget independent of gpt-oss-120b, so the shared keys get a fresh vision bucket
 * and a screenshot 429 can never sideline a key for the answer-generation route.
 */
type KeyScope = 'llm' | 'stt' | 'stt_dg' | 'analyze' | 'vision'

// Global in-memory cooldown tracker (persists across requests within the worker isolate)
const keyCooldowns = new Map<string, number>()

function cooldownKey(scope: KeyScope, apiKey: string): string {
  return `${scope}:${apiKey}`
}

function extractGroqKeys(env: Env): string[] {
  const set = new Set<string>()

  const add = (k?: string) => {
    if (k && typeof k === 'string' && k.trim().startsWith('gsk_')) {
      set.add(k.trim())
    }
  }

  // Check all named environment variables
  add(env.GROQ_KEY_1)
  add(env.GROQ_KEY_2)
  add(env.GROQ_KEY_3)
  add(env.GROQ_KEY_4)
  add(env.GROQ_KEY_5)

  add(env.GROQ_LLAMA_KEY_1)
  add(env.GROQ_LLAMA_KEY_2)
  add(env.GROQ_LLAMA_KEY_3)
  add(env.GROQ_LLAMA_KEY_4)
  add(env.GROQ_LLAMA_KEY_5)

  add(env.GROQ_WHISPER_KEY_1)
  add(env.GROQ_WHISPER_KEY_2)
  add(env.GROQ_WHISPER_KEY_3)
  add(env.GROQ_WHISPER_KEY_4)
  add(env.GROQ_WHISPER_KEY_5)

  // Optional dedicated vision keys. Unset by default — the pool above already gives
  // /gateway/vision a full fresh quota bucket because Groq limits are per model.
  add(env.GROQ_VISION_KEY_1)
  add(env.GROQ_VISION_KEY_2)
  add(env.GROQ_VISION_KEY_3)
  add(env.GROQ_VISION_KEY_4)
  add(env.GROQ_VISION_KEY_5)

  if (env.GROQ_API_KEYS) {
    env.GROQ_API_KEYS.split(',').forEach(add)
  }

  // Ensure all 5 default keys are always present
  DEFAULT_GROQ_KEYS.forEach(add)

  return Array.from(set)
}

/**
 * Deepgram STT key pool. Unlike Groq keys these carry no `gsk_` prefix (they are opaque
 * tokens), so any non-empty secret counts. Deduplicated and order-stable so the
 * round-robin in getOrderedKeys() is predictable.
 */
function extractDeepgramKeys(env: Env): string[] {
  const set = new Set<string>()
  const add = (k?: string): void => {
    if (k && typeof k === 'string' && k.trim().length > 0) set.add(k.trim())
  }
  add(env.DEEPGRAM_STT_KEY)
  add(env.DEEPGRAM_STT_KEY_2)
  add(env.DEEPGRAM_STT_KEY_3)
  add(env.DEEPGRAM_STT_KEY_4)
  add(env.DEEPGRAM_STT_KEY_5)
  return Array.from(set)
}

let globalKeyIndex = 0

/**
 * Deterministic Round-Robin Load Balancer:
 * 1. Checks which keys are currently healthy vs cooling down.
 * 2. Question 1 -> Key 1, Question 2 -> Key 2, Question 3 -> Key 3, Question 4 -> Key 4, Question 5 -> Key 5.
 * 3. Rotates sequentially and wraps around to Key 1.
 * 4. Puts cooling keys at the end as last-resort fallbacks.
 */
function getOrderedKeys(allKeys: string[], scope: KeyScope): string[] {
  const now = Date.now()
  const healthy: string[] = []
  const cooling: string[] = []

  for (const k of allKeys) {
    const until = keyCooldowns.get(cooldownKey(scope, k)) || 0
    if (now >= until) {
      healthy.push(k)
    } else {
      cooling.push(k)
    }
  }

  const activePool = healthy.length > 0 ? healthy : allKeys
  const startIdx = globalKeyIndex % activePool.length
  globalKeyIndex = (globalKeyIndex + 1) % activePool.length
  const ordered: string[] = []

  for (let i = 0; i < activePool.length; i++) {
    ordered.push(activePool[(startIdx + i) % activePool.length])
  }

  for (const k of cooling) {
    if (!ordered.includes(k)) {
      ordered.push(k)
    }
  }

  return ordered
}

function markKeyCooldown(key: string, scope: KeyScope, cooldownMs: number) {
  keyCooldowns.set(cooldownKey(scope, key), Date.now() + cooldownMs)
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS policy (audit M5)
// ─────────────────────────────────────────────────────────────────────────────
// The gateway is called from exactly three places: the website (www.zyro-ai.in),
// local dev servers, and the desktop app's renderer (whose origin is the literal
// string "null" because it loads from file://). Everything else gets no CORS
// headers, so a malicious page opened in the user's browser cannot read gateway
// responses cross-origin. Non-browser clients (curl, Electron's main process)
// never send Origin and ignore CORS entirely.
const ALLOWED_ORIGINS = new Set(['https://www.zyro-ai.in', 'https://zyro-ai.in'])

function corsAllowOrigin(originHeader: string | undefined): string | null {
  if (!originHeader) return null
  if (ALLOWED_ORIGINS.has(originHeader)) return originHeader
  // Desktop app: file:// renderer sends the literal origin "null"
  if (originHeader === 'null') return 'null'
  // Local dev servers (Vite etc.), any port
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHeader)) return originHeader
  return null
}

/** CORS headers for a request, or an empty object when the origin is not allowed. */
function gatewayCorsHeaders(originHeader: string | undefined): Record<string, string> {
  const origin = corsAllowOrigin(originHeader)
  return origin ? { 'Access-Control-Allow-Origin': origin } : {}
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC Auth Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies a gateway token of the form "userId:expiryEpoch:hmacSignature".
 * The HMAC is SHA-256 keyed with GATEWAY_HMAC_SECRET.
 * Returns the userId on success, null on failure.
 * This runs entirely in-process (WebCrypto) — zero external calls, ~0ms overhead.
 */
async function verifyGatewayToken(
  token: string,
  secret: string
): Promise<string | null> {
  if (!token || !secret) return null
  const parts = token.split(':')
  if (parts.length !== 3) return null
  const [userId, expiryStr, signature] = parts

  // 1. Check expiry first (cheap integer comparison)
  const expiry = parseInt(expiryStr, 10)
  if (isNaN(expiry) || Date.now() > expiry) return null

  // 2. Verify HMAC signature
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const expectedSigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(`${userId}:${expiryStr}`))
  const expectedSig = Array.from(new Uint8Array(expectedSigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  // Constant-time comparison to prevent timing attacks
  if (expectedSig.length !== signature.length) return null
  let diff = 0
  for (let i = 0; i < expectedSig.length; i++) {
    diff |= expectedSig.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  if (diff !== 0) return null

  return userId
}

const app = new Hono<{ Bindings: Env }>()

// CORS restricted to known origins (audit M5). No credentials — the gateway
// authenticates via Authorization/x-gateway-token headers, never cookies, so
// reflecting arbitrary origins with credentials:true only bought cross-site
// request forgery against a logged-in user.
app.use('*', cors({
  origin: (origin) => corsAllowOrigin(origin) ?? undefined,
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-user-api-key', 'x-gateway-token'],
  maxAge: 86400,
  credentials: false
}))

// Explicitly handle OPTIONS for fast preflight — same allowlist as above.
// Requests from unknown origins get no ACAO header, so the browser blocks them.
app.options('*', (c) => {
  const headers = gatewayCorsHeaders(c.req.header('Origin'))
  if (!headers['Access-Control-Allow-Origin']) {
    return c.text('Origin not allowed', 403)
  }
  return c.text('', 204, {
    ...headers,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-api-key, x-gateway-token',
    'Access-Control-Max-Age': '86400'
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GATEWAY AUTH MIDDLEWARE
// Placed after CORS (so preflights pass) but before every route handler.
// Free route: GET / and GET /gateway (health checks, no auth needed).
// All POST routes (/gateway/llm, /gateway/stt, /gateway/vision, etc.) require
// a valid HMAC token issued by the generate-gateway-token Supabase Edge Function.
// ─────────────────────────────────────────────────────────────────────────────
app.use('/gateway/*', async (c, next) => {
  // Auth is REQUIRED on every gateway route, STT included (audit C7/M6 — the
  // old /gateway/stt exemption left paid Whisper keys burnable with one curl).
  // Local dev: set GATEWAY_HMAC_SECRET in .dev.vars to keep the same behaviour.
  const secret = c.env.GATEWAY_HMAC_SECRET
  if (!secret) {
    console.warn('[Auth] GATEWAY_HMAC_SECRET not set — running in open mode (dev only)')
    return next()
  }

  // The browser cannot set headers on a WebSocket handshake or an <audio>
  // element, so those callers pass the same token as ?token= on the URL. The
  // header is preferred everywhere else.
  const token = c.req.header('x-gateway-token') || c.req.query('token') || ''
  const userId = await verifyGatewayToken(token, secret)

  if (!userId) {
    return c.json(
      { error: 'Unauthorized', message: 'Valid gateway token required. Please restart the app.' },
      401,
      { ...gatewayCorsHeaders(c.req.header('Origin')) }
    )
  }

  // KV revocation check — performed on every route, STT included (audit M6).
  // This lets admins instantly block a userId by writing "revoked:{userId}" = "1" to KV.
  // Hot KV reads are <5ms globally; cold reads are still faster than a Supabase round-trip.
  if (c.env.GATEWAY_REVOKED_KV) {
    const revoked = await c.env.GATEWAY_REVOKED_KV.get(`revoked:${userId}`)
    if (revoked !== null) {
      return c.json(
        { error: 'Forbidden', message: 'Account access has been revoked. Please contact support.' },
        403,
        { ...gatewayCorsHeaders(c.req.header('Origin')) }
      )
    }
  }

  // Attach userId to the context for downstream logging if needed
  c.set('userId' as never, userId)
  return next()
})

// Custom 404
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404, {
    ...gatewayCorsHeaders(c.req.header('Origin'))
  })
})

// Global error handler
app.onError((err, c) => {
  // Log the real error server-side; the client gets a generic body (audit M5 —
  // provider/upstream internals leaked through err.message before).
  console.error('[Global Error]', err)
  return c.json({ error: 'Internal Server Error' }, 500, {
    ...gatewayCorsHeaders(c.req.header('Origin'))
  })
})

// Resume AI routes — mounted before inline handlers so /gateway/resume/* is caught first
app.route('/gateway/resume', resumeRoutes)

app.get('/', (c) => c.json({ status: 'alive', message: 'AI Gateway is running. Endpoints: /gateway/llm, /gateway/stt, /gateway/vision, /gateway/analyze, /gateway/resume' }))

app.get('/gateway', (c) => {
  const keys = extractGroqKeys(c.env)
  return c.json({
    status: 'healthy',
    providerCount: keys.length,
    supportedModels: {
      llm: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
      stt: ['whisper-large-v3-turbo', 'deepgram-nova-2'],
      vision: ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b'],
      tts: ['cartesia/sonic-preview']
    }
  })
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// TTS ENDPOINT (Cartesia Sonic Neural Hindi -> ElevenLabs Fallback)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.all('/gateway/tts', async (c) => {
  try {
    let text = ''
    let voiceId = c.req.query('voice') || c.env.CARTESIA_VOICE_ID || DEFAULT_CARTESIA_VOICE_ID
    let lang = c.req.query('lang') || ''

    if (c.req.method !== 'GET') {
      const body = await c.req.json().catch(() => ({})) as any
      if (body.text) text = body.text
      if (body.voice) voiceId = body.voice
      if (body.lang) lang = body.lang
    } else {
      text = c.req.query('text') || ''
    }

    if (!text || !text.trim()) {
      return c.json({ error: 'Text parameter is required' }, 400)
    }

    const cleanText = text.trim()
    const isHindi = lang === 'hi' || /[\u0900-\u097F]/.test(cleanText)
    const cartesiaKey = c.env.CARTESIA_API_KEY || DEFAULT_CARTESIA_KEY
    const elevenKey = c.env.ELEVENLABS_API_KEY || DEFAULT_ELEVENLABS_KEY
    const elevenVoiceId = c.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID

    // â”€â”€ Tier 1: Cartesia Sonic Neural TTS (Ultra-Fast ~120ms) â”€â”€
    if (cartesiaKey) {
      try {
        const cartesiaRes = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: {
            'X-API-Key': cartesiaKey,
            'Cartesia-Version': '2024-06-10',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model_id: 'sonic-preview',
            transcript: cleanText,
            voice: {
              mode: 'id',
              id: voiceId
            },
            language: isHindi ? 'hi' : 'en',
            output_format: {
              container: 'mp3',
              encoding: 'mp3',
              sample_rate: 44100
            }
          }),
          signal: AbortSignal.timeout(8000)
        })

        if (cartesiaRes.ok) {
          const audioBytes = await cartesiaRes.arrayBuffer()
          return new Response(audioBytes, {
            status: 200,
            headers: {
              'Content-Type': 'audio/mpeg',
              'Content-Length': audioBytes.byteLength.toString(),
              'Cache-Control': 'public, max-age=86400',
              ...gatewayCorsHeaders(c.req.header('Origin')),
              'x-tts-provider': 'cartesia'
            }
          })
        }

        const errText = await cartesiaRes.text().catch(() => '')
        console.warn(`[Cartesia Quota/Error ${cartesiaRes.status}]: ${errText.slice(0, 100)} - Failing over to ElevenLabs...`)
      } catch (cartesiaErr: any) {
        console.warn('[Cartesia Failover Triggered]:', cartesiaErr.message)
      }
    }

    // â”€â”€ Tier 2: ElevenLabs Turbo v2.5 Fallback (Neural HD Multilingual) â”€â”€
    if (elevenKey) {
      try {
        const elevenRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}?output_format=mp3_44100_128`, {
          method: 'POST',
          headers: {
            'xi-api-key': elevenKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: cleanText,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75
            }
          }),
          signal: AbortSignal.timeout(12000)
        })

        if (elevenRes.ok) {
          const audioBytes = await elevenRes.arrayBuffer()
          return new Response(audioBytes, {
            status: 200,
            headers: {
              'Content-Type': 'audio/mpeg',
              'Content-Length': audioBytes.byteLength.toString(),
              'Cache-Control': 'public, max-age=86400',
              ...gatewayCorsHeaders(c.req.header('Origin')),
              'x-tts-provider': 'elevenlabs'
            }
          })
        }

        const elevenErrText = await elevenRes.text().catch(() => '')
        console.warn(`[ElevenLabs Error ${elevenRes.status}]:`, elevenErrText.slice(0, 100))
      } catch (elevenErr: any) {
        console.warn('[ElevenLabs Error]:', elevenErr.message)
      }
    }

    return c.json({ error: 'All neural TTS providers failed' }, 502)
  } catch (err: any) {
    console.error('[TTS Global Error]', err)
    return c.json({ error: 'TTS processing failed' }, 500)
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 1. EMBEDDINGS (Workers AI)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/gateway/embeddings', async (c) => {
  try {
    const body = await c.req.json() as { text: string | string[] }
    const text = body.text

    if (!text) {
      return c.json({ error: 'Text parameter is required' }, 400)
    }

    if (!c.env.AI) {
      return c.json({ error: 'Workers AI binding is missing' }, 500)
    }

    const texts = Array.isArray(text) ? text : [text]
    const response = await c.env.AI.run('@cf/baai/bge-small-en-v1.5', {
      text: texts
    })

    return c.json(response)
  } catch (err: any) {
    console.error('[Embeddings Error]', err)
    return c.json({ error: 'Failed to generate embeddings' }, 500)
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 2. STT (Audio Transcription with 5-Key Whisper + Deepgram Fallback)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** One entry of Whisper's verbose_json `segments` array (fields we care about). */
interface WhisperSegment {
  text?: string
  avg_logprob?: number
  compression_ratio?: number
  no_speech_prob?: number
}

/**
 * Drops hallucinated segments using Whisper's own published decoding heuristics
 * instead of a word blacklist.
 *
 * - `no_speech_prob > 0.6` together with `avg_logprob < -1.0` is how Whisper itself
 *   classifies a segment as silence. This is what produces confident nonsense out of
 *   a pause or of room noise.
 * - `compression_ratio > 2.4` is Whisper's degenerate-repetition test: a segment that
 *   gzips that well is a stuck decoder loop ("haan haan haan haanâ€¦"), not speech.
 * - A very low `avg_logprob` on its own means the decoder was guessing.
 *
 * Anything without segment metadata falls back to the plain `text` field unchanged.
 */
function filterHallucinatedSegments(data: { text?: string; segments?: WhisperSegment[] }): string {
  const segments = Array.isArray(data?.segments) ? data.segments : null
  if (!segments || segments.length === 0) return data?.text || ''

  const kept: string[] = []
  for (const seg of segments) {
    const text = (seg?.text || '').trim()
    if (!text) continue
    const noSpeech = typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : 0
    const logprob = typeof seg.avg_logprob === 'number' ? seg.avg_logprob : 0
    const ratio = typeof seg.compression_ratio === 'number' ? seg.compression_ratio : 1

    if (noSpeech > 0.6 && logprob < -1.0) continue // silence decoded as words
    if (ratio > 2.4) continue                      // stuck repetition loop
    if (logprob < -1.4) continue                   // decoder was guessing
    kept.push(text)
  }

  // Every segment failing the checks means the clip really was silence/noise. Return
  // empty rather than the unfiltered text â€” passing it through defeats the filter.
  return kept.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Live (streaming) STT -- a WebSocket proxy to Deepgram.
 *
 * The batch sibling below transcribes a finished clip, so the client only learns what
 * was said once the clip is uploaded and decoded: a phrase at a time, never word by
 * word. This route instead holds a socket open for the turn and relays Deepgram's
 * interim results straight through, which is what a live word-by-word ticker needs.
 *
 * It exists as a proxy rather than a direct client connection for one reason: the keys
 * live here. A browser cannot set an Authorization header on a WebSocket (it would have
 * to pass the key as a subprotocol, in the clear), and a desktop build must not ship
 * one at all. Proxying keeps the key server-side and lets the same rotation and
 * cooldown bookkeeping as the batch path apply.
 */
app.get('/gateway/stt-stream', async (c) => {
  if ((c.req.header('Upgrade') || '').toLowerCase() !== 'websocket') {
    return c.text('expected a websocket upgrade', 426)
  }

  const deepgramKeys = getOrderedKeys(extractDeepgramKeys(c.env), 'stt_dg')
  if (deepgramKeys.length === 0) {
    return c.text('no deepgram key configured on this gateway', 503)
  }

  // Whitelist, do not forward. Everything Deepgram receives is either a value this
  // gateway chose or one that passed a format check, so a client cannot rewrite the
  // model, redirect billing, or smuggle arbitrary query parameters upstream.
  const requested = c.req.query()
  const language =
    requested.language && /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$|^multi$/.test(requested.language)
      ? requested.language
      : 'multi'
  const sampleRate = /^\d{4,6}$/.test(requested.sample_rate || '')
    ? requested.sample_rate
    : '48000'

  const params = new URLSearchParams({
    model: 'nova-3',
    language,
    encoding: 'linear16',
    sample_rate: sampleRate,
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true'
  })

  // Try each healthy key in turn: a drained or throttled key refuses the upgrade, and
  // failing over here is cheaper than surfacing it to the client mid-interview.
  for (const dgKey of deepgramKeys) {
    const dgId = dgKey.slice(0, 6) + '...'
    let upstreamRes: Response
    try {
      upstreamRes = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
        headers: { Upgrade: 'websocket', Authorization: `Token ${dgKey}` }
      })
    } catch (err) {
      console.error(`[STT-STREAM] ${dgId} upgrade threw:`, (err as Error).message)
      markKeyCooldown(dgKey, 'stt_dg', 15000)
      continue
    }

    const upstream = upstreamRes.webSocket
    if (!upstream) {
      console.warn(`[STT-STREAM] ${dgId} refused the upgrade: ${upstreamRes.status}`)
      // Same cooldown ladder the batch path uses.
      if (upstreamRes.status === 402 || upstreamRes.status === 403) {
        markKeyCooldown(dgKey, 'stt_dg', 600000)
      } else if (upstreamRes.status === 429) {
        markKeyCooldown(dgKey, 'stt_dg', 15000)
      } else {
        markKeyCooldown(dgKey, 'stt_dg', 60000)
      }
      continue
    }

    upstream.accept()
    const pair = new WebSocketPair()
    const clientSide = pair[0]
    const edgeSide = pair[1]
    edgeSide.accept()

    // Straight relay in both directions. Audio frames go up as binary, Deepgram's
    // JSON results and this client's control frames (KeepAlive, CloseStream) come
    // back down as text; neither is inspected here.
    edgeSide.addEventListener('message', (event) => {
      try {
        upstream.send(event.data)
      } catch {
        /* upstream already gone; its close handler tears the pair down */
      }
    })
    upstream.addEventListener('message', (event) => {
      try {
        edgeSide.send(event.data)
      } catch {
        /* client already gone */
      }
    })

    // Close one side, close the other -- otherwise a client that walks away leaves a
    // Deepgram connection open and billing.
    edgeSide.addEventListener('close', () => {
      try {
        upstream.close()
      } catch {
        /* already closed */
      }
    })
    upstream.addEventListener('close', (event) => {
      try {
        edgeSide.close(event.code >= 1000 && event.code <= 4999 ? event.code : 1011, event.reason)
      } catch {
        /* already closed */
      }
    })
    edgeSide.addEventListener('error', () => {
      try {
        upstream.close()
      } catch {
        /* already closed */
      }
    })
    upstream.addEventListener('error', () => {
      try {
        edgeSide.close(1011, 'upstream error')
      } catch {
        /* already closed */
      }
    })

    console.log(`[STT-STREAM] relaying via ${dgId} (${language} @ ${sampleRate}Hz)`)
    return new Response(null, { status: 101, webSocket: clientSide })
  }

  return c.text('every deepgram key refused the streaming upgrade', 502)
})

app.post('/gateway/stt', async (c) => {
  const userApiKey = c.req.header('x-user-api-key')
  const allKeys = userApiKey && userApiKey.trim().startsWith('gsk_')
    ? [userApiKey.trim(), ...extractGroqKeys(c.env)]
    : extractGroqKeys(c.env)

  const orderedKeys = getOrderedKeys(allKeys, 'stt')

  let incomingFormData: FormData
  try {
    incomingFormData = await c.req.formData()
  } catch {
    return c.json({ error: 'Expected multipart/form-data with audio file' }, 400)
  }

  // Extract audio blob and parameters
  let audioBlob: Blob | undefined
  let language = ''
  let prompt = ''
  let requestedModel = 'whisper-large-v3-turbo'

  for (const [key, value] of incomingFormData.entries()) {
    if (value instanceof Blob) {
      audioBlob = value
    } else if (key === 'language') {
      language = String(value)
    } else if (key === 'prompt') {
      prompt = String(value)
    } else if (key === 'model') {
      requestedModel = String(value)
    }
  }

  if (!audioBlob) {
    return c.json({ error: 'No audio file provided in form data' }, 400)
  }

  // Only 'auto' means "let Whisper detect it". A caller that explicitly picked a
  // language gets it pinned, including `hi` and `en`: auto-detect on a short clip
  // flips language mid-utterance and is the single largest source of invented words.
  // Mirrors resolveSttLanguage() in the desktop main process, repeated here so
  // already-installed clients get the fix without an app update.
  const sttLanguage = (() => {
    if (!language) return null
    const base = language.split('-')[0].toLowerCase()
    if (!base || base === 'auto') return null
    return base
  })()

  // 1. PRIMARY: Deepgram Nova-3 rotation across every configured Deepgram key.
  //    Nova-3 `language=multi` keeps both halves of a Hinglish sentence; an explicit
  //    locale is pinned on the same model. Rotation + cooldown fails a drained or
  //    throttled key over to the next (per-project limit caveat noted on KeyScope).
  const deepgramKeys = getOrderedKeys(extractDeepgramKeys(c.env), 'stt_dg')
  if (deepgramKeys.length > 0) {
    // `detect_language=true` is what makes Deepgram populate `detected_language`, which
    // is the field read below and handed to the renderer as `language`. Without it that
    // field was always undefined, so the per-utterance language signal the answer-language
    // decision depends on was structurally dead on this path -- and Deepgram is the
    // primary path. Only asked for in multi mode; a pinned locale needs no detection.
    const dgQuery = sttLanguage
      ? `model=nova-3&language=${encodeURIComponent(sttLanguage)}`
      : 'model=nova-3&language=multi&detect_language=true'
    const dgAudio = await audioBlob.arrayBuffer()
    const dgContentType = audioBlob.type || 'audio/wav'

    for (const dgKey of deepgramKeys) {
      const dgId = dgKey.slice(0, 6) + '...'
      try {
        const dgRes = await fetch(
          `https://api.deepgram.com/v1/listen?${dgQuery}&smart_format=true&encoding=linear16`,
          {
            method: 'POST',
            headers: { 'Authorization': `Token ${dgKey}`, 'Content-Type': dgContentType },
            body: dgAudio
          }
        )

        if (dgRes.ok) {
          const dgData = (await dgRes.json()) as any
          const channel = dgData.results?.channels?.[0]
          const transcript = channel?.alternatives?.[0]?.transcript || ''
          const detectedLanguage =
            channel?.detected_language || channel?.alternatives?.[0]?.languages?.[0]
          return c.json({ text: transcript, language: detectedLanguage }, 200, {
            ...gatewayCorsHeaders(c.req.header('Origin')),
            
          })
        }
        const dgErrText = await dgRes.text().catch(() => '')
        console.warn(
          `[Gateway STT] Deepgram key ${dgId} returned ${dgRes.status}: ${dgErrText.substring(0, 120)}`
        )

        // 400 = malformed request (e.g. a locale this model can't pin). Every other
        // key would fail identically, so stop rotating and drop to Whisper.
        if (dgRes.status === 400) break

        // 402/403 = credits exhausted or key disabled → park it 10 min so rotation
        // moves to the next account's key. 429 = project concurrency, clears fast →
        // short cooldown. 401/5xx → medium.
        if (dgRes.status === 402 || dgRes.status === 403) markKeyCooldown(dgKey, 'stt_dg', 600000)
        else if (dgRes.status === 429) markKeyCooldown(dgKey, 'stt_dg', 15000)
        else markKeyCooldown(dgKey, 'stt_dg', 60000)
      } catch (dgErr: any) {
        console.error(`[Gateway STT] Deepgram key ${dgId} error:`, dgErr?.message)
        markKeyCooldown(dgKey, 'stt_dg', 15000)
      }
    }
    console.warn('[Gateway STT] All Deepgram keys exhausted — falling back to Groq Whisper')
  }

  // 2. FALLBACK: Groq Whisper rotation across all 5 keys
  for (let i = 0; i < orderedKeys.length; i++) {
    const apiKey = orderedKeys[i]
    const keyId = apiKey.slice(0, 10) + '...'

    const formData = new FormData()
    formData.append('file', audioBlob, 'recording.wav')
    formData.append('model', requestedModel || 'whisper-large-v3-turbo')
    if (sttLanguage) {
      formData.append('language', sttLanguage)
    }
    if (prompt) {
      // slice(0, â€¦) not slice(-â€¦): the prompt is a fixed vocabulary hint, and
      // left-truncating it fed Whisper a half-word fragment as leading context.
      formData.append('prompt', prompt.slice(0, 400))
    }
    // Greedy decoding. Whisper's default temperature fallback re-samples a segment
    // when it looks degenerate, and those re-samples are where fluent-but-invented
    // sentences come from.
    formData.append('temperature', '0')
    // verbose_json exposes the per-segment confidence fields we need to drop
    // silence/repetition hallucinations at the source instead of by word blacklist.
    formData.append('response_format', 'verbose_json')

    try {
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        body: formData
      })

      if (res.ok) {
        const data = await res.json() as any
        // Surface Whisper's detected language (verbose_json includes it) so the
        // client can pick the answer language for Latin-script and CJK utterances
        // that script detection alone can't disambiguate. Additive + optional:
        // older clients simply ignore the extra field.
        return c.json({ text: filterHallucinatedSegments(data), language: data.language }, 200, {
          ...gatewayCorsHeaders(c.req.header('Origin')),
          
        })
      }

      const errText = await res.text().catch(() => '')
      console.warn(`[Gateway STT] Key ${keyId} returned ${res.status}: ${errText.substring(0, 120)}`)

      // Put key in cooldown on rate limits or server errors and immediately try next key
      if (res.status === 429 || res.status === 401 || res.status >= 500) {
        markKeyCooldown(apiKey, 'stt', 15000)
        continue
      }
    } catch (err: any) {
      console.error(`[Gateway STT] Error on key ${keyId}:`, err.message)
      markKeyCooldown(apiKey, 'stt', 15000)
    }
  }

  // Both providers exhausted (Deepgram tried first, Whisper as the safety net).
  return c.json({ error: 'All STT providers failed or rate-limited' }, 503)
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 3. LLM (Answer Generation with 5-Key openai/gpt-oss-120b Pool)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/gateway/llm', async (c) => {
  const userApiKey = c.req.header('x-user-api-key')
  const allKeys = userApiKey && userApiKey.trim().startsWith('gsk_')
    ? [userApiKey.trim(), ...extractGroqKeys(c.env)]
    : extractGroqKeys(c.env)

  const orderedKeys = getOrderedKeys(allKeys, 'llm')

  let rawBody: any
  try {
    rawBody = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // Strictly enforce openai/gpt-oss-120b (NO Llama model)
  const model = 'openai/gpt-oss-120b'

  // Opt-in SSE streaming: normalize a truthy-but-not-`true` value to a real boolean.
  const wantsStream = rawBody.stream === true

  // max_tokens is deprecated upstream; accept it on the wire, send the new field.
  const { max_tokens: _legacyMaxTokens, ..._rest } = rawBody
  void _rest // audit L3: explicit allowlist below — unknown client fields are
  // dropped so they can't inject provider-level options through this proxy.
  const requestedTokens = Math.min(rawBody.max_completion_tokens || rawBody.max_tokens || 1600, 1600)

  const payload = {
    model,
    messages: Array.isArray(rawBody.messages) ? rawBody.messages : [],
    stream: wantsStream,
    max_completion_tokens: requestedTokens,
    // gpt-oss-120b defaults to 'medium', and reasoning tokens compete with the
    // answer for the same ceiling. 'low' leaves the budget for the answer.
    reasoning_effort: rawBody.reasoning_effort ?? 'low'
    // Deliberately NOT sending reasoning_format or include_reasoning: Groq documents
    // reasoning_format as unsupported on gpt-oss-*, and a 400 is not in the retry
    // predicate at :616, so one unsupported field 503s this route for every key.
  }

  let lastError: any = null

  // 2-pass resilience: pass 1 tries all keys, if all rate-limited, wait 1200ms for Groq rolling token refill and pass 2 succeeds
  for (let pass = 0; pass < 2; pass++) {
    if (pass > 0) {
      console.log('[Gateway LLM] All keys busy on first pass, waiting 1200ms for Groq token bucket refill...')
      await new Promise((r) => setTimeout(r, 1200))
    }

    for (let i = 0; i < orderedKeys.length; i++) {
      const apiKey = orderedKeys[i]
      const keyId = apiKey.slice(0, 10) + '...'

      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        })

        if (res.ok) {
          if (wantsStream && res.body) {
            // Committed to this key: status was 200, so no rotation is possible past here.
            return new Response(res.body, {
              status: 200,
              headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                ...gatewayCorsHeaders(c.req.header('Origin')),
                'x-gateway-stream': '1'
              }
            })
          }

          const data = await res.json() as any
          if (data.choices?.[0]?.message) {
            let content = data.choices[0].message.content || ''
            const reasoning = data.choices[0].message.reasoning || ''

            // Remove think blocks cleanly
            content = content.replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
            const thinkStart = content.toLowerCase().indexOf('<think>')
            if (thinkStart !== -1) {
              content = content.substring(0, thinkStart)
            }
            content = content.trim()

            // Reasoning is chain-of-thought and must never be shown as the answer.
            // An empty content field is a failed generation, not a cue to substitute it.
            if (!content && reasoning) {
              console.warn(
                `[Gateway LLM] empty content with ${reasoning.length} chars of reasoning ` +
                  `(finish_reason=${data.choices?.[0]?.finish_reason}) — returning empty, not the reasoning`
              )
            }

            data.choices[0].message.content = content
          }

          const finishReason = data.choices?.[0]?.finish_reason ?? 'unknown'
          if (finishReason === 'length') {
            console.warn(`[Gateway LLM] truncated: finish_reason=length at max_completion_tokens=${requestedTokens}`)
          }

          return c.json(data, 200, {
            ...gatewayCorsHeaders(c.req.header('Origin')),
            'x-finish-reason': String(finishReason)
          })
        }

        const errText = await res.text().catch(() => '')
        console.warn(`[Gateway LLM] Key ${keyId} returned ${res.status}: ${errText.substring(0, 150)}`)

        // Parse reset time if provided in headers (e.g. 500ms - 8s)
        if (res.status === 429 || res.status === 413 || res.status === 401 || res.status >= 500) {
          const resetHeader = res.headers.get('x-ratelimit-reset-tokens') || res.headers.get('retry-after')
          let cooldownMs = 8000
          if (resetHeader) {
            const parsedSec = parseFloat(resetHeader)
            if (!isNaN(parsedSec) && parsedSec > 0) {
              cooldownMs = Math.min(Math.ceil(parsedSec * 1000) + 500, 15000)
            }
          }
          markKeyCooldown(apiKey, 'llm', cooldownMs)
          lastError = { status: res.status, body: errText }
          continue // instantly try next key
        }

        lastError = { status: res.status, body: errText }
      } catch (err: any) {
        console.error(`[Gateway LLM] Network error on key ${keyId}:`, err.message)
        markKeyCooldown(apiKey, 'llm', 5000)
        lastError = err
      }
    }
  }

  return c.json({
    error: 'All Groq provider keys exhausted or rate-limited for openai/gpt-oss-120b',
    details: lastError?.body || lastError?.message || lastError
  }, 503)
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 4. VISION (Groq Qwen3.8 Vision — 5-Key Rotation + SSE Streaming)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const VISION_MODELS = ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b'] as const
const VISION_MAX_IMAGES = 3 // Groq hard limit on qwen/qwen3.8-27b

/**
 * Groq rejects vision requests carrying more than 3 images. Keep the LAST 3 image parts
 * (the newest screenshot is the one on the candidate's screen) and leave text untouched.
 */
function clampVisionImages(messages: any[]): any[] {
  let total = 0
  for (const msg of messages) {
    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        if (part?.type === 'image_url') total++
      }
    }
  }
  if (total <= VISION_MAX_IMAGES) return messages

  const dropBefore = total - VISION_MAX_IMAGES
  let seen = 0
  return messages.map((msg) => {
    if (!Array.isArray(msg?.content)) return msg
    const content = msg.content.filter((part: any) => {
      if (part?.type !== 'image_url') return true
      return seen++ >= dropBefore
    })
    return { ...msg, content }
  })
}

function stripThinkTags(raw: string): string {
  let content = (raw || '').replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
  const thinkStart = content.toLowerCase().indexOf('<think>')
  if (thinkStart !== -1) content = content.substring(0, thinkStart)
  return content.trim()
}

/**
 * Last-resort shape fix for a 400: some providers refuse a `system` role alongside image
 * parts. Folds the system text into the first user text part and drops the system turn.
 */
function foldSystemIntoUser(messages: any[]): any[] {
  const systemText = messages
    .filter((m) => m?.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n\n')
    .trim()
  if (!systemText) return messages

  const rest = messages.filter((m) => m?.role !== 'system')
  const firstUser = rest.find((m) => m?.role === 'user')
  if (!firstUser) return [{ role: 'user', content: systemText }, ...rest]

  return rest.map((m) => {
    if (m !== firstUser) return m
    if (Array.isArray(m.content)) {
      const idx = m.content.findIndex((p: any) => p?.type === 'text')
      if (idx >= 0) {
        const content = [...m.content]
        content[idx] = { ...content[idx], text: `${systemText}\n\n${content[idx].text || ''}` }
        return { ...m, content }
      }
      return { ...m, content: [{ type: 'text', text: systemText }, ...m.content] }
    }
    return { ...m, content: `${systemText}\n\n${typeof m.content === 'string' ? m.content : ''}` }
  })
}

app.post('/gateway/vision', async (c) => {
  const userApiKey = c.req.header('x-user-api-key')
  const allKeys = userApiKey && userApiKey.trim().startsWith('gsk_')
    ? [userApiKey.trim(), ...extractGroqKeys(c.env)]
    : extractGroqKeys(c.env)

  const orderedKeys = getOrderedKeys(allKeys, 'vision')

  let rawBody: any
  try {
    rawBody = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (orderedKeys.length === 0) {
    return c.json({ error: 'No Groq provider keys configured for vision' }, 503)
  }

  // Opt-in SSE streaming: normalize a truthy-but-not-`true` value to a real boolean.
  const wantsStream = rawBody.stream === true

  // max_tokens is deprecated upstream; accept it on the wire, send the new field.
  // model is forced here, so a client-supplied one is dropped rather than honoured.
  const {
    max_tokens: _legacyMaxTokens,
    messages: _clientMessages,
    model: _clientModel,
    ..._rest
  } = rawBody
  void _rest // audit L3: unknown client fields are dropped, not forwarded — the
  // payload below is an explicit allowlist, so a caller can't inject provider-level
  // options (other_models, response_format, tool specs, …) through this proxy.
  const requestedTokens = Math.min(rawBody.max_completion_tokens || rawBody.max_tokens || 1600, 4096)

  const baseMessages = clampVisionImages(Array.isArray(rawBody.messages) ? rawBody.messages : [])
  if (baseMessages.length === 0) {
    return c.json({ error: 'messages[] is required' }, 400)
  }

  const buildPayload = (model: string, messages: any[]) => ({
    model,
    messages,
    stream: wantsStream,
    max_completion_tokens: requestedTokens,
    // Zero thinking tokens: first byte as fast as possible, which is the entire point of
    // the live-interview screenshot path. Deliberately NOT sending reasoning_format —
    // Groq documents it as mutually exclusive with include_reasoning, and a 400 here
    // would burn the whole key ladder for one unsupported field.
    reasoning_effort: rawBody.reasoning_effort ?? 'none',
    temperature: rawBody.temperature ?? 0.6,
    top_p: rawBody.top_p ?? 0.8
  })

  let lastError: any = null
  let foldedSystem = false
  let messages = baseMessages

  for (const model of VISION_MODELS) {
    let nextModel = false

    // 2-pass resilience: pass 1 tries every key, pass 2 retries after Groq's rolling
    // token bucket refills. Same shape as /gateway/llm.
    for (let pass = 0; pass < 2 && !nextModel; pass++) {
      if (pass > 0) {
        console.log(`[Gateway Vision] All keys busy on ${model}, waiting 1200ms for Groq token bucket refill...`)
        await new Promise((r) => setTimeout(r, 1200))
      }

      for (let i = 0; i < orderedKeys.length; i++) {
        const apiKey = orderedKeys[i]
        const keyId = apiKey.slice(0, 10) + '...'

        try {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(buildPayload(model, messages))
          })

          if (res.ok) {
            if (wantsStream && res.body) {
              // Committed to this key: status was 200, so no rotation is possible past here.
              return new Response(res.body, {
                status: 200,
                headers: {
                  'Content-Type': 'text/event-stream; charset=utf-8',
                  'Cache-Control': 'no-cache, no-transform',
                  Connection: 'keep-alive',
                  ...gatewayCorsHeaders(c.req.header('Origin')),
                  'x-gateway-stream': '1',
                  'x-vision-model': model
                }
              })
            }

            const data = await res.json() as any
            if (data.choices?.[0]?.message) {
              // Defensive: reasoning_effort:'none' should never emit a <think> block.
              data.choices[0].message.content = stripThinkTags(data.choices[0].message.content || '')
            }

            const finishReason = data.choices?.[0]?.finish_reason ?? 'unknown'
            if (finishReason === 'length') {
              console.warn(`[Gateway Vision] truncated: finish_reason=length at max_completion_tokens=${requestedTokens}`)
            }

            return c.json(data, 200, {
              ...gatewayCorsHeaders(c.req.header('Origin')),
              'x-vision-model': model,
              'x-finish-reason': String(finishReason)
            })
          }

          const errText = await res.text().catch(() => '')
          console.warn(`[Gateway Vision] Key ${keyId} on ${model} returned ${res.status}: ${errText.substring(0, 150)}`)
          lastError = { status: res.status, body: errText }

          // Payload too large: no other key and no other model will accept it either.
          if (res.status === 413) {
            return c.json({
              error: 'Screenshot too large for the vision model (Groq caps requests at 20MB)',
              details: errText.substring(0, 300)
            }, 413)
          }

          if (res.status === 429 || res.status === 401 || res.status >= 500) {
            const resetHeader = res.headers.get('x-ratelimit-reset-tokens') || res.headers.get('retry-after')
            let cooldownMs = 8000
            if (resetHeader) {
              const parsedSec = parseFloat(resetHeader)
              if (!isNaN(parsedSec) && parsedSec > 0) {
                cooldownMs = Math.min(Math.ceil(parsedSec * 1000) + 500, 15000)
              }
            }
            markKeyCooldown(apiKey, 'vision', cooldownMs)
            continue // instantly try next key
          }

          // One shape-fix attempt before giving up on this model: a 400 while a system
          // turn sits next to image parts is the one failure a retry can actually fix.
          if (res.status === 400 && !foldedSystem && messages.some((m: any) => m?.role === 'system')) {
            foldedSystem = true
            messages = foldSystemIntoUser(baseMessages)
            console.warn('[Gateway Vision] 400 with a system turn — retrying once with it folded into the user message')
            i-- // same key, fixed payload
            continue
          }

          // 400/404 = the request or the model is the problem (unsupported field, preview
          // model pulled). Every key fails identically, so rotating is wasted latency.
          nextModel = true
          break
        } catch (err: any) {
          console.error(`[Gateway Vision] Network error on key ${keyId}:`, err.message)
          markKeyCooldown(apiKey, 'vision', 5000)
          lastError = err
        }
      }
    }
  }

  return c.json({
    error: `All Groq provider keys exhausted or rate-limited for ${VISION_MODELS.join(' / ')}`,
    details: lastError?.body || lastError?.message || lastError
  }, 503)
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 5. HELPER FUNCTIONS FOR QUESTION GENERATOR & ANALYZE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function tryParseJsonObject(raw: string): any | null {
  try {
    return JSON.parse(raw)
  } catch {
    const first = raw.indexOf('{')
    const last = raw.lastIndexOf('}')
    if (first >= 0 && last > first) {
      const candidate = raw.slice(first, last + 1)
      try {
        return JSON.parse(candidate)
      } catch {
        return null
      }
    }
    return null
  }
}

function trimText(input: unknown, maxLen = 18000): string {
  const text = typeof input === 'string' ? input : ''
  return text.length > maxLen ? text.slice(0, maxLen) : text
}

function isCodingWritePrompt(text: string): boolean {
  const lower = text.toLowerCase()
  return /(write\s+(a|an|the)?\s*(program|code|function)|implement\s+|code\s+this|build\s+this\s+function|compile|run\s+the\s+code|use\s+an\s+ide|leetcode|hackerrank)/i.test(lower)
}

function normalizeQuestionType(input: unknown): 'technical' | 'behavioral' | 'situational' | 'role_specific' {
  const value = String(input || '').toLowerCase().trim()
  if (value.includes('behavior')) return 'behavioral'
  if (value.includes('situat')) return 'situational'
  if (value.includes('role')) return 'role_specific'
  return 'technical'
}

function normalizeDifficulty(input: unknown): 'easy' | 'medium' | 'hard' {
  const value = String(input || '').toLowerCase().trim()
  if (value === 'easy' || value === 'hard') return value
  return 'medium'
}

function sanitizeKeywords(input: unknown, fallbackField: string): string[] {
  if (!Array.isArray(input)) {
    return fallbackField ? [fallbackField, 'trade-offs', 'best practices'] : ['trade-offs', 'best practices']
  }
  const cleaned = input
    .map((k) => String(k || '').trim())
    .filter(Boolean)
    .slice(0, 8)
  if (cleaned.length > 0) return cleaned
  return fallbackField ? [fallbackField, 'trade-offs', 'best practices'] : ['trade-offs', 'best practices']
}

function buildVerbalFallbackQuestion(context: any, idx: number): any {
  const role = context.role || 'the role'
  const company = context.company || 'the company'
  const field = context.field || 'your stack'
  const interviewType = String(context.interview_type || 'Mixed').toLowerCase()

  const templates = [
    `For the ${role} position at ${company}, explain how you would design a reliable solution for a common ${field} challenge and what trade-offs you would consider.`,
    `Describe a technical decision you would make in a ${field} project for ${role}, and explain why this approach is better than alternatives.`,
    `Walk me through how you would diagnose and resolve a production issue in a ${field} system, verbally and step by step.`,
    `Share an example of how you handled ambiguity in a previous project and how that experience applies to this ${role} role.`,
    `Explain how you would communicate architecture and risk decisions to cross-functional stakeholders at ${company}.`
  ]

  const byType = interviewType.includes('behavior')
    ? 'behavioral'
    : interviewType.includes('system')
      ? 'role_specific'
      : interviewType.includes('technical')
        ? 'technical'
        : idx % 4 === 0
          ? 'behavioral'
          : 'technical'

  return {
    question_text: templates[idx % templates.length],
    type: byType,
    difficulty: 'medium',
    expected_keywords: sanitizeKeywords([field, role, 'trade-offs', 'communication'], field),
    expected_answer_themes: ['reasoning', 'decision-making', 'clarity'],
    evaluation_criteria: 'Assess conceptual depth, clarity of explanation, and practical judgment.'
  }
}

function enforceQuestionQuality(rawQuestions: any[], context: any, requestedCount: number): any[] {
  const field = String(context.field || '').trim()
  const cleaned: any[] = []

  for (const q of rawQuestions) {
    const text = String(q?.question_text || '').trim()
    if (!text) continue

    const safeQuestion = isCodingWritePrompt(text)
      ? `For the ${context.role || 'target role'} position, explain your approach to solve this problem verbally, including trade-offs, edge cases, and validation steps.`
      : text

    cleaned.push({
      question_text: safeQuestion,
      type: normalizeQuestionType(q?.type),
      difficulty: normalizeDifficulty(q?.difficulty),
      expected_keywords: sanitizeKeywords(q?.expected_keywords, field),
      expected_answer_themes: Array.isArray(q?.expected_answer_themes)
        ? q.expected_answer_themes.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 6)
        : ['reasoning', 'clarity', 'practicality'],
      evaluation_criteria: String(q?.evaluation_criteria || 'Assess conceptual understanding, communication, and decision quality.')
    })
  }

  const result = [...cleaned]
  let i = 0
  while (result.length < requestedCount) {
    result.push(buildVerbalFallbackQuestion(context, i))
    i++
  }
  return result.slice(0, requestedCount)
}

function computeCounts(interviewType: string, num: number, exp: string) {
  const type = interviewType.toLowerCase()
  if (type.includes('technical')) {
    return { tech: Math.max(1, Math.round(num * 0.7)), beh: Math.max(0, Math.round(num * 0.1)), sit: Math.max(0, Math.round(num * 0.1)), role: Math.max(1, num - Math.round(num * 0.7) - Math.round(num * 0.1) - Math.round(num * 0.1)) }
  }
  if (type.includes('behavior')) {
    return { tech: Math.max(0, Math.round(num * 0.1)), beh: Math.max(1, Math.round(num * 0.7)), sit: Math.max(0, Math.round(num * 0.1)), role: Math.max(1, num - Math.round(num * 0.1) - Math.round(num * 0.7) - Math.round(num * 0.1)) }
  }
  if (type.includes('system')) {
    return { tech: Math.max(1, Math.round(num * 0.4)), beh: Math.max(0, Math.round(num * 0.1)), sit: Math.max(0, Math.round(num * 0.2)), role: Math.max(1, num - Math.round(num * 0.4) - Math.round(num * 0.1) - Math.round(num * 0.2)) }
  }

  const mix = (exp.includes('Fresher') ? { tech: 0.3, beh: 0.4, sit: 0.2, role: 0.1 } :
              exp.includes('1-3') ? { tech: 0.4, beh: 0.3, sit: 0.2, role: 0.1 } :
              exp.includes('3-5') ? { tech: 0.4, beh: 0.2, sit: 0.2, role: 0.2 } :
              { tech: 0.3, beh: 0.2, sit: 0.3, role: 0.2 })

  return {
    tech: Math.max(1, Math.round(num * mix.tech)),
    beh: Math.max(1, Math.round(num * mix.beh)),
    sit: Math.max(1, Math.round(num * mix.sit)),
    role: Math.max(1, Math.round(num * (1 - mix.tech - mix.beh - mix.sit))),
  }
}

function parseResumeSummary(summary: unknown): { skills: string[]; projects: string[] } {
  if (!summary) return { skills: [], projects: [] }
  try {
    const parsed = typeof summary === 'string' ? JSON.parse(summary) : summary
    const skills = Array.isArray((parsed as any)?.skills)
      ? (parsed as any).skills.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 12)
      : []
    const projects = Array.isArray((parsed as any)?.projects)
      ? (parsed as any).projects
        .map((p: any) => {
          if (typeof p === 'string') return p.trim()
          if (p && typeof p === 'object') return String(p.name || p.title || p.project || '').trim()
          return ''
        })
        .filter(Boolean)
        .slice(0, 6)
      : []
    return { skills, projects }
  } catch {
    return { skills: [], projects: [] }
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 6. ANALYZE (Resume Parser, Question Generator, Answer Evaluator)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/gateway/analyze', async (c) => {
  const userApiKey = c.req.header('x-user-api-key')
  const allKeys = userApiKey && userApiKey.trim().startsWith('gsk_')
    ? [userApiKey.trim(), ...extractGroqKeys(c.env)]
    : extractGroqKeys(c.env)

  const orderedKeys = getOrderedKeys(allKeys, 'analyze')
  const { task, context } = await c.req.json()

  let prompt = ''
  if (task === 'parse-resume') {
    const resumeText = trimText(context.resume_text, 24000)
    prompt = `Extract structured information from this resume:
${resumeText}

Return strictly JSON with:
- name, email, phone
- skills (array)
- experience (array of objects with company, role, duration, responsibilities)
- education (array)
- projects (array)

If any field is missing, return empty string/array, never null. Keep arrays concise and factual.`
  } else if (task === 'generate-questions') {
    const num = Number(context.num_questions || 10)
    const exp = String(context.experience || 'Fresher (0 years)')
    const interviewType = String(context.interview_type || 'Mixed')
    const counts = computeCounts(interviewType, num, exp)
    const parsedResume = parseResumeSummary(context.resume_summary)
    const fewShotExamples = getRelevantExamplesFromBank({
      role: String(context.role || ''),
      experience: exp,
      limit: 3
    })

    const basePrompt = buildQuestionGeneratorPrompt({
      role: String(context.role || 'Software Engineer'),
      company: String(context.company || 'General'),
      field: String(context.field || 'General'),
      experience: exp,
      difficulty: String(context.difficulty || 'Adaptive'),
      resumeSkills: parsedResume.skills,
      resumeProjects: parsedResume.projects,
      jobDescription: trimText(context.jd_text || '', 1200),
      numQuestions: num,
      interviewType,
      fewShotExamples
    })

    prompt = `${basePrompt}

REQUIRED DISTRIBUTION FOR THIS RUN:
- ${counts.tech} technical
- ${counts.beh} behavioral
- ${counts.sit} situational
- ${counts.role} role_specific

Ensure total questions count is exactly ${num}.`
  } else if (task === 'evaluate-answer') {
    const rawTranscript = String(context.user_transcript || '').trim()
    const transcriptText = rawTranscript || '(No verbal response detected - silence/skipped)'

    prompt = `You are a strict, objective, industry-standard Technical & Behavioral Interview Evaluator (calibrated to FAANG and Fortune 500 hiring bars).
Evaluate the candidate's actual verbal transcript against the interview question rigorously, honestly, and without grade inflation.

QUESTION: ${context.question_text}
CANDIDATE TRANSCRIPT: ${transcriptText}
EXPECTED DOMAIN KEYWORDS/THEMES: ${Array.isArray(context.expected_keywords) ? context.expected_keywords.join(', ') : context.expected_keywords || 'Core principles, technical trade-offs, structured reasoning'}

EVALUATION RULES & PENALTIES:
1. EMPTY / SILENCE / "I DON'T KNOW" / "PASS" / "SKIP" / SHORT UNRELATED NOISE:
   - Score MUST be between 0 and 15 (Never give higher!).
   - All sub-metrics (relevance, structure, depth, communication, keywords) MUST be 1.
   - Feedback MUST clearly state that the candidate did not answer or skipped the question.
   - Improvements MUST detail the exact expected concepts to study.

2. GIBBERISH / OFF-TOPIC / CASUAL RAMBLING (e.g., testing mic, speaking about unrelated topics, filler words):
   - Score MUST be between 10 and 25.
   - Relevance = 1, Depth = 1, Structure = 1, Keywords = 1, Communication = 1-2.
   - Feedback MUST candidly state that the response was off-topic and lacked domain substance.

3. VAGUE / SHALLOW / MINIMAL EFFORT (e.g. 1-2 generic sentences, buzzwords without explanation, definition without depth or trade-offs):
   - Score MUST be between 25 and 45.
   - Relevance = 2, Depth = 1-2, Structure = 1-2, Keywords = 1-2, Communication = 2.
   - Feedback MUST state that the answer scratched the surface but lacked architectural mechanisms or concrete examples.

4. PARTIAL / AVERAGE (Touches key points but has noticeable gaps, lack of structure, or minor inaccuracies):
   - Score MUST be between 45 and 65.
   - Metrics around 2-3.

5. SOLID / COMPETENT (Direct answer, good structure, explains trade-offs, correct technical vocabulary):
   - Score MUST be between 70 and 84.
   - Metrics around 3-4.

6. EXCEPTIONAL / BAR-RAISER (STAR structure for behavioral, deep architectural trade-offs, edge cases, metrics, best practices for technical):
   - Score MUST be between 85 and 100.
   - Metrics 4-5.

SCORING FORMULA:
- Overall Score (0-100) must strictly reflect the weighted metrics:
  Score = Math.round((relevance * 0.3 + depth * 0.3 + structure * 0.15 + keywords * 0.15 + communication * 0.1) * 20)

RETURN STRICTLY A JSON OBJECT:
{
  "score": number (0-100, strictly computed),
  "feedback": "2-3 candid, objective sentences detailing what the candidate actually said, what was missing, and the technical verdict.",
  "metrics": {
    "relevance": number (1-5),
    "structure": number (1-5),
    "depth": number (1-5),
    "communication": number (1-5),
    "keywords": number (1-5)
  },
  "improvements": [
    "Specific, actionable technical or behavioral recommendation 1",
    "Specific, actionable technical or behavioral recommendation 2",
    "Specific, actionable technical or behavioral recommendation 3"
  ]
}`
  } else {
    return c.json({ error: 'Invalid task' }, 400)
  }

  let llmContent = ''
  let lastError: any = null

  for (let i = 0; i < orderedKeys.length; i++) {
    const apiKey = orderedKeys[i]
    const keyId = apiKey.slice(0, 10) + '...'

    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [{ role: 'user', content: prompt }],
          temperature: task === 'parse-resume' ? 0.1 : 0.25,
          response_format: { type: 'json_object' }
        })
      })

      if (res.ok) {
        const data = await res.json() as any
        llmContent = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning || ''
        if (llmContent) break
      } else {
        const errText = await res.text().catch(() => '')
        console.warn(`[Analyze] Key ${keyId} failed (${res.status}): ${errText.substring(0, 120)}`)
        if (res.status === 429 || res.status === 401 || res.status >= 500) {
          markKeyCooldown(apiKey, 'analyze', 45000)
          lastError = { status: res.status, body: errText }
          continue
        }
      }
    } catch (err: any) {
      console.error(`[Analyze] Network error on key ${keyId}:`, err.message)
      markKeyCooldown(apiKey, 'analyze', 15000)
      lastError = err
    }
  }

  if (!llmContent) {
    return c.json({ error: `Failed to complete ${task} after trying all Groq keys`, details: lastError }, 500)
  }

  const parsed = tryParseJsonObject(llmContent)
  if (!parsed) {
    return c.json({ error: 'Invalid JSON from LLM', raw: llmContent }, 500)
  }

  if (task === 'parse-resume') {
    return c.json({
      name: String(parsed.name || ''),
      email: String(parsed.email || ''),
      phone: String(parsed.phone || ''),
      skills: Array.isArray(parsed.skills) ? parsed.skills.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 40) : [],
      experience: Array.isArray(parsed.experience) ? parsed.experience : [],
      education: Array.isArray(parsed.education) ? parsed.education : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects : []
    })
  }

  if (task === 'generate-questions') {
    const requestedCount = Number(context.num_questions || 10)
    const rawQuestions = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.questions)
        ? parsed.questions
        : []
    const questions = enforceQuestionQuality(rawQuestions, context, requestedCount)
    return c.json({ questions })
  }

  return c.json(parsed)
})

export default app

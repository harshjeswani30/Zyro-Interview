import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { buildQuestionGeneratorPrompt } from './prompts/questionGenerator'
import { getRelevantExamplesFromBank } from './data/questionBank'

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
  GROQ_API_KEYS?: string
  DEEPGRAM_STT_KEY?: string
  CARTESIA_API_KEY?: string
  CARTESIA_VOICE_ID?: string
  ELEVENLABS_API_KEY?: string
  ELEVENLABS_VOICE_ID?: string
  AI?: any
}

// 5 Verified Groq API Keys
const DEFAULT_GROQ_KEYS: string[] = []

const DEFAULT_CARTESIA_KEY = ''
const DEFAULT_CARTESIA_VOICE_ID = 'faf0731e-dfb9-4cfc-8119-259a79b27e12'

const DEFAULT_ELEVENLABS_KEY = ''
const DEFAULT_ELEVENLABS_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL' // Bella (Premade Neural HD)

// Global in-memory cooldown tracker (persists across requests within the worker isolate)
const keyCooldowns = new Map<string, number>()

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

  if (env.GROQ_API_KEYS) {
    env.GROQ_API_KEYS.split(',').forEach(add)
  }

  // Ensure all 5 default keys are always present
  DEFAULT_GROQ_KEYS.forEach(add)

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
function getOrderedKeys(allKeys: string[]): string[] {
  const now = Date.now()
  const healthy: string[] = []
  const cooling: string[] = []

  for (const k of allKeys) {
    const until = keyCooldowns.get(k) || 0
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

function markKeyCooldown(key: string, cooldownMs = 30000) {
  keyCooldowns.set(key, Date.now() + cooldownMs)
}

const app = new Hono<{ Bindings: Env }>()

// Permissive CORS for all client requests (Desktop App, Web, Localhost)
app.use('*', cors({
  origin: (origin) => origin || '*',
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-user-api-key'],
  maxAge: 86400,
  credentials: true
}))

// Explicitly handle OPTIONS for fast preflight
app.options('*', (c) => {
  return c.text('', 204, {
    'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-api-key',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400'
  })
})

// Custom 404
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404, {
    'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
    'Access-Control-Allow-Credentials': 'true'
  })
})

// Global error handler
app.onError((err, c) => {
  console.error('[Global Error]', err)
  return c.json({ error: 'Internal Server Error', message: err.message }, 500, {
    'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
    'Access-Control-Allow-Credentials': 'true'
  })
})

app.get('/', (c) => c.json({ status: 'alive', message: 'AI Gateway is running. Endpoints: /gateway/llm, /gateway/stt, /gateway/vision, /gateway/analyze' }))

app.get('/gateway', (c) => {
  const keys = extractGroqKeys(c.env)
  return c.json({
    status: 'healthy',
    providerCount: keys.length,
    supportedModels: {
      llm: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
      stt: ['whisper-large-v3-turbo', 'deepgram-nova-2'],
      vision: ['gemini-2.5-flash', 'gemini-2.0-flash'],
      tts: ['cartesia/sonic-preview']
    }
  })
})

// ─────────────────────────────────────────────
// TTS ENDPOINT (Cartesia Sonic Neural Hindi -> ElevenLabs Fallback)
// ─────────────────────────────────────────────
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

    // ── Tier 1: Cartesia Sonic Neural TTS (Ultra-Fast ~120ms) ──
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
              'Access-Control-Allow-Origin': '*',
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

    // ── Tier 2: ElevenLabs Turbo v2.5 Fallback (Neural HD Multilingual) ──
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
              'Access-Control-Allow-Origin': '*',
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
    return c.json({ error: 'TTS processing failed', message: err.message }, 500)
  }
})

// ─────────────────────────────────────────────
// 1. EMBEDDINGS (Workers AI)
// ─────────────────────────────────────────────
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
    return c.json({ error: 'Failed to generate embeddings', message: err.message }, 500)
  }
})

// ─────────────────────────────────────────────
// 2. STT (Audio Transcription with 5-Key Whisper + Deepgram Fallback)
// ─────────────────────────────────────────────
app.post('/gateway/stt', async (c) => {
  const userApiKey = c.req.header('x-user-api-key')
  const allKeys = userApiKey && userApiKey.trim().startsWith('gsk_')
    ? [userApiKey.trim(), ...extractGroqKeys(c.env)]
    : extractGroqKeys(c.env)

  const orderedKeys = getOrderedKeys(allKeys)

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

  // 1. Try Groq Whisper rotation across all 5 keys
  for (let i = 0; i < orderedKeys.length; i++) {
    const apiKey = orderedKeys[i]
    const keyId = apiKey.slice(0, 10) + '...'

    const formData = new FormData()
    formData.append('file', audioBlob, 'recording.wav')
    formData.append('model', requestedModel || 'whisper-large-v3-turbo')
    if (language && language !== 'auto') {
      formData.append('language', language.split('-')[0])
    }
    if (prompt) {
      formData.append('prompt', prompt.slice(-400))
    }

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
        return c.json({ text: data.text || '' }, 200, {
          'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
          'Access-Control-Allow-Credentials': 'true'
        })
      }

      const errText = await res.text().catch(() => '')
      console.warn(`[Gateway STT] Key ${keyId} returned ${res.status}: ${errText.substring(0, 120)}`)

      // Put key in cooldown on rate limits or server errors and immediately try next key
      if (res.status === 429 || res.status === 401 || res.status >= 500) {
        markKeyCooldown(apiKey, 45000)
        continue
      }
    } catch (err: any) {
      console.error(`[Gateway STT] Error on key ${keyId}:`, err.message)
      markKeyCooldown(apiKey, 15000)
    }
  }

  // 2. Fallback to Deepgram STT if all Groq Whisper keys are exhausted
  const deepgramKey = c.env.DEEPGRAM_STT_KEY || 'f4e051a4656912a23e451ffd65132e529b2b4575'
  if (deepgramKey) {
    try {
      console.log('[Gateway STT] Falling back to Deepgram Nova-2 STT...')
      const arrayBuf = await audioBlob.arrayBuffer()
      const dgRes = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&encoding=linear16', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${deepgramKey}`,
          'Content-Type': audioBlob.type || 'audio/wav'
        },
        body: arrayBuf
      })

      if (dgRes.ok) {
        const dgData = await dgRes.json() as any
        const transcript = dgData.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
        return c.json({ text: transcript })
      }
    } catch (dgErr: any) {
      console.error('[Gateway STT] Deepgram fallback failed:', dgErr.message)
    }
  }

  return c.json({ error: 'All STT providers failed or rate-limited' }, 503)
})

// ─────────────────────────────────────────────
// 3. LLM (Answer Generation with 5-Key openai/gpt-oss-120b Pool)
// ─────────────────────────────────────────────
app.post('/gateway/llm', async (c) => {
  const userApiKey = c.req.header('x-user-api-key')
  const allKeys = userApiKey && userApiKey.trim().startsWith('gsk_')
    ? [userApiKey.trim(), ...extractGroqKeys(c.env)]
    : extractGroqKeys(c.env)

  const orderedKeys = getOrderedKeys(allKeys)

  let rawBody: any
  try {
    rawBody = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // Strictly enforce openai/gpt-oss-120b (NO Llama model)
  const model = 'openai/gpt-oss-120b'
  const payload = {
    ...rawBody,
    model,
    max_tokens: Math.min(rawBody.max_tokens || 1600, 1600) // Ample token headroom for full complete answers
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

            // If content was in reasoning block, populate content
            if (!content && reasoning) {
              content = reasoning.replace(/<think>[\s\S]*?<\/think>\n?/gi, '').trim()
            }

            data.choices[0].message.content = content
          }

          return c.json(data, 200, {
            'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
            'Access-Control-Allow-Credentials': 'true'
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
          markKeyCooldown(apiKey, cooldownMs)
          lastError = { status: res.status, body: errText }
          continue // instantly try next key
        }

        lastError = { status: res.status, body: errText }
      } catch (err: any) {
        console.error(`[Gateway LLM] Network error on key ${keyId}:`, err.message)
        markKeyCooldown(apiKey, 5000)
        lastError = err
      }
    }
  }

  return c.json({
    error: 'All Groq provider keys exhausted or rate-limited for openai/gpt-oss-120b',
    details: lastError?.body || lastError?.message || lastError
  }, 503)
})

// ─────────────────────────────────────────────
// 4. VISION (Gemini Vision Pipeline)
// ─────────────────────────────────────────────
app.post('/gateway/vision', async (c) => {
  try {
    const rawBody = await c.req.json() as any
    const messages = rawBody.messages || []

    let promptText = 'Look at this screenshot. Identify ANY interview question visible (coding, MCQ, behavioral, HR, technical). Provide the answer the candidate should say out loud.'
    let base64Data = ''
    let mimeType = 'image/png'

    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) promptText = part.text
          if (part.type === 'image_url' && part.image_url?.url) {
            const url = part.image_url.url
            let rawBase64 = url
            if (url.includes(';base64,')) {
              mimeType = url.split(';')[0].replace('data:', '')
              rawBase64 = url.split(';base64,')[1]
            } else if (url.includes(',')) {
              rawBase64 = url.split(',')[1]
            }
            base64Data = rawBase64.trim()
          }
        }
      } else if (typeof msg.content === 'string') {
        promptText = msg.content
      }
    }

    const GEMINI_API_KEY = c.env.GEMINI_API_KEY || 'AIzaSyBSy8zZTzkjifdTq0ChJTmk1JsFJ4VARGA'
    const systemInstruction = messages.find((m: any) => m.role === 'system')?.content || ''

    const parts: any[] = [{ text: promptText }]
    if (base64Data) {
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      })
    }

    const payload = {
      system_instruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
      contents: [{ parts }],
      generationConfig: {
        maxOutputTokens: rawBody.max_tokens || 1024,
        temperature: 0.2
      }
    }

    const endpoints = [
      { url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`, model: 'gemini-3.5-flash-lite' },
      { url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`, model: 'gemini-3.5-flash' },
      { url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`, model: 'gemini-2.5-flash-lite' },
      { url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`, model: 'gemini-flash-latest' }
    ]

    let res: Response | null = null
    let lastError: any = null
    let usedModel = 'gemini-3.5-flash-lite'

    for (const endpoint of endpoints) {
      try {
        const tempRes = await fetch(endpoint.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000) // 15s per-model timeout for vision processing
        })
        if (tempRes.ok) {
          res = tempRes
          usedModel = endpoint.model
          break
        } else {
          lastError = await tempRes.json().catch(() => ({}))
          console.warn(`[Vision] ${endpoint.model} failed:`, lastError?.error?.message)
        }
      } catch (err) {
        lastError = err
        console.warn(`[Vision] ${endpoint.model} timed out or failed:`, (err as any)?.message || err)
      }
    }

    if (!res || !res.ok) {
      console.error('[Gemini Vision Error]', lastError)
      return c.json({ error: 'Gemini Vision failed', details: lastError?.error?.message || JSON.stringify(lastError) }, 400)
    }

    const data = await res.json() as any
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from Gemini.'

    return c.json({
      id: 'chatcmpl-gemini-vision-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: usedModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: responseText
          },
          finish_reason: 'stop'
        }
      ]
    })
  } catch (err: any) {
    console.error('[Vision Error]', err)
    return c.json({ error: 'Vision processing failed', message: err.message }, 500)
  }
})

// ─────────────────────────────────────────────
// 5. HELPER FUNCTIONS FOR QUESTION GENERATOR & ANALYZE
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// 6. ANALYZE (Resume Parser, Question Generator, Answer Evaluator)
// ─────────────────────────────────────────────
app.post('/gateway/analyze', async (c) => {
  const userApiKey = c.req.header('x-user-api-key')
  const allKeys = userApiKey && userApiKey.trim().startsWith('gsk_')
    ? [userApiKey.trim(), ...extractGroqKeys(c.env)]
    : extractGroqKeys(c.env)

  const orderedKeys = getOrderedKeys(allKeys)
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
          markKeyCooldown(apiKey, 45000)
          lastError = { status: res.status, body: errText }
          continue
        }
      }
    } catch (err: any) {
      console.error(`[Analyze] Network error on key ${keyId}:`, err.message)
      markKeyCooldown(apiKey, 15000)
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

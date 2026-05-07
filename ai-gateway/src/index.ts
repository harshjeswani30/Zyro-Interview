import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { buildQuestionGeneratorPrompt } from './prompts/questionGenerator'
import { getRelevantExamplesFromBank } from './data/questionBank'

type ServiceType = 'stt' | 'llm' | 'vision' | 'tts'

interface Provider {
  name: string
  service: ServiceType
  apiKey: string
  apiUrl: string
  activeRequests: number
  status: 'healthy' | 'cooldown'
  cooldownUntil: number
  enforcedModel?: string
}

interface RequestContent {
  type: 'json' | 'form' | 'raw'
  data: Record<string, unknown> | FormData | ArrayBuffer
  headers: Headers
}

interface Env {
  GROQ_WHISPER_KEY_1: string
  GROQ_WHISPER_KEY_2: string
  DEEPGRAM_STT_KEY: string
  GROQ_LLAMA_KEY_1: string
  GROQ_LLAMA_KEY_2: string
  OPENROUTER_KEY: string
}

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return 'https://www.zyro-ai.in'
    if (origin.endsWith('zyro-ai.in') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return origin
    }
    return 'https://www.zyro-ai.in'
  },
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-user-api-key'],
  maxAge: 86400,
  credentials: true,
}))

// Explicitly handle all OPTIONS requests for preflight
app.options('*', (c) => {
  return c.text('', 204, {
    'Access-Control-Allow-Origin': c.req.header('Origin') || 'https://www.zyro-ai.in',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-api-key',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  })
})

// Custom 404 to ensure CORS headers even on missing routes
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404, {
    'Access-Control-Allow-Origin': c.req.header('Origin') || 'https://www.zyro-ai.in',
    'Access-Control-Allow-Credentials': 'true',
  })
})

// Global error handler to preserve CORS
app.onError((err, c) => {
  console.error('[Global Error]', err)
  return c.json({ error: 'Internal Server Error', message: err.message }, 500, {
    'Access-Control-Allow-Origin': c.req.header('Origin') || 'https://www.zyro-ai.in',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-api-key',
    'Access-Control-Allow-Credentials': 'true'
  })
})


// In-memory provider registry
// Since Workers are stateless per request, we use a global variable 
// to keep track as long as the isolate stays alive. 
// For high concurrency, some data might drift, but this is acceptable 
// for a lightweight routing layer.
let providers: Provider[] = []

function initializeProviders(env: Env) {
  // Always refresh provider definitions to ensure latest model strings are picked up after deploy
  providers = [
    {
      name: 'groq_whisper_1',
      service: 'stt',
      apiKey: env.GROQ_WHISPER_KEY_1,
      apiUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
      activeRequests: 0,
      status: 'healthy',
      cooldownUntil: 0,
      enforcedModel: 'whisper-large-v3'
    },
    {
      name: 'groq_whisper_2',
      service: 'stt',
      apiKey: env.GROQ_WHISPER_KEY_2,
      apiUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
      activeRequests: 0,
      status: 'healthy',
      cooldownUntil: 0,
      enforcedModel: 'whisper-large-v3'
    },
    {
      name: 'deepgram_stt',
      service: 'stt',
      apiKey: env.DEEPGRAM_STT_KEY,
      apiUrl: 'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true',
      activeRequests: 0,
      status: 'healthy',
      cooldownUntil: 0
    },
    {
      name: 'groq_llama_1',
      service: 'llm',
      apiKey: env.GROQ_LLAMA_KEY_1,
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      activeRequests: 0,
      status: 'healthy',
      cooldownUntil: 0,
      enforcedModel: 'llama-3.3-70b-versatile'  // Text/chat model
    },
    {
      name: 'groq_llama_2',
      service: 'llm',
      apiKey: env.GROQ_LLAMA_KEY_2,
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      activeRequests: 0,
      status: 'healthy',
      cooldownUntil: 0,
      enforcedModel: 'llama-3.3-70b-versatile'  // Text/chat model
    },
    {
      name: 'openrouter_llm',
      service: 'llm',
      apiKey: env.OPENROUTER_KEY,
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      activeRequests: 0,
      status: 'healthy',
      cooldownUntil: 0,
      // User requested Gemma model on OpenRouter
      enforcedModel: 'google/gemma-4-31b-it:free'
    },
    {
      name: 'groq_vision_1',
      service: 'vision',
      apiKey: env.GROQ_LLAMA_KEY_1,
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      activeRequests: 0,
      status: 'healthy',
      cooldownUntil: 0,
      enforcedModel: 'meta-llama/llama-4-scout-17b-16e-instruct'  // Vision/screen analysis model
    },
    {
      name: 'groq_vision_2',
      service: 'vision',
      apiKey: env.GROQ_LLAMA_KEY_2,
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      activeRequests: 0,
      status: 'healthy',
      cooldownUntil: 0,
      enforcedModel: 'meta-llama/llama-4-scout-17b-16e-instruct'  // Vision/screen analysis model (failover)
    }
  ]
}

function getBestProvider(service: ServiceType): Provider | null {
  const now = Date.now()
  
  // Filter and update health status
  const available = providers.filter(p => {
    if (p.service !== service) return false
    
    if (p.status === 'cooldown' && now > p.cooldownUntil) {
      p.status = 'healthy'
    }
    
    return p.status === 'healthy'
  })

  if (available.length === 0) return null

  // Sort by active requests
  return available.sort((a, b) => a.activeRequests - b.activeRequests)[0]
}

async function forwardRequest(provider: Provider, content: RequestContent, method: string): Promise<Response> {
  provider.activeRequests++
  
  try {
    const headers = new Headers()
    
    // Set provider specific auth
    const userApiKey = content.headers.get('x-user-api-key')
    const apiKey = (userApiKey && userApiKey.trim() !== '') ? userApiKey : provider.apiKey
    
    if (apiKey) {
      const prefix = provider.name === 'deepgram_stt' ? 'Token' : 'Bearer'
      headers.set('Authorization', `${prefix} ${apiKey}`)
    }

    if (provider.name === 'openrouter_llm') {
      headers.set('HTTP-Referer', 'https://ai-assistant.local')
      headers.set('X-Title', 'AI Assistant')
    }

    let body: string | FormData | ArrayBuffer | Blob = content.data as any
    const contentType = content.headers.get('Content-Type')
    if (contentType) headers.set('Content-Type', contentType)
    
    // Specialized handling for Deepgram (expects binary body, not multipart)
    if (provider.name === 'deepgram_stt' && content.type === 'form') {
      const formData = content.data as FormData
      let audioBlob: Blob | undefined
      for (const value of formData.values()) {
        if (value instanceof Blob) {
          audioBlob = value
          break
        }
      }
      if (audioBlob) {
        body = await audioBlob.arrayBuffer()
        headers.set('Content-Type', audioBlob.type || 'audio/wav')
      }
    } else if (provider.enforcedModel) {
      if (content.type === 'json') {
        const json = { ...(content.data as Record<string, unknown>) }
        json.model = provider.enforcedModel
        body = JSON.stringify(json)
        headers.set('Content-Type', 'application/json')
      } else if (content.type === 'form') {
        const incomingFormData = content.data as FormData
        const formData = new FormData()
        for (const [key, value] of incomingFormData.entries()) {
          if (value instanceof Blob) {
            formData.append(key, value, 'audio.wav')
          } else {
            formData.append(key, String(value))
          }
        }
        formData.set('model', provider.enforcedModel)
        body = formData
        // Let fetch set the boundary for multipart
        headers.delete('Content-Type')
      }
    } else { // standard passthrough for others
      if (content.type === 'json') {
        body = JSON.stringify(content.data)
      } else {
        body = content.data as FormData
        headers.delete('Content-Type')
      }
    }

    const response = await fetch(provider.apiUrl, {
      method: method,
      headers: headers,
      body: body,
      // @ts-ignore - Cloudflare dynamic body support
      duplex: 'half' 
    })

    // If successful and STT, attempt to normalize the response format
    if (!response.ok) {
      const errorText = await response.clone().text()
      console.error(`[Gateway] Provider ${provider.name} Error ${response.status}:`, errorText)
    }
    if (response.ok && provider.service === 'stt') {
      const data = await response.json() as any
      let normalizedText = ''
      
      if (data.text) {
        normalizedText = data.text
      } else if (data.results?.channels?.[0]?.alternatives?.[0]?.transcript) {
        // Deepgram format
        normalizedText = data.results.channels[0].alternatives[0].transcript
      } else if (data.transcript) {
        // Common fallback
        normalizedText = data.transcript
      }
      
      return new Response(JSON.stringify({ text: normalizedText }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // If we get an error status (including 401/403 meaning invalid key, or 429/500/404)
    if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500 || response.status === 404) {
      console.warn(`[Gateway] Provider ${provider.name} returned ${response.status}. Retrying...`)
      // For auth errors or rate limits, put in cooldown
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        provider.status = 'cooldown'
        provider.cooldownUntil = Date.now() + 60000 // 1 minute cooldown
      }
      throw new Error(`Provider ${provider.name} failed with status ${response.status}`)
    }

    return response
  } finally {
    provider.activeRequests--
  }
}

async function parseRequest(req: Request): Promise<RequestContent> {
  const contentType = req.headers.get('Content-Type') || ''
  const headers = new Headers(req.headers)
  
  if (contentType.includes('application/json')) {
    const data = await req.json()
    return { type: 'json', data, headers }
  } else if (contentType.includes('multipart/form-data')) {
    const data = await req.formData()
    return { type: 'form', data, headers }
  } else {
    // For raw audio or other streams
    const data = await req.arrayBuffer()
    return { type: 'raw', data, headers }
  }
}

app.get('/', (c) => c.json({ status: 'alive', message: 'AI Gateway is running. Use /gateway/stt or /gateway/llm' }))
app.get('/gateway', (c) => {
  initializeProviders(c.env)
  return c.json({ 
    status: 'healthy', 
    providers: providers.map(p => ({ 
      name: p.name, 
      service: p.service, 
      status: p.status,
      activeRequests: p.activeRequests,
      enforcedModel: p.enforcedModel
    })) 
  })
})

app.post('/gateway/stt', async (c) => {
  initializeProviders(c.env)
  
  const content = await parseRequest(c.req.raw)
  let attempts = 0
  const maxAttempts = 3
  
  while (attempts < maxAttempts) {
    const provider = getBestProvider('stt')
    if (!provider) {
      return c.json({ error: 'No healthy STT providers available' }, 503)
    }

    try {
      return await forwardRequest(provider, content, c.req.method)
    } catch (e) {
      attempts++
      provider.status = 'cooldown'
      provider.cooldownUntil = Date.now() + 30000 // 30 second cooldown
      console.error(`Attempt ${attempts} failed for ${provider.name}: ${e}`)
    }
  }

  return c.json({ error: 'Max retry attempts reached for STT' }, 503)
})

app.post('/gateway/llm', async (c) => {
  initializeProviders(c.env)

  const content = await parseRequest(c.req.raw)
  let attempts = 0
  const maxAttempts = 4

  while (attempts < maxAttempts) {
    const provider = getBestProvider('llm')
    if (!provider) {
      return c.json({ error: 'No healthy LLM providers available' }, 503)
    }

    try {
      return await forwardRequest(provider, content, c.req.method)
    } catch (e) {
      attempts++
      provider.status = 'cooldown'
      provider.cooldownUntil = Date.now() + 30000 // 30 second cooldown
      console.error(`Attempt ${attempts} failed for ${provider.name}: ${e}`)
    }
  }

  return c.json({ error: 'Max retry attempts reached for LLM' }, 503)
})

app.post('/gateway/tts', async (c) => {
  initializeProviders(c.env)
  const content = await parseRequest(c.req.raw)
  const provider = getBestProvider('tts')
  if (!provider) return c.json({ error: 'No TTS providers available' }, 503)
  
  try {
    return await forwardRequest(provider, content, c.req.method)
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

app.post('/gateway/vision', async (c) => {
  initializeProviders(c.env)

  const content = await parseRequest(c.req.raw)
  let attempts = 0
  const maxAttempts = 2

  while (attempts < maxAttempts) {
    const provider = getBestProvider('vision')
    if (!provider) {
      return c.json({ error: 'No healthy vision providers available' }, 503)
    }

    try {
      return await forwardRequest(provider, content, c.req.method)
    } catch (e) {
      attempts++
      provider.status = 'cooldown'
      provider.cooldownUntil = Date.now() + 30000
      console.error(`Attempt ${attempts} failed for ${provider.name}: ${e}`)
    }
  }

  return c.json({ error: 'Max retry attempts reached for Vision' }, 503)
})

function tryParseJsonObject(raw: string): any | null {
  try {
    return JSON.parse(raw)
  } catch {
    // Try extracting the first JSON object if model wrapped content.
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

app.post('/gateway/analyze', async (c) => {
  initializeProviders(c.env)
  const { task, context } = await c.req.json()
  const provider = getBestProvider('llm')
  if (!provider) return c.json({ error: 'No LLM providers available' }, 503)

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
    prompt = `You are a professional AI Interview Coach. Evaluate the candidate's response based on the following context:
    
QUESTION: ${context.question_text}
CANDIDATE ANSWER: ${context.user_transcript}
EXPECTED KEYWORDS/TOPICS: ${context.expected_keywords}

SCORING CRITERIA (Rate each 1-5):
1. RELEVANCE: Did the candidate directly address the question?
2. STRUCTURE: Was the answer logical and well-organized (e.g., STAR method)?
3. DEPTH: Did they demonstrate sufficient technical or role-specific knowledge?
4. COMMUNICATION: Was the articulation clear and professional?
5. KEYWORDS: Did they use industry-standard terminology and expected keywords?

RETURN STRICTLY JSON OBJECT:
{
  "score": number (0-100, overall performance index),
  "feedback": "2-3 sentences summarizing the overall performance for this specific answer",
  "metrics": {
    "relevance": number (1-5),
    "structure": number (1-5),
    "depth": number (1-5),
    "communication": number (1-5),
    "keywords": number (1-5)
  },
  "improvements": ["Specific improvement 1", "Specific improvement 2", "Specific improvement 3"]
}`
  } else {
    return c.json({ error: 'Invalid task' }, 400)
  }

  let llmContent = ''
  let attempts = 0
  const maxAttempts = 4 // enough to try all LLM providers in the pool

  // Build a synthetic RequestContent so forwardRequest handles auth, model injection, etc.
  const userApiKey = c.req.header('x-user-api-key') ?? ''
  const syntheticHeaders = new Headers()
  if (userApiKey) syntheticHeaders.set('x-user-api-key', userApiKey)
  syntheticHeaders.set('Content-Type', 'application/json')

  while (attempts < maxAttempts) {
    const llmProvider = getBestProvider('llm')
    if (!llmProvider) {
      return c.json({ error: 'No healthy LLM providers available for analyze' }, 503)
    }

    const requestContent: RequestContent = {
      type: 'json',
      data: {
        messages: [{ role: 'user', content: prompt }],
        temperature: task === 'parse-resume' ? 0.1 : 0.25,
        response_format: { type: 'json_object' }
      },
      headers: syntheticHeaders
    }

    try {
      const response = await forwardRequest(llmProvider, requestContent, 'POST')
      if (!response.ok) {
        throw new Error(`LLM status ${response.status}`)
      }
      const data = await response.json() as { choices?: { message?: { content?: string } }[] }
      llmContent = data.choices?.[0]?.message?.content || ''
      if (!llmContent) throw new Error('No content from LLM')
      break // success — exit retry loop
    } catch (err) {
      attempts++
      console.error(`[Analyze] attempt ${attempts} failed for task "${task}" on provider "${llmProvider.name}":`, err)
      // forwardRequest already puts provider in cooldown on 401/403/429.
      // For other errors we also cooldown so we try a different provider next iteration.
      if (llmProvider.status !== 'cooldown') {
        llmProvider.status = 'cooldown'
        llmProvider.cooldownUntil = Date.now() + 30000
      }
      if (attempts >= maxAttempts) {
        return c.json({ error: `Failed to complete ${task} after ${maxAttempts} attempts` }, 500)
      }
    }
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

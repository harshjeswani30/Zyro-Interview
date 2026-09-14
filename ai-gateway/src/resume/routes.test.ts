/**
 * Route tests.
 *
 * These cover the three things the route layer actually decides, now that there is
 * no authentication in front of it:
 *
 *  - Input bounds. Every field here becomes prompt tokens, so an unbounded field
 *    is an unbounded bill. The rejections are cost control as much as validation.
 *  - The rate limiter, which is the only brake between the public internet and a
 *    paid OpenRouter key. Worth a test precisely because it is load-bearing.
 *  - Error mapping. A provider's error envelope can carry internal hostnames and
 *    request ids, and §44 says the user never sees them — so the assertions check
 *    what is *absent* from a response as much as what is present.
 *
 * OpenRouter is stubbed throughout; `openrouter.test.ts` covers the client itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resumeRoutes, type ResumeEnv } from './routes'

const KEY = 'sk-or-v1-fake-key-for-route-tests'
const ENV: ResumeEnv = { OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: 'test/model' }

/**
 * The rate limiter is module-level state keyed on client IP, shared by every test
 * in this file. Each request therefore gets its own IP, so one test cannot spend
 * another's allowance.
 */
let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `203.0.113.${ipCounter % 250}:${ipCounter}`
}

interface CallOptions {
  ip?: string
  /** Sent verbatim, for the "unreadable body" cases. */
  rawBody?: string
}

async function call(
  path: string,
  body?: unknown,
  options: CallOptions = {}
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const response = await resumeRoutes.request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': options.ip ?? freshIp()
      },
      body: options.rawBody ?? JSON.stringify(body ?? {})
    },
    ENV
  )
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Left empty; the assertions check `text` in that case.
  }
  return { status: response.status, json, text }
}

async function get(path: string, env: ResumeEnv = ENV): Promise<Record<string, unknown>> {
  const response = await resumeRoutes.request(path, {}, env)
  return (await response.json()) as Record<string, unknown>
}

/** A successful OpenRouter completion carrying `content`. */
function stubCompletion(content: string): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 42 } }), {
      status: 200
    })
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

function stubStatus(status: number, body: string): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(body, { status }))
  vi.stubGlobal('fetch', mock)
  return mock
}

/** Any upstream call in a bounds test is a bug: the route should have refused first. */
function stubForbidden(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => {
    throw new Error('the route called OpenRouter when it should have rejected the input')
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/* ── configuration endpoints ────────────────────────────────────────────────── */

describe('GET /health', () => {
  it('reports ready when a key and model are configured', async () => {
    expect(await get('/health')).toEqual({ status: 'ready', configured: true })
  })

  it('reports unconfigured rather than pretending, with no model name', async () => {
    // §69: an AI panel that looks live with no credential behind it is a fake feature.
    expect(await get('/health', {})).toEqual({ status: 'unconfigured', configured: false })
  })

  it('never includes key material', async () => {
    const body = JSON.stringify(await get('/health'))
    expect(body).not.toContain(KEY)
    expect(body).not.toContain('sk-or')
  })
})

describe('GET /config', () => {
  it('returns the model name, which is configuration rather than a secret', async () => {
    expect(await get('/config')).toEqual({
      ok: true,
      configured: true,
      model: 'test/model',
      hasFallback: false
    })
  })

  it('never includes key material', async () => {
    const body = JSON.stringify(await get('/config', { ...ENV, OPENROUTER_MODEL_FALLBACK: 'b/c' }))
    expect(body).not.toContain(KEY)
    expect(body).not.toContain('sk-or')
  })
})

/* ── input bounds ───────────────────────────────────────────────────────────── */

describe('request body handling', () => {
  it('rejects a body that is not JSON', async () => {
    const fetchMock = stubForbidden()
    const result = await call('/edit', undefined, { rawBody: 'not json at all' })
    expect(result.status).toBe(400)
    expect(result.json.error).toBe('We could not read that request.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a JSON array, which would slip past a plain typeof check', async () => {
    stubForbidden()
    const result = await call('/edit', undefined, { rawBody: '[{"instruction":"hi"}]' })
    expect(result.status).toBe(400)
    expect(result.json.error).toBe('We could not read that request.')
  })

  it('rejects a JSON null body', async () => {
    stubForbidden()
    expect((await call('/edit', undefined, { rawBody: 'null' })).status).toBe(400)
  })
})

describe('POST /edit bounds', () => {
  it('asks for an instruction rather than sending an empty prompt', async () => {
    const fetchMock = stubForbidden()
    const result = await call('/edit', { resume: {}, instruction: '   ' })
    expect(result.status).toBe(400)
    expect(result.json.error).toBe('Tell Zyro what you would like to change.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires a resume object', async () => {
    stubForbidden()
    const result = await call('/edit', { instruction: 'improve my summary' })
    expect(result.status).toBe(400)
    expect(result.json.error).toContain('could not read your resume')
  })

  it('refuses a resume too large to prompt with, and says what to do about it', async () => {
    const fetchMock = stubForbidden()
    // Just over the 80k serialized ceiling.
    const result = await call('/edit', {
      instruction: 'improve everything',
      resume: { summary: 'x'.repeat(80_100) }
    })
    expect(result.status).toBe(413)
    expect(result.json.error).toContain('too large')
    // The user is told to trim older roles, not handed a limit in bytes.
    expect(result.json.error).toContain('trimming')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /import bounds', () => {
  it('explains the scanned-PDF case instead of asking the model to guess', async () => {
    const fetchMock = stubForbidden()
    const result = await call('/import', { text: 'Ana Diaz\nEngineer' })
    expect(result.status).toBe(422)
    expect(result.json.error).toContain('scanned image')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('collapses extraction whitespace before it becomes prompt tokens', async () => {
    const fetchMock = stubCompletion('{"personal":{"fullName":"Ana Diaz"}}')
    const messy = `ANA DIAZ${' '.repeat(40)}engineer\n\n\n\n\nEXPERIENCE${' '.repeat(30)}Google\n${'- did a thing that is long enough to clear the minimum length check\n'.repeat(3)}`
    const result = await call('/import', { text: messy })
    expect(result.status).toBe(200)

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      messages: { content: string }[]
    }
    // Only the delimited extraction, not the surrounding instructions — the prompt
    // template has its own aligned JSON shape and is allowed runs of spaces.
    const prompt = sent.messages.map((m) => m.content).join('\n')
    const extracted = /EXTRACTED TEXT:\n=====\n([\s\S]*?)\n=====/.exec(prompt)?.[1] ?? ''
    expect(extracted).not.toBe('')
    expect(extracted).not.toContain('   ')
    expect(extracted).not.toContain('\n\n\n')
    // The content itself survives the tidying.
    expect(extracted).toContain('ANA DIAZ')
    expect(extracted).toContain('Google')
  })
})

describe('POST /job and /ats bounds', () => {
  it('asks for more of the job description rather than analysing a fragment', async () => {
    stubForbidden()
    const result = await call('/job', { jobDescription: 'Senior engineer needed' })
    expect(result.status).toBe(400)
    expect(result.json.error).toContain('bit more')
  })

  it('will not score an empty resume', async () => {
    stubForbidden()
    const result = await call('/ats', { resumeText: 'Ana Diaz' })
    expect(result.status).toBe(400)
    expect(result.json.error).toContain('Add some content')
  })
})

describe('POST /rewrite', () => {
  it('requires something to rewrite', async () => {
    stubForbidden()
    const result = await call('/rewrite', { text: '   ', mode: 'improve' })
    expect(result.status).toBe(400)
    expect(result.json.error).toBe('Select some text to rewrite.')
  })

  it('falls back to improve for an unrecognised mode instead of erroring', async () => {
    // A stale client sending an old mode name should still get a useful answer.
    stubCompletion('{"text":"Owned the billing service","changed":true}')
    const result = await call('/rewrite', { text: 'Responsible for billing', mode: 'make-it-pop' })
    expect(result.status).toBe(200)
    expect((result.json.data as { text: string }).text).toBe('Owned the billing service')
  })
})

/* ── success envelope ───────────────────────────────────────────────────────── */

describe('successful responses', () => {
  it('returns parsed data with the model that answered', async () => {
    stubCompletion('{"action":"update_resume","message":"Tightened it.","operations":[]}')
    const result = await call('/edit', { instruction: 'tighten my summary', resume: { summary: 'hi' } })
    expect(result.status).toBe(200)
    expect(result.json.ok).toBe(true)
    expect(result.json.model).toBe('test/model')
    expect(result.json.data).toMatchObject({ action: 'update_resume', message: 'Tightened it.' })
  })

  it('recovers the fenced snake_case shape the configured model really returns', async () => {
    // End-to-end proof that parseJsonLoose and normalizeKeys are wired into the route.
    stubCompletion('```json\n{"required_keywords":["Go"],"preferred_keywords":[]}\n```')
    const result = await call('/job', {
      jobDescription: 'We need a senior backend engineer with strong Go and Kubernetes experience.'
    })
    expect(result.status).toBe(200)
    expect(result.json.data).toEqual({ requiredKeywords: ['Go'], preferredKeywords: [] })
  })

  it('never echoes the API key back to the caller', async () => {
    stubCompletion('{"text":"Owned billing","changed":true}')
    const result = await call('/rewrite', { text: 'Responsible for billing', mode: 'impact' })
    expect(result.text).not.toContain(KEY)
    expect(result.text).not.toContain('sk-or')
  })
})

/* ── failure mapping ────────────────────────────────────────────────────────── */

describe('failure mapping', () => {
  it('answers 503 when the server has no credential, without calling out', async () => {
    const fetchMock = stubForbidden()
    const response = await resumeRoutes.request(
      '/edit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': freshIp() },
        body: JSON.stringify({ instruction: 'help', resume: { summary: 'hi' } })
      },
      {} // no key, no model
    )
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string; failure: string }
    expect(body.failure).toBe('not-configured')
    expect(body.error).toContain('not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 502 for a rejected provider key and leaks nothing about it', async () => {
    // The kind of payload a provider really returns, internal detail and all.
    stubStatus(401, '{"error":{"message":"No auth credentials found","metadata":{"host":"internal-lb-7.openrouter.internal","request_id":"req_9f2"}}}')
    const result = await call('/edit', { instruction: 'help', resume: { summary: 'hi' } })

    expect(result.status).toBe(502)
    expect(result.json.error).toBe('Resume AI could not authenticate with its provider. Contact support.')
    // §44: none of the provider's envelope reaches the user.
    expect(result.text).not.toContain('internal-lb-7')
    expect(result.text).not.toContain('req_9f2')
    expect(result.text).not.toContain('No auth credentials')
  })

  it('turns an empty provider balance into a message support can act on', async () => {
    stubStatus(402, '{"error":{"message":"Insufficient credits"}}')
    const result = await call('/ats', {
      resumeText: 'Ana Diaz. Senior Backend Engineer at Google, responsible for the billing service.',
      localScore: 61
    })
    expect(result.status).toBe(502)
    expect(result.json.error).toContain('run out of provider credit')
  })

  it('answers 429 after exhausting its retries on a rate limit', async () => {
    vi.useFakeTimers()
    const fetchMock = stubStatus(429, '{"error":{"message":"rate limited"}}')

    const pending = call('/rewrite', { text: 'Responsible for billing', mode: 'improve' })
    // The rewrite route's 60s budget covers the 1500/4000ms delays but not the 8000ms one.
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await pending

    expect(result.status).toBe(429)
    expect(result.json.failure).toBe('rate-limited')
    expect(result.json.error).toContain('busy right now')
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('answers 502 with "Nothing was changed" when the model returns unusable text', async () => {
    stubCompletion('I would love to help but I cannot produce JSON today.')
    const result = await call('/edit', { instruction: 'help', resume: { summary: 'hi' } })
    expect(result.status).toBe(502)
    expect(result.json.failure).toBe('invalid-json')
    // The client applies nothing on this path, and the message says so.
    expect(result.json.error).toContain('Nothing was changed')
  })
})

/* ── rate limiting ──────────────────────────────────────────────────────────── */

describe('rate limiting', () => {
  beforeEach(() => {
    stubCompletion('{"text":"Owned billing","changed":true}')
  })

  it('allows a burst and then refuses, telling the caller to wait', async () => {
    const ip = `198.51.100.${ipCounter++}`
    const statuses: number[] = []
    for (let i = 0; i < 27; i++) {
      statuses.push((await call('/rewrite', { text: 'Responsible for billing' }, { ip })).status)
    }
    // 25 per minute, so the 26th is the first refusal.
    expect(statuses.slice(0, 25).every((s) => s === 200)).toBe(true)
    expect(statuses[25]).toBe(429)
    expect(statuses[26]).toBe(429)

    const refused = await call('/rewrite', { text: 'Responsible for billing' }, { ip })
    expect(refused.json.error).toContain('Give it a minute')
  })

  it('counts each caller separately', async () => {
    const noisy = `198.51.100.200`
    for (let i = 0; i < 26; i++) {
      await call('/rewrite', { text: 'Responsible for billing' }, { ip: noisy })
    }
    expect((await call('/rewrite', { text: 'Responsible for billing' }, { ip: noisy })).status).toBe(429)
    // A different IP is untouched by the first one's spending.
    expect(
      (await call('/rewrite', { text: 'Responsible for billing' }, { ip: '198.51.100.201' })).status
    ).toBe(200)
  })

  it('applies across routes, because they all spend the same key', async () => {
    const ip = '198.51.100.210'
    for (let i = 0; i < 25; i++) {
      await call('/rewrite', { text: 'Responsible for billing' }, { ip })
    }
    const other = await call('/job', {
      jobDescription: 'We need a senior backend engineer with strong Go and Kubernetes experience.'
    }, { ip })
    expect(other.status).toBe(429)
  })

  it('checks the limit before parsing the body, so a huge payload is cheap to refuse', async () => {
    const ip = '198.51.100.220'
    for (let i = 0; i < 25; i++) {
      await call('/rewrite', { text: 'Responsible for billing' }, { ip })
    }
    const result = await call('/edit', undefined, { ip, rawBody: 'x'.repeat(200_000) })
    // 429 rather than the 400 an unparseable body would otherwise earn.
    expect(result.status).toBe(429)
  })
})

/* ── context bounds ─────────────────────────────────────────────────────────── */

describe('context bounds', () => {
  it('truncates a long selection instead of forwarding it whole', async () => {
    const fetchMock = stubCompletion('{"action":"reply","message":"ok","operations":[]}')
    await call('/edit', {
      instruction: 'make this stronger',
      resume: { summary: 'hi' },
      selection: { text: 'A'.repeat(9000), sectionKind: 'experience' }
    })

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      messages: { content: string }[]
    }
    const prompt = sent.messages.map((m) => m.content).join('\n')
    expect(prompt).toContain('A'.repeat(4000))
    expect(prompt).not.toContain('A'.repeat(4001))
  })

  it('keeps only the last few conversation turns', async () => {
    const fetchMock = stubCompletion('{"action":"reply","message":"ok","operations":[]}')
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `turn-number-${i}`
    }))
    await call('/edit', { instruction: 'and again', resume: { summary: 'hi' }, history })

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      messages: { content: string }[]
    }
    const prompt = sent.messages.map((m) => m.content).join('\n')
    // Six turns kept, so the earliest are gone and the latest survive.
    expect(prompt).not.toContain('turn-number-0')
    expect(prompt).not.toContain('turn-number-13')
    expect(prompt).toContain('turn-number-19')
  })

  it('drops non-string junk from keyword and change lists', async () => {
    const fetchMock = stubCompletion('{"action":"reply","message":"ok","operations":[]}')
    await call('/edit', {
      instruction: 'what should I add?',
      resume: { summary: 'hi' },
      missingKeywords: ['Kubernetes', null, 42, { nested: true }, '  Terraform  '],
      jobDescription: 'A long enough job description mentioning Go and Kubernetes for a senior role.'
    })

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      messages: { content: string }[]
    }
    const prompt = sent.messages.map((m) => m.content).join('\n')
    expect(prompt).toContain('Kubernetes')
    expect(prompt).toContain('Terraform')
    expect(prompt).not.toContain('[object Object]')
    expect(prompt).not.toContain('nested')
  })
})

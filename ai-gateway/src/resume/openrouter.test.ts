/**
 * OpenRouter client tests.
 *
 * Three things here are worth locking down with tests rather than trusting:
 *
 *  - JSON recovery and key normalization, because the configured model was observed
 *    returning fenced markdown with snake_case keys despite `strict: true`. These
 *    two functions are the only reason those responses validate at all.
 *  - Failure classification, because the difference between "retry" and "tell the
 *    user" is the difference between a hiccup and an error toast.
 *  - The retry schedule and the overall deadline, since a wrong schedule burns all
 *    the attempts inside one rate-limit window and looks like an outage.
 *
 * `classify` is not exported, so it is tested through `callOpenRouter` with a
 * stubbed `fetch` — which is the surface the routes actually use.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  callOpenRouter,
  configStatus,
  normalizeKeys,
  parseJsonLoose,
  repairTruncatedJson,
  resolveConfig,
  type ChatMessage,
  type OpenRouterEnv
} from './openrouter'

const KEY = 'sk-or-v1-fake-key-for-tests'

const ENV: OpenRouterEnv = { OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: 'test/model' }

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'user' }
]

const SCHEMA = { name: 'test', schema: { type: 'object' as const }, strict: false }

/* ── fetch stubbing ─────────────────────────────────────────────────────────── */

interface StubbedFetch {
  mock: ReturnType<typeof vi.fn>
  /** Parsed request bodies, in call order. */
  bodies: Record<string, unknown>[]
  /** Request init objects, in call order. */
  inits: RequestInit[]
}

/**
 * Stubs `fetch` with a scripted sequence of responses. The last entry repeats, so
 * a single-element script means "always answer this".
 */
function stubFetch(script: Array<(init: RequestInit) => Response | Promise<never>>): StubbedFetch {
  const bodies: Record<string, unknown>[] = []
  const inits: RequestInit[] = []
  let index = 0

  const mock = vi.fn(async (_url: string, init: RequestInit) => {
    inits.push(init)
    bodies.push(JSON.parse(init.body as string) as Record<string, unknown>)
    const next = script[Math.min(index, script.length - 1)]
    index++
    return next(init)
  })

  vi.stubGlobal('fetch', mock)
  return { mock, bodies, inits }
}

function completion(content: string, usage?: Record<string, number>): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200
  })
}

function errorResponse(status: number, body = '{"error":{"message":"nope"}}'): Response {
  return new Response(body, { status })
}

function abortError(): Promise<never> {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return Promise.reject(error)
}

/** Hangs until the caller's AbortController fires, the way a slow provider does. */
function hangsUntilAborted(init: RequestInit): Promise<never> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
}

/* ── config ─────────────────────────────────────────────────────────────────── */

describe('resolveConfig', () => {
  it('returns null unless both the key and the model are present', () => {
    expect(resolveConfig({})).toBeNull()
    expect(resolveConfig({ OPENROUTER_API_KEY: KEY })).toBeNull()
    expect(resolveConfig({ OPENROUTER_MODEL: 'a/b' })).toBeNull()
  })

  it('treats whitespace-only values as absent', () => {
    expect(resolveConfig({ OPENROUTER_API_KEY: '   ', OPENROUTER_MODEL: 'a/b' })).toBeNull()
    expect(resolveConfig({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: '  ' })).toBeNull()
  })

  it('trims values and applies defaults', () => {
    const config = resolveConfig({ OPENROUTER_API_KEY: ` ${KEY} `, OPENROUTER_MODEL: ' a/b ' })
    expect(config).not.toBeNull()
    expect(config?.apiKey).toBe(KEY)
    expect(config?.model).toBe('a/b')
    expect(config?.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(config?.appName).toBe('Zyro Resume AI')
    expect(config?.fallbackModel).toBeUndefined()
  })

  it('strips a trailing slash from an overridden base URL', () => {
    const config = resolveConfig({ ...ENV, OPENROUTER_BASE_URL: 'https://proxy.example.com/v1/' })
    expect(config?.baseUrl).toBe('https://proxy.example.com/v1')
  })

  it('ignores a blank fallback model rather than trying to call it', () => {
    expect(resolveConfig({ ...ENV, OPENROUTER_MODEL_FALLBACK: '  ' })?.fallbackModel).toBeUndefined()
  })
})

describe('configStatus', () => {
  it('reports readiness and the model without exposing the key', () => {
    const status = configStatus({ ...ENV, OPENROUTER_MODEL_FALLBACK: 'other/model' })
    expect(status).toEqual({ configured: true, model: 'test/model', hasFallback: true })
    // The health and config routes serialize this straight to the client.
    expect(JSON.stringify(status)).not.toContain(KEY)
    expect(JSON.stringify(status)).not.toContain('sk-or')
  })

  it('reports not-configured without inventing a model name', () => {
    expect(configStatus({})).toEqual({ configured: false, model: null, hasFallback: false })
  })
})

/* ── JSON recovery ──────────────────────────────────────────────────────────── */

describe('parseJsonLoose', () => {
  it('parses a clean object', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 })
  })

  it('recovers the fenced block the configured model actually returns', () => {
    // Verbatim shape of a real observed response, fence and all.
    const raw = '```json\n{\n  "name": "Ana Diaz",\n  "company": "Google"\n}\n```'
    expect(parseJsonLoose(raw)).toEqual({ name: 'Ana Diaz', company: 'Google' })
  })

  it('recovers a fence with no language tag', () => {
    expect(parseJsonLoose('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('recovers an object wrapped in prose', () => {
    expect(parseJsonLoose('Sure! {"a":1} Let me know if you need more.')).toEqual({ a: 1 })
  })

  it('handles nested braces without truncating', () => {
    const raw = 'Here: {"a":{"b":[1,2]},"c":"}"} done'
    expect(parseJsonLoose(raw)).toEqual({ a: { b: [1, 2] }, c: '}' })
  })

  it('returns null for anything that is not a JSON object', () => {
    expect(parseJsonLoose('')).toBeNull()
    expect(parseJsonLoose('   ')).toBeNull()
    expect(parseJsonLoose('I cannot help with that.')).toBeNull()
    expect(parseJsonLoose('null')).toBeNull()
    expect(parseJsonLoose('"a string"')).toBeNull()
    expect(parseJsonLoose('42')).toBeNull()
    expect(parseJsonLoose('```json\n{not valid}\n```')).toBeNull()
  })

  it('salvages an ATS review the token ceiling cut off mid-suggestion', () => {
    // The failure this was written for: `finish_reason: "length"` on the /ats route,
    // which yields JSON with no closing brace and therefore no parse at all.
    const raw =
      '{"jobRelevance":72,"contentQuality":58,"supportedMissingKeywords":["Go"],' +
      '"suggestions":[{"title":"Add outcomes","impact":"high"},{"title":"Quantify the bil'
    expect(parseJsonLoose(raw)).toEqual({
      jobRelevance: 72,
      contentQuality: 58,
      supportedMissingKeywords: ['Go'],
      // The half-written suggestion is dropped, not shown as if it were complete.
      suggestions: [{ title: 'Add outcomes', impact: 'high' }]
    })
  })

  it('salvages a truncated response that also opened a fence it never closed', () => {
    const raw = '```json\n{"jobRelevance":72,"contentQuality":58,"strengths":["Clear str'
    expect(parseJsonLoose(raw)).toEqual({ jobRelevance: 72, contentQuality: 58 })
  })
})

describe('repairTruncatedJson', () => {
  it('closes containers that were still open', () => {
    expect(repairTruncatedJson('{"a":{"b":1},"c":"partial')).toBe('{"a":{"b":1}}')
    expect(repairTruncatedJson('{"list":[{"x":1},{"y":2},{"z":')).toBe('{"list":[{"x":1},{"y":2}]}')
  })

  it('does not mistake a brace inside a string for structure', () => {
    // The rewind point must be the real comma, not one inside a quoted value.
    expect(repairTruncatedJson('{"note":"a } and a , inside","next":"cut')).toBe(
      '{"note":"a } and a , inside"}'
    )
  })

  it('respects an escaped quote', () => {
    expect(repairTruncatedJson('{"note":"say \\"hi\\"","next":"cut')).toBe('{"note":"say \\"hi\\""}')
  })

  it('refuses when nothing was ever completed', () => {
    // No comma and no closed container: there is no partial object worth keeping.
    expect(repairTruncatedJson('{"title":"half a titl')).toBeNull()
    expect(repairTruncatedJson('{')).toBeNull()
  })

  it('refuses input that is not a truncated container', () => {
    expect(repairTruncatedJson('I cannot help with that.')).toBeNull()
    expect(repairTruncatedJson('')).toBeNull()
    // Balanced but invalid is a different fault, and guessing at it would be wrong.
    expect(repairTruncatedJson('{not valid}')).toBeNull()
  })

  it('produces something JSON.parse actually accepts', () => {
    const raw =
      '{"scores":{"a":1,"b":2},"items":[{"t":"one"},{"t":"two"}],"tail":[1,2,3],"cut":{"deep":[{"k":'
    const repaired = repairTruncatedJson(raw)
    expect(repaired).not.toBeNull()
    expect(() => JSON.parse(repaired as string)).not.toThrow()
    expect(JSON.parse(repaired as string)).toEqual({
      scores: { a: 1, b: 2 },
      items: [{ t: 'one' }, { t: 'two' }],
      tail: [1, 2, 3]
    })
  })
})

describe('normalizeKeys', () => {
  it('rewrites snake_case and kebab-case keys to camelCase', () => {
    expect(normalizeKeys({ start_date: 'Mar 2021', 'end-date': 'Present' })).toEqual({
      startDate: 'Mar 2021',
      endDate: 'Present'
    })
  })

  it('leaves camelCase keys alone', () => {
    expect(normalizeKeys({ startDate: 'x', bullets: ['a'] })).toEqual({
      startDate: 'x',
      bullets: ['a']
    })
  })

  it('recurses through nested objects and arrays', () => {
    const input = {
      target_job_title: 'Engineer',
      experience: [{ start_date: '2021', tech_stack: ['Go'] }],
      ats_score: { keyword_match: 80 }
    }
    expect(normalizeKeys(input)).toEqual({
      targetJobTitle: 'Engineer',
      experience: [{ startDate: '2021', techStack: ['Go'] }],
      atsScore: { keywordMatch: 80 }
    })
  })

  it('never lets a rewritten key clobber one that was already correct', () => {
    // A model that emits both spellings must not lose the correct value.
    expect(normalizeKeys({ startDate: 'correct', start_date: 'duplicate' })).toEqual({
      startDate: 'correct'
    })
  })

  it('does not touch values — an operation path must survive intact', () => {
    const input = { operations: [{ type: 'set', path: '/experience/0/bullets/1', value: 'a_b c-d' }] }
    expect(normalizeKeys(input)).toEqual({
      operations: [{ type: 'set', path: '/experience/0/bullets/1', value: 'a_b c-d' }]
    })
  })

  it('passes primitives and null straight through', () => {
    expect(normalizeKeys(null)).toBeNull()
    expect(normalizeKeys('a_b')).toBe('a_b')
    expect(normalizeKeys(7)).toBe(7)
    expect(normalizeKeys([1, 'a_b'])).toEqual([1, 'a_b'])
  })

  it('handles a leading underscore without producing an empty key', () => {
    expect(normalizeKeys({ _private: 1, __double_under: 2 })).toEqual({
      Private: 1,
      DoubleUnder: 2
    })
  })
})

/* ── calling ────────────────────────────────────────────────────────────────── */

describe('callOpenRouter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reports a configuration error without making a request', async () => {
    const stub = stubFetch([() => completion('{}')])
    const result = await callOpenRouter({}, { messages: MESSAGES, jsonSchema: SCHEMA })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('not-configured')
    expect(result.message).toBe('Resume AI is not configured on the server yet. Contact support.')
    expect(stub.mock).not.toHaveBeenCalled()
  })

  it('returns parsed, key-normalized data on success', async () => {
    stubFetch([
      () => completion('{"action":"edit","start_date":"Mar 2021"}', { total_tokens: 120 })
    ])
    const result = await callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({ action: 'edit', startDate: 'Mar 2021' })
    expect(result.model).toBe('test/model')
    expect(result.usage?.total_tokens).toBe(120)
  })

  it('recovers a fenced response end to end', async () => {
    stubFetch([() => completion('```json\n{"message":"done","operations":[]}\n```')])
    const result = await callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({ message: 'done', operations: [] })
  })

  it('sends the key as a bearer token and never in the URL', async () => {
    const stub = stubFetch([() => completion('{}')])
    await callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })
    const [url, init] = stub.mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(url).not.toContain(KEY)
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(headers['X-Title']).toBe('Zyro Resume AI')
    expect(headers['HTTP-Referer']).toBe('https://zyro.ai')
  })

  it('requests structured output and never streams', async () => {
    const stub = stubFetch([() => completion('{}')])
    await callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonSchema: { name: 'zyro_test', schema: { type: 'object' }, strict: true },
      maxTokens: 1234,
      temperature: 0
    })
    const body = stub.bodies[0]
    expect(body.stream).toBe(false)
    expect(body.max_tokens).toBe(1234)
    expect(body.temperature).toBe(0)
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'zyro_test', strict: true, schema: { type: 'object' } }
    })
  })

  it('returns raw text when no JSON mode was requested', async () => {
    const stub = stubFetch([() => completion('Just prose.')])
    const result = await callOpenRouter<string>(ENV, { messages: MESSAGES })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toBe('Just prose.')
    expect(stub.bodies[0].response_format).toBeUndefined()
  })

  it('honours a per-call model override', async () => {
    const stub = stubFetch([() => completion('{}')])
    const result = await callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonObject: true,
      model: 'other/model'
    })
    expect(stub.bodies[0].model).toBe('other/model')
    expect(result.ok).toBe(true)
  })

  /* ── failure classification ── */

  it('treats 401 as unauthorized and does not retry', async () => {
    const stub = stubFetch([() => errorResponse(401)])
    const result = await callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('unauthorized')
    expect(result.retryable).toBe(false)
    expect(stub.mock).toHaveBeenCalledTimes(1)
  })

  it('turns 402 into a credit message rather than a generic auth error', async () => {
    stubFetch([() => errorResponse(402, '{"error":{"message":"insufficient credits"}}')])
    const result = await callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('Resume AI has run out of provider credit. Contact support.')
  })

  it('never leaks the provider payload or the key into the user-facing message', async () => {
    stubFetch([
      () => errorResponse(500, `{"error":{"message":"internal trace at 0x1234","key":"${KEY}"}}`)
    ])
    const result = await callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonSchema: SCHEMA,
      totalBudgetMs: 1
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('The AI service returned an error. Please try again.')
    expect(result.message).not.toContain(KEY)
    expect(result.message).not.toContain('0x1234')
    expect(result.detail).toBe('status 500')
  })

  it('reports an empty completion as such', async () => {
    stubFetch([() => completion('   ')])
    const result = await callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonSchema: SCHEMA,
      totalBudgetMs: 1
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('empty-response')
  })

  it('reports unparseable output and says nothing was changed', async () => {
    stubFetch([() => completion('I am afraid I cannot do that.')])
    const result = await callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonSchema: SCHEMA,
      totalBudgetMs: 1
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('invalid-json')
    expect(result.message).toContain('Nothing was changed')
  })

  it('classifies an aborted request as a timeout', async () => {
    stubFetch([abortError])
    const result = await callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonSchema: SCHEMA,
      totalBudgetMs: 1
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('timeout')
  })

  it('classifies a transport failure as a network error', async () => {
    stubFetch([() => Promise.reject(new Error('ECONNRESET'))])
    const result = await callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonSchema: SCHEMA,
      totalBudgetMs: 1
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('network')
  })

  it('reads an unknown model slug out of a 400 as a model problem', async () => {
    stubFetch([() => errorResponse(400, '{"error":{"message":"model not found"}}')])
    const result = await callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonObject: true,
      totalBudgetMs: 1
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('model-unavailable')
  })

  /* ── retries, backoff and the deadline ── */

  it('retries a rate limit and succeeds', async () => {
    vi.useFakeTimers()
    const stub = stubFetch([
      () => errorResponse(429),
      () => errorResponse(429),
      () => completion('{"ok":true}')
    ])
    const pending = callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending
    expect(result.ok).toBe(true)
    expect(stub.mock).toHaveBeenCalledTimes(3)
  })

  it('gives a rate limit the long schedule, not the fast one', async () => {
    vi.useFakeTimers()
    const stub = stubFetch([() => errorResponse(429), () => completion('{"ok":true}')])
    const pending = callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })

    // The observed upstream needed seconds to recover, so a rate limit must not be
    // retried inside the first second.
    await vi.advanceTimersByTimeAsync(1_400)
    expect(stub.mock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(stub.mock).toHaveBeenCalledTimes(2)
    await pending
  })

  it('gives a server error the fast schedule', async () => {
    vi.useFakeTimers()
    const stub = stubFetch([() => errorResponse(500), () => completion('{"ok":true}')])
    const pending = callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })

    await vi.advanceTimersByTimeAsync(400)
    expect(stub.mock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(stub.mock).toHaveBeenCalledTimes(2)
    const result = await pending
    expect(result.ok).toBe(true)
  })

  it('stops after four attempts on a persistent rate limit', async () => {
    vi.useFakeTimers()
    const stub = stubFetch([() => errorResponse(429)])
    const pending = callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('rate-limited')
    expect(stub.mock).toHaveBeenCalledTimes(4)
  })

  it('abandons retries rather than blowing the overall budget', async () => {
    // A user watching a spinner would rather be told to try again than wait out
    // four attempts of backoff.
    const stub = stubFetch([() => errorResponse(429)])
    const result = await callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonSchema: SCHEMA,
      totalBudgetMs: 200
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('rate-limited')
    expect(stub.mock).toHaveBeenCalledTimes(1)
  })

  it('clamps a single attempt to the remaining budget', async () => {
    // The import route originally asked for a 90s timeout inside a 90s budget,
    // which meant one attempt and a hard failure on a response that was merely
    // slow. The budget has to win over the per-attempt timeout.
    vi.useFakeTimers()
    const stub = stubFetch([hangsUntilAborted])
    const pending = callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonObject: true,
      timeoutMs: 600_000,
      totalBudgetMs: 5_000
    })
    await vi.advanceTimersByTimeAsync(6_000)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe('timeout')
    expect(stub.mock).toHaveBeenCalledTimes(1)
  })

  it('does not start an attempt it has no time to finish', async () => {
    vi.useFakeTimers()
    const stub = stubFetch([() => errorResponse(500)])
    const pending = callOpenRouter(ENV, {
      messages: MESSAGES,
      jsonSchema: SCHEMA,
      // Room for the 500ms backoff, but not for a meaningful second attempt after it.
      totalBudgetMs: 2_400
    })
    await vi.advanceTimersByTimeAsync(3_000)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(stub.mock).toHaveBeenCalledTimes(1)
  })

  /* ── degradation ── */

  it('downgrades to json_object mode when the provider rejects the schema', async () => {
    const stub = stubFetch([
      () => errorResponse(400, '{"error":{"message":"response_format json_schema not supported"}}'),
      () => completion('{"ok":true}')
    ])
    const result = await callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })
    expect(result.ok).toBe(true)
    expect(stub.mock).toHaveBeenCalledTimes(2)
    expect((stub.bodies[0].response_format as { type: string }).type).toBe('json_schema')
    expect(stub.bodies[1].response_format).toEqual({ type: 'json_object' })
  })

  it('does not downgrade twice — a second schema rejection is a real failure', async () => {
    const stub = stubFetch([
      () => errorResponse(400, '{"error":{"message":"response_format not supported"}}')
    ])
    const result = await callOpenRouter(ENV, { messages: MESSAGES, jsonSchema: SCHEMA })
    expect(result.ok).toBe(false)
    // One schema attempt, one downgraded attempt, then it stops. The downgrade path
    // does not sleep, so this needs no timers.
    expect(stub.mock).toHaveBeenCalledTimes(2)
  })

  it('falls back to the second model when the first is unroutable', async () => {
    vi.useFakeTimers()
    const stub = stubFetch([
      () => errorResponse(404, '{"error":{"message":"no endpoints for model"}}'),
      () => errorResponse(404, '{"error":{"message":"no endpoints for model"}}'),
      () => errorResponse(404, '{"error":{"message":"no endpoints for model"}}'),
      () => errorResponse(404, '{"error":{"message":"no endpoints for model"}}'),
      () => completion('{"ok":true}')
    ])
    const pending = callOpenRouter(
      { ...ENV, OPENROUTER_MODEL_FALLBACK: 'backup/model' },
      { messages: MESSAGES, jsonObject: true }
    )
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.model).toBe('backup/model')
    expect(stub.bodies[0].model).toBe('test/model')
    expect(stub.bodies[4].model).toBe('backup/model')
  })

  it('does not call the fallback when the primary fails unrecoverably', async () => {
    const stub = stubFetch([() => errorResponse(401)])
    await callOpenRouter(
      { ...ENV, OPENROUTER_MODEL_FALLBACK: 'backup/model' },
      { messages: MESSAGES, jsonObject: true }
    )
    // A bad key is a bad key for both models; retrying wastes the user's time.
    expect(stub.mock).toHaveBeenCalledTimes(1)
  })
})

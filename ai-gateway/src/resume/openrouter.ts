/**
 * Zyro Resume AI — the OpenRouter client.
 *
 * The single place in the system that holds the OpenRouter key and the single
 * place that talks to it (§17). Nothing in the browser bundle imports this file;
 * it only ever runs inside the Cloudflare Worker, so the key never reaches a
 * React component, `localStorage`, a public env var, HTML or a source map (§16).
 *
 * Unlike the older routes in this gateway, there is **no hardcoded key fallback**
 * here. A missing secret produces a clear configuration error rather than a
 * committed credential.
 *
 * The model is read from `OPENROUTER_MODEL` and never hardcoded (§45), so it can
 * be changed with `wrangler secret put` and no deploy.
 */

export interface OpenRouterEnv {
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
  /** Optional second model tried once if the primary is unavailable. */
  OPENROUTER_MODEL_FALLBACK?: string
  /** Override for self-hosted or proxied deployments. */
  OPENROUTER_BASE_URL?: string
  /** Sent as HTTP-Referer, which OpenRouter uses for attribution. */
  OPENROUTER_SITE_URL?: string
  OPENROUTER_APP_NAME?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface JsonSchemaSpec {
  name: string
  schema: Record<string, unknown>
  /**
   * Whether the provider should enforce the schema rather than treat it as a hint.
   * Only safe when every field has a concrete type — see the note in `schemas.ts`.
   */
  strict?: boolean
}

export interface OpenRouterRequest {
  messages: ChatMessage[]
  /** Requests structured output. Strongly preferred over prose parsing. */
  jsonSchema?: JsonSchemaSpec
  /** Plain JSON object mode, when a full schema is overkill. */
  jsonObject?: boolean
  maxTokens?: number
  temperature?: number
  /**
   * Passed through to the provider to make output as reproducible as the backend
   * allows. Not a guarantee — MoE routing and the fallback-model path are not
   * bit-reproducible — but it removes the gratuitous sampling drift.
   */
  seed?: number
  /** Per-attempt timeout. */
  timeoutMs?: number
  /** Ceiling on the whole call including retries and backoff. */
  totalBudgetMs?: number
  /** Overrides the configured model for this call only. */
  model?: string
}

export type OpenRouterFailure =
  | 'not-configured'
  | 'timeout'
  | 'rate-limited'
  | 'unauthorized'
  | 'model-unavailable'
  | 'upstream-error'
  | 'empty-response'
  | 'invalid-json'
  | 'network'

export interface OpenRouterOk<T> {
  ok: true
  /** Parsed JSON when a schema or object mode was requested. */
  data: T
  raw: string
  model: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export interface OpenRouterErr {
  ok: false
  failure: OpenRouterFailure
  /** Safe to show a user. Never contains provider payloads or the API key. */
  message: string
  /** Server-side detail for logs only. */
  detail?: string
  retryable: boolean
}

export type OpenRouterResult<T> = OpenRouterOk<T> | OpenRouterErr

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Per-attempt and whole-call ceilings.
 *
 * The budget is deliberately more than double the attempt timeout. They were equal
 * at first, which quietly meant one attempt: the import route asked for a 90s
 * timeout, the first attempt used the entire 90s budget, and a slow-but-valid
 * response was reported as a timeout with no retry. A reasoning model producing a
 * full resume as structured JSON genuinely takes tens of seconds, so the attempt
 * timeout has to be generous and the budget has to be larger still.
 */
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_BUDGET_MS = 150_000

/** Below this much remaining budget there is no point starting another attempt. */
const MIN_ATTEMPT_MS = 2_000

const DEFAULT_MAX_TOKENS = 3000

/** Human-readable messages. §44: no stack traces, no provider JSON, ever. */
const FAILURE_MESSAGES: Record<OpenRouterFailure, string> = {
  'not-configured': 'Resume AI is not configured on the server yet. Contact support.',
  timeout: 'The AI took too long to respond. Please try again.',
  'rate-limited': 'Resume AI is busy right now. Please try again in a moment.',
  unauthorized: 'Resume AI could not authenticate with its provider. Contact support.',
  'model-unavailable': 'The configured AI model is unavailable right now. Please try again shortly.',
  'upstream-error': 'The AI service returned an error. Please try again.',
  'empty-response': 'The AI returned an empty response. Please try again.',
  'invalid-json': 'The AI returned something we could not read. Nothing was changed.',
  network: 'We could not reach the AI service. Check your connection and try again.'
}

function fail(failure: OpenRouterFailure, detail?: string, retryable = false): OpenRouterErr {
  return { ok: false, failure, message: FAILURE_MESSAGES[failure], detail, retryable }
}

export interface ResolvedConfig {
  apiKey: string
  model: string
  fallbackModel?: string
  baseUrl: string
  siteUrl: string
  appName: string
}

/**
 * Reads and validates configuration.
 *
 * Returns null rather than throwing so the caller can answer with a configuration
 * error instead of a 500, and so `/gateway/resume/health` can report readiness
 * without ever touching the key's value.
 */
export function resolveConfig(env: OpenRouterEnv): ResolvedConfig | null {
  const apiKey = env.OPENROUTER_API_KEY?.trim()
  const model = env.OPENROUTER_MODEL?.trim()
  if (!apiKey || !model) return null
  return {
    apiKey,
    model,
    fallbackModel: env.OPENROUTER_MODEL_FALLBACK?.trim() || undefined,
    baseUrl: (env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ''),
    siteUrl: env.OPENROUTER_SITE_URL?.trim() || 'https://zyro.ai',
    appName: env.OPENROUTER_APP_NAME?.trim() || 'Zyro Resume AI'
  }
}

/** Reports configuration state without revealing any secret value. */
export function configStatus(env: OpenRouterEnv): {
  configured: boolean
  model: string | null
  hasFallback: boolean
} {
  const config = resolveConfig(env)
  return {
    configured: !!config,
    model: config?.model ?? null,
    hasFallback: !!config?.fallbackModel
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * JSON recovery
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Best-effort JSON extraction from a model response.
 *
 * Necessary rather than defensive. The configured model was observed returning a
 * fenced ```json block even with `strict: true` set on a json_schema
 * response_format — many OpenRouter providers treat the schema as a hint rather
 * than a constraint. Slicing to the outermost braces recovers those without
 * accepting arbitrary prose. This mirrors the `tryParseJsonObject` helper the
 * interview routes already use.
 */
export function parseJsonLoose<T>(raw: string): T | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const attempts: string[] = [trimmed]

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1]) attempts.push(fenced[1].trim())

  // A truncated response can open a fence and never close it, so the regex above
  // finds nothing. Strip the markers positionally as well.
  const unfenced = trimmed.replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim()
  if (unfenced && unfenced !== trimmed) attempts.push(unfenced)

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    attempts.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt)
      if (parsed && typeof parsed === 'object') return parsed as T
    } catch {
      // Try the next candidate.
    }
  }

  // Last resort: the response may simply have been cut off mid-object. Repair the
  // fence-stripped original rather than the brace-sliced candidate, which has
  // already discarded any complete scalar that followed the final `}`.
  const repaired = repairTruncatedJson(unfenced || trimmed)
  if (repaired) {
    try {
      const parsed = JSON.parse(repaired)
      if (parsed && typeof parsed === 'object') return parsed as T
    } catch {
      // Genuinely unreadable.
    }
  }
  return null
}

/**
 * Closes an object that was truncated by a token ceiling.
 *
 * The ATS review is the longest output in the module and was observed hitting
 * `finish_reason: 'length'`, which produces JSON with no closing brace and
 * therefore no parse. Every field in the client's Zod schemas has a default, so
 * three quarters of a review is genuinely more useful to a user than an error —
 * but only if the salvage is honest about where the data stopped.
 *
 * So this does not simply append brackets. It rewinds to the last point where a
 * complete value had just been written, discarding whatever element was in
 * progress, and only then closes the open containers. A suggestion cut off
 * mid-sentence is dropped rather than shown as though the model meant to end
 * there. Returns null when there is nothing coherent to keep.
 */
export function repairTruncatedJson(input: string): string | null {
  const text = input.trim()
  // A parseable string never reaches here, so anything not opening a container is
  // a different problem than truncation and not ours to guess at.
  if (!text.startsWith('{') && !text.startsWith('[')) return null

  /** Expected closers, innermost last. */
  const open: string[] = []
  let inString = false
  let escaped = false
  /** Index just past the last complete element, and the open stack at that point. */
  let safeEnd = -1
  let safeStack: string[] = []

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      open.push('}')
    } else if (ch === '[') {
      open.push(']')
    } else if (ch === '}' || ch === ']') {
      open.pop()
      safeEnd = i + 1
      safeStack = [...open]
    } else if (ch === ',') {
      // A comma proves the value before it was finished.
      safeEnd = i
      safeStack = [...open]
    }
  }

  // Nothing was ever completed, or the document is balanced and simply invalid.
  if (safeEnd <= 0 || safeStack.length === 0) return null

  const body = text.slice(0, safeEnd).replace(/,\s*$/, '')
  return body + safeStack.reverse().join('')
}

/**
 * Converts snake_case and kebab-case object keys to camelCase, recursively.
 *
 * Also a response to observed behaviour: the same request that produced a fenced
 * block also produced `start_date` where the schema said `startDate`. Since the
 * whole resume contract is camelCase, rewriting keys costs nothing and turns a
 * class of hard validation failure into a successful parse.
 *
 * Only *keys* are touched. Values — including operation paths like
 * `/experience/0/bullets/1` — pass through untouched, which matters because a path
 * is load-bearing and a mangled one would address the wrong field.
 */
export function normalizeKeys<T>(input: T): T {
  if (Array.isArray(input)) return input.map((entry) => normalizeKeys(entry)) as unknown as T
  if (!input || typeof input !== 'object') return input

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const camel = key.replace(/[_-]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
    // Never let a rewritten key clobber one the model already spelled correctly.
    if (camel !== key && camel in (input as Record<string, unknown>)) continue
    out[camel] = normalizeKeys(value)
  }
  return out as T
}

/* ────────────────────────────────────────────────────────────────────────────
 * Request
 * ──────────────────────────────────────────────────────────────────────────── */

interface RawCallOutcome {
  status: number
  body: string
  networkError?: boolean
  aborted?: boolean
}

async function rawCall(
  config: ResolvedConfig,
  model: string,
  request: OpenRouterRequest,
  useSchema: boolean,
  timeoutMs: number
): Promise<RawCallOutcome> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  const body: Record<string, unknown> = {
    model,
    messages: request.messages,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: request.temperature ?? 0.25,
    stream: false
  }

  // Passed through when the caller wants reproducibility (e.g. the ATS score, which
  // must not wander between opens of an unchanged resume). Providers that ignore it
  // are no worse off than before.
  if (typeof request.seed === 'number') {
    body.seed = request.seed
  }

  // Only attach response_format on standard OpenRouter. Non-standard proxies often reject or
  // silently break on json_schema / json_object modes. The gateway's parseJsonLoose() handles
  // plain-text JSON responses gracefully, so skipping this is safe for structured calls too.
  const isStandardOpenRouter = config.baseUrl.includes('openrouter.ai')
  if (isStandardOpenRouter) {
    if (useSchema && request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.jsonSchema.name,
          strict: request.jsonSchema.strict ?? false,
          schema: request.jsonSchema.schema
        }
      }
    } else if (request.jsonSchema || request.jsonObject) {
      // Fallback for models without json_schema support.
      body.response_format = { type: 'json_object' }
    }
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': config.siteUrl,
        'X-Title': config.appName
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const text = await response.text()
    return { status: response.status, body: text }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return { status: 0, body: '', networkError: !aborted, aborted }
  } finally {
    clearTimeout(timeout)
  }
}

function extractContent(body: string): {
  content: string
  usage?: OpenRouterOk<unknown>['usage']
  finishReason?: string
} {
  try {
    const parsed = JSON.parse(body) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[]
      usage?: OpenRouterOk<unknown>['usage']
    }
    return {
      content: parsed.choices?.[0]?.message?.content ?? '',
      usage: parsed.usage,
      finishReason: parsed.choices?.[0]?.finish_reason
    }
  } catch {
    return { content: '' }
  }
}

/** Classifies an HTTP status into a failure the client can act on. */
function classify(status: number, body: string): OpenRouterErr {
  if (status === 401 || status === 403) return fail('unauthorized', `status ${status}`)
  if (status === 402) {
    return {
      ...fail('unauthorized', 'insufficient credit'),
      message: 'Resume AI has run out of provider credit. Contact support.'
    }
  }
  if (status === 429) return fail('rate-limited', 'status 429', true)
  if (status === 404 || status === 400) {
    // OpenRouter answers 400/404 for an unknown or unroutable model slug, which
    // is a configuration problem rather than a transient one.
    const looksModelRelated = /model/i.test(body)
    return looksModelRelated
      ? fail('model-unavailable', `status ${status}`, true)
      : fail('upstream-error', `status ${status}`, false)
  }
  if (status >= 500) return fail('upstream-error', `status ${status}`, true)
  return fail('upstream-error', `status ${status}`)
}

/**
 * Backoff schedule, in milliseconds.
 *
 * Tuned against the real thing rather than picked round: the configured model sits
 * on a shared upstream pool that returns 429 for a noticeable fraction of requests,
 * and observed recovery took several seconds, not several hundred milliseconds. A
 * 400ms retry would have burned all three attempts inside one rate-limit window and
 * surfaced a failure the user did not need to see.
 */
const RETRY_DELAYS_MS = [1500, 4000, 8000]

/** Rate limits need the longer end of the schedule; other faults are usually instant. */
const FAST_RETRY_DELAYS_MS = [500, 1500, 3000]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Calls OpenRouter and returns parsed, structured output.
 *
 * Retries on rate limits, transient upstream failures and unparseable JSON.
 * Schema mode is attempted first and degraded to plain JSON-object mode if the
 * model rejects it, so a model change can't silently break every action.
 */
export async function callOpenRouter<T = unknown>(
  env: OpenRouterEnv,
  request: OpenRouterRequest
): Promise<OpenRouterResult<T>> {
  const config = resolveConfig(env)
  if (!config) return fail('not-configured', 'OPENROUTER_API_KEY or OPENROUTER_MODEL missing')

  const models = [request.model?.trim() || config.model]
  if (config.fallbackModel && config.fallbackModel !== models[0]) models.push(config.fallbackModel)

  // Overall wall-clock ceiling. Four attempts across two models, each with its own
  // timeout and its own backoff, can otherwise add up to minutes — and a user
  // watching a spinner would rather be told to try again.
  const deadline = Date.now() + (request.totalBudgetMs ?? DEFAULT_BUDGET_MS)

  let lastError: OpenRouterErr = fail('upstream-error')
  let useSchema = !!request.jsonSchema

  for (const model of models) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      // Clamp each attempt to whatever budget is left, so `totalBudgetMs` is a real
      // wall-clock ceiling rather than an approximate one. The first attempt always
      // runs: a caller who set an unreachably small budget should still get one
      // genuine try rather than an instant synthetic failure.
      const remaining = deadline - Date.now()
      if (attempt > 0 && remaining <= MIN_ATTEMPT_MS) return lastError
      const attemptTimeout = Math.min(
        request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        Math.max(remaining, MIN_ATTEMPT_MS)
      )

      const outcome = await rawCall(config, model, request, useSchema, attemptTimeout)

      if (outcome.aborted) {
        lastError = fail('timeout', `model ${model}`, true)
      } else if (outcome.networkError) {
        lastError = fail('network', `model ${model}`, true)
      } else if (outcome.status !== 200) {
        console.log('GROQ_ERROR:', outcome.status, outcome.body); lastError = classify(outcome.status, outcome.body)
        // A schema rejection is worth exactly one downgrade before giving up on
        // structured mode for this call.
        if (useSchema && outcome.status === 400 && /schema|response_format/i.test(outcome.body)) {
          useSchema = false
          continue
        }
      } else {
        const { content, usage, finishReason } = extractContent(outcome.body)
        if (!content.trim()) {
          lastError = fail('empty-response', `model ${model} finish=${finishReason ?? '?'}`, true)
        } else if (request.jsonSchema || request.jsonObject) {
          const parsed = parseJsonLoose<T>(content)
          if (parsed) {
            return { ok: true, data: normalizeKeys(parsed), raw: content, model, usage }
          }
          // `finish=length` in this log means the token ceiling cut the JSON off,
          // which is a `maxTokens` problem for this route rather than a bad model.
          lastError = fail(
            'invalid-json',
            `model ${model} finish=${finishReason ?? '?'} chars=${content.length}`,
            // Retrying an answer the ceiling truncated just truncates it again.
            finishReason !== 'length'
          )
        } else {
          return { ok: true, data: content as unknown as T, raw: content, model, usage }
        }
      }

      if (!lastError.retryable || attempt === RETRY_DELAYS_MS.length) break
      const schedule = lastError.failure === 'rate-limited' ? RETRY_DELAYS_MS : FAST_RETRY_DELAYS_MS
      const delay = schedule[attempt]
      if (Date.now() + delay >= deadline) return lastError
      await sleep(delay)
    }
    // A rejected key or an empty balance applies to every model on the account, so
    // the fallback has nothing to fix. Stop rather than spending four more attempts
    // proving it.
    if (lastError.failure === 'unauthorized') return lastError
    if (Date.now() >= deadline) return lastError
  }

  return lastError
}

/**
 * Zyro Resume AI — gateway routes.
 *
 * Mounted under `/gateway/resume`. Every route follows the same three steps:
 *
 *   validate and bound the input → call OpenRouter → return JSON
 *
 * Three things are deliberately *not* here.
 *
 * There is no authentication, matching every other route in this gateway. The
 * consequence is worth stating plainly rather than leaving implicit: the
 * OpenRouter key lives in this worker, so anyone who learns the worker URL can
 * spend it. The per-IP window below is a brake on runaway usage, not an access
 * control. Adding a real one means verifying the caller's Supabase token here,
 * which is a deliberate future change and not something this file pretends to do.
 *
 * There is no resume storage: resumes live in Supabase and are read and written
 * by the browser under row-level security, so this worker never becomes a second
 * source of truth. That is also what keeps §57 intact without auth here — resume
 * ownership is enforced by Postgres RLS on the user's own session, not by this
 * stateless proxy, which never sees a stored resume.
 *
 * And there is no application of operations: the client validates and applies
 * them, because the client is where the resume actually is. This worker's whole
 * job is to hold the OpenRouter key and turn text into structured proposals.
 */

import { Hono } from 'hono'
import { callOpenRouter, configStatus, type OpenRouterEnv, type OpenRouterResult } from './openrouter'
import {
  buildAtsReviewMessages,
  buildEditMessages,
  buildImportMessages,
  buildJobAnalysisMessages,
  buildRewriteMessages,
  type EditContext,
  type RewriteMode
} from './prompts'
import { ATS_SPEC, EDIT_SPEC, IMPORT_SPEC, JOB_SPEC, REWRITE_SPEC } from './schemas'

export type ResumeEnv = OpenRouterEnv

/* ────────────────────────────────────────────────────────────────────────────
 * Input bounds
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Hard caps on every user-supplied field.
 *
 * These are cost controls as much as safety controls: the request body is what
 * becomes prompt tokens, and an unbounded field is an unbounded bill. They are
 * generous enough that no real resume hits them — a 120k-character extraction is
 * roughly a 40-page document.
 */
const LIMITS = {
  instruction: 2000,
  resumeJson: 80_000,
  jobDescription: 20_000,
  importText: 120_000,
  rewriteText: 6000,
  selectionText: 4000,
  historyTurns: 6,
  historyChars: 2000,
  keywords: 40,
  recentChanges: 8
} as const

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function strArray(value: unknown, maxItems: number, maxChars = 120): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed) out.push(trimmed.slice(0, maxChars))
    if (out.length >= maxItems) break
  }
  return out
}

/* ────────────────────────────────────────────────────────────────────────────
 * Best-effort rate limiting
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Per-caller sliding window, held in isolate memory and keyed on client IP.
 *
 * Being honest about what this is: Workers isolates are per-region and can be
 * recycled at any time, and an IP is trivially changed, so a determined caller
 * gets more than the stated allowance. It is not a security boundary. It exists
 * to stop an ordinary runaway — a retry loop in a component, a user leaning on a
 * button, a script someone points at the URL — from quietly emptying the
 * OpenRouter account. A real limiter needs a Durable Object or KV, which is a
 * deploy-configuration change rather than a code change.
 */
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 25
const hits = new Map<string, number[]>()

function rateLimited(key: string): boolean {
  const now = Date.now()
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent)
    return true
  }
  recent.push(now)
  hits.set(key, recent)

  // Opportunistic cleanup; the map would otherwise grow for the isolate's lifetime.
  if (hits.size > 500) {
    for (const [k, stamps] of hits) {
      if (stamps.every((t) => now - t >= WINDOW_MS)) hits.delete(k)
    }
  }
  return false
}

/* ────────────────────────────────────────────────────────────────────────────
 * Shared plumbing
 * ──────────────────────────────────────────────────────────────────────────── */

/** The slice of Hono's context this file actually uses. */
interface RouteContext {
  req: { header: (name: string) => string | undefined; json: () => Promise<unknown> }
  env: ResumeEnv
  json: (body: unknown, status?: number) => Response
}

/**
 * Cloudflare sets `CF-Connecting-IP` on every request and it cannot be spoofed by
 * the client, unlike `X-Forwarded-For`. Absent in local `wrangler dev`, where a
 * single shared bucket is fine.
 *
 * Takes the context rather than the `header` function, because Hono's `header` is
 * a prototype method that reads `this.raw` — detaching it throws.
 */
function callerKey(c: RouteContext): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Real-IP') ?? 'local'
}

interface Guarded {
  body: Record<string, unknown>
}

type GuardFailure = { response: Response }

/**
 * Rate-limits and parses the body in one step, so each route handler stays down
 * to its actual logic.
 */
async function guard(c: RouteContext): Promise<Guarded | GuardFailure> {
  if (rateLimited(callerKey(c))) {
    return {
      response: c.json(
        { ok: false, error: 'That was a lot of requests at once. Give it a minute and try again.' },
        429
      )
    }
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { response: c.json({ ok: false, error: 'We could not read that request.' }, 400) }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { response: c.json({ ok: false, error: 'We could not read that request.' }, 400) }
  }

  return { body: body as Record<string, unknown> }
}

function isFailure(value: Guarded | GuardFailure): value is GuardFailure {
  return 'response' in value
}

/**
 * Maps an OpenRouter failure onto an HTTP status.
 *
 * The user-facing string always comes from the client, never from the provider —
 * §44's "never show raw stack traces" applies just as much to a provider's error
 * envelope, which can contain internal hostnames and request ids.
 */
function statusFor(failure: string): number {
  switch (failure) {
    case 'not-configured':
      return 503
    case 'rate-limited':
      return 429
    case 'timeout':
      return 504
    case 'unauthorized':
      return 502
    default:
      return 502
  }
}

function respond<T>(
  c: { json: (body: unknown, status?: number) => Response },
  result: OpenRouterResult<T>,
  label: string
): Response {
  if (result.ok) {
    return c.json({ ok: true, data: result.data, model: result.model, usage: result.usage })
  }
  // Detail is for the log; the client only ever sees `message`.
  console.error(`[resume:${label}] ${result.failure}${result.detail ? ` (${result.detail})` : ''}`)
  return c.json({ ok: false, error: result.message, failure: result.failure }, statusFor(result.failure))
}

/* ────────────────────────────────────────────────────────────────────────────
 * Routes
 * ──────────────────────────────────────────────────────────────────────────── */

export const resumeRoutes = new Hono<{ Bindings: ResumeEnv }>()

/**
 * Readiness probe.
 *
 * Deliberately uninformative: whether the module is configured, and nothing else.
 * No model slug, no key prefix, no env dump — so it stays safe to point uptime
 * monitoring at.
 */
resumeRoutes.get('/health', (c) => {
  const status = configStatus(c.env)
  return c.json({ status: status.configured ? 'ready' : 'unconfigured', configured: status.configured })
})

/**
 * Configuration detail for the client.
 *
 * The client uses this to decide whether to show AI affordances at all, rather
 * than offering a chat box that can only fail. Returns the model name — which is
 * the value of `OPENROUTER_MODEL` and not a secret — and never anything derived
 * from the key.
 */
resumeRoutes.get('/config', (c) => {
  return c.json({ ok: true, ...configStatus(c.env) })
})

/**
 * POST /gateway/resume/edit — the chat endpoint (§18, §21).
 *
 * Returns operations, never a resume. The client validates them against its Zod
 * schemas, runs them through the guard in `core/actions.ts`, and applies them
 * atomically — so nothing here can corrupt a document even if the model returns
 * something malicious.
 */
resumeRoutes.post('/edit', async (c) => {
  const guarded = await guard(c)
  if (isFailure(guarded)) return guarded.response
  const { body } = guarded

  const instruction = str(body.instruction, LIMITS.instruction).trim()
  if (!instruction) {
    return c.json({ ok: false, error: 'Tell Zyro what you would like to change.' }, 400)
  }

  const resume = body.resume
  if (!resume || typeof resume !== 'object') {
    return c.json({ ok: false, error: 'We could not read your resume. Try reloading the page.' }, 400)
  }

  const serialized = JSON.stringify(resume)
  if (serialized.length > LIMITS.resumeJson) {
    return c.json(
      {
        ok: false,
        error: 'This resume is too large for Zyro to work on in one go. Try trimming older roles.'
      },
      413
    )
  }

  const selectionInput = (body.selection ?? {}) as Record<string, unknown>
  const context: EditContext = {
    resume,
    templateId: str(body.templateId, 60) || 'ats-safe',
    targetJobTitle: str(body.targetJobTitle, 200).trim() || undefined,
    targetCompany: str(body.targetCompany, 200).trim() || undefined,
    jobDescription: str(body.jobDescription, LIMITS.jobDescription).trim() || undefined,
    atsScore: typeof body.atsScore === 'number' ? Math.round(body.atsScore) : undefined,
    missingKeywords: strArray(body.missingKeywords, LIMITS.keywords),
    recentChanges: strArray(body.recentChanges, LIMITS.recentChanges, 200),
    selection: {
      sectionKind: str(selectionInput.sectionKind, 40) || undefined,
      itemId: str(selectionInput.itemId, 80) || undefined,
      fieldPath: str(selectionInput.fieldPath, 200) || undefined,
      text: str(selectionInput.text, LIMITS.selectionText) || undefined
    },
    history: Array.isArray(body.history)
      ? body.history
          .slice(-LIMITS.historyTurns)
          .map((turn) => {
            const t = (turn ?? {}) as Record<string, unknown>
            return {
              role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
              content: str(t.content, LIMITS.historyChars)
            }
          })
          .filter((turn) => !!turn.content.trim())
      : []
  }

  const result = await callOpenRouter(c.env, {
    messages: buildEditMessages(instruction, context),
    jsonSchema: EDIT_SPEC,
    maxTokens: 2000,
    temperature: 0.3,
    // The user is watching a chat cursor blink, so this one gives up sooner than the
    // background analyses do. Two full attempts, then an error they can retry.
    totalBudgetMs: 120_000
  })
  return respond(c, result, 'edit')
})

/**
 * POST /gateway/resume/import — normalises extracted text into resume JSON (§12).
 *
 * Text extraction happens in the browser (pdf.js for PDF, mammoth for DOCX) and
 * only the resulting text arrives here. That is a security property, not an
 * accident: no uploaded file ever reaches the server, so there is nothing to
 * execute, nothing to store, and no file-parsing attack surface in the worker.
 */
resumeRoutes.post('/import', async (c) => {
  const guarded = await guard(c)
  if (isFailure(guarded)) return guarded.response
  const { body } = guarded

  const raw = str(body.text, LIMITS.importText)
  // Collapse the runs of whitespace that PDF extraction produces. Left as one
  // pass here rather than in the prompt, because tokens spent on whitespace are
  // tokens not spent on the resume.
  const text = raw.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

  if (text.length < 120) {
    return c.json(
      {
        ok: false,
        error:
          "We could not read enough text from that file. If it is a scanned image, try exporting a text-based PDF or start from scratch."
      },
      422
    )
  }

  const result = await callOpenRouter(c.env, {
    messages: buildImportMessages(text, str(body.filename, 200) || undefined),
    jsonSchema: IMPORT_SPEC,
    // Import is the longest output in the system: a full resume as JSON.
    maxTokens: 3000,
    // Transcription, not composition. As deterministic as the provider allows.
    temperature: 0,
    // Measured, not guessed: a reasoning model transcribing a two-page resume into
    // structured JSON ran past 90s. The budget allows two full attempts, because
    // making the user upload the file again is worse than making them wait.
    timeoutMs: 110_000,
    totalBudgetMs: 240_000
  })
  return respond(c, result, 'import')
})

/** POST /gateway/resume/job — job description analysis (§26). */
resumeRoutes.post('/job', async (c) => {
  const guarded = await guard(c)
  if (isFailure(guarded)) return guarded.response
  const { body } = guarded

  const jobDescription = str(body.jobDescription, LIMITS.jobDescription).trim()
  if (jobDescription.length < 40) {
    return c.json(
      { ok: false, error: 'Paste a bit more of the job description so Zyro has something to work with.' },
      400
    )
  }

  const result = await callOpenRouter(c.env, {
    messages: buildJobAnalysisMessages(
      jobDescription,
      str(body.jobTitle, 200).trim() || undefined,
      str(body.company, 200).trim() || undefined,
      str(body.resumeText, LIMITS.resumeJson).trim() || undefined
    ),
    jsonSchema: JOB_SPEC,
    maxTokens: 2500,
    temperature: 0.1
  })
  return respond(c, result, 'job')
})

/**
 * POST /gateway/resume/ats — the AI half of the hybrid score (§30).
 *
 * The client has already computed a full local score before calling this, and
 * merges the two. That ordering matters: the score shown while this request is in
 * flight is a real score, not a spinner, and a failure here degrades to the local
 * score rather than to nothing.
 */
resumeRoutes.post('/ats', async (c) => {
  const guarded = await guard(c)
  if (isFailure(guarded)) return guarded.response
  const { body } = guarded

  const resumeText = str(body.resumeText, LIMITS.resumeJson).trim()
  if (resumeText.length < 80) {
    return c.json({ ok: false, error: 'Add some content to your resume first.' }, 400)
  }

  const localScore = typeof body.localScore === 'number' ? Math.round(body.localScore) : 0
  const result = await callOpenRouter(c.env, {
    messages: buildAtsReviewMessages(
      resumeText,
      Math.max(0, Math.min(100, localScore)),
      str(body.jobDescription, LIMITS.jobDescription).trim() || undefined,
      str(body.jobTitle, 200).trim() || undefined
    ),
    jsonSchema: ATS_SPEC,
    // Deliberately roomy. A reasoning model's thinking counts against this ceiling
    // on some providers, and a review truncated at 3000 tokens came back as
    // unparseable JSON — an expensive way to fail on the module's slowest call.
    maxTokens: 6000,
    // Determinism first: the same resume must score the same on every open. The
    // client also caches the review per content hash, so this only has to stop the
    // provider from sampling a different answer on a genuine recompute.
    temperature: 0,
    seed: 7,
    // The slowest call in the module by some margin: three judged scores, strengths,
    // weaknesses, six suggestions with instructions, and two keyword lists. It is
    // also the least urgent, because the client already has a real local score on
    // screen — so it gets a long budget rather than a fast failure.
    timeoutMs: 120_000,
    totalBudgetMs: 200_000
  })
  return respond(c, result, 'ats')
})

const REWRITE_MODES: RewriteMode[] = [
  'improve',
  'shorten',
  'rewrite',
  'professional',
  'impact',
  'grammar'
]

/** POST /gateway/resume/rewrite — selected-text actions (§50). */
resumeRoutes.post('/rewrite', async (c) => {
  const guarded = await guard(c)
  if (isFailure(guarded)) return guarded.response
  const { body } = guarded

  const text = str(body.text, LIMITS.rewriteText).trim()
  if (!text) {
    return c.json({ ok: false, error: 'Select some text to rewrite.' }, 400)
  }

  const requested = str(body.mode, 40)
  const mode = REWRITE_MODES.includes(requested as RewriteMode)
    ? (requested as RewriteMode)
    : 'improve'

  const result = await callOpenRouter(c.env, {
    messages: buildRewriteMessages(text, mode, {
      role: str(body.role, 200) || undefined,
      company: str(body.company, 200) || undefined,
      jobTitle: str(body.jobTitle, 200) || undefined,
      sectionKind: str(body.sectionKind, 40) || undefined
    }),
    jsonSchema: REWRITE_SPEC,
    // One line of text in, one line out. A large budget here only buys rambling.
    maxTokens: 700,
    temperature: mode === 'grammar' ? 0 : 0.4,
    // Inline action with the user's cursor in the field, so this is the one route
    // that should give up early rather than retry patiently.
    timeoutMs: 45_000,
    totalBudgetMs: 60_000
  })
  return respond(c, result, 'rewrite')
})

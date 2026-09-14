/**
 * Live model tests.
 *
 * Skipped unless `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are in the
 * environment, so an ordinary `pnpm test` stays offline and free. Run them with:
 *
 *   set -a && . ./.dev.vars && set +a && npx vitest run src/resume/live.test.ts
 *
 * These exist because the offline tests cannot answer the question that actually
 * matters: does *this* model, on *these* prompts, return the shape the client's Zod
 * schemas accept? The configured model was observed ignoring `strict: true` and
 * returning fenced markdown with snake_case keys, which is why `prompts.ts` states
 * every shape literally and `openrouter.ts` normalizes keys. That defence is only
 * meaningfully verified against the real thing.
 *
 * The fabrication assertions are the important ones. A model that invents
 * "Google, Mountain View, CA" from a resume that only said "Google" is a product
 * defect, not a style problem (§15/§24).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { callOpenRouter, type OpenRouterEnv } from './openrouter'
import {
  buildAtsReviewMessages,
  buildEditMessages,
  buildImportMessages,
  buildJobAnalysisMessages,
  buildRewriteMessages
} from './prompts'
import { ATS_SPEC, EDIT_SPEC, IMPORT_SPEC, JOB_SPEC, REWRITE_SPEC } from './schemas'

const processEnv =
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env ?? {}

const ENV: OpenRouterEnv = {
  OPENROUTER_API_KEY: processEnv.OPENROUTER_API_KEY,
  OPENROUTER_MODEL: processEnv.OPENROUTER_MODEL,
  OPENROUTER_MODEL_FALLBACK: processEnv.OPENROUTER_MODEL_FALLBACK
}

const LIVE = !!(ENV.OPENROUTER_API_KEY && ENV.OPENROUTER_MODEL)

/**
 * Generous, and `retry: 1` on top. The configured model sits on a shared upstream
 * pool that returns 429 for a noticeable fraction of requests — a real production
 * condition the client handles with backoff, but one that would otherwise make this
 * file fail for reasons that have nothing to do with prompt compliance.
 */
const TIMEOUT = 150_000
const OPTIONS = { timeout: TIMEOUT, retry: 1 }

/**
 * The two slow calls. Each test timeout must exceed the client's own
 * `totalBudgetMs` for that route, otherwise vitest kills the test before the client
 * can return its own classified failure and every slow response looks identical.
 * These mirror the tuning in routes.ts.
 */
const IMPORT_OPTIONS = { timeout: 280_000, retry: 1 }
const ATS_OPTIONS = { timeout: 240_000, retry: 1 }

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Deliberately sparse: no employer locations, no metrics, no percentages. */
const RESUME_TEXT = `ANA DIAZ
ana.diaz@example.com | +1 555 0134

EXPERIENCE
Senior Backend Engineer, Google
Mar 2021 - Present
- Responsible for the billing service
- Worked on payment reconciliation with the finance team

Backend Engineer, Razorpay
Jul 2019 - Feb 2021
- Built internal tooling for the payments team

EDUCATION
B.Tech Computer Science, IIT Delhi
2015 - 2019

SKILLS
Go, Python, PostgreSQL, Kubernetes`

const RESUME_JSON = {
  personal: {
    fullName: 'Ana Diaz',
    headline: 'Senior Backend Engineer',
    email: 'ana.diaz@example.com',
    phone: '+1 555 0134',
    location: '',
    linkedin: '',
    github: '',
    portfolio: ''
  },
  summary: 'Backend engineer working on payments.',
  experience: [
    {
      id: 'exp_1',
      company: 'Google',
      position: 'Senior Backend Engineer',
      location: '',
      startDate: 'Mar 2021',
      endDate: '',
      current: true,
      bullets: ['Responsible for the billing service', 'Worked on payment reconciliation']
    }
  ],
  education: [
    {
      id: 'edu_1',
      institution: 'IIT Delhi',
      degree: 'B.Tech',
      field: 'Computer Science',
      location: '',
      startDate: '2015',
      endDate: '2019',
      gpa: '',
      details: []
    }
  ],
  skills: [{ id: 'skl_1', category: 'Languages', items: ['Go', 'Python'] }],
  projects: [],
  certifications: [],
  achievements: [],
  languages: [],
  customSections: [],
  sections: [
    { id: 'sec_1', kind: 'summary', title: '', visible: true },
    { id: 'sec_2', kind: 'experience', title: '', visible: true }
  ]
}

const JOB_DESCRIPTION = `Senior Platform Engineer — Stripe

We are looking for a senior engineer to work on our payments platform.

Requirements:
- 5+ years of backend engineering experience
- Strong Go or Java
- Experience with Kubernetes and distributed systems
- Must have worked on high-throughput payment or billing systems
- Experience with Terraform is a plus
- Familiarity with gRPC preferred`

/** Words we never supplied. If one comes back, the model invented it. */
const FABRICATIONS = /mountain view|menlo park|california|\bCA\b|bangalore|new delhi/i

const ALLOWED_PATH = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/
const ALLOWED_OP_TYPES = ['replace', 'add', 'remove', 'move']

function report(label: string, raw: string): void {
  const fenced = raw.trimStart().startsWith('```')
  const snake = /"[a-z]+_[a-z]/.test(raw)
  console.log(
    `[live:${label}] ${raw.length} chars, fenced=${fenced}, snake_case_keys=${snake}` +
      (fenced || snake ? ' (recovered by parseJsonLoose/normalizeKeys)' : '')
  )
}

describe.runIf(LIVE)('live model compliance', () => {
  // Five structured calls back to back is enough to rate-limit ourselves on a
  // shared pool, which would say nothing about the prompts.
  beforeEach(() => pause(4000))

  it(
    'returns a rewrite in the documented shape without inventing a metric',
    OPTIONS,
    async () => {
      const result = await callOpenRouter<{ text: string; note: string; changed: boolean }>(ENV, {
        messages: buildRewriteMessages('Responsible for the billing service', 'impact'),
        jsonSchema: REWRITE_SPEC,
        maxTokens: 700,
        temperature: 0.4
      })
      expect(result.ok, result.ok ? '' : `${result.failure}: ${result.detail}`).toBe(true)
      if (!result.ok) return
      report('rewrite', result.raw)

      expect(typeof result.data.text).toBe('string')
      expect(result.data.text.trim().length).toBeGreaterThan(0)
      expect(typeof result.data.changed).toBe('boolean')
      // "impact" mode on a bullet with no outcome must not conjure one.
      expect(result.data.text).not.toMatch(/\d+\s?%/)
      expect(result.data.text).not.toMatch(/\$\d/)
    }
  )

  it(
    'transcribes an import without inventing an employer location',
    IMPORT_OPTIONS,
    async () => {
      const result = await callOpenRouter<Record<string, unknown>>(ENV, {
        messages: buildImportMessages(RESUME_TEXT, 'ana-diaz.pdf'),
        jsonSchema: IMPORT_SPEC,
        maxTokens: 8000,
        temperature: 0,
        timeoutMs: 110_000,
        totalBudgetMs: 240_000
      })
      expect(result.ok, result.ok ? '' : `${result.failure}: ${result.detail}`).toBe(true)
      if (!result.ok) return
      report('import', result.raw)

      const data = result.data as {
        personal?: { fullName?: string }
        experience?: { company?: string; position?: string; location?: string; bullets?: string[] }[]
      }

      expect(data.personal?.fullName).toMatch(/ana diaz/i)

      const first = data.experience?.[0]
      expect(first).toBeDefined()
      expect(first?.company).toMatch(/google/i)
      // The source says "Google" and nothing more. §15's worked example.
      expect(first?.location ?? '').toBe('')
      // "position", not "role" or "jobTitle" — the client schema has no other name.
      expect(first?.position).toMatch(/backend engineer/i)
      expect(Array.isArray(first?.bullets)).toBe(true)
      // Transcription, not rewriting: the original wording must survive.
      expect(first?.bullets?.join(' ')).toMatch(/billing/i)

      expect(JSON.stringify(data)).not.toMatch(FABRICATIONS)
      // normalizeKeys should have left nothing snake_cased for the client to trip on.
      expect(JSON.stringify(data)).not.toMatch(/"[a-z]+_[a-z]+":/)
    }
  )

  it(
    'returns edit operations on real paths and invents no numbers',
    OPTIONS,
    async () => {
      const result = await callOpenRouter<{
        action?: string
        message?: string
        operations?: { type?: string; path?: string; value?: unknown }[]
      }>(ENV, {
        messages: buildEditMessages(
          'Make the first Google bullet stronger and lead with the outcome.',
          { resume: RESUME_JSON, templateId: 'ats-safe' }
        ),
        jsonSchema: EDIT_SPEC,
        maxTokens: 4000,
        temperature: 0.3
      })
      expect(result.ok, result.ok ? '' : `${result.failure}: ${result.detail}`).toBe(true)
      if (!result.ok) return
      report('edit', result.raw)

      expect(['update_resume', 'reply', 'change_template']).toContain(result.data.action)
      expect(typeof result.data.message).toBe('string')
      expect(Array.isArray(result.data.operations)).toBe(true)

      const operations = result.data.operations ?? []
      // The instruction names a specific bullet, so a "reply" with no operations
      // would be a failure to act rather than caution.
      expect(
        operations.length,
        `model replied instead of editing: ${result.data.message}`
      ).toBeGreaterThan(0)

      for (const op of operations) {
        expect(ALLOWED_OP_TYPES).toContain(op.type)
        expect(op.path).toMatch(ALLOWED_PATH)
        // A path the client rejects is a wasted round trip; /role would be one.
        expect(op.path).not.toMatch(/\/role(\/|$)/)
      }
      expect(operations.some((op) => op.path?.startsWith('/experience/0/bullets'))).toBe(true)

      const written = JSON.stringify(operations.map((op) => op.value))
      expect(written).not.toMatch(/\d+\s?%/)
      expect(written).not.toMatch(FABRICATIONS)
    }
  )

  it(
    'analyses a job description into keyword arrays',
    OPTIONS,
    async () => {
      const result = await callOpenRouter<Record<string, unknown>>(ENV, {
        messages: buildJobAnalysisMessages(JOB_DESCRIPTION, 'Senior Platform Engineer', 'Stripe'),
        jsonSchema: JOB_SPEC,
        maxTokens: 2500,
        temperature: 0.1
      })
      expect(result.ok, result.ok ? '' : `${result.failure}: ${result.detail}`).toBe(true)
      if (!result.ok) return
      report('job', result.raw)

      const data = result.data as {
        jobTitle?: string
        requiredKeywords?: string[]
        preferredKeywords?: string[]
        technologies?: string[]
      }
      expect(Array.isArray(data.requiredKeywords)).toBe(true)
      expect(Array.isArray(data.preferredKeywords)).toBe(true)
      expect(data.requiredKeywords?.length).toBeGreaterThan(0)

      const required = (data.requiredKeywords ?? []).join(' ').toLowerCase()
      const anywhere = JSON.stringify(data).toLowerCase()
      expect(anywhere).toContain('kubernetes')
      // "Terraform is a plus" and "gRPC preferred" are not hard requirements.
      expect(required).not.toContain('terraform')
    }
  )

  it(
    'scores the three ATS dimensions as numbers and splits keywords honestly',
    ATS_OPTIONS,
    async () => {
      const result = await callOpenRouter<Record<string, unknown>>(ENV, {
        messages: buildAtsReviewMessages(RESUME_TEXT, 61, JOB_DESCRIPTION, 'Senior Platform Engineer'),
        jsonSchema: ATS_SPEC,
        maxTokens: 6000,
        temperature: 0.2,
        timeoutMs: 120_000,
        totalBudgetMs: 200_000
      })
      expect(result.ok, result.ok ? '' : `${result.failure}: ${result.detail}`).toBe(true)
      if (!result.ok) return
      report('ats', result.raw)

      const data = result.data as {
        jobRelevance?: unknown
        contentQuality?: unknown
        experienceRelevance?: unknown
        suggestions?: { title?: string; instruction?: string; impact?: string }[]
        supportedMissingKeywords?: string[]
        unsupportedKeywords?: string[]
      }

      // Plain numbers, not "72/100" — the score feeds arithmetic on the client.
      for (const key of ['jobRelevance', 'contentQuality', 'experienceRelevance'] as const) {
        expect(typeof data[key], `${key} was ${JSON.stringify(data[key])}`).toBe('number')
        expect(data[key] as number).toBeGreaterThanOrEqual(0)
        expect(data[key] as number).toBeLessThanOrEqual(100)
      }

      expect(Array.isArray(data.suggestions)).toBe(true)
      for (const suggestion of data.suggestions ?? []) {
        expect(['high', 'medium', 'low']).toContain(suggestion.impact)
        expect(suggestion.title?.trim().length).toBeGreaterThan(0)
      }

      expect(Array.isArray(data.supportedMissingKeywords)).toBe(true)
      expect(Array.isArray(data.unsupportedKeywords)).toBe(true)
      // The resume shows no Terraform or gRPC anywhere, so neither may be presented
      // as something the user already evidences (§28).
      const supported = (data.supportedMissingKeywords ?? []).join(' ').toLowerCase()
      expect(supported).not.toContain('terraform')
      expect(supported).not.toContain('grpc')
    }
  )
})

describe.skipIf(LIVE)('live model compliance', () => {
  it('is skipped without OPENROUTER_API_KEY and OPENROUTER_MODEL', () => {
    expect(LIVE).toBe(false)
  })
})

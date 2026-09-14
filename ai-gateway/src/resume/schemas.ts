/**
 * Zyro Resume AI — JSON schemas for structured output.
 *
 * These mirror `website/src/features/resume-ai/schema/operations.ts`. The
 * duplication is deliberate and unavoidable: `ai-gateway` is a separate
 * Cloudflare Worker project with its own build, and it cannot import from the
 * website's source tree.
 *
 * The split of responsibility keeps that duplication safe:
 *
 *   - This file is a *hint*. It tells the model what shape to produce, which
 *     raises first-pass validity but guarantees nothing.
 *   - The Zod schemas on the client are the *enforcement boundary*. Every response
 *     is re-validated there before a single character of the resume changes, so a
 *     drifted schema here produces a rejected response, never a corrupted resume.
 *
 * If you change a schema, change both — and change the Zod one first.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Strict-mode normalisation
 * ──────────────────────────────────────────────────────────────────────────── */

type JsonSchema = Record<string, unknown>

/**
 * Rewrites a schema so every declared property is required.
 *
 * OpenAI-lineage models reject `strict: true` schemas that have optional
 * properties, and OpenRouter forwards that rejection verbatim. Rather than
 * hand-maintaining a `required` array that has to list every field — which drifts
 * the moment someone adds a property — the required list is derived from
 * `properties` at request time.
 *
 * Being required does not mean being meaningful: the client's Zod schemas accept
 * empty strings and empty arrays everywhere, so a model that has nothing to say
 * for a field says `""` and nothing downstream cares.
 */
function deepRequire(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(deepRequire)
  if (!node || typeof node !== 'object') return node

  const out: JsonSchema = {}
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    out[key] = deepRequire(value)
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.required = Object.keys(out.properties as JsonSchema)
    out.additionalProperties = false
  }
  return out
}

export function strictify(schema: JsonSchema): JsonSchema {
  return deepRequire(schema) as JsonSchema
}

/* ────────────────────────────────────────────────────────────────────────────
 * Chat edit response (§18)
 * ──────────────────────────────────────────────────────────────────────────── */

export const AI_EDIT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'message', 'operations'],
  properties: {
    action: {
      type: 'string',
      enum: ['update_resume', 'reply', 'change_template'],
      description:
        'update_resume when modifying the resume, reply when only answering a question, change_template when switching template.'
    },
    message: {
      type: 'string',
      description: 'One to three sentences telling the user what you changed and why. Plain text.'
    },
    operations: {
      type: 'array',
      description:
        'The edits to apply. Empty when action is reply. Use the smallest set of operations that achieves the request.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: {
            type: 'string',
            enum: ['replace', 'add', 'remove', 'move'],
            description:
              'replace overwrites a value; add appends to an array (use /- as last segment); remove deletes; move reorders.'
          },
          path: {
            type: 'string',
            description:
              'JSON Pointer into the resume, e.g. /summary, /experience/0/bullets/1, /skills/0/items, /experience/-'
          },
          value: {
            description:
              'The new value: a string for text fields, an array of strings for bullet lists, an object for a new entry. Omit for remove and move.'
          },
          toIndex: {
            type: 'integer',
            description: 'Destination index, only for move.'
          }
        }
      }
    },
    suggestions: {
      type: 'array',
      description:
        'Things the user should consider adding that you could NOT write yourself because you lack the facts (e.g. a metric). Never invent these into the resume.',
      items: { type: 'string' }
    },
    requiresReview: {
      type: 'boolean',
      description:
        'true when the change is substantial and the user should review a diff before it applies.'
    },
    templateId: {
      type: 'string',
      description: 'Only when action is change_template. Empty string otherwise.'
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Job description analysis (§26)
 * ──────────────────────────────────────────────────────────────────────────── */

const stringArray = { type: 'array', items: { type: 'string' } } as const

export const JOB_ANALYSIS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobTitle: { type: 'string' },
    seniority: {
      type: 'string',
      description: 'e.g. Junior, Mid, Senior, Staff — only if stated or clearly implied.'
    },
    requiredKeywords: {
      ...stringArray,
      description:
        'Hard requirements stated in the posting. Concrete nouns and technologies, not sentences.'
    },
    preferredKeywords: { ...stringArray, description: 'Nice-to-haves and "bonus" items.' },
    skills: stringArray,
    technologies: stringArray,
    responsibilities: stringArray,
    softSkills: stringArray,
    educationRequirements: stringArray,
    experienceRequirements: stringArray
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Import normalisation (§12)
 * ──────────────────────────────────────────────────────────────────────────── */

export const RESUME_IMPORT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    looksLikeResume: {
      type: 'boolean',
      description: 'false when the document is not a resume at all.'
    },
    personal: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fullName: { type: 'string' },
        headline: {
          type: 'string',
          description: 'Current title or tagline, ONLY if the resume states one.'
        },
        email: { type: 'string' },
        phone: { type: 'string' },
        location: {
          type: 'string',
          description: 'Exactly as written. Do not expand a city into "City, State".'
        },
        linkedin: { type: 'string' },
        github: { type: 'string' },
        portfolio: { type: 'string' }
      }
    },
    summary: {
      type: 'string',
      description:
        'The existing summary or objective, verbatim. Empty string if absent — do not write one.'
    },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          company: { type: 'string' },
          position: { type: 'string' },
          location: { type: 'string' },
          startDate: { type: 'string', description: 'As written, e.g. "Jan 2022" or "2022".' },
          endDate: { type: 'string', description: 'Empty when the role is current.' },
          current: { type: 'boolean' },
          bullets: { ...stringArray, description: 'Verbatim bullet text.' }
        }
      }
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          institution: { type: 'string' },
          degree: { type: 'string' },
          field: { type: 'string' },
          location: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          gpa: { type: 'string' },
          details: stringArray
        }
      }
    },
    skills: {
      type: 'array',
      description:
        'Group by the categories the resume itself uses. One group with an empty category is fine.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string' },
          items: stringArray
        }
      }
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          technologies: stringArray,
          url: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          bullets: stringArray
        }
      }
    },
    certifications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          issuer: { type: 'string' },
          date: { type: 'string' },
          credentialId: { type: 'string' },
          url: { type: 'string' }
        }
      }
    },
    achievements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          date: { type: 'string' }
        }
      }
    },
    languages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          proficiency: { type: 'string' }
        }
      }
    },
    customSections: {
      type: 'array',
      description:
        'Any section that does not fit the fields above (Publications, Volunteering, ...).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                subtitle: { type: 'string' },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                description: { type: 'string' },
                bullets: stringArray
              }
            }
          }
        }
      }
    },
    confidence: {
      type: 'number',
      description:
        '0 to 1. How confident you are that the extraction is complete and correctly attributed. Lower it when the layout was ambiguous, columns interleaved, or dates unclear.'
    },
    warnings: {
      ...stringArray,
      description:
        'Short notes about what the user should double-check, e.g. "Dates for the second role were ambiguous".'
    },
    needsReview: {
      ...stringArray,
      description:
        'Section names the user should verify, e.g. ["experience", "education"]. Empty when you are confident throughout.'
    },
    detectedSections: {
      ...stringArray,
      description: 'Which sections you actually found in the source text.'
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * ATS review (§27)
 * ──────────────────────────────────────────────────────────────────────────── */

export const ATS_REVIEW_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobRelevance: {
      type: 'number',
      description:
        '0-100. How well this resume matches the target role. 50 if no job description was given.'
    },
    contentQuality: {
      type: 'number',
      description:
        '0-100. Strength of the writing: action verbs, specificity, absence of filler.'
    },
    experienceRelevance: {
      type: 'number',
      description: '0-100. Relevance and depth of the experience shown.'
    },
    strengths: stringArray,
    weaknesses: stringArray,
    suggestions: {
      type: 'array',
      description: 'Concrete improvements, highest impact first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Short label, e.g. "Improve Summary".' },
          detail: { type: 'string' },
          instruction: {
            type: 'string',
            description: 'The exact instruction to send back to you to perform this change.'
          },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] }
        }
      }
    },
    supportedMissingKeywords: {
      ...stringArray,
      description:
        'Job-description keywords the resume clearly demonstrates but never names. Only include when the existing content is real evidence for it.'
    },
    unsupportedKeywords: {
      ...stringArray,
      description:
        'Job-description keywords with NO evidence in the resume. These will be shown as "add only if you genuinely have this experience".'
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Single-text rewrite (§50)
 * ──────────────────────────────────────────────────────────────────────────── */

export const REWRITE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: 'The rewritten text. Never empty.' },
    note: {
      type: 'string',
      description:
        'One short sentence for the user, or empty. Use it to say what you could not do without a fact they did not give you.'
    },
    changed: { type: 'boolean', description: 'false when the original was already good.' }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Request specs
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Ready-made specs, so a route never has to decide whether strict mode is safe.
 *
 * Strict mode is a real win where every field has a concrete type — the model
 * physically cannot return the wrong shape. It is unusable for the edit schema,
 * because an operation's `value` is legitimately a string, a string array, or an
 * object depending on the path, and strict structured output has no way to say
 * "any JSON here". Forcing a type there would break more requests than it fixes,
 * so the edit schema ships as a non-strict hint and leans on the client's Zod
 * validation — which was always the real boundary anyway.
 */
export const EDIT_SPEC = { name: 'zyro_resume_edit', schema: AI_EDIT_SCHEMA, strict: false }

export const IMPORT_SPEC = {
  name: 'zyro_resume_import',
  schema: strictify(RESUME_IMPORT_SCHEMA),
  strict: true
}

export const JOB_SPEC = {
  name: 'zyro_job_analysis',
  schema: strictify(JOB_ANALYSIS_SCHEMA),
  strict: true
}

export const ATS_SPEC = { name: 'zyro_ats_review', schema: strictify(ATS_REVIEW_SCHEMA), strict: true }

export const REWRITE_SPEC = { name: 'zyro_rewrite', schema: strictify(REWRITE_SCHEMA), strict: true }

// aiService.ts - Logic moved to main process via IPC
import { classifyIntent, IntentResult } from './pipeline/intentClassifier'
import { planAnswer, AnswerPlan } from './pipeline/answerPlanner'
import { enforceHumanLikeness, normalizeBulletFormatting } from './pipeline/humanLikeness'
import { inspectAndSanitizeAnswerCode } from './pipeline/codeSanityCheck'
import { getSystemDesignDiagramPrompt } from './pipeline/diagramIntelligence'
import { liveSessionMemory } from './pipeline/liveSessionMemory'
import {
  buildLanguageDirective,
  coerceResponseLanguages,
  detectUtteranceLanguage,
  exampleFillerFor,
  resolveResponseLanguage,
  resolveSttLocale,
  type LanguageCode
} from './pipeline/languagePolicy'

export interface SessionData {
  name: string
  role: string
  company: string
  language: string
  resumeText: string
  groqApiKey?: string
  autoAnswer: boolean
  experienceLevel: 'fresher' | 'experienced'
  experienceDuration?: string
  workHistory?: string
  sessions_balance?: number
  trial_seconds_used?: number
  isPremium?: boolean
  codingLanguage?: string
  interviewContent?: string
  activeKbId?: string
  sessionStartedFromSchedule?: boolean
  hasHold?: boolean
  /** 1–2 answer languages the user configured (raw config; normalized on init). */
  responseLanguages?: string[]
}

export interface AnswerStreamOptions {
  /**
   * Called with the accumulated raw answer on every delta. Supplying it is what
   * switches this request onto the streaming transport.
   */
  onDelta: (partial: string) => void
  /** Correlates `answer-chunk` events with this request. Generated if omitted. */
  requestId?: string
}

let sessionContext: SessionData | null = null
// Resolved, validated answer-language selection (1–2 entries, English fallback).
// Populated by initAI via coerceResponseLanguages; defaults to English single-mode
// for users with no explicit selection.
let responseLanguages: LanguageCode[] = ['en']
/**
 * Locale handed to the recogniser, resolved once per session.
 *
 * Pinning it makes every other configured answer language unreachable: the recogniser
 * is told the audio is (say) English, so Hindi speech comes back as English-ish Latin
 * text and no downstream signal can recover it -- which is how a Hindi question ended
 * up transcribed AND answered in English. So more than one configured answer language
 * means the recogniser must be left free to detect per utterance.
 */
let sttLanguage = 'auto'
const MODEL_NAME = 'openai/gpt-oss-120b'        // Text/chat model
let activeCodingChallenge: string = ''

function getExperienceContext(): string {
  if (!sessionContext) return ''
  const targetCompany = sessionContext.company ? `"${sessionContext.company}"` : 'the company'

  if (sessionContext.experienceLevel === 'fresher') {
    return `
⚠️ EXPERIENCE LEVEL — FRESHER (CRITICAL — NEVER IGNORE):
- The candidate is a FRESHER. They have NO prior full-time paid work experience at any company.
- The company name in the context (${targetCompany}) is the company they are CURRENTLY INTERVIEWING FOR — NOT a place they have worked at. NEVER say "I worked at ${targetCompany}" or treat it as a past employer.
- NEVER say "In my previous role at [any company]" or fabricate job titles, work durations, or employers.
- For "tell me about yourself": Introduce yourself as a ${sessionContext.role}. Mention your transition from education to professional work and highlight your project achievements as your primary "work" evidence.
- For technical/behavioral questions: Focus heavily on the personal/college/internship projects listed in your resume. Treat them with the same importance as jobs.
- Confidence is key — frame your project experience as high-quality practical work.
`
  }

  const duration = sessionContext.experienceDuration || 'some time'
  const workHistory = sessionContext.workHistory?.trim()

  if (workHistory) {
    return `
⚠️ EXPERIENCE LEVEL — EXPERIENCED (CRITICAL — NEVER IGNORE):
- The candidate has ${duration} of professional experience.
- The company name (${targetCompany}) is the company they are CURRENTLY INTERVIEWING FOR — NOT necessarily a past employer.
- NEVER claim more experience than ${duration}. Do not fabricate additional jobs beyond what is listed.
- Their past work context (use this for introduction and behavioral answers ONLY if asked): ${workHistory}
- Do NOT elaborate more than necessary on past work — keep it brief in introduction and only expand if the interviewer asks.
- NEVER invent company names, roles, or responsibilities beyond what is in their work history or resume.
`
  }

  return `
⚠️ EXPERIENCE LEVEL — EXPERIENCED (CRITICAL — NEVER IGNORE):
- The candidate has ${duration} of professional experience.
- The company name (${targetCompany}) is the company they are CURRENTLY INTERVIEWING FOR — NOT a past employer.
- For introduction: Simply say "I have ${duration} of experience in [field from resume]". Do NOT mention specific past companies unless they are explicitly in the resume.
- NEVER fabricate company names, job titles, or work details not present in the resume.
- NEVER claim more experience than ${duration}.
`
}



export function initAI(data: SessionData): void {
  console.log('[AI-Train] Initializing AI with context:', {
    name: data.name,
    role: data.role,
    company: data.company,
    resumeLength: data.resumeText?.length
  })

  // Clear any existing session history/cache to prevent carry-over
  liveSessionMemory.clearMemory()
  activeCodingChallenge = ''

  if (data.groqApiKey) window.api.initGroq(data.groqApiKey)
  sessionContext = data
  // Resolve the answer-language selection once per session (migrates legacy configs
  // to Hindi single-mode; clamps to 1–2 languages with English as the fallback).
  responseLanguages = coerceResponseLanguages(data.responseLanguages, data.language)
  sttLanguage = resolveSttLocale(responseLanguages, data.language)

  // Index resume and interview content locally on-device
  if (data.resumeText && window.api?.indexLocalContent) {
    window.api.indexLocalContent('resume', data.resumeText).catch(() => {})
  }
  if (data.interviewContent && window.api?.indexLocalContent) {
    window.api.indexLocalContent('interview_content', data.interviewContent).catch(() => {})
  }
}

/** The locale the recogniser is being run with. Single source of truth for STT. */
export function getSttLanguage(): string {
  return sttLanguage
}

export function getCurrentModelName(): string {
  return MODEL_NAME
}

export async function parseResumePDF(base64Data: string): Promise<string> {
  if (!window.api?.parsePdf) {
    throw new Error('PDF parsing not available in this environment.')
  }
  return await window.api.parsePdf(base64Data)
}

export async function refineResumeWithAI(rawText: string): Promise<string> {
  if (!sessionContext) return rawText

  const systemPrompt = `You are a professional resume parser and information extractor.
TASK: Extract ALL information from the raw resume text and structure it clearly.
GUIDELINES:
- **EXTRACT ONLY**: Use ONLY information explicitly present in the provided text. Do NOT invent anything.
- **FORBIDDEN**: Do NOT add, assume, or fabricate any details — no placeholder names, dates, companies, or universities.
- **COMPLETENESS IS CRITICAL**: Extract every detail present — names, companies, dates, percentages, tech stack, project names, achievement numbers, links, certifications — everything.
- If a field is missing from the resume, omit that section entirely.
- Structure the output as clean Markdown with these sections (only include sections that exist in the resume):
  1. **Personal Info** — Full name, contact email, phone, LinkedIn, GitHub, portfolio
  2. **Professional Summary** — Exact summary or objective if present
  3. **Tech Stack & Skills** — All technologies, languages, frameworks, tools, databases mentioned
  4. **Work Experience** — For each role: Company name, Job title, Dates, all responsibilities and achievements with exact numbers/metrics
  5. **Projects** — Project name, description, tech used, outcomes/metrics
  6. **Education** — Institution, degree, field, dates, percentage/GPA if mentioned
  7. **Certifications & Courses** — All certifications, courses, training
  8. **Achievements & Awards** — Any competitions, rankings, recognitions
- Output: ONLY the structured Markdown content. No greetings, no commentary, no extra text.`

  try {
    return await window.api.generateAnswer({
      transcript: `Extract and structure ALL information from this resume:\n\n${rawText.substring(0, 8000)}`,
      model: MODEL_NAME,
      systemPrompt,
      maxTokens: 1200
    })
  } catch (err) {
    console.error('[AI] Resume Refinement Error:', err)
    return rawText // fallback to raw text if AI fails
  }
}

function getIntroTemplate(): string {
  if (!sessionContext) return ''
  const { name, role, company, experienceLevel, experienceDuration, workHistory } = sessionContext

  const fresherIntro = `I am ${name}, a ${role}${company ? ` applying for the role at ${company}` : ''}. I recently completed my studies and have been deeply involved in building several key projects that demonstrate my skills in [Reference specific skills/tech from resume]. I am excited to bring this hands-on project experience to a professional environment.`

  const expNoHistory = `I am ${name}, a ${role} with ${experienceDuration || 'some'} of experience. My background focuses on [Mention key skills from resume], and I have successfully delivered projects such as [Mention 1-2 major projects from resume]. I am looking forward to contributing my expertise${company ? ` to ${company}` : ''}.`

  const expWithHistory = `I am ${name}, a ${role} with ${experienceDuration || 'some'} of professional experience. ${workHistory}. Throughout my career, I've prioritized [Key theme from resume], and I'm particularly proud of my work on [Project from resume]. I am now seeking a new challenge${company ? ` at ${company}` : ''}.`

  let template = ''
  if (experienceLevel === 'fresher') template = fresherIntro
  else if (workHistory?.trim()) template = expWithHistory
  else template = expNoHistory

  return `
INTRODUCTION TEMPLATE (use this as the BASE when asked "tell me about yourself", "introduce yourself", "give your introduction", or similar):
- Always build the introduction using BOTH this template AND the actual resume content below.
- Fill in [bracketed placeholders] with real details from the resume — skills, specific projects, tech stack, education institution.
- Break the template into 5-7 separate bullet points, one idea per bullet, following the mandatory bullet-point output format. Do NOT output it as a single flowing paragraph.
- Do NOT add experience or companies beyond what is in the template or the resume.
TEMPLATE: ${template}
`
}

// getInterviewContentPrompt removed — interview content is now served exclusively
// through the on-device local RAG pipeline. When a question is asked, the top-3
// semantically relevant chunks from the indexed interview_content source are
// injected via localRagContext, eliminating ~1,200 wasted tokens per request.

/**
 * Universal bullet-point output contract.
 *
 * The model kept answering in prose paragraphs, which is unreadable on a glance
 * during a live interview. This forces every answer — technical, behavioural,
 * coding, Hinglish — into a scannable point list, and tells the model how to
 * ORDER those points so they build an argument instead of repeating each other.
 */
function getAnswerFormatContract(intent: string, answerPlan?: AnswerPlan): string {
  const min = answerPlan?.bulletsMin ?? 4
  const max = answerPlan?.bulletsMax ?? 6

  // Intent-specific point skeleton ("smart pointing" — each bullet answers the
  // next question the interviewer would naturally ask.
  let skeleton: string
  switch (intent) {
    case 'identity':
      skeleton = `- Point 1: Who you are — name, current role, and years/level of experience.
- Point 2: Your core technical strengths, named explicitly from the resume.
- Point 3: One flagship project or achievement with a concrete outcome.
- Point 4: One more project or responsibility that shows range.
- Point 5: Why you are a fit for this role, and what you want to do next.`
      break

    case 'behavioral':
    case 'project_deepdive':
      skeleton = `- Point 1: The situation — one sentence of context: what was the problem and why it mattered.
- Point 2: The constraint or difficulty — what made this hard, risky, or ambiguous.
- Point 3: Your reasoning — WHY you chose this specific approach over alternatives.
- Point 4: The concrete action you took — name the tool, technique, or process step explicitly.
- Point 5: The measurable outcome — a number, a percentage, a deadline met, or quality improvement.
- Point 6: The lesson or process change you now apply going forward.`
      break

    case 'system_design':
      skeleton = `- Point 1: The core requirement and scale you are designing for.
- Point 2: The high-level component breakdown.
- Point 3: The data store choice and why it fits.
- Point 4: How the design scales — caching, sharding, queues, load balancing.
- Point 5: The main trade-off or failure mode you accept.
- Point 6: A real-world example of this pattern in production.`
      break

    case 'definitional':
    case 'technical_concept':
    default:
      skeleton = `- Point 1: The direct definition or direct answer — one precise sentence, no filler.
- Point 2: How it actually works internally — the mechanism, not just the label.
- Point 3: WHEN to use this versus the most common alternative, and WHY one wins over the other in that scenario.
- Point 4: The failure mode — what breaks or degrades if this is applied incorrectly or ignored.
- Point 5: A concrete real-world example with a specific outcome or metric.
- Point 6 (only if genuinely needed): A best-practice edge case or nuance a senior practitioner would know.`
      break
  }

  return `
=== 🔴 MANDATORY OUTPUT FORMAT — BULLET POINTS ONLY (HIGHEST PRIORITY RULE) ===
Prose paragraph answers are STRICTLY FORBIDDEN. Every answer is a Markdown point list.

STRUCTURE RULES:
1. Every single line of your answer starts with "- " (a hyphen then ONE space). Never use "*", "•", "→", "·", or numbered lists as bullet markers.
2. Each bullet sits on its OWN line. Never put two bullets on one line. Never join bullets with commas.
3. Each bullet is ONE complete, self-contained sentence. Simple factual bullets: 10-18 words. Behavioral, technical depth, or reasoning bullets: up to 30 words if needed to be precise — never pad, never cut depth.
4. The FIRST character of your reply is "-". No opening line, no preamble, no "Here is", no restating the question, no closing summary paragraph.
5. Produce ${min} to ${max} bullets. Never fewer than ${min}. Quality over padding: if you only have ${min} real points, stop at ${min}.
6. Never repeat the same idea in two bullets. Every bullet must add new information.
7. Finish the final bullet completely. Never stop mid-sentence and never leave a dangling "-" at the end.

PRECISION & DEPTH RULES (THIS IS WHAT SEPARATES A GOOD ANSWER FROM A GREAT ONE):
- SHOW YOUR REASONING: Do not just state what you did — briefly state WHY you chose that approach. "I used Cohen's kappa because it corrects for chance agreement, unlike a raw accuracy score."
- SPECIFIC OVER GENERIC: Never say "I improved quality" when you can say "I reduced label errors by 15% using gold-standard spot-checks.". Always prefer numbers, percentages, named tools.
- TECHNICAL TERMS — ALWAYS EXPLAIN WHEN/WHY: If you name a metric, algorithm, or methodology (e.g. Cohen's kappa, stratified sampling, IOU threshold), in the SAME bullet explain when it applies and why you chose it over the obvious alternative.
- GROUND CLAIMS IN EVIDENCE: If discussing a document, text, or specific example — reference the actual detail before making a claim. Never make an assertion that floats without backing.
- AVOID VAGUE PROCESS LANGUAGE: "I created a systematic process" is weak. "I built a 12-point checklist with version control that reduced rework by 20%" is strong.
- EXPERT COMPLETENESS — GO ONE LEVEL DEEPER: When the topic has well-known adjacent expert concepts, proactively include them even if not literally asked. Examples: PII/privacy → also mention least-privilege access, retention limits, quasi-identifiers, re-identification risk. Data annotation → also mention inter-rater reliability, edge-class stratification. Security → also mention threat modeling, blast radius. A recruiter or hiring manager expects to hear these; omitting them makes the answer sound junior.
- CRISP BEFORE COMPLETE: Lead with the direct answer in the first bullet — no warm-up, no "So basically...", no restating the question. Every subsequent bullet must add NEW depth, not repeat or paraphrase the first.

SMART POINTING — order the bullets so the answer builds logically:
${skeleton}

WORDING RULES:
- Front-load each bullet with the meaningful word, not with filler. Write "- Debugging is the process of finding and fixing errors in code." not "- Basically it is when you find errors."
- Use **bold** ONLY on a genuine technical keyword inside a bullet, and at most twice in the whole answer. NEVER bold an entire bullet, and never bold the first bullet.
- Keep each bullet speakable out loud as a natural sentence — this is a spoken interview answer that happens to be laid out as points.
- Do NOT add any emoji, icon, symbol, or decorative prefix anywhere in the answer.
=== END OUTPUT FORMAT ===`
}

export function getSystemPrompt(
  intentResult?: IntentResult,
  answerPlan?: AnswerPlan,
  localRagContext?: string,
  sessionMemoryContext?: string,
  responseLang: LanguageCode = 'en'
): string {
  if (!sessionContext) return ''

  const intent = intentResult?.intent || 'general_factual'
  const isSystemDesign = intent === 'system_design'
  const isCoding = intent === 'dsa_coding'
  const isIdentity = intent === 'identity'
  const isBehavioral = intent === 'behavioral' || intent === 'project_deepdive'
  const isConceptOrDef = intent === 'definitional' || intent === 'technical_concept'

  // 1. Coding Directive (ONLY for DSA Coding)
  const codingLang = sessionContext.codingLanguage || 'python'
  const codingDirective = isCoding ? `
=== 🔴 MANDATORY CODING / DSA OUTPUT FORMAT (OVERRIDES THE GENERIC BULLET CONTRACT) ===
A coding answer is a sequence of labelled point-blocks plus ONE code block. Follow this exact skeleton:

**Understanding**
- One bullet restating the input, output, and the key constraint.
- One bullet naming the edge cases you will handle (empty input, duplicates, overflow).

**Approach**
- One bullet on the brute-force idea and its complexity.
- One bullet naming the optimal data structure or algorithm you will use instead.
- One bullet on WHY that structure removes the bottleneck.

\`\`\`${codingLang}
# Complete, runnable, production-ready solution.
# Comment the non-obvious lines only.
\`\`\`

**Dry Run**
- One bullet with the sample input you are tracing.
- One bullet with the state after the key iteration and the final returned value.

**Complexity**
- Time Complexity: O(?)
- Space Complexity: O(?)

CODING RULES:
- The four labels above are written EXACTLY as bold lines on their own: **Understanding**, **Approach**, **Dry Run**, **Complexity**. No other headings.
- Every non-heading, non-code line starts with "- ". No prose paragraphs anywhere.
- Exactly ONE fenced code block, tagged \`${codingLang}\`, and it must be complete and syntactically valid. Never truncate it.
- Write the code in ${codingLang} unless the interviewer explicitly named another language.
=== END CODING FORMAT ===` : ''

  // 2. System Design & Diagram Directive (ONLY for System Design)
  const diagramInstruction = getSystemDesignDiagramPrompt(isSystemDesign)

  // 2b. Universal bullet-point contract (skipped for coding — the coding format
  // above already defines its own stricter point layout).
  const formatContract = isCoding ? '' : getAnswerFormatContract(intent, answerPlan)

  // 3. Voice & Identity
  const voiceRule = answerPlan?.voicePerspective === 'neutral_explanation'
    ? 'Explain technical concepts clearly, objectively, and directly without unnecessary personal narrative.'
    : `Write the answer AS ${sessionContext.name} — the candidate sitting in this interview. Every "I" in the answer refers to ${sessionContext.name}. Never refer to yourself as an AI, a tool, or "Natively". The interviewer is reading this answer as words spoken by ${sessionContext.name}.`

  // 4. Resume & Experience Context (ONLY for Identity, Behavioral, or when required)
  let profileSection = ''
  if (answerPlan?.profileContextPolicy === 'required' || isIdentity || isBehavioral) {
    profileSection = `
${getExperienceContext()}
${isIdentity ? getIntroTemplate() : ''}
=== CANDIDATE RESUME ===
${sessionContext.resumeText?.substring(0, 2500) || ''}
=== END OF RESUME ===`
  } else if (answerPlan?.profileContextPolicy === 'allowed' || isSystemDesign) {
    profileSection = `\n**CANDIDATE BACKGROUND**: ${sessionContext.name}, ${sessionContext.role} with expertise in modern scalable architectures.`
  }

  // 5. Cheat Sheet Notes: served via localRagContext (on-device RAG, top-3 relevant chunks)
  // No full-text injection — see localRagContext below.

  // 6. Real-World Example Rule. The lead-in phrase follows the answer language;
  // when we have no safe connector for that language we let the model phrase the
  // example naturally rather than forcing an English "For example,".
  const exampleLeadIn = exampleFillerFor(responseLang)
  const exampleRule = (intentResult?.requiresExample || answerPlan?.requiresExample || isConceptOrDef || isSystemDesign)
    ? exampleLeadIn
      ? `EXAMPLE RULE (MANDATORY): One of your bullets must be a concrete real-world example, and that bullet starts with "- ${exampleLeadIn.trim()}".`
      : 'EXAMPLE RULE (MANDATORY): One of your bullets must be a concrete real-world example, phrased naturally in the answer language.'
    : ''

  // 7. Hard language lock. The answer language is decided once per utterance (see
  // resolveResponseLanguage) and emitted here as a single unambiguous directive,
  // placed up top where it carries the most weight — the model otherwise drifts
  // back toward English a sentence or two in.
  const languageDirective = buildLanguageDirective(responseLang)

  return `You are a real-time AI interview copilot. Your only job is to generate the perfect spoken answer that ${sessionContext.name} will say out loud to the interviewer in a live interview.
${languageDirective}
CORE MISSION — READ THIS FIRST:
Every word you output is the candidate's voice. The interviewer hears this answer as if ${sessionContext.name} is speaking it. Write for a human who is about to read it aloud, naturally and confidently.

CRITICAL IDENTITY RULE:
- You are a background tool — NEVER identify yourself as "Natively", "Zyro", or any AI product name in the answer. The candidate is not an AI.
- If the interviewer asks about AI tools the candidate uses (e.g. "do you use ChatGPT / Copilot?"), answer honestly using the candidate's actual tools from their resume/context. That is a legitimate question about the candidate's workflow.
- When the question is personal/behavioral (identity, introduction, behavioral): write entirely in first person as ${sessionContext.name}. Every "I" = ${sessionContext.name}, not an AI tool.
- When the question is technical/factual: explain objectively, no personal narrative unless the question asks for it.

IDENTITY & VOICE:
- ${voiceRule}
- Never say "Certainly!", "Of course!", "Great question!", or "As an AI...".
- NO greetings or filler openers. Start your answer immediately.

ANTI-AI TELLS & SPOKEN NATURALNESS:
- BANNED PUNCTUATION: NEVER use em-dashes (—) or semicolons (;). Use standard commas or separate sentences.
- BANNED BUZZWORDS: Do NOT use "delve", "leverage", "rich tapestry", "moreover", "furthermore", "it is important to note that".
- Write output so it reads like a real human naturally speaking out loud in an interview.
- COMPLETENESS (CRITICAL): Always conclude your thoughts cleanly and fully. Finish every sentence, bullet point, and code block completely before stopping. Never cut off mid-thought.

### ANSWER DEPTH (bullet counts, not paragraphs):
- **Definition / Concept**: 4-6 points. Definition → how it works → why it matters → real example.
- **Behavioral / Identity**: 5-7 points. Context → what YOU did → measurable outcome.
- **System Design**: 5-7 points + a clean Mermaid diagram.
- **Coding / DSA**: follow the mandatory coding format below.
${formatContract}
${codingDirective}
${diagramInstruction}
${exampleRule}
${sessionMemoryContext || ''}
${localRagContext || ''}
${profileSection}
${sessionContext.company ? `\n**TARGET COMPANY**: Interviewing at ${sessionContext.company}.` : ''}`
}

type AnswerRequest = Parameters<Window['api']['generateAnswer']>[0]

/**
 * One request, two transports. Deltas are streamed only when the caller passes
 * `onDelta` AND the preload exposes the channel; otherwise this is the original
 * buffered invoke. A stream that yields nothing (gateway error after a 200, or a
 * first-byte timeout) retries once on the buffered path rather than handing the
 * user an empty answer.
 */
async function requestAnswer(
  payload: AnswerRequest,
  stream?: AnswerStreamOptions
): Promise<string> {
  const canStream = Boolean(
    stream?.onDelta && window.api?.generateAnswerStream && window.api?.onAnswerChunk
  )
  if (!stream || !canStream) return window.api.generateAnswer(payload)

  const requestId =
    stream.requestId ?? `ans-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const unsubscribe = window.api.onAnswerChunk!((chunk) => {
    if (chunk.requestId !== requestId) return
    // `full` is the accumulated text, so the renderer never reassembles deltas.
    if (chunk.full) stream.onDelta(chunk.full)
    if (chunk.error) console.warn('[AI Pipeline] stream error:', chunk.error)
  })

  try {
    const streamed = await window.api.generateAnswerStream!({ ...payload, requestId })
    if (streamed && streamed.trim()) return streamed
    console.warn('[AI Pipeline] stream produced no text — retrying buffered')
    return window.api.generateAnswer(payload)
  } finally {
    unsubscribe()
  }
}

export async function generateInterviewAnswer(
  transcript: string,
  detectedLanguage?: LanguageCode,
  stream?: AnswerStreamOptions
): Promise<string> {
  if (!sessionContext) return 'AI not initialized.'

  if (!transcript || transcript.trim().length < 4) {
    return ''
  }

  const lowerT = transcript
    .toLowerCase()
    .replace(/[.,!?;:]/g, '')
    .trim()
  const commonH = [
    'thank you',
    'thanks for watching',
    'thanks for',
    'subtitle by',
    'bye',
    'you',
    'please subscribe',
    'subscribe',
    'thanks',
    'notification',
    'alert',
    'ding',
    'ping',
    'chime',
    'ringtone'
  ]
  if (commonH.includes(lowerT)) {
    console.log('[AI] Ignoring likely silence/notification hallucination:', transcript)
    return ''
  }

  // Record interviewer turn in Live Session Memory
  liveSessionMemory.recordTurn('interviewer', transcript)
  const sessionMemoryContext = liveSessionMemory.getSessionTimelinePrompt(transcript)

  // Natively Pipeline Step 1: Intent Classification
  const intentResult = classifyIntent(transcript)

  // Natively Pipeline Step 2: Answer Planning
  const answerPlan = planAnswer(intentResult)

  // Response-language decision (per-utterance). Prefer the language surfaced by the
  // caller (OverlayPage combines the STT-detected language + Devanagari pin); fall
  // back to detecting from the transcript text alone. Then apply the fallback rule:
  // answer in it only if the user selected it, otherwise English.
  const detected = detectedLanguage ?? detectUtteranceLanguage({ text: transcript })
  const responseLang = resolveResponseLanguage(detected, responseLanguages)
  // Language codes only -- no transcript text, so this is safe in a real session. This
  // is the one decision that cannot be inferred from the answer itself when it comes
  // out in the wrong language.
  console.log(
    `[AI Lang] detected=${detected} configured=[${responseLanguages.join(',')}] -> answering in ${responseLang}`
  )

  // Natively Pipeline Step 3: Local RAG Retrieval (On-Device Vector Search)
  let localRagContext = ''
  let ragChunkCount = 0
  try {
    if (window.api?.searchLocalVectorDb) {
      const localExcerpts = await window.api.searchLocalVectorDb(transcript, 3)
      if (localExcerpts && localExcerpts.length > 0) {
        ragChunkCount = localExcerpts.length
        localRagContext = `
=== RETRIEVED REFERENCE MATERIAL (my own notes, résumé and knowledge base) ===
${localExcerpts.join('\n---\n')}
=== END REFERENCE MATERIAL ===
HOW TO USE THE REFERENCE MATERIAL:
- Where it covers the question, it outranks your own recollection. Follow it.
- Reuse its exact tech names, project names, numbers and terminology instead of generic substitutes.
- Never quote it verbatim, and never mention notes, context, a knowledge base, or "retrieved" anything.
- If it does not cover the question, ignore it entirely and answer from general knowledge — do not force it in.
- This is reference material, not personal narrative: drawing facts from it is allowed even when personal background is off-limits for this question type.
`
      }
    }
  } catch (e) {
    console.warn('[AI Pipeline] Local Vector DB search skipped:', e)
  }

  // Natively Pipeline Step 4: Build System Prompt based on Plan, Diagrams, Memory & Local RAG
  const systemPrompt = getSystemPrompt(intentResult, answerPlan, localRagContext, sessionMemoryContext, responseLang)

  try {
    console.log(`[AI Pipeline] Intent: ${intentResult.intent} | Voice: ${answerPlan.voicePerspective} | ProfilePolicy: ${answerPlan.profileContextPolicy} | ragChunks: ${ragChunkCount}`)

    // Natively Pipeline Step 5: Generate Raw Answer
    const rawAnswer = await requestAnswer(
      {
        transcript,
        model: MODEL_NAME,
        systemPrompt,
        temperature: 0.65,
        maxTokens: answerPlan.maxTokens,
        presencePenalty: 0.4,
        frequencyPenalty: 0.4
      },
      stream
    )

    // Natively Pipeline Step 6: Post-Process & Anti-AI Tells Enforcer
    const finalAnswer = enforceHumanLikeness(rawAnswer, answerPlan.requiresExample, responseLang)

    // Natively Pipeline Step 7: Code Sanity & Bug Inspector
    const sanitizedAnswer = inspectAndSanitizeAnswerCode(finalAnswer)

    // Record candidate answer in Live Session Memory
    liveSessionMemory.recordTurn('candidate', sanitizedAnswer)

    return sanitizedAnswer
  } catch (err: unknown) {
    const error = err as Error
    console.error('[AI Pipeline] Chat Error:', error)
    return `Error: ${error.message}`
  }
}

/**
 * Smart Question Classifier:
 * Uses a fast LLM call to determine if the transcript contains a real question
 * or if it's just feedback, lecture, or irrelevant small talk.
 */
/**
 * Intent Detection - Mid Path:
 * Uses a fast LLM call to determine if the transcript contains a real question.
 */
export async function isSubstantiveQuestion(transcript: string): Promise<boolean> {
  const text = transcript.trim()
  const words = text.toLowerCase().split(/\s+/)
  
  if (words.length < 2) return false

  // Fast Path (Heuristics)
  // Check first few words for common question starters
  const starters = words.slice(0, 3).map(w => w.replace(/[^a-z]/g, ''))
  const questionWords = [
    'what', 'how', 'why', 'can', 'could', 'tell', 'explain', 'describe',
    'write', 'code', 'implement', 'give', 'show', 'where', 'when', 'which',
    'is', 'are', 'do', 'does', 'did', 'if', 'discuss', 'elaborate', 'suppose'
  ]
  if (starters.some(w => questionWords.includes(w))) {
    return true
  }

  const systemPrompt = `You are a real-time intent detector. 
Classify the transcript:
1. QUESTION: Seeking information/explanation.
2. IGNORE: Feedback, lecture, noise, small talk.
Respond ONLY with "QUESTION" or "IGNORE".`

  try {
    const result = await window.api.generateAnswer({
      transcript: text,
      model: MODEL_NAME,
      systemPrompt,
      temperature: 0,
      maxTokens: 5
    })
    return result.trim().toUpperCase().includes('QUESTION')
  } catch (err) {
    return true // Default to true
  }
}

/**
 * Question Extraction Module:
 * Purifies a noisy buffer into a clean, standalone question.
 */
export async function extractCleanQuestion(rawBuffer: string): Promise<string> {
  const text = rawBuffer.trim()
  if (!text || text.length < 5) return text

  const systemPrompt = `You are a transcript purification module. 
Your ONLY job is to extract the core question from the input.
- REMOVE: Small talk, greetings, resume comments, and noise.
- RULES: Output ONLY the question. Never introduce yourself. Never describe your identity as an AI. Never explain your logic.
- IF NO QUESTION: Return the input exactly as is.

EXAMPLES:
Input: "Hi there so I was looking at your resume and it looks great anyway what is the difference between a list and a tuple?"
Output: "What is the difference between a list and a tuple?"

Input: "Okay sounds good and tell me about yourself."
Output: "Tell me about yourself."

Input: "Exactly so how do you handle state in React?"
Output: "How do you handle state in React?"`

  try {
    const result = await window.api.generateAnswer({
      transcript: text,
      model: MODEL_NAME,
      systemPrompt,
      temperature: 0,
      maxTokens: 100
    })
    
    const cleaned = result.trim()
    
    // Hallucination Safeguard: 
    // If the "cleaned" version is massively longer than the raw input, 
    // or contains robotic AI keywords, it's a hallucination. Fallback to raw.
    const roboticKeywords = ['artificial intelligence', 'ai model', 'language model', 'as an ai', 'developed by']
    if (cleaned.length > text.length * 1.5 + 50 || roboticKeywords.some(k => cleaned.toLowerCase().includes(k))) {
        console.warn('[AI-Extraction] Hallucination detected, falling back to raw text.')
        return text
    }

    return cleaned
  } catch (err) {
    console.error('[AI-Service] Extraction error:', err)
    return text
  }
}

export async function generateAudioResponse(
  base64Audio: string,
  mimeType: string = 'audio/webm'
): Promise<{ transcript: string; answer: string }> {
  if (!sessionContext?.groqApiKey) throw new Error('AI Key missing.')

  try {
    console.log('[AI] Transcribing audio only...')
    const { text: transcript, language } = await transcribeAudioOnly(base64Audio, mimeType)
    console.log('[AI] Transcribed', transcript.length, 'chars')

    if (!transcript || transcript.trim().length < 4) {
      return { transcript: '', answer: '' }
    }

    const detected = detectUtteranceLanguage({ text: transcript, whisperLang: language })
    const answer = await generateInterviewAnswer(transcript, detected)
    return { transcript, answer }
  } catch (err: unknown) {
    console.error('[AI] generateAudioResponse Error Details:', err)
    throw err
  }
}

/**
 * Speech-to-text only, no answer generation.
 *
 * Deliberately takes no transcript context: Whisper's prompt field is decoder
 * conditioning, so passing the previous utterance made it repeat or continue that
 * utterance whenever the new audio was short or quiet. The domain vocabulary hint
 * lives in the main process instead (buildSttPrompt).
 *
 * `languageOverride` exists for one specific case: the default session language is
 * `auto`, which makes every request an independent language detection. Once one clip
 * of an utterance has come back in Devanagari, the speaker is demonstrably talking
 * Hindi, and the caller pins `hi` for the rest of that utterance so a short, quiet
 * tail cannot be re-detected as some other language and come back as invented words.
 */
export async function transcribeAudioOnly(
  base64Audio: string,
  mimeType: string = 'audio/webm',
  isPartial = false,
  languageOverride?: string
): Promise<{ text: string; language?: string }> {
  if (!sessionContext) throw new Error('AI not initialized.')
  try {
    return await window.api.transcribeOnly({
      base64Audio,
      mimeType,
      language: languageOverride || sttLanguage,
      isPartial
    })
  } catch (err: unknown) {
    console.error('[AI] Groq Transcribe-Only Error:', err)
    return { text: '' }
  }
}

/**
 * Vision's mirror of requestAnswer: same two transports, same requestId contract, same
 * one-shot buffered retry when a stream yields nothing. Deltas arrive raw and get
 * replaced by the sanitized final text, exactly as on the text path.
 */
async function requestVisionAnswer(
  systemPrompt: string,
  base64Image: string,
  stream?: AnswerStreamOptions
): Promise<string> {
  const canStream = Boolean(
    stream?.onDelta && window.api?.analyzeScreenStream && window.api?.onAnswerChunk
  )
  if (!stream || !canStream) return window.api.queryVision({ systemPrompt, base64Image })

  const requestId =
    stream.requestId ?? `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const unsubscribe = window.api.onAnswerChunk!((chunk) => {
    if (chunk.requestId !== requestId) return
    // `full` is the accumulated text, so the renderer never reassembles deltas.
    if (chunk.full) stream.onDelta(chunk.full)
    if (chunk.error) console.warn('[AI Vision] stream error:', chunk.error)
  })

  try {
    const streamed = await window.api.analyzeScreenStream!({ requestId, systemPrompt, base64Image })
    if (streamed && streamed.trim()) return streamed
    console.warn('[AI Vision] stream produced no text — retrying buffered')
    return window.api.queryVision({ systemPrompt, base64Image })
  } finally {
    unsubscribe()
  }
}

export async function analyzeScreen(stream?: AnswerStreamOptions): Promise<string> {
  if (!sessionContext) return 'AI not initialized.'

  try {
    console.log('[AI] Capturing screen screenshot...')
    const base64Image = await window.api.captureScreenshot()

    // Vision has no audio signal, so we ask the model to echo the question language
    // back in its OCR step. Instead we use the same text-based detector that the audio
    // path uses — it looks for Devanagari script (हिंदी), romanized Hindi tokens
    // (mujhe, kya, batao…), or any other configured non-English script.
    // Step 1: Grab a small "pre-scan" of what's on screen to detect language.
    //   We do a lightweight first pass — just read the text, don't answer yet.
    //   Since we already have the screenshot, we detect from the prompt response lazily:
    //   instead we peek at any previously transcribed text OR run a heuristic on the image.
    //   Practical approach: build a dual-language directive so the model itself picks the
    //   right language from the two the user configured, based on what it reads on screen.

    // Build a per-language label list for the configured languages
    const configuredLangs = responseLanguages.length > 0 ? responseLanguages : ['en' as LanguageCode]

    // Build a combined vision language directive that covers ALL user-selected languages.
    // If user chose English + Hindi → model reads the screen and picks Hindi for Hindi
    // questions, English for English questions. No pre-scan needed.
    let visionDirective: string
    if (configuredLangs.length === 1) {
      // Single language — simple direct directive
      visionDirective = buildLanguageDirective(configuredLangs[0], { forVision: true })
    } else {
      // Dual-language mode: give the model both options and let it match the screen language
      const langNames = configuredLangs.map(l =>
        l === 'hi' ? 'Hindi/Hinglish (Roman script)' : l === 'en' ? 'English' : l
      ).join(' and ')
      const hindiInSet = configuredLangs.includes('hi')
      visionDirective = `
🔴 LANGUAGE LOCK — AUTO-DETECT FROM SCREEN (User configured: ${langNames}):
- Read the question on screen carefully. If the question is written in Hindi, Hinglish, or Devanagari script → answer in conversational HINGLISH (Roman/Latin letters only, NEVER Devanagari).
- If the question is written in English → answer in Simple Indian English.
- Match the language of the question on screen. Never mix: either full Hinglish or full English per answer.
${hindiInSet ? `- Hinglish rule: Hindi grammar in Roman letters. Example: "Main yeh feature tab use karta hoon jab koi naya user onboard hota hai." Technical nouns stay English: API, database, deployment, CI/CD, sprint, test case.` : ''}
- NEVER output Devanagari script characters. Roman letters only for Hindi.
- No preamble, no language meta-commentary, no restating the question. First character of reply is "-".
`
    }

    const isDualLang = configuredLangs.length > 1
    const hindiSelected = configuredLangs.includes('hi' as LanguageCode)

    // Coding template — headings adapt to the screen language when Hindi is configured
    const codingTemplate = isDualLang && hindiSelected
      ? `CODING / DSA PROBLEM (NATIVELY FAANG ROLLING INTERVIEW SCRIPT):
Use bold lines as the only headings, everything else is a "- " bullet.
⚠️ LANGUAGE RULE FOR CODING: If the coding question on screen is in Hindi/Hinglish → write ALL explanation bullets in Hinglish. If it is in English → write in English. Code itself is always in ${sessionContext.codingLanguage || 'Python'} (no language mixing inside code).
**Understanding** (or Hinglish: **Samajhna**)
- 2 bullets: input/output/constraint, then the edge cases you will handle.
**Approach** (or Hinglish: **Approach**)
- 3 bullets: brute force and its complexity, the optimal data structure, why it removes the bottleneck.
\`\`\`${sessionContext.codingLanguage || 'Python'}
# Complete, runnable, commented solution. Never truncate it.
\`\`\`
**Dry Run** (or Hinglish: **Dry Run**)
- 2 bullets: the sample input traced, then the final returned value.
**Complexity**
- Time Complexity: O(?)
- Space Complexity: O(?)`
      : `CODING / DSA PROBLEM (NATIVELY FAANG ROLLING INTERVIEW SCRIPT):
Use bold lines as the only headings, everything else is a "- " bullet:
**Understanding**
- 2 bullets: input/output/constraint, then the edge cases you will handle.
**Approach**
- 3 bullets: brute force and its complexity, the optimal data structure, why it removes the bottleneck.
\`\`\`${sessionContext.codingLanguage || 'Python'}
# Complete, runnable, commented solution. Never truncate it.
\`\`\`
**Dry Run**
- 2 bullets: the sample input traced, then the final returned value.
**Complexity**
- Time Complexity: O(?)
- Space Complexity: O(?)`

    const mcqTemplate = isDualLang && hindiSelected
      ? `MCQ / MULTIPLE-CHOICE ON SCREEN:
- First bullet: "The answer is [Option Label]: [Option Text]." — write this line in the same language as the question (Hinglish if question is Hindi, English otherwise).
- Then 2-3 bullets in the same language explaining WHY it is correct.
- Do NOT discuss or explain the wrong options.`
      : `MCQ / MULTIPLE-CHOICE ON SCREEN:
- First bullet: "The answer is [Option Label]: [Option Text]."
- Then 2-3 bullets explaining WHY it is correct.
- Do NOT discuss or explain the wrong options.`

    let activePrompt = `You are a real-time AI interview assistant. You ARE the candidate — ${sessionContext.name}, a ${sessionContext.role}${sessionContext.company ? ` at ${sessionContext.company}` : ''}.

TASK: Scan the screen and identify any interview question visible — this could be a coding problem, technical question, MCQ, behavioral question, HR/situational question, or any other type. Give exactly what the candidate should say out loud in response. Apply the correct answer structure for the question type detected.

IDENTITY: First person only. No "Certainly!", no AI preamble.
${visionDirective}

ANSWER FORMAT BY QUESTION TYPE:

🔴 UNIVERSAL RULE — BULLET POINTS ONLY. Prose paragraphs are FORBIDDEN for every question type below.
- Every line starts with "- " (hyphen + one space), each bullet on its own line, one complete 10-22 word sentence per bullet.
- The first character of your reply is "-". No preamble, no "Here is", no restating the question, no closing paragraph.
- Never bold a whole bullet. Never add emoji, icons, or decorative symbols.
- Finish the last bullet and any code block completely. Never stop mid-sentence.

${codingTemplate}

${mcqTemplate}

BEHAVIORAL / HR / SITUATIONAL QUESTION:
- 5-6 bullets in first person as the candidate.
- Order them: context → what was at stake → what YOU did → how you executed it → the measurable result.
- Write bullets in the language matching the question on screen (Hinglish if question is Hindi, English if English).

TECHNICAL / CONCEPT QUESTION:
- 4-6 bullets ordered: direct definition → how it works → why it matters → what breaks without it → a concrete real-world example.
- Write bullets in the language matching the question on screen (Hinglish if question is Hindi, English if English).

STYLE (ALL TYPES):
- Clear, confident, conversational — each bullet must be speakable out loud. Follow the LANGUAGE LOCK above for what language to answer in.
- If this is a follow-up screen scan, continue the previous explanation naturally with fresh bullets that do not repeat earlier points.
${getExperienceContext()}
=== CANDIDATE'S COMPLETE RESUME (SOURCE OF TRUTH) ===
${sessionContext.resumeText.substring(0, 2000)}
=== END OF RESUME ===${sessionContext.company ? `\n**TARGET COMPANY**: Interviewing at ${sessionContext.company}. If asked why, show genuine interest.` : ''}`

    console.log('[AI] Querying vision model fast path...')
    const result = await requestVisionAnswer(activePrompt, base64Image, stream)
    const sanitizedResult = normalizeBulletFormatting(inspectAndSanitizeAnswerCode(result))
    return sanitizedResult
  } catch (err: unknown) {
    const error = err as Error
    console.error('[AI] Screen Analysis Error:', error)
    return `Error analyzing screen: ${error.message}`
  }
}

export function getCurrentModel(): string {
  return MODEL_NAME
}

export function useActiveCodingChallenge(): string {
  return activeCodingChallenge
}

// aiService.ts - Logic moved to main process via IPC
import { classifyIntent, IntentResult } from './pipeline/intentClassifier'
import { planAnswer, AnswerPlan } from './pipeline/answerPlanner'
import { enforceHumanLikeness } from './pipeline/humanLikeness'
import { inspectAndSanitizeAnswerCode } from './pipeline/codeSanityCheck'
import { getSystemDesignDiagramPrompt } from './pipeline/diagramIntelligence'
import { liveSessionMemory } from './pipeline/liveSessionMemory'

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
}

let sessionContext: SessionData | null = null
const MODEL_NAME = 'openai/gpt-oss-120b'        // Text/chat model
let activeCodingChallenge: string = ''
const conversationHistory: { role: 'user' | 'assistant'; content: string }[] = []

function updateHistory(role: 'user' | 'assistant', content: string): void {
  conversationHistory.push({ role, content })
  if (conversationHistory.length > 10) conversationHistory.shift()
}

function getHistoryContext(): string {
  if (conversationHistory.length === 0) return ''
  return `\n### RECENT CONVERSATION HISTORY (CRITICAL CONTEXT):
${conversationHistory.map((h) => `${h.role === 'user' ? 'Interviewer' : 'Me (Harsh)'}: ${h.content}`).join('\n')}
### END OF HISTORY\n`
}

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
  conversationHistory.length = 0
  activeCodingChallenge = ''

  if (data.groqApiKey) window.api.initGroq(data.groqApiKey)
  sessionContext = data

  // Index resume and interview content locally on-device
  if (data.resumeText && window.api?.indexLocalContent) {
    window.api.indexLocalContent('resume', data.resumeText).catch(() => {})
  }
  if (data.interviewContent && window.api?.indexLocalContent) {
    window.api.indexLocalContent('interview_content', data.interviewContent).catch(() => {})
  }
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
- Keep the introduction natural and flowing. 6-8 sentences. No bullet points.
- Do NOT add experience or companies beyond what is in the template or the resume.
TEMPLATE: ${template}
`
}

function getInterviewContentPrompt(_hasRagContext?: boolean): string {
  if (!sessionContext || !sessionContext.interviewContent?.trim()) return ''
  
  const cheatSheetContent = sessionContext.interviewContent.trim().substring(0, 5000)

  return `
=== CANDIDATE PREPARATION MATERIAL & CHEAT SHEET (HIGHEST PRIORITY) ===
"""
${cheatSheetContent}
"""
=== END OF PREPARATION MATERIAL ===

CRITICAL CROSS-LINGUAL & CHEAT SHEET RULES:
1. **Source of Truth**: When the interviewer asks about ANY topic or question covered in the preparation material above (e.g. QA testing, automation, methodologies, tools, scenarios, test plans), you MUST base your answer directly on this material.
2. **Cross-Lingual Adaptation (Smart RAG)**: The preparation material above may be in English, but the interviewer may ask the question in Hindi or Hinglish (or vice versa). You MUST understand the concepts from the English text and explain them seamlessly in **HINGLISH** (Hindi written in English alphabet) or English as requested.
3. **Conversational Tone**: Do not copy notes robotically. Explain the core points from the material intelligently and naturally as a candidate speaking out loud.
`
}

export function getSystemPrompt(
  intentResult?: IntentResult,
  answerPlan?: AnswerPlan,
  localRagContext?: string,
  sessionMemoryContext?: string
): string {
  if (!sessionContext) return ''

  const intent = intentResult?.intent || 'general_factual'
  const isSystemDesign = intent === 'system_design'
  const isCoding = intent === 'dsa_coding'
  const isIdentity = intent === 'identity'
  const isBehavioral = intent === 'behavioral' || intent === 'project_deepdive'
  const isConceptOrDef = intent === 'definitional' || intent === 'technical_concept'

  // 1. Coding Directive (ONLY for DSA Coding)
  const codingDirective = isCoding ? `
=== MANDATORY FAANG CODING & DSA SCRIPT FORMAT ===
1. **Problem Clarification**: 1-2 conversational sentences confirming constraints and edge cases.
2. **Approach & Complexity**: 2-3 sentences comparing brute-force to optimal data structure.
3. **Optimal Code Solution**: Complete, production-ready solution in \`\`\`${sessionContext.codingLanguage || 'python'}\n...\n\`\`\`.
4. **Dry-Run**: 1-2 sentences tracing with a simple test input.
5. **Complexity**: Exact final line: Time Complexity: O(?) | Space Complexity: O(?)
=== END CODING SCRIPT ===` : ''

  // 2. System Design & Diagram Directive (ONLY for System Design)
  const diagramInstruction = getSystemDesignDiagramPrompt(isSystemDesign)

  // 3. Voice & Identity
  const voiceRule = answerPlan?.voicePerspective === 'neutral_explanation'
    ? 'Explain technical concepts clearly, objectively, and directly without unnecessary personal narrative.'
    : `You ARE ${sessionContext.name} — applying for ${sessionContext.role}${sessionContext.company ? ` at ${sessionContext.company}` : ''}. Use first-person "I" / "Main".`

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

  // 5. Cheat Sheet Notes (Semantic RAG excerpts + full preparation material)
  const hasRag = Boolean(localRagContext && localRagContext.trim().length > 0)
  const cheatSheetSection = getInterviewContentPrompt(hasRag)

  // 6. Real-World Example Rule
  const exampleRule = (intentResult?.requiresExample || answerPlan?.requiresExample || isConceptOrDef || isSystemDesign)
    ? 'EXAMPLE RULE (MANDATORY): Always include at least one concrete real-world example starting with "For example," or "Jaise ki / Example ke liye".'
    : ''

  return `You are Natively, a real-time AI interview assistant helping ${sessionContext.name} answer live interview questions.

IDENTITY & VOICE:
- ${voiceRule}
- First person ONLY when answering personal/behavioral questions. Never say "Certainly!", "Of course!", "Great question!", or "As an AI...".
- NO greetings or filler openers. Start your answer immediately.

ANTI-AI TELLS & SPOKEN NATURALNESS:
- BANNED PUNCTUATION: NEVER use em-dashes (—) or semicolons (;). Use standard commas or separate sentences.
- BANNED BUZZWORDS: Do NOT use "delve", "leverage", "rich tapestry", "moreover", "furthermore", "it is important to note that".
- Write output so it reads like a real human naturally speaking out loud in an interview.
- COMPLETENESS (CRITICAL): Always conclude your thoughts cleanly and fully. Finish every sentence, bullet point, and code block completely before stopping. Never cut off mid-thought.

TONE & LANGUAGE RULES (CRITICAL):
1. **HINDI / HINGLISH QUESTIONS**: If the interviewer asks in HINDI, HINGLISH, or Devanagari script (e.g. "Aapka testing experience kaisa raha?", "Regression testing kab perform karte ho?", "रिग्रेशन टेस्टिंग क्या है?"):
   - You MUST answer in **fluent, conversational HINGLISH** (Conversational Hindi written in English/Latin alphabet, e.g. "Main regression testing perform karne ke liye sabse pehle...", "Hum test cases design karte hain...").
   - **STRICT PROHIBITION 1**: DO NOT use Devanagari script (NO हिंदी लिपि like मैं, आप, यह). Always write in Roman English letters.
   - **STRICT PROHIBITION 2**: DO NOT answer in pure English when the question was asked in Hindi/Hinglish. Answer in Hinglish.
   - Keep all technical terms, tool names, framework names, and processes in standard ENGLISH (e.g., QA Lead, Regression Testing, Test Plan, Selenium, Postman, Bug Lifecycle, Jira, Agile, Sprint, CI/CD).
2. **ENGLISH QUESTIONS**: If the interviewer asks in pure English, answer in clear, professional English.

### ANSWER LENGTH:
- **Definition / Concept**: 2-4 sentences. Core concept → direct explanation → one real-world example.
- **Behavioral / Identity**: 4-5 sentences. Context → what YOU did → measurable outcome.
- **System Design**: 4-5 sentences + architecture breakdown + clean Mermaid diagram.
- **Coding / DSA**: 1-2 sentence approach → code block in ${sessionContext.codingLanguage || 'Python'} → "Time Complexity: O(?) | Space Complexity: O(?)".

${codingDirective}
${diagramInstruction}
${exampleRule}
${sessionMemoryContext || ''}
${localRagContext || ''}
${cheatSheetSection}
${profileSection}${getHistoryContext()}
${sessionContext.company ? `\n**TARGET COMPANY**: Interviewing at ${sessionContext.company}.` : ''}`
}

export async function generateInterviewAnswer(transcript: string): Promise<string> {
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

  // Natively Pipeline Step 3: Local RAG Retrieval (On-Device Vector Search)
  let localRagContext = ''
  try {
    if (window.api?.searchLocalVectorDb) {
      const localExcerpts = await window.api.searchLocalVectorDb(transcript, 3)
      if (localExcerpts && localExcerpts.length > 0) {
        localRagContext = `\n=== LOCAL ON-DEVICE RETRIEVED CONTEXT ===\n${localExcerpts.join('\n---\n')}\n=== END RETRIEVED CONTEXT ===\n`
      }
    }
  } catch (e) {
    console.warn('[AI Pipeline] Local Vector DB search skipped:', e)
  }

  // Natively Pipeline Step 4: Build System Prompt based on Plan, Diagrams, Memory & Local RAG
  const systemPrompt = getSystemPrompt(intentResult, answerPlan, localRagContext, sessionMemoryContext)

  try {
    console.log(`[AI Pipeline] Intent: ${intentResult.intent} | Voice: ${answerPlan.voicePerspective} | ProfilePolicy: ${answerPlan.profileContextPolicy}`)

    // Natively Pipeline Step 5: Generate Raw Answer
    const rawAnswer = await window.api.generateAnswer({
      transcript,
      model: MODEL_NAME,
      systemPrompt,
      temperature: 0.65,
      maxTokens: 1600,
      presencePenalty: 0.4,
      frequencyPenalty: 0.4
    })

    // Natively Pipeline Step 6: Post-Process & Anti-AI Tells Enforcer
    const finalAnswer = enforceHumanLikeness(rawAnswer, answerPlan.requiresExample)

    // Natively Pipeline Step 7: Code Sanity & Bug Inspector
    const sanitizedAnswer = inspectAndSanitizeAnswerCode(finalAnswer)

    // Record candidate answer in Live Session Memory
    liveSessionMemory.recordTurn('candidate', sanitizedAnswer)

    updateHistory('user', transcript)
    updateHistory('assistant', sanitizedAnswer)
    return sanitizedAnswer
  } catch (err: unknown) {
    const error = err as Error
    console.error('[AI Pipeline] Chat Error:', error)
    return `Error: ${error.message}`
  }
}

export function recordInteraction(question: string, answer: string): void {
  updateHistory('user', question)
  updateHistory('assistant', answer)
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
    const transcript = await transcribeAudioOnly(base64Audio, mimeType)
    console.log('[AI] Transcribed text:', transcript)

    if (!transcript || transcript.trim().length < 4) {
      return { transcript: '', answer: '' }
    }

    const answer = await generateInterviewAnswer(transcript)
    return { transcript, answer }
  } catch (err: unknown) {
    console.error('[AI] generateAudioResponse Error Details:', err)
    throw err
  }
}

export async function transcribeAudioOnly(
  base64Audio: string,
  mimeType: string = 'audio/webm',
  context?: string
): Promise<string> {
  if (!sessionContext) throw new Error('AI not initialized.')
  try {
    return await window.api.transcribeOnly({
      base64Audio,
      mimeType,
      language: sessionContext.language,
      context
    })
  } catch (err: unknown) {
    console.error('[AI] Groq Transcribe-Only Error:', err)
    return ''
  }
}

export async function analyzeScreen(): Promise<string> {
  if (!sessionContext) return 'AI not initialized.'

  try {
    console.log('[AI] Capturing screen screenshot...')
    const base64Image = await window.api.captureScreenshot()

    let activePrompt = `You are a real-time AI interview assistant. You ARE the candidate — ${sessionContext.name}, a ${sessionContext.role}${sessionContext.company ? ` at ${sessionContext.company}` : ''}.

TASK: Scan the screen and identify any interview question visible — this could be a coding problem, technical question, MCQ, behavioral question, HR/situational question, or any other type. Give exactly what the candidate should say out loud in response. Apply the correct answer structure for the question type detected.

IDENTITY: First person only. No "Certainly!", no AI preamble.

ANSWER FORMAT BY QUESTION TYPE:

CODING / DSA PROBLEM (NATIVELY FAANG ROLLING INTERVIEW SCRIPT):
1. **Problem Clarification** (Start with "So just to make sure I understand..."): 1-2 conversational sentences confirming understanding & edge cases.
2. **Approach & Brainstorming**: 2-3 sentences. First mention naive/brute force approach (and its complexity), then pivot to optimal algorithm/data structure.
3. **Optimal Code Solution**: Complete, production-ready, heavily commented code block in \`\`\`${sessionContext.codingLanguage || 'Python'}\n...\n\`\`\`.
4. **Quick Dry-Run**: 1-2 sentences tracing code with a simple example.
5. **Complexity Analysis**: Single line at end: **Time Complexity**: O(?) | **Space Complexity**: O(?)

MCQ / MULTIPLE-CHOICE ON SCREEN:
- First line: "The answer is [Option Label] — [Option Text]."
- Then explain WHY it is correct in 2-3 short sentences.
- Do NOT discuss or explain the wrong options.
- Example: "The answer is C — TCP is connection-oriented. It establishes a handshake before data transfer, ensuring reliability. UDP sends data without any confirmation."

BEHAVIORAL / HR / SITUATIONAL QUESTION:
- Answer in first person as the candidate.
- Brief context → what YOU did → result. Keep it natural and conversational.
- 5-6 sentences. Simple Indian English.

TECHNICAL / CONCEPT QUESTION:
- Simple clear answer first → brief explanation → one real example.
- Be naturally brief. Don't pad.

STYLE (ALL TYPES):
- Simple Indian English. Clear, confident, conversational.
- For non-coding answers: flowing sentences, NO bullet points, short active sentences.
- If this is a follow-up screen scan, continue the previous explanation naturally.
${getExperienceContext()}${getHistoryContext()}
${getInterviewContentPrompt(false)}
=== CANDIDATE'S COMPLETE RESUME (SOURCE OF TRUTH) ===
${sessionContext.resumeText.substring(0, 2000)}
=== END OF RESUME ===${sessionContext.company ? `\n**TARGET COMPANY**: Interviewing at ${sessionContext.company}. If asked why, show genuine interest.` : ''}`

    console.log('[AI] Querying vision model fast path...')
    const result = await window.api.queryVision({ systemPrompt: activePrompt, base64Image })
    const sanitizedResult = inspectAndSanitizeAnswerCode(result)
    if (sanitizedResult && !sanitizedResult.startsWith('Error')) {
      updateHistory('user', '[Screen Scan Triggered]')
      updateHistory('assistant', sanitizedResult)
    }
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

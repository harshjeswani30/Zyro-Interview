// aiService.ts - Logic moved to main process via IPC

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
}

let sessionContext: SessionData | null = null
const MODEL_NAME = 'llama-3.3-70b-versatile'        // Text/chat model — same as Interview Pro
const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct' // Vision model for screen scan
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

export function getSystemPrompt(): string {
  if (!sessionContext) return ''
  return `You are a real-time AI interview assistant helping ${sessionContext.name} answer interview questions live.

IDENTITY:
- You ARE ${sessionContext.name} — applying for ${sessionContext.role}${sessionContext.company ? ` at ${sessionContext.company}` : ''}.
- First person ONLY. Never say "Certainly!", "Of course!", "Great question!", or "As an AI...".
- NO greetings or filler openers. Start your answer immediately.

TONE (SIMPLE INDIAN ENGLISH):
- Natural, confident, conversational. Simple vocabulary — like how a smart person speaks casually.
- Short sentences, active voice. Easy to read aloud quickly.
- NEVER use bullet points. Always flowing sentences.

### ANSWER LENGTH — SMART & ADAPTIVE (READ CAREFULLY):
Answer length must match the question. The goal is to sound natural — not robotic, not padded.

- **One-word / definition question** ("What is X?", "Define Y"): 2-3 sentences MAX. Direct answer → one-line why it matters.
- **Short technical question** ("How does X work?", "Diff between A and B"): 3-4 sentences. Core concept + one real example.
- **Behavioral** ("Tell me about a time...", "How do you handle..."): 4-5 sentences. Context → what YOU did → result.
- **Introduction** ("Tell me about yourself"): Follow INTRODUCTION TEMPLATE below. 6-7 sentences, natural flow.
- **Project question** ("Tell me about your project"): 5-6 sentences. Problem → what you built → tech → outcome.
- **Follow-up** ("Why?", "Can you explain more?", "What about X?"): 2-3 sentences. Pick up context from history.
- **MCQ** (options A, B, C, D given): Line 1: "The answer is [Letter] — [Option text]." Then 2 sentences why.
- **Elaborate request** ("Tell me more", "Go deeper", "Explain in detail"): Expand the last answer by 3-4 sentences with a new angle or example.

HARD RULE: Never exceed 6 sentences for any single answer UNLESS it's a project deep-dive or explicit elaborate request.
HARD RULE: Never repeat the question back. Never pad with conclusions like "I hope that answers your question."

CODING QUESTIONS:
- Provide the complete, working code in ${sessionContext.codingLanguage || 'Python'}.
- Briefly explain the logic in 2 sentences.
- **MANDATORY**: End with "Time Complexity: O(?) | Space Complexity: O(?)" on a new line.

${getIntroTemplate()}
${getExperienceContext()}${getHistoryContext()}
=== CANDIDATE RESUME (SOURCE OF TRUTH — NEVER go beyond this) ===
${sessionContext.resumeText.substring(0, 4500)}
=== END OF RESUME ===${sessionContext.company ? `\n**TARGET COMPANY**: Interviewing at ${sessionContext.company}.` : ''}`
}

export async function generateInterviewAnswer(transcript: string): Promise<string> {
  if (!sessionContext) return 'AI not initialized.'

  // Skip if transcript is too short or appears to be a noise artifact
  if (!transcript || transcript.trim().length < 4) {
    return ''
  }

  // Final sanity check: if the transcript is JUST a common hallucination, ignore it
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
    'thanks'
  ]
  if (commonH.includes(lowerT)) {
    console.log('[AI] Ignoring likely silence hallucination:', transcript)
    return ''
  }

  const systemPrompt = getSystemPrompt()

  try {
    console.log('[AI] Generating Text Answer. Resume Length:', sessionContext.resumeText?.length)
    if (!sessionContext.resumeText || sessionContext.resumeText.length < 10) {
      console.warn('[AI] WARNING: resumeText is missing or extremely short in sessionContext!')
    }

    console.log('[AI-Train] Full System Prompt:', systemPrompt)
    const answer = await window.api.generateAnswer({
      transcript,
      model: MODEL_NAME,
      systemPrompt,
      temperature: 0.65,
      maxTokens: 500, // Increased to allow code + complexity
      presencePenalty: 0.4,
      frequencyPenalty: 0.4
    })
    updateHistory('user', transcript)
    updateHistory('assistant', answer)
    return answer
  } catch (err: unknown) {
    const error = err as Error
    console.error('[AI] Groq IPC Chat Error:', error)
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
    const systemPrompt = `You are a real-time AI interview assistant helping ${sessionContext.name} answer interview questions during a live interview.

IDENTITY:
- You ARE the candidate — ${sessionContext.name}, applying for ${sessionContext.role}${sessionContext.company ? ` at ${sessionContext.company}` : ''}.
- First person only. Never say "Certainly!", "Of course!", "Great question!", or "As an AI...".

TONE & STYLE (SIMPLE INDIAN ENGLISH):
- Confident, clear, conversational. Simple Indian English — no corporate jargon.
- Short sentences. Active voice. Never start two consecutive sentences with "I".
- Never repeat the question. No filler openers ("So basically...", "Sure...", etc.).
- NEVER use bullet points. Always flowing sentences.
${getIntroTemplate()}
ANSWER LENGTH (SMART & ADAPTIVE):
Judge how long to answer based on what the question actually needs. Be naturally brief — not artificially short.
- Simple/factual ("What is X?", "Define Y?"): 2-4 sentences. Direct and clear.
- Technical depth ("How does X work?", "Explain X"): Clear explanation + one real-world example from your experience. Can be 5-8 sentences if the topic genuinely needs it.
- Behavioral ("Tell me about a time..."): 5-6 sentences — context, what you did, result.
- "Tell me about yourself": Follow the INTRODUCTION TEMPLATE above. 6-8 sentences, natural flow.
- Follow-up questions: Match the depth the question actually deserves. Small follow-up = 2-3 sentences. A detailed follow-up = answer it properly with full depth.
- If the interviewer says "tell me more", "elaborate", "explain in detail", "go deeper", or similar → give a full, detailed answer. Expand with depth and examples. Do NOT hold back.
- Multiple questions in one: Bold heading per topic, proportional length per topic.
- NEVER pad or repeat yourself. Stop when the point is made.

MCQ / MULTIPLE-CHOICE QUESTION HANDLING:
- If the question includes spoken options (A, B, C, D or 1, 2, 3, 4), IMMEDIATELY state the correct option and its label first.
- Format: "The answer is [Option Label] — [Option Text]." then explain why in 2-3 sentences.
- Do NOT explain the wrong options.
- Example: "The answer is B — Polymorphism. It allows objects of different types to be treated via a common interface, making code flexible and reusable."

ANSWER STRUCTURE:
- Technical: Simple clear answer → explanation of how/why → one real-world or work example from your experience.
- Behavioral (STAR): Brief context → what YOU specifically did (50%) → result.

PERSONALIZATION (STRICT SOURCE OF TRUTH):
- Your resume is the absolute boundary. Never discuss projects, internships, or work that is not explicitly found in the provided resume text.
- Reference specific details from the resume: company names, tech stack, project names.
- If a specific skill or tool is asked for that is NOT on your resume: mention you have worked with similar technologies found on your resume, or explain the conceptual understanding, but NEVER invent a fake project or job role to justify it.

CONTINUITY:
- "slow down", "explain that" → refined version of LAST response. Do NOT pivot.
- "tell me more", "elaborate", "in detail", "go deeper" → expand the last answer fully with more depth and examples.
${getExperienceContext()}${getHistoryContext()}
=== CANDIDATE'S COMPLETE RESUME (SOURCE OF TRUTH) ===
${sessionContext.resumeText.substring(0, 4500)}
=== END OF RESUME ===${sessionContext.company ? `
**TARGET COMPANY**: Interviewing at ${sessionContext.company}. If asked why, show genuine interest.` : ''}

Format: JSON only: {"transcript": "...", "answer": "..."}`

    console.log('[AI] Generating Audio Answer. Resume Length:', sessionContext.resumeText?.length)

    const response = await window.api.transcribeAudio({
      base64Audio,
      mimeType,
      language: sessionContext.language,
      model: MODEL_NAME,
      systemPrompt,
      resumeText: sessionContext.resumeText.substring(0, 3000)
    })
    updateHistory('user', response.transcript)
    updateHistory('assistant', response.answer)
    return response
  } catch (err: unknown) {
    console.error('[AI] Groq IPC Audio Error Details:', err)
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

  const systemPrompt = `You are a real-time AI interview assistant. You ARE the candidate — ${sessionContext.name}, a ${sessionContext.role}${sessionContext.company ? ` at ${sessionContext.company}` : ''}.

TASK: Scan the screen and identify any interview question visible — this could be a coding problem, technical question, MCQ, behavioral question, HR/situational question, or any other type. Give exactly what the candidate should say out loud in response. Apply the correct answer structure for the question type detected.

IDENTITY: First person only. No "Certainly!", no AI preamble.

ANSWER FORMAT BY QUESTION TYPE:

CODING / DSA PROBLEM (use this format when a code problem is on screen):
1. In 2-3 plain sentences, explain the approach and logic clearly.
2. Provide the complete, working, optimized solution in a proper code block using ${sessionContext.codingLanguage || 'Python'}.
3. **MANDATORY**: After the code, state "Time Complexity: O(?) | Space Complexity: O(?)" on a separate line.
4. Example format:
   "The idea is to use a hashmap to track seen values so we avoid nested loops. For each element we check if its complement already exists in the map.
   \`\`\`python
   def two_sum(nums, target):
       seen = {}
       for i, n in enumerate(nums):
           diff = target - n
           if diff in seen:
               return [seen[diff], i]
           seen[n] = i
   \`\`\`
   Time Complexity: O(n) | Space Complexity: O(n)"

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
=== CANDIDATE'S COMPLETE RESUME (SOURCE OF TRUTH) ===
${sessionContext.resumeText.substring(0, 4500)}
=== END OF RESUME ===${sessionContext.company ? `
**TARGET COMPANY**: Interviewing at ${sessionContext.company}. If asked why, show genuine interest.` : ''}`

    console.log('[AI] Analyzing Screen. Resume Length:', sessionContext.resumeText?.length)

  try {
    const result = await window.api.analyzeScreen({ systemPrompt, model: VISION_MODEL })
    if (result && !result.startsWith('Error')) {
      activeCodingChallenge = result
      updateHistory('user', '[Screen Scan Triggered]')
      updateHistory('assistant', result)
    }
    return result
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

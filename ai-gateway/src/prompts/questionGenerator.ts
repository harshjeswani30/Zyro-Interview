import { QuestionBankItem } from '../data/questionBank'

interface PromptParams {
  role: string
  company: string
  field: string
  experience: string
  difficulty: string
  resumeSkills: string[]
  resumeProjects: string[]
  jobDescription?: string
  numQuestions: number
  interviewType?: string
  fewShotExamples?: QuestionBankItem[]
}

function normalizeExperience(experience: string): 'fresher' | '1-3' | '3-5' | '5+' {
  const e = String(experience || '').toLowerCase()
  if (e.includes('fresher') || e.includes('0')) return 'fresher'
  if (e.includes('1-3') || e.includes('1') || e.includes('2') || e.includes('3')) return '1-3'
  if (e.includes('3-5') || e.includes('4') || e.includes('5')) return '3-5'
  return '5+'
}

export function buildQuestionGeneratorPrompt(params: PromptParams): string {
  const experienceMapping = {
    fresher: {
      technical: 'Focus on fundamentals, OOP basics, debugging approach, and conceptual DSA explanations.',
      behavioral: 'Projects, teamwork, learning ability, motivation, and communication clarity.'
    },
    '1-3': {
      technical: 'Intermediate DSA, backend/frontend architecture basics, and practical trade-off reasoning.',
      behavioral: 'Real work examples, stakeholder collaboration, conflict handling, and growth mindset.'
    },
    '3-5': {
      technical: 'Advanced system design, scalability, reliability, and decision-making trade-offs.',
      behavioral: 'Leadership influence, mentoring, execution ownership, and difficult decisions.'
    },
    '5+': {
      technical: 'Complex architecture, distributed systems, performance tuning, and strategic design choices.',
      behavioral: 'Strategic leadership, cross-team impact, organizational alignment, and crisis management.'
    }
  }

  const companyStyles: Record<string, string> = {
    google: 'Focus on algorithms reasoning, scalability, structured communication, and leadership.',
    amazon: 'Focus on leadership principles, ownership, customer impact, and practical trade-offs.',
    microsoft: 'Focus on collaboration, technical depth, and growth mindset.',
    meta: 'Focus on impact, fast iteration, and systems thinking.',
    netflix: 'Focus on judgment, responsibility, and context-driven decision making.',
    startup: 'Focus on versatility, ambiguity handling, MVP mindset, and ownership.'
  }

  const expLevel = normalizeExperience(params.experience)
  const companyKey = String(params.company || 'General').toLowerCase()
  const companyStyle = companyStyles[companyKey] || 'Balanced technical and behavioral interview style with clear communication and practical reasoning.'

  const examples = params.fewShotExamples || []
  const examplesBlock = examples.length
    ? examples
      .map((ex, i) => `Example ${i + 1}:\n${JSON.stringify(ex, null, 2)}`)
      .join('\n\n')
    : 'No examples provided.'

  return `You are an expert interviewer conducting a mock interview for a ${params.role} candidate.

CANDIDATE PROFILE:
- Role: ${params.role}
- Company: ${params.company || 'General'}
- Field/Domain: ${params.field || 'General'}
- Experience: ${params.experience}
- Difficulty: ${params.difficulty || 'Adaptive'}
- Interview Mode: ${params.interviewType || 'Mixed'}
- Resume Skills: ${params.resumeSkills.join(', ') || 'Not provided'}
- Resume Projects: ${params.resumeProjects.slice(0, 3).join('; ') || 'Not provided'}
${params.jobDescription ? `- Job Description: ${params.jobDescription.slice(0, 700)}` : '- Job Description: Not provided'}

COMPANY STYLE:
${companyStyle}

EXPERIENCE GUIDELINES:
- Technical: ${experienceMapping[expLevel].technical}
- Behavioral: ${experienceMapping[expLevel].behavioral}

MANDATORY RULES:
1. Generate exactly ${params.numQuestions} questions.
2. Questions must follow setup details strictly (role, company, field, experience, interview mode).
3. At least 2 questions must reference resume skills/projects if available.
4. Questions must sound like natural spoken interviewer prompts.
5. Behavioral questions must be STAR-answer compatible.
6. This is voice-only. NEVER ask to write code/programs/functions.
7. NEVER ask to run, compile, test, or use editor/IDE/compiler.
8. Technical questions must be verbal and conceptual: architecture, debugging strategy, trade-offs, performance reasoning, design explanation.
9. Do not ask for pseudocode syntax or line-by-line implementation.

FEW-SHOT EXAMPLES:
${examplesBlock}

OUTPUT FORMAT:
Return strictly valid JSON object:
{
  "questions": [
    {
      "question_number": 1,
      "question_text": "Natural interviewer-style question",
      "type": "technical|behavioral|situational|role_specific",
      "difficulty": "easy|medium|hard",
      "category": "short category label",
      "expected_answer_themes": ["theme1", "theme2"],
      "expected_keywords": ["keyword1", "keyword2"],
      "evaluation_criteria": "What a strong verbal answer should contain",
      "follow_up_questions": ["follow-up 1", "follow-up 2"]
    }
  ]
}

Return only JSON. No markdown.`
}

export interface QuestionBankItem {
  text: string
  type: 'technical' | 'behavioral' | 'situational' | 'role_specific'
  difficulty: 'easy' | 'medium' | 'hard'
  category: string
  keywords: string[]
}

const QUESTION_BANK: Record<string, Record<string, QuestionBankItem[]>> = {
  software_engineer: {
    fresher: [
      {
        text: 'Explain the difference between a stack and a queue. When would you use each in real applications?',
        type: 'technical',
        difficulty: 'easy',
        category: 'DSA Fundamentals',
        keywords: ['LIFO', 'FIFO', 'data structure', 'use cases']
      },
      {
        text: 'Tell me about a challenging project from your college or internship. What was your role and what did you learn?',
        type: 'behavioral',
        difficulty: 'easy',
        category: 'Project Ownership',
        keywords: ['STAR', 'teamwork', 'learning', 'impact']
      },
      {
        text: 'If your API starts timing out in production, how would you investigate the issue step by step?',
        type: 'situational',
        difficulty: 'medium',
        category: 'Debugging',
        keywords: ['logs', 'latency', 'monitoring', 'root cause']
      }
    ],
    '1-3': [
      {
        text: 'Design a caching strategy for a high-traffic service and explain your eviction policy choice.',
        type: 'technical',
        difficulty: 'medium',
        category: 'System Design',
        keywords: ['cache invalidation', 'LRU', 'TTL', 'Redis']
      },
      {
        text: 'Describe a time you disagreed with a technical decision. How did you align the team?',
        type: 'behavioral',
        difficulty: 'medium',
        category: 'Conflict Resolution',
        keywords: ['alignment', 'trade-offs', 'communication', 'outcome']
      },
      {
        text: 'Walk me through how you would improve reliability for a feature with recurring incidents.',
        type: 'role_specific',
        difficulty: 'medium',
        category: 'Reliability Engineering',
        keywords: ['SLO', 'postmortem', 'monitoring', 'mitigation']
      }
    ],
    '3-5': [
      {
        text: 'How would you design a scalable notification service handling millions of events per day?',
        type: 'technical',
        difficulty: 'hard',
        category: 'Distributed Systems',
        keywords: ['queue', 'idempotency', 'partitioning', 'backpressure']
      },
      {
        text: 'Tell me about a time you mentored a junior engineer and improved team delivery quality.',
        type: 'behavioral',
        difficulty: 'medium',
        category: 'Leadership',
        keywords: ['mentoring', 'feedback', 'impact', 'ownership']
      },
      {
        text: 'Your service latency increased by 40% after a release. How would you lead the response?',
        type: 'situational',
        difficulty: 'hard',
        category: 'Incident Management',
        keywords: ['rollback', 'canary', 'metrics', 'coordination']
      }
    ],
    '5+': [
      {
        text: 'Explain the trade-offs between consistency and availability in a globally distributed system.',
        type: 'technical',
        difficulty: 'hard',
        category: 'Architecture',
        keywords: ['CAP theorem', 'eventual consistency', 'replication', 'latency']
      },
      {
        text: 'Describe a strategic technical decision that changed business outcomes. What data supported it?',
        type: 'behavioral',
        difficulty: 'hard',
        category: 'Strategic Leadership',
        keywords: ['business impact', 'decision framework', 'stakeholders', 'metrics']
      },
      {
        text: 'How would you prioritize and communicate during a multi-team production crisis?',
        type: 'situational',
        difficulty: 'hard',
        category: 'Crisis Management',
        keywords: ['severity', 'stakeholders', 'communication', 'recovery plan']
      }
    ]
  },
  data_scientist: {
    '1-3': [
      {
        text: 'You have a highly imbalanced dataset. How would you train and evaluate a classifier effectively?',
        type: 'technical',
        difficulty: 'medium',
        category: 'ML Modeling',
        keywords: ['class weights', 'SMOTE', 'precision-recall', 'F1']
      },
      {
        text: 'Tell me about a model you shipped and how you measured real-world impact.',
        type: 'behavioral',
        difficulty: 'medium',
        category: 'Model Impact',
        keywords: ['A/B test', 'business metric', 'monitoring', 'drift']
      },
      {
        text: 'A model performance drops suddenly after deployment. How would you diagnose it verbally?',
        type: 'situational',
        difficulty: 'hard',
        category: 'Model Operations',
        keywords: ['data drift', 'feature drift', 'retraining', 'rollback']
      }
    ]
  },
  general: {
    fresher: [
      {
        text: 'What project are you most proud of, and what technical decisions did you make?',
        type: 'behavioral',
        difficulty: 'easy',
        category: 'Project Storytelling',
        keywords: ['ownership', 'impact', 'learning', 'trade-offs']
      },
      {
        text: 'Explain a core concept from your stack in simple terms for a non-technical stakeholder.',
        type: 'technical',
        difficulty: 'easy',
        category: 'Communication',
        keywords: ['clarity', 'abstraction', 'examples', 'audience adaptation']
      },
      {
        text: 'How would you handle an urgent bug reported by users right before release?',
        type: 'situational',
        difficulty: 'medium',
        category: 'Release Readiness',
        keywords: ['risk assessment', 'triage', 'communication', 'mitigation']
      }
    ]
  }
}

function normalizeRole(role: string): string {
  const r = role.toLowerCase()
  if (r.includes('software') || r.includes('frontend') || r.includes('backend') || r.includes('fullstack')) {
    return 'software_engineer'
  }
  if (r.includes('data scientist') || r.includes('ml') || r.includes('machine learning')) {
    return 'data_scientist'
  }
  return 'general'
}

function normalizeExperience(experience: string): 'fresher' | '1-3' | '3-5' | '5+' {
  const e = experience.toLowerCase()
  if (e.includes('fresher') || e.includes('0')) return 'fresher'
  if (e.includes('1-3') || e.includes('1') || e.includes('2') || e.includes('3')) return '1-3'
  if (e.includes('3-5') || e.includes('4') || e.includes('5')) return '3-5'
  return '5+'
}

export function getRelevantExamplesFromBank(input: { role: string; experience: string; limit?: number }): QuestionBankItem[] {
  const roleKey = normalizeRole(input.role)
  const expKey = normalizeExperience(input.experience)
  const limit = input.limit ?? 3

  const roleBucket = QUESTION_BANK[roleKey] || QUESTION_BANK.general
  const exact = roleBucket[expKey] || []

  if (exact.length >= limit) return exact.slice(0, limit)

  const fallback = [
    ...(roleBucket.fresher || []),
    ...(QUESTION_BANK.general.fresher || [])
  ]

  const merged = [...exact, ...fallback]
  return merged.slice(0, limit)
}

// intentClassifier.ts - Natively-style Question & Intent Classification Engine

export type QuestionIntent =
  | 'definitional'
  | 'technical_concept'
  | 'dsa_coding'
  | 'system_design'
  | 'behavioral'
  | 'identity'
  | 'project_deepdive'
  | 'followup'
  | 'general_factual'

export interface IntentResult {
  intent: QuestionIntent
  isCoding: boolean
  isHindi: boolean
  requiresExample: boolean
}

export function classifyIntent(query: string): IntentResult {
  const lower = query.toLowerCase().trim()

  // 1. Detect language (Hindi / Hinglish)
  const isHindi =
    /[\u0900-\u097F]/.test(query) ||
    /\b(aap|aapka|aapke|aapko|hum|hume|humein|mujhe|mera|mere|meri|kya|kyun|kyu|kaise|kaisa|kaisi|kab|kahan|konsa|kaunsa|kitna|kitne|batao|bataiye|samjhao|karo|karein|karna|karte|karta|karti|kiya|kiye|karega|karenge|hota|hoti|hote|hai|hain|tha|thi|the|hoga|hogi|honge|mein|me|se|ko|par|pe|ke|ki|aur|ya|nahi|matlab|baare|bare|kuch|kabhi|accha|theek|samajh|madad|chahiye|boliye|sunte|bata|batao)\b/i.test(lower)

  // 2. Detect DSA / Coding problem
  const isCoding =
    /\b(code|leetcode|function|class|algorithm|array|string|linked list|tree|graph|dp|dynamic programming|complexity|dsa|two sum|reverse|sort)\b/i.test(lower) ||
    /```[\s\S]*```/.test(query) ||
    /\b(write a function|implement|given an array|given a string|return the|find all)\b/i.test(lower)

  if (isCoding) {
    return { intent: 'dsa_coding', isCoding: true, isHindi, requiresExample: false }
  }

  // 3. System Design
  if (/\b(system design|scale|rate limiter|load balancer|architecture|sharding|microservices|distributed)\b/i.test(lower)) {
    return { intent: 'system_design', isCoding: false, isHindi, requiresExample: true }
  }

  // 4. Identity / Self Intro
  if (/\b(tell me about yourself|introduce yourself|who are you|your background|walk me through your resume)\b/i.test(lower)) {
    return { intent: 'identity', isCoding: false, isHindi, requiresExample: false }
  }

  // 5. Behavioral
  if (/\b(tell me about a time|how do you handle|describe a situation|conflict|disagreement|mistake|failed|challenge you faced)\b/i.test(lower)) {
    return { intent: 'behavioral', isCoding: false, isHindi, requiresExample: false }
  }

  // 6. Project Deep Dive
  if (/\b(tell me about your project|your recent project|what tech stack did you use|project experience|built in your project)\b/i.test(lower)) {
    return { intent: 'project_deepdive', isCoding: false, isHindi, requiresExample: true }
  }

  // 7. Definitional ("What is X", "Define Y")
  if (/^(what is|define|what do you mean by|what are|explain the concept of)\b/i.test(lower) || /\b(definition|meaning of)\b/i.test(lower)) {
    return { intent: 'definitional', isCoding: false, isHindi, requiresExample: true }
  }

  // 8. Technical Concept ("How does X work", "Difference between A and B")
  if (/\b(how does|how do|difference between|vs|diff between|pros and cons|advantages|working of|how is)\b/i.test(lower)) {
    return { intent: 'technical_concept', isCoding: false, isHindi, requiresExample: true }
  }

  // 9. Followup
  if (/\b(why|can you elaborate|go deeper|tell me more|what else|give an edge case)\b/i.test(lower) && query.split(' ').length < 8) {
    return { intent: 'followup', isCoding: false, isHindi, requiresExample: true }
  }

  // Default
  return { intent: 'general_factual', isCoding: false, isHindi, requiresExample: false }
}

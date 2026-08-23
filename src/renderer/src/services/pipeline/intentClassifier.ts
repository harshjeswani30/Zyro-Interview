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

// Hinglish counterparts of the English intent cues below. Hindi questions put the
// interrogative at the END ("regression testing kya hai?") instead of the start,
// so these can't reuse the `^`-anchored English patterns. Both Roman Hinglish and
// Devanagari spellings are listed because Whisper emits either depending on how
// much of the sentence was actually spoken in Hindi.
const HINGLISH = {
  coding: /\b(code likho|code likhiye|code kar|program likho|program banao|function likho|function banao|implement karo|solve karo|likh kar dikhao)\b|\u0915\u094B\u0921 (\u0932\u093F\u0916\u094B|\u0932\u093F\u0916\u093F\u090F|\u0915\u0940\u091C\u093F\u090F)|\u092A\u094D\u0930\u094B\u0917\u094D\u0930\u093E\u092E (\u0932\u093F\u0916\u094B|\u092C\u0928\u093E\u0913)/i,
  systemDesign: /\b(design karo|design kaise|kaise scale|scale kaise|architecture kaisa|architecture batao)\b|\u0921\u093F\u091C\u093C\u093E\u0907\u0928 \u0915\u0948\u0938\u0947|\u0906\u0930\u094D\u0915\u093F\u091F\u0947\u0915\u094D\u091A\u0930/i,
  identity: /\b(apne baare mein batao|apne baare me batao|apne bare me batao|apna introduction|khud ke baare mein|apne aap ke baare mein|apni jaankari)\b|\u0905\u092A\u0928\u0947 \u092C\u093E\u0930\u0947 \u092E\u0947\u0902 (\u092C\u0924\u093E\u0907\u090F|\u092C\u0924\u093E\u0913|\u092C\u0924\u093E\u092F\u0947\u0902)|\u0905\u092A\u0928\u093E (\u092A\u0930\u093F\u091A\u092F|\u0907\u0902\u091F\u094D\u0930\u094B\u0921\u0915\u094D\u0936\u0928)/i,
  behavioral: /\b(kaise handle karte|kaise handle karoge|kabhi aisa hua|koi aisa time|mushkil situation|problem aayi to|conflict hua|galti hui)\b|\u0915\u0948\u0938\u0947 (\u0939\u0948\u0902\u0921\u0932|\u0938\u0902\u092D\u093E\u0932\u0924\u0947)|\u092E\u0941\u0936\u094D\u0915\u093F\u0932 (\u0938\u094D\u0925\u093F\u0924\u093F|\u0938\u093F\u091A\u0941\u090F\u0936\u0928)/i,
  project: /\b(project ke baare mein|project ke bare me|project mein kya kiya|apne project|tech stack kya|kaunsi technology use)\b|\u092A\u094D\u0930\u094B\u091C\u0947\u0915\u094D\u091F (\u0915\u0947 \u092C\u093E\u0930\u0947 \u092E\u0947\u0902|\u092E\u0947\u0902 \u0915\u094D\u092F\u093E)/i,
  definitional: /\b(kya hai|kya hota hai|kya hoti hai|kya hote hain|kya matlab|matlab kya|kise kehte hain|kya kehte hain|define karo|kya cheez hai)\b|\u0915\u094D\u092F\u093E (\u0939\u0948|\u0939\u094B\u0924\u093E \u0939\u0948|\u0939\u094B\u0924\u0940 \u0939\u0948|\u092E\u0924\u0932\u092C)/i,
  technicalConcept: /\b(kaise kaam karta hai|kaise kaam karti hai|kaise kaam karta|kaise karte ho|kaise karte hain|kaise karoge|kaise banate hain|kab use karte|kyun use karte|kyun zaroori)\b|\u0915\u0948\u0938\u0947 (\u0915\u093E\u092E \u0915\u0930\u0924\u093E|\u0915\u093E\u092E \u0915\u0930\u0924\u0940|\u0915\u0930\u0924\u0947 \u0939\u0948\u0902|\u0915\u0930\u094B\u0917\u0947)|\u0915\u094D\u092F\u094B\u0902 (\u091C\u093C\u0930\u0942\u0930\u0940|\u0907\u0938\u094D\u0924\u0947\u092E\u093E\u0932)/i,
  difference: /\b(antar kya|antar batao|farak kya|fark kya|difference kya|kya farak|kya fark|alag kaise|comparison batao)\b|(\u0905\u0902\u0924\u0930|\u092B\u093C\u0930\u094D\u0915|\u092B\u0930\u094D\u0915) \u0915\u094D\u092F\u093E/i,
  followup: /\b(aur batao|thoda aur|detail mein batao|detail me batao|elaborate karo|iske aage|aur kuch|example do|example batao)\b|(\u0914\u0930 \u092C\u0924\u093E\u0913|\u0925\u094B\u0921\u093C\u093E \u0914\u0930|\u0909\u0926\u093E\u0939\u0930\u0923 (\u0926\u094B|\u092C\u0924\u093E\u0913))/i
}

// Unambiguous Hindi/Hinglish tokens. None of these is an English word, so a single
// hit settles the language.
const HINDI_STRONG =
  /\b(aap|aapka|aapke|aapko|hume|humein|mujhe|mera|mere|meri|kya|kyun|kyu|kaise|kaisa|kaisi|kab|kahan|konsa|kaunsa|kitna|kitne|batao|bataiye|bata|samjhao|karo|karein|karna|karte|karta|karti|kiya|kiye|karega|karenge|hota|hoti|hote|hai|hain|tha|thi|hoga|hogi|honge|mein|nahi|nahin|matlab|baare|bare|kabhi|accha|acha|theek|samajh|madad|chahiye|boliye|sunte|bilkul|zaroori|zyada)\b/i

// Short function words that are also plausible mis-hearings of English words
// ("ki"/"key", "se"/"say", "ko"/"co"). One of these on its own is not evidence \u2014
// two independent ones are. Requiring two is what stops a single odd word from
// flipping an English question into the Hinglish answer path.
const HINDI_WEAK =
  /\b(se|ko|ki|ke|par|pe|aur|ya|hum|kuch|bhi|toh|jo|woh|wo|yeh|ye|abhi|phir|lekin|magar|sirf|bahut|jaise|thoda)\b/gi

export function classifyIntent(query: string): IntentResult {
  const lower = query.toLowerCase().trim()

  // 1. Detect language (Hindi / Hinglish)
  //
  // `the` and `me` used to be in this list, which made almost every English
  // question ("tell me about the project") classify as Hindi and pick up the
  // Hinglish LANGUAGE LOCK in the answer prompt. They are English words and cannot
  // be used as Hindi cues; the Hindi readings ("\u0925\u0947", "\u092E\u0947\u0902") are always accompanied
  // by a strong marker anyway.
  const weakHits = new Set(lower.match(HINDI_WEAK) || [])
  const isHindi =
    /[\u0900-\u097F]/.test(query) || HINDI_STRONG.test(lower) || weakHits.size >= 2

  // 2. Detect DSA / Coding problem
  const isCoding =
    /\b(code|leetcode|function|class|algorithm|array|string|linked list|tree|graph|dp|dynamic programming|complexity|dsa|two sum|reverse|sort)\b/i.test(lower) ||
    /```[\s\S]*```/.test(query) ||
    /\b(write a function|implement|given an array|given a string|return the|find all)\b/i.test(lower) ||
    HINGLISH.coding.test(query)

  if (isCoding) {
    return { intent: 'dsa_coding', isCoding: true, isHindi, requiresExample: false }
  }

  // 3. System Design
  if (/\b(system design|scale|rate limiter|load balancer|architecture|sharding|microservices|distributed)\b/i.test(lower) || HINGLISH.systemDesign.test(query)) {
    return { intent: 'system_design', isCoding: false, isHindi, requiresExample: true }
  }

  // 4. Identity / Self Intro
  if (/\b(tell me about yourself|introduce yourself|who are you|your background|walk me through your resume)\b/i.test(lower) || HINGLISH.identity.test(query)) {
    return { intent: 'identity', isCoding: false, isHindi, requiresExample: false }
  }

  // 5. Behavioral
  if (/\b(tell me about a time|how do you handle|describe a situation|conflict|disagreement|mistake|failed|challenge you faced)\b/i.test(lower) || HINGLISH.behavioral.test(query)) {
    return { intent: 'behavioral', isCoding: false, isHindi, requiresExample: false }
  }

  // 6. Project Deep Dive
  if (/\b(tell me about your project|your recent project|what tech stack did you use|project experience|built in your project)\b/i.test(lower) || HINGLISH.project.test(query)) {
    return { intent: 'project_deepdive', isCoding: false, isHindi, requiresExample: true }
  }

  // 7. Definitional ("What is X", "Define Y", "X kya hai")
  // "difference kya hai" also contains "kya hai", so comparisons are routed to
  // technical_concept below instead of being flattened into a definition.
  const isDifference = HINGLISH.difference.test(query)
  if (
    !isDifference &&
    (/^(what is|define|what do you mean by|what are|explain the concept of)\b/i.test(lower) ||
      /\b(definition|meaning of)\b/i.test(lower) ||
      HINGLISH.definitional.test(query))
  ) {
    return { intent: 'definitional', isCoding: false, isHindi, requiresExample: true }
  }

  // 8. Technical Concept ("How does X work", "Difference between A and B")
  if (
    /\b(how does|how do|difference between|vs|diff between|pros and cons|advantages|working of|how is)\b/i.test(lower) ||
    isDifference ||
    HINGLISH.technicalConcept.test(query)
  ) {
    return { intent: 'technical_concept', isCoding: false, isHindi, requiresExample: true }
  }

  // 9. Followup
  if (
    (/\b(why|can you elaborate|go deeper|tell me more|what else|give an edge case)\b/i.test(lower) && query.split(' ').length < 8) ||
    HINGLISH.followup.test(query)
  ) {
    return { intent: 'followup', isCoding: false, isHindi, requiresExample: true }
  }

  // Default
  return { intent: 'general_factual', isCoding: false, isHindi, requiresExample: false }
}

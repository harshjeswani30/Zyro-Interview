// humanLikeness.ts - Natively-style Anti-AI Tells & Human Speech Enforcer

const BUZZWORD_REPLACEMENTS: [RegExp, string][] = [
  [/\bdelve into\b/gi, 'explore'],
  [/\bdelves into\b/gi, 'explores'],
  [/\bdelve\b/gi, 'explore'],
  [/\bleverage\b/gi, 'use'],
  [/\bleveraging\b/gi, 'using'],
  [/\brich tapestry\b/gi, 'combination'],
  [/\btapestry\b/gi, 'framework'],
  [/\bin conclusion\b/gi, 'Overall'],
  [/\bmoreover\b/gi, 'Also'],
  [/\bfurthermore\b/gi, 'Also'],
  [/\badditionally\b/gi, 'Also'],
  [/\bit'?s important to note that\b/gi, 'Note that'],
  [/\bit'?s worth noting that\b/gi, 'Note that'],
  [/\ballow me to explain,?\b/gi, ''],
  [/\blet me walk you through,?\b/gi, ''],
  [/\bgreat question!?,?\s*/gi, ''],
  [/\bcertainly!?,?\s*/gi, ''],
  [/\babsolutely!?,?\s*/gi, '']
]

const META_PREFIXES = [
  /^here'?s what you can say:\s*/i,
  /^say this:\s*/i,
  /^as an ai language model,?\s*/i,
  /^sure,?\s*/i,
  /^certainly,?\s*/i,
  /^here is the answer:\s*/i
]

export function enforceHumanLikeness(rawAnswer: string, requiresExample: boolean = false): string {
  if (!rawAnswer || !rawAnswer.trim()) return ''

  let text = rawAnswer.trim()

  // 1. Remove Meta Coaching Prefixes
  for (const prefix of META_PREFIXES) {
    text = text.replace(prefix, '')
  }

  // 2. Ban Em-Dashes (—), En-Dashes (–), Semicolons (;), and replace AI Buzzwords
  const parts = text.split(/(```[\s\S]*?```)/g)
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('```')) {
      // Replace em-dash with comma or period
      parts[i] = parts[i].replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ', ')

      // Replace Semicolons with full stops / commas
      parts[i] = parts[i].replace(/;\s*/g, '. ')

      // Smart Buzzword Replacement
      for (const [bannedRegex, replacement] of BUZZWORD_REPLACEMENTS) {
        parts[i] = parts[i].replace(bannedRegex, replacement)
      }

      // Cleanup double spaces
      parts[i] = parts[i].replace(/[ \t]{2,}/g, ' ')
    }
  }

  text = parts.join('').trim()

  // 3. Ensure definition questions have a real-world example if required and missing
  if (requiresExample && !text.includes('```')) {
    const hasExampleCue = /\b(for example|for instance|a real example|such as|like when)\b/i.test(text)
    if (!hasExampleCue && text.length > 30) {
      text += ' For example, in practical usage, this helps streamline processing and prevent unexpected failures.'
    }
  }

  return text
}

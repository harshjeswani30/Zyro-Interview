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

/**
 * Bullet normaliser — safety net for the mandatory point-list output format.
 *
 * The model is instructed to emit "- " bullets, but it still drifts into "•",
 * "*", en-dashes or a marker with no trailing space. Any of those either render
 * as literal characters or collapse the list, so they get rewritten to canonical
 * Markdown before the answer reaches ReactMarkdown. Code blocks are left alone.
 */
export function normalizeBulletFormatting(text: string): string {
  if (!text || !text.trim()) return text

  const parts = text.split(/(```[\s\S]*?```)/g)

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith('```')) continue

    const lines = parts[i].split('\n')

    for (let j = 0; j < lines.length; j++) {
      let line = lines[j]

      // Decorative / non-Markdown bullet markers → canonical "- ".
      line = line.replace(/^(\s*)[•·‣▪◦●○*]\s+/, '$1- ')
      line = line.replace(/^(\s*)[–—]\s+/, '$1- ')
      line = line.replace(/^(\s*)(?:→|=>|>>)\s+/, '$1- ')

      // "-Point" with no space after the marker breaks the list parse. Only a
      // letter counts, so "---" rules and "-5 items" are left alone.
      line = line.replace(/^(\s*)-(?=[A-Za-z])/, '$1- ')

      // Leading emoji / icon prefix inside a bullet (the UI adds no symbols and
      // the answer body should not either).
      line = line.replace(
        /^(\s*-\s+)(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]\s*)+/u,
        '$1'
      )

      lines[j] = line
    }

    parts[i] = lines.join('\n')
  }

  let out = parts.join('')

  // A dangling marker from a truncated generation renders as an empty bullet.
  out = out.replace(/\n\s*-\s*$/, '')

  // Collapse 3+ blank lines, which open big dead gaps between points.
  out = out.replace(/\n{3,}/g, '\n\n')

  return out.trim()
}

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
      // Replace em-dash with comma or period. A dash at the start of a line is
      // a bullet marker, not punctuation, so it is preserved.
      parts[i] = parts[i].replace(/(?<!^|\n)[ \t]*—[ \t]*/g, ', ')
      parts[i] = parts[i].replace(/(?<!^|\n)[ \t]*–[ \t]*/g, ', ')

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

  // 3. Canonicalise the bullet markers before anything is appended.
  text = normalizeBulletFormatting(text)

  // 4. Ensure definition questions have a real-world example if required and missing
  if (requiresExample && !text.includes('```')) {
    const hasExampleCue = /\b(for example|for instance|a real example|such as|like when|jaise ki|example ke liye)\b/i.test(text)
    if (!hasExampleCue && text.length > 30) {
      // Append as its own point so the bullet layout survives.
      const isBulleted = /^\s*-\s+/m.test(text)
      const filler =
        'For example, in practical usage, this helps streamline processing and prevent unexpected failures.'
      text += isBulleted ? `\n- ${filler}` : ` ${filler}`
    }
  }

  return text
}

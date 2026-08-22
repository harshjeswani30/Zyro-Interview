// codeSanityCheck.ts - Natively-style Code Sanity & Bug Inspector Engine

export function sanitizeCodeBlock(code: string, language: string = 'python'): string {
  if (!code || !code.trim()) return code

  let lines = code.split('\n')
  const isPython = language.toLowerCase().includes('python') || code.includes('def ') || code.includes('self.')

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]

    // Bug 1: Tuple Subtraction Bug (e.g. `complement = target, num` instead of `complement = target - num`)
    // Pattern: varName = var1, var2 where it should be subtraction
    if (/\b(complement|diff|difference|remainder|total)\s*=\s*(\w+)\s*,\s*(\w+)\b/i.test(line)) {
      line = line.replace(/(\w+)\s*=\s*(\w+)\s*,\s*(\w+)/i, '$1 = $2 - $3')
    }

    // Bug 2: Equality vs Assignment in conditionals
    if (isPython) {
      // Fix `if x = y:` to `if x == y:`
      line = line.replace(/\bif\s+([a-zA-Z0-9_.[\]()'"]+)\s*=\s*([a-zA-Z0-9_.[\]()'"]+)\s*:/g, 'if $1 == $2:')
      line = line.replace(/\belif\s+([a-zA-Z0-9_.[\]()'"]+)\s*=\s*([a-zA-Z0-9_.[\]()'"]+)\s*:/g, 'elif $1 == $2:')
    } else {
      // Fix JS/C++ `if (x = y)` to `if (x === y)`
      line = line.replace(/\bif\s*\(\s*([a-zA-Z0-9_.]+)\s*=\s*([a-zA-Z0-9_.]+)\s*\)/g, 'if ($1 === $2)')
    }

    lines[i] = line
  }

  return lines.join('\n')
}

export function cleanComplexityAndMath(text: string): string {
  if (!text) return text

  // Process non-code text and code blocks separately
  const parts = text.split(/(```[\s\S]*?```)/g)

  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('```')) {
      let part = parts[i]

      // 1. Clean up LaTeX symbols inside math or prose text
      part = part
        .replace(/\\times\s*/gi, ' × ')
        .replace(/\\cdot\s*/gi, ' * ')
        .replace(/\\le\s*/gi, ' ≤ ')
        .replace(/\\ge\s*/gi, ' ≥ ')
        .replace(/\\neq\s*/gi, ' ≠ ')
        .replace(/\\approx\s*/gi, ' ≈ ')
        .replace(/\\log\^2\s*/gi, ' log² ')
        .replace(/\\log\^(\d+)\s*/gi, ' log^$1 ')
        .replace(/\\log\s*/gi, ' log ')
        .replace(/\\mathcal\{O\}/gi, 'O')
        .replace(/\\Theta/gi, 'O')
        .replace(/\\sqrt\{([^}]+)\}/gi, 'sqrt($1)')

      // 2. Convert common exponents like 10^5 -> 10⁵, N^2 -> N²
      part = part
        .replace(/\^2\b/g, '²')
        .replace(/\^3\b/g, '³')
        .replace(/\^5\b/g, '⁵')
        .replace(/\^9\b/g, '⁹')

      // 3. Strip $ or $$ dollar signs around math expressions (e.g. `$2 \times 10^5$` -> `2 × 10⁵`)
      part = part.replace(/\$\$?([^$\n]+)\$\$?/g, (_match, inner) => {
        return inner.replace(/\\/g, '').replace(/\s+/g, ' ').trim()
      })

      // 4. Remove leftover backslashes inside Big-O expressions
      part = part.replace(/(\\mathcal\{O\}|\\Theta|O)\s*\(([^)]+)\)/g, (_match, _symbol, inner) => {
        const cleanInner = inner
          .replace(/\\/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
        return `O(${cleanInner})`
      })

      parts[i] = part
    }
  }

  return parts.join('')
}

export function inspectAndSanitizeAnswerCode(rawAnswer: string): string {
  if (!rawAnswer) return rawAnswer

  let processed = rawAnswer

  // First process code blocks
  if (processed.includes('```')) {
    processed = processed.replace(/(```(\w+)?\n[\s\S]*?\n```)/g, (_match, fullBlock, lang) => {
      const codeOnly = fullBlock.replace(/^```(\w+)?\n/, '').replace(/\n```$/, '')
      const sanitizedCode = sanitizeCodeBlock(codeOnly, lang || 'python')
      return `\`\`\`${lang || 'python'}\n${sanitizedCode}\n\`\`\``
    })
  }

  // Second process complexity & LaTeX math formatting
  return cleanComplexityAndMath(processed)
}

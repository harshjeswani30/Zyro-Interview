/**
 * Display-only repair for markdown that is still arriving.
 *
 * A fenced code block that has been opened but not closed makes ReactMarkdown treat
 * every following line as code, so a streamed coding answer appears to collapse into one
 * grey slab. Appending a closing fence keeps the document renderable; once the real
 * closing fence arrives the count is even again and this is a no-op.
 *
 * Only ever applied at render time — never to the text that is stored, copied or logged.
 */
export function closeOpenCodeFence(text: string): string {
  if (!text) return ''

  // A fence is ``` (or longer) at the start of a line, indented at most 3 spaces.
  // Inline spans use single backticks and must never be counted.
  const fences = text.match(/^ {0,3}```/gm)
  if (!fences || fences.length % 2 === 0) return text

  return text.endsWith('\n') ? `${text}\`\`\`` : `${text}\n\`\`\``
}

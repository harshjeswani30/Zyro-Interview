export const SSE_DONE = '[DONE]'

/**
 * Pull every complete `data:` frame out of a growing buffer.
 * Network chunks split mid-frame, so whatever is left over is returned as `rest`
 * and must be prepended to the next read.
 */
export function drainSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  const events: string[] = []

  for (const frame of parts) {
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) events.push(line.slice(5).trim())
    }
  }

  return { events, rest }
}

/**
 * The visible-answer delta from one frame.
 *
 * Reads `delta.content` and nothing else — by construction a `delta.reasoning`
 * (or any other) field yields '' and never reaches the UI. This is the enforcement
 * point for "no thinking text in the answer panel" on the streaming path.
 */
export function extractDelta(eventData: string): string {
  if (!eventData || eventData === SSE_DONE) return ''
  try {
    const parsed = JSON.parse(eventData) as { choices?: { delta?: { content?: string } }[] }
    return parsed.choices?.[0]?.delta?.content ?? ''
  } catch {
    return ''
  }
}

/**
 * Strip chain-of-thought out of accumulated answer text.
 *
 * Mirrors the gateway's buffered cleanup at ai-gateway/src/index.ts:591-596, which
 * cannot run over a stream, and adds the case only streaming produces: an opening
 * `<think>` whose closing tag has not arrived yet. Everything from that tag onward is
 * dropped, so a partially-emitted thought is never rendered — it reappears as answer
 * text only if it turns out not to have been a thought at all.
 */
export function stripThinkBlocks(text: string): string {
  if (!text) return ''
  let out = text.replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
  const open = out.toLowerCase().indexOf('<think>')
  if (open !== -1) out = out.slice(0, open)
  return out.trim()
}

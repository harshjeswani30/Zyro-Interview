import { describe, it, expect } from 'vitest'
import { drainSseEvents, extractDelta, stripThinkBlocks } from './sseParser'

describe('drainSseEvents', () => {
  it('returns nothing and keeps a partial frame', () => {
    const out = drainSseEvents('data: {"choices":[{"delta":')
    expect(out.events).toEqual([])
    expect(out.rest).toBe('data: {"choices":[{"delta":')
  })

  it('yields complete frames and retains the tail', () => {
    const out = drainSseEvents('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
    expect(out.events).toEqual(['{"a":1}', '{"b":2}'])
    expect(out.rest).toBe('data: {"c"')
  })

  it('handles CRLF line endings', () => {
    const out = drainSseEvents('data: {"a":1}\r\n\r\n')
    expect(out.events).toEqual(['{"a":1}'])
    expect(out.rest).toBe('')
  })

  it('surfaces the terminator', () => {
    expect(drainSseEvents('data: [DONE]\n\n').events).toEqual(['[DONE]'])
  })

  it('ignores comment and non-data lines', () => {
    const out = drainSseEvents(': keepalive\n\nevent: ping\n\ndata: {"a":1}\n\n')
    expect(out.events).toEqual(['{"a":1}'])
  })
})

describe('extractDelta', () => {
  it('pulls the content delta', () => {
    expect(extractDelta('{"choices":[{"delta":{"content":"Hel"}}]}')).toBe('Hel')
  })

  it('returns empty for a reasoning-only delta', () => {
    expect(extractDelta('{"choices":[{"delta":{"reasoning":"thinking"}}]}')).toBe('')
  })

  it('returns empty for malformed JSON rather than throwing', () => {
    expect(extractDelta('{not json')).toBe('')
  })

  it('returns empty for the terminator', () => {
    expect(extractDelta('[DONE]')).toBe('')
  })

  it('ignores every non-content field on the delta', () => {
    expect(extractDelta('{"choices":[{"delta":{"reasoning":"long CoT","role":"assistant"}}]}')).toBe('')
    expect(extractDelta('{"choices":[{"delta":{"reasoning_content":"CoT"}}]}')).toBe('')
  })
})

describe('stripThinkBlocks — no chain-of-thought in the answer panel', () => {
  it('leaves clean text alone', () => {
    expect(stripThinkBlocks('- A closure captures scope.')).toBe('- A closure captures scope.')
  })

  it('removes a closed think block', () => {
    expect(stripThinkBlocks('<think>deliberating</think>\n- Real answer')).toBe('- Real answer')
  })

  it('truncates at an unterminated think block (the mid-stream case)', () => {
    expect(stripThinkBlocks('- Real answer\n<think>we need to consi')).toBe('- Real answer')
  })

  it('returns empty when the stream has produced only reasoning so far', () => {
    expect(stripThinkBlocks('<think>the user is asking about')).toBe('')
  })

  it('is case-insensitive and survives multiple blocks', () => {
    expect(stripThinkBlocks('<THINK>a</THINK>one<think>b</think>two')).toBe('onetwo')
  })
})

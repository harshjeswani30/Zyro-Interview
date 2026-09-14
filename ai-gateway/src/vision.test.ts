/**
 * /gateway/vision tests.
 *
 * The vision route is where a live interview stalls if anything goes wrong, and each
 * assertion here covers a failure we would otherwise only meet mid-interview:
 *
 *  - Key rotation. One throttled key must not take the screenshot feature down, so a
 *    429 has to move to the NEXT key instead of surfacing to the candidate.
 *  - The model ladder. qwen/qwen3.8-27b is a Preview model on Groq; when it is pulled
 *    or saturated the route has to fall through to qwen/qwen3.6-27b by itself.
 *  - Payload shaping. `max_tokens` is deprecated upstream, `reasoning_format` 400s on
 *    some models, and Groq rejects a 4th image — each of those fails identically on all
 *    five keys, so they are asserted on the wire rather than trusted.
 *  - 400 vs 429. Rotating keys on a 400 only multiplies latency before the same
 *    failure, so a 400 must advance the model, not the key.
 *
 * Groq is stubbed throughout. Cooldowns and the round-robin cursor are module-level
 * state in src/index.ts, so every test uses its own key prefix to stay isolated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

interface Sent {
  url: string
  authorization: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

let sent: Sent[] = []
let realFetch: typeof globalThis.fetch

/** Isolated keys per test so one test's cooldowns cannot reach another's pool. */
function envFor(tag: string, count = 5): Record<string, string> {
  const env: Record<string, string> = {}
  for (let i = 1; i <= count; i++) env[`GROQ_KEY_${i}`] = `gsk_${tag}_key_${i}`
  return env
}

function jsonOk(content = '- The answer is B.'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

function sseOk(): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"- hi"}}]}\n\n'))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  return new Response(stream, { status: 200 })
}

function failure(status: number, body = 'upstream said no', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

/** Records every upstream call and answers it from `reply`. */
function stubGroq(reply: (call: Sent, index: number) => Response): void {
  globalThis.fetch = vi.fn(async (input: unknown, init: Record<string, any>) => {
    const call: Sent = {
      url: String(input),
      authorization: String(init?.headers?.Authorization ?? ''),
      body: JSON.parse(String(init?.body ?? '{}'))
    }
    sent.push(call)
    return reply(call, sent.length - 1)
  }) as unknown as typeof globalThis.fetch
}

function visionRequest(body: unknown, env: Record<string, string>): Promise<Response> {
  return app.request(
    '/gateway/vision',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env
  )
}

const image = (n: number): Record<string, unknown> => ({
  type: 'image_url',
  image_url: { url: `data:image/jpeg;base64,img${n}` }
})

/** What the desktop app actually posts: a system turn, one text part, one screenshot. */
const BASE_BODY = {
  messages: [
    { role: 'system', content: 'You are the candidate.' },
    { role: 'user', content: [{ type: 'text', text: 'Read the screen.' }, image(1)] }
  ],
  max_tokens: 1024
}

beforeEach(() => {
  sent = []
  realFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('/gateway/vision key rotation', () => {
  it('moves to the next key on a 429 instead of failing the request', async () => {
    stubGroq((_call, index) =>
      index < 3 ? failure(429, 'rate limited', { 'retry-after': '1' }) : jsonOk()
    )

    const res = await visionRequest(BASE_BODY, envFor('rot'))

    expect(res.status).toBe(200)
    expect(sent).toHaveLength(4)
    // Four calls on four DIFFERENT keys — a repeat would mean the cooldown never landed.
    expect(new Set(sent.map((s) => s.authorization)).size).toBe(4)
    expect(sent.every((s) => s.url === GROQ_URL)).toBe(true)
    expect(res.headers.get('x-vision-model')).toBe('qwen/qwen3.8-27b')
  })

  it('falls through to qwen3.6 once every key is throttled on qwen3.8', async () => {
    stubGroq((call) => (call.body.model === 'qwen/qwen3.8-27b' ? failure(429) : jsonOk()))

    // One key, so the ladder is reached after a single 1200ms refill pass.
    const res = await visionRequest(BASE_BODY, envFor('ladder', 1))

    expect(res.status).toBe(200)
    expect(sent.map((s) => s.body.model)).toEqual([
      'qwen/qwen3.8-27b',
      'qwen/qwen3.8-27b',
      'qwen/qwen3.6-27b'
    ])
    expect(res.headers.get('x-vision-model')).toBe('qwen/qwen3.6-27b')
  })
})

describe('/gateway/vision payload shaping', () => {
  it('translates the deprecated max_tokens into max_completion_tokens', async () => {
    stubGroq(() => jsonOk())

    await visionRequest(BASE_BODY, envFor('tokens', 1))

    expect(sent[0].body.max_completion_tokens).toBe(1024)
    expect(sent[0].body).not.toHaveProperty('max_tokens')
  })

  it('caps the token request at the vision ceiling', async () => {
    stubGroq(() => jsonOk())

    await visionRequest({ ...BASE_BODY, max_tokens: 99999 }, envFor('cap', 1))

    expect(sent[0].body.max_completion_tokens).toBe(4096)
  })

  it('asks for zero reasoning tokens and never sends reasoning_format', async () => {
    stubGroq(() => jsonOk())

    await visionRequest(BASE_BODY, envFor('effort', 1))

    expect(sent[0].body.reasoning_effort).toBe('none')
    expect(sent[0].body).not.toHaveProperty('reasoning_format')
    expect(sent[0].body.model).toBe('qwen/qwen3.8-27b')
  })

  it('forwards only the last 3 images, since Groq rejects a 4th', async () => {
    stubGroq(() => jsonOk())

    await visionRequest(
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'q' }, image(1), image(2), image(3), image(4)]
          }
        ]
      },
      envFor('images', 1)
    )

    const parts = sent[0].body.messages[0].content
    expect(parts[0]).toEqual({ type: 'text', text: 'q' })
    expect(parts.filter((p: { type: string }) => p.type === 'image_url')).toHaveLength(3)
    expect(
      parts
        .map((p: { image_url?: { url: string } }) => p.image_url?.url)
        .filter(Boolean)
    ).toEqual([
      'data:image/jpeg;base64,img2',
      'data:image/jpeg;base64,img3',
      'data:image/jpeg;base64,img4'
    ])
  })
})

describe('/gateway/vision streaming', () => {
  it('passes the upstream SSE body straight through', async () => {
    stubGroq(() => sseOk())

    const res = await visionRequest({ ...BASE_BODY, stream: true }, envFor('stream', 1))

    expect(sent[0].body.stream).toBe(true)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(res.headers.get('x-gateway-stream')).toBe('1')
    expect(res.headers.get('x-vision-model')).toBe('qwen/qwen3.8-27b')
    expect(await res.text()).toContain('data: [DONE]')
  })

  it('does not stream unless the client asked for it', async () => {
    stubGroq(() => jsonOk())

    const res = await visionRequest(BASE_BODY, envFor('nostream', 1))

    expect(sent[0].body.stream).toBe(false)
    expect(res.headers.get('x-gateway-stream')).toBeNull()
  })
})

describe('/gateway/vision error handling', () => {
  it('advances the model on a 400 rather than burning the key pool', async () => {
    stubGroq(() => failure(400, 'unsupported parameter'))

    const res = await visionRequest(BASE_BODY, envFor('badreq'))

    expect(res.status).toBe(503)
    // Three calls, not ten: two on qwen3.8 (the second being the single system-fold
    // retry) and one on qwen3.6 — all on the SAME key, because no key fixes a 400.
    expect(sent.map((s) => s.body.model)).toEqual([
      'qwen/qwen3.8-27b',
      'qwen/qwen3.8-27b',
      'qwen/qwen3.6-27b'
    ])
    expect(new Set(sent.map((s) => s.authorization)).size).toBe(1)
  })

  it('folds the system turn into the user message on its one 400 retry', async () => {
    stubGroq((_call, index) => (index === 0 ? failure(400, 'bad request') : jsonOk()))

    const res = await visionRequest(BASE_BODY, envFor('fold'))

    expect(res.status).toBe(200)
    const retried = sent[1].body.messages
    expect(retried.some((m: { role: string }) => m.role === 'system')).toBe(false)
    expect(retried[0].content[0].text).toContain('You are the candidate.')
    expect(retried[0].content[0].text).toContain('Read the screen.')
  })

  it('returns 413 without rotating, because no key accepts an oversized screenshot', async () => {
    stubGroq(() => failure(413, 'request too large'))

    const res = await visionRequest(BASE_BODY, envFor('large'))

    expect(res.status).toBe(413)
    expect(sent).toHaveLength(1)
  })

  it('strips a leaked <think> block out of the buffered answer', async () => {
    stubGroq(() => jsonOk('<think>plan the answer</think>- The answer is B.'))

    const res = await visionRequest(BASE_BODY, envFor('think', 1))
    const data = (await res.json()) as {
      choices: { message: { content: string } }[]
    }

    expect(data.choices[0].message.content).toBe('- The answer is B.')
  })
})

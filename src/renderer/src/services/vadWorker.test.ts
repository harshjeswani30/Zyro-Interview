import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The VAD worker is written against the Web Worker global scope (`self.onmessage`
 * / `self.postMessage`). We give it a fake `self` before importing, capture every
 * message it posts, and drive it by calling the handler it registered. Module
 * state is per-import, so each test re-imports with a fresh mock.
 */
type Posted = { type: string; data: unknown }

async function loadWorker(): Promise<{
  send: (type: string, data?: unknown, enabled?: boolean) => void
  posted: Posted[]
}> {
  const posted: Posted[] = []
  let handler: ((e: { data: unknown }) => void) | null = null
  const fakeSelf = {
    set onmessage(fn: (e: { data: unknown }) => void) {
      handler = fn
    },
    postMessage(msg: Posted) {
      posted.push(msg)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).self = fakeSelf
  vi.resetModules()
  await import('./vadWorker')
  return {
    send: (type: string, data?: unknown, enabled?: boolean) => handler?.({ data: { type, data, ...(enabled === undefined ? {} : { enabled }) } }),
    posted
  }
}

const SR = 48000
const CHUNK = 4096

// A chunk whose RMS equals |v| (constant-filled buffer → RMS = |v|).
function chunk(v: number): Float32Array {
  return new Float32Array(CHUNK).fill(v)
}
const LOUD = () => chunk(0.05) //   > SPEECH_START_RMS (0.018): real speech
const DEADBAND = () => chunk(0.014) // between SPEECH_END_RMS (0.01) and START (0.018)
const SILENT = () => chunk(0.0) //  < SPEECH_END_RMS: clean silence

function configAuto(send: (t: string, d?: unknown, enabled?: boolean) => void): void {
  send('config', { isAuto: true, isManual: false, sampleRate: SR })
}

describe('vadWorker — turn finalization', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).self
  })

  it('finalizes a turn after clean silence past LONG_PAUSE_SEC (baseline)', async () => {
    const { send, posted } = await loadWorker()
    configAuto(send)

    // Speak: enough loud audio to clear onset + MIN_VOICED_SEC (0.4s ≈ 5 chunks).
    for (let i = 0; i < 10; i++) send('audio', LOUD())
    // Then true silence for > LONG_PAUSE_SEC (2.4s ≈ 28 chunks). Use 40 for margin.
    for (let i = 0; i < 40; i++) send('audio', SILENT())

    const finalize = posted.find((m) => m.type === 'finalize')
    expect(finalize, 'clean silence must close the turn').toBeTruthy()
  })

  it('finalizes even when the trailing pause carries dead-band ambient noise', async () => {
    // This is the stuck-"Waiting..." bug: dead-band ambient audio (0.01–0.018 RMS,
    // e.g. room tone / call codec noise on desktop capture) after the speaker stops
    // repeatedly reset the pause timer, so silence never reached LONG_PAUSE_SEC and
    // the finalize that triggers the answer was never emitted.
    const { send, posted } = await loadWorker()
    configAuto(send)

    for (let i = 0; i < 10; i++) send('audio', LOUD())
    // The speaker stops: a couple of genuinely quiet chunks flip speech off and post
    // "Waiting..." — this is the state the chip gets stuck in.
    for (let i = 0; i < 2; i++) send('audio', SILENT())
    // Then the ambient floor creeps back up into the dead band (0.01–0.018) and stays
    // there, well past LONG_PAUSE_SEC worth. The old code reset the pause timer on every
    // one of these, so silence never accumulated and finalize never fired.
    for (let i = 0; i < 60; i++) send('audio', DEADBAND())

    const finalize = posted.find((m) => m.type === 'finalize')
    expect(
      finalize,
      'a turn must still close when the trailing pause is ambient dead-band noise'
    ).toBeTruthy()
  })

  it('recovers when a short dead-band dip is followed by clean silence', async () => {
    // A short dead-band run is allowed as a continuation, but it must not erase the
    // pause forever when the stream becomes genuinely silent afterwards.
    const { send, posted } = await loadWorker()
    configAuto(send)

    for (let i = 0; i < 10; i++) send('audio', LOUD())
    send('audio', SILENT())
    for (let i = 0; i < 6; i++) send('audio', DEADBAND()) // ~0.5s continuation grace
    for (let i = 0; i < 40; i++) send('audio', SILENT())

    expect(
      posted.find((m) => m.type === 'finalize'),
      'clean silence after a dead-band dip must close the turn'
    ).toBeTruthy()
  })

  it('closes a speaker who stops directly into the dead band', async () => {
    // There may be no below-END sample at all when system-audio capture has a steady
    // codec floor. The old detector stayed speechActive forever in that case.
    const { send, posted } = await loadWorker()
    configAuto(send)

    for (let i = 0; i < 10; i++) send('audio', LOUD())
    for (let i = 0; i < 40; i++) send('audio', DEADBAND())

    expect(
      posted.find((m) => m.type === 'finalize'),
      'a direct dead-band tail must still emit finalize'
    ).toBeTruthy()
    expect(posted.some((m) => m.type === 'status' && m.data === 'Waiting...')).toBe(true)
  })

  it('does NOT finalize on a short dead-band dip inside a sentence (no mid-question cut)', async () => {
    // The behaviour the dead-band-as-speech rule was added to protect: a quiet stretch
    // shorter than LONG_PAUSE_SEC is the middle of a clause, not the end of the turn.
    const { send, posted } = await loadWorker()
    configAuto(send)

    for (let i = 0; i < 10; i++) send('audio', LOUD())
    send('audio', SILENT())
    // ~1s of dead band (12 chunks ≈ 1.0s) — under the 2.4s ceiling.
    for (let i = 0; i < 12; i++) send('audio', DEADBAND())

    expect(
      posted.find((m) => m.type === 'finalize'),
      'a brief quiet dip must not end the turn'
    ).toBeFalsy()
  })

  it('re-arms the grace window when real speech breaks through the dead band', async () => {
    // A dead-band run interrupted by an actual loud syllable is continuing speech: the
    // ceiling clock must restart, not carry over toward a premature finalize.
    const { send, posted } = await loadWorker()
    configAuto(send)

    for (let i = 0; i < 10; i++) send('audio', LOUD())
    send('audio', SILENT())
    for (let i = 0; i < 20; i++) send('audio', DEADBAND()) // ~1.7s, still under ceiling
    for (let i = 0; i < 6; i++) send('audio', LOUD()) // real speech: resets the clock
    for (let i = 0; i < 20; i++) send('audio', DEADBAND()) // another ~1.7s, still under

    expect(
      posted.find((m) => m.type === 'finalize'),
      'speech breaking through must re-arm the grace window'
    ).toBeFalsy()
  })

  it('keeps the worker clock aligned while manual detection is disabled', async () => {
    const { send, posted } = await loadWorker()
    send('config', { isAuto: false, isManual: true, sampleRate: SR })

    const idleChunks = 120
    for (let i = 0; i < idleChunks; i++) send('audio', SILENT(), false)
    for (let i = 0; i < 10; i++) send('audio', LOUD(), true)
    send('manual_stop')

    const finalize = posted.find((m) => m.type === 'finalize')
    expect(finalize).toBeTruthy()
    expect((finalize?.data as { startSample: number }).startSample).toBeGreaterThanOrEqual(idleChunks * CHUNK)
  })
})

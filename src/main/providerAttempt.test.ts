import { describe, expect, it, vi } from 'vitest'
import { runProviderAttempt } from './providerAttempt'

describe('runProviderAttempt', () => {
  it('bounds a hung provider and suppresses late deltas', async () => {
    vi.useFakeTimers()
    try {
      const deltas: string[] = []
      const pending = runProviderAttempt(
        async () => new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, text: 'late answer' }), 100)
        }),
        { onDelta: (text) => deltas.push(text), firstTextMs: 50, totalMs: 200 }
      )

      await vi.advanceTimersByTimeAsync(50)
      await expect(pending).resolves.toMatchObject({ ok: false, error: 'Timed out waiting for the linked account' })
      await vi.advanceTimersByTimeAsync(100)
      expect(deltas).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the idle watchdog whenever visible text advances', async () => {
    vi.useFakeTimers()
    try {
      const pending = runProviderAttempt(
        async (_signal, onDelta) => new Promise((resolve) => {
          setTimeout(() => onDelta('first'), 20)
          setTimeout(() => resolve({ ok: true, text: 'first answer' }), 80)
        }),
        { onDelta: vi.fn(), firstTextMs: 40, idleMs: 100, totalMs: 200 }
      )

      await vi.advanceTimersByTimeAsync(80)
      await expect(pending).resolves.toMatchObject({ ok: true, text: 'first answer' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an attempt without treating cancellation as a provider answer', async () => {
    vi.useFakeTimers()
    try {
      const outer = new AbortController()
      const pending = runProviderAttempt(
        async (signal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }),
        { onDelta: vi.fn(), signal: outer.signal, firstTextMs: 100, totalMs: 200 }
      )
      outer.abort()
      await expect(pending).resolves.toMatchObject({ ok: false, error: 'Request cancelled' })
    } finally {
      vi.useRealTimers()
    }
  })
})

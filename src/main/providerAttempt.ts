export interface ProviderAttemptResult {
  ok: boolean
  text: string
  exhausted?: boolean
  resetAt?: number
  error?: string
}

/**
 * Bound the ENTIRE attempt, including cookies, navigation, composer submission and
 * response bodies. Abort alone is insufficient: Electron navigation/executeJavaScript
 * and a broken transport may never reject. Race them against a settling watchdog and
 * suppress all late deltas before advancing to the fallback provider.
 *
 * Semantics:
 *  - The watchdog can abort the run's signal to unblock a stuck provider, but it
 *    does NOT determine the final result on its own.
 *  - After the race settles (whichever side wins), we always await the run to
 *    completion. A successful run answer (ok:true, non-empty) always takes priority
 *    over a concurrent watchdog error so that an answer that arrives in the same
 *    timer-flush tick as a timeout is never discarded.
 *  - If the run itself hangs forever after abort, `totalMs` (default 120s) acts as
 *    an outer hard deadline that both aborts the signal AND settles the race — the
 *    `stopped` promise ensures the function does not block indefinitely.
 */
export async function runProviderAttempt(
  run: (signal: AbortSignal, onDelta: (text: string) => void) => Promise<ProviderAttemptResult>,
  opts: {
    onDelta: (text: string) => void
    signal?: AbortSignal
    firstTextMs: number
    idleMs?: number
    totalMs?: number
  }
): Promise<ProviderAttemptResult> {
  if (opts.signal?.aborted) return { ok: false, text: '', error: 'Request cancelled' }
  const controller = new AbortController()
  let active = true
  let previous = ''
  let timer: ReturnType<typeof setTimeout>
  let totalTimer: ReturnType<typeof setTimeout>
  let watchdogError: string | null = null
  let finish!: (result: ProviderAttemptResult) => void
  const stopped = new Promise<ProviderAttemptResult>((resolve) => { finish = resolve })
  const stop = (error: string): void => {
    if (!active) return
    active = false
    watchdogError = error
    controller.abort()
    // Delay one microtask so a run that resolves in the same timer-flush tick
    // can win the race below before `stopped` settles.
    Promise.resolve().then(() => finish({ ok: false, text: '', error }))
  }
  const onAbort = (): void => stop('Request cancelled')
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  timer = setTimeout(() => stop('Timed out waiting for the linked account'), opts.firstTextMs)
  totalTimer = setTimeout(() => stop('Linked account exceeded the response time limit'), opts.totalMs ?? 120_000)
  const onDelta = (text: string): void => {
    if (!active || !text.trim() || text === previous) return
    previous = text
    clearTimeout(timer)
    timer = setTimeout(() => stop('Linked account stopped responding'), opts.idleMs ?? 20_000)
    opts.onDelta(text)
  }
  try {
    const runPromise = Promise.resolve()
      .then(() => run(controller.signal, onDelta))
      .catch((error: unknown): ProviderAttemptResult => ({
        ok: false,
        text: '',
        error: error instanceof Error ? error.message : 'Linked account request failed'
      }))

    // Race the run against the watchdog. The Promise.resolve() delay in stop() gives
    // the run one microtask to win if both settle in the same timer tick.
    const result = await Promise.race([runPromise, stopped])

    // If the run produced a valid answer, return it even if the watchdog also fired.
    if (result.ok && result.text.trim()) return result

    // Watchdog won (or run failed). Prefer the watchdog message as it is more
    // user-readable than internal provider errors.
    if (watchdogError && !result.ok) return { ok: false, text: '', error: watchdogError }
    return result
  } finally {
    active = false
    clearTimeout(timer)
    clearTimeout(totalTimer)
    opts.signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}

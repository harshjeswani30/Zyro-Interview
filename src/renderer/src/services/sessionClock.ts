/*
 * Session-clock math, pulled out of OverlayPage so the branch that decides how much
 * time is left -- and whether that is worth alarming the user about -- can be tested
 * directly. Two bugs lived in the inline version this replaces:
 *
 *   1. `sessionBalance` starts at -1 meaning "not fetched yet", but the old code fell
 *      straight into the free-trial branch for anything that was not > 0. So every
 *      session opened on the 10-minute trial clock, and for a user whose old trial was
 *      already spent that computed 0s remaining -- firing "Under 5 minutes left" at
 *      someone holding a full credit balance.
 *   2. When the balance was known only from the session payload (fetch still in
 *      flight), `isPremium` went true while the arithmetic still used the -1
 *      sentinel: -1 * 3600 clamped to 0 remaining, which is also 'crit'.
 *
 * The fix in both cases is the same idea: "unknown" is its own state, and an unknown
 * clock never raises an alarm.
 */

export type SessionTimeBand = 'ok' | 'warn' | 'crit'

/** Free-trial allowance, in seconds. */
export const TRIAL_LIMIT_SEC = 600
/** One credit buys one hour. */
export const SECONDS_PER_CREDIT = 3600
/** Below this many seconds the session is "low". */
export const WARN_BELOW_SEC = 900
/** Below this many seconds the session is about to end. */
export const CRIT_BELOW_SEC = 300

export interface SessionClockInput {
    /** Credits fetched for the account, or -1 while the fetch has not landed. */
    sessionBalance: number
    /** True once a paid run has been latched for this session. */
    sessionDeducted: boolean
    /** sessions_balance carried in on the session payload, when it had one. */
    sessionPayloadBalance?: number
    /** trial_seconds_used already spent before this session started. */
    trialSecondsUsed: number
    /** Seconds elapsed in this session. */
    elapsedSeconds: number
}

export interface SessionClock {
    /** False until a real balance is in. Nothing about time is trustworthy yet. */
    balanceKnown: boolean
    isPremium: boolean
    remainingSeconds: number
    totalSeconds: number
    /** 0..1, for the timer tab's progress bar. */
    progress: number
    band: SessionTimeBand
}

/** An unknown clock never raises an alarm. */
export function resolveTimeBand(remainingSeconds: number, balanceKnown: boolean): SessionTimeBand {
    if (!balanceKnown) return 'ok'
    if (remainingSeconds < CRIT_BELOW_SEC) return 'crit'
    if (remainingSeconds < WARN_BELOW_SEC) return 'warn'
    return 'ok'
}

export function resolveSessionClock(input: SessionClockInput): SessionClock {
    const {
        sessionBalance,
        sessionDeducted,
        sessionPayloadBalance,
        trialSecondsUsed,
        elapsedSeconds
    } = input

    // The fetched balance wins; the session payload fills in while the fetch is still
    // in flight. -1 from both means we genuinely do not know yet.
    const effectiveBalance =
        sessionBalance >= 0
            ? sessionBalance
            : sessionPayloadBalance !== undefined
              ? sessionPayloadBalance
              : -1

    // Deliberately not OR-ed with sessionDeducted: a latched paid run with no credit
    // number to work from is still an unknown clock, and reporting it as known is what
    // produced a bogus 'crit'.
    const balanceKnown = effectiveBalance >= 0
    const isPremium = effectiveBalance > 0 || sessionDeducted

    const creditSeconds = Math.max(0, effectiveBalance) * SECONDS_PER_CREDIT
    const totalSeconds = isPremium ? Math.max(1, creditSeconds) : TRIAL_LIMIT_SEC
    const remainingSeconds = isPremium
        ? Math.max(0, creditSeconds - elapsedSeconds)
        : Math.max(0, TRIAL_LIMIT_SEC - (trialSecondsUsed + elapsedSeconds))

    return {
        balanceKnown,
        isPremium,
        remainingSeconds,
        totalSeconds,
        progress: balanceKnown ? Math.min(1, Math.max(0, remainingSeconds / totalSeconds)) : 1,
        band: resolveTimeBand(remainingSeconds, balanceKnown)
    }
}

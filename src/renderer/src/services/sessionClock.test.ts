import { describe, it, expect } from 'vitest'
import {
    resolveSessionClock,
    resolveTimeBand,
    TRIAL_LIMIT_SEC,
    SECONDS_PER_CREDIT
} from './sessionClock'

const base = {
    sessionBalance: -1,
    sessionDeducted: false,
    sessionPayloadBalance: undefined as number | undefined,
    trialSecondsUsed: 0,
    elapsedSeconds: 0
}

describe('resolveSessionClock -- unknown balance', () => {
    it('reports the balance as unknown before the fetch lands', () => {
        const clock = resolveSessionClock(base)
        expect(clock.balanceKnown).toBe(false)
        expect(clock.band).toBe('ok')
    })

    it('stays silent for a paid user whose old free trial was fully spent', () => {
        // The reported bug: 149 credits on the account, trial long since exhausted, and
        // the overlay opened with "Under 5 minutes left -- wrap up soon".
        const clock = resolveSessionClock({ ...base, trialSecondsUsed: TRIAL_LIMIT_SEC })
        expect(clock.balanceKnown).toBe(false)
        expect(clock.band).toBe('ok')
    })

    it('never warns while unknown, no matter how much trial time was used', () => {
        for (const used of [0, 299, 300, 599, 600, 5000]) {
            expect(resolveSessionClock({ ...base, trialSecondsUsed: used }).band).toBe('ok')
        }
    })

    it('shows a full progress bar while unknown rather than an empty one', () => {
        expect(resolveSessionClock({ ...base, trialSecondsUsed: 600 }).progress).toBe(1)
    })
})

describe('resolveSessionClock -- paid sessions', () => {
    it('gives a 149-credit account its full hours', () => {
        const clock = resolveSessionClock({ ...base, sessionBalance: 149 })
        expect(clock.balanceKnown).toBe(true)
        expect(clock.isPremium).toBe(true)
        expect(clock.remainingSeconds).toBe(149 * SECONDS_PER_CREDIT)
        expect(clock.band).toBe('ok')
    })

    it('uses the session payload balance while the fetch is still in flight', () => {
        // Second bug: isPremium went true off the payload while the arithmetic still
        // used the -1 sentinel, clamping remaining to 0 and landing on 'crit'.
        const clock = resolveSessionClock({ ...base, sessionPayloadBalance: 149 })
        expect(clock.balanceKnown).toBe(true)
        expect(clock.remainingSeconds).toBe(149 * SECONDS_PER_CREDIT)
        expect(clock.band).toBe('ok')
    })

    it('prefers the fetched balance over the payload once both exist', () => {
        const clock = resolveSessionClock({
            ...base,
            sessionBalance: 2,
            sessionPayloadBalance: 149
        })
        expect(clock.remainingSeconds).toBe(2 * SECONDS_PER_CREDIT)
    })

    it('ignores trial usage entirely for a paid account', () => {
        const clock = resolveSessionClock({
            ...base,
            sessionBalance: 149,
            trialSecondsUsed: TRIAL_LIMIT_SEC
        })
        expect(clock.remainingSeconds).toBe(149 * SECONDS_PER_CREDIT)
    })

    it('still warns a paid session that is genuinely running out', () => {
        // 0.05 credits = 180s, so the warning must fire -- the fix must not mute real ones.
        expect(resolveSessionClock({ ...base, sessionBalance: 0.05 }).band).toBe('crit')
        expect(resolveSessionClock({ ...base, sessionBalance: 0.2 }).band).toBe('warn')
        expect(
            resolveSessionClock({ ...base, sessionBalance: 1, elapsedSeconds: 3500 }).band
        ).toBe('crit')
    })

    it('floors remaining time at zero instead of going negative', () => {
        const clock = resolveSessionClock({ ...base, sessionBalance: 1, elapsedSeconds: 99999 })
        expect(clock.remainingSeconds).toBe(0)
        expect(clock.progress).toBe(0)
    })
})

describe('resolveSessionClock -- free trial', () => {
    it('gives an untouched trial the full allowance', () => {
        const clock = resolveSessionClock({ ...base, sessionBalance: 0 })
        expect(clock.balanceKnown).toBe(true)
        expect(clock.isPremium).toBe(false)
        expect(clock.remainingSeconds).toBe(TRIAL_LIMIT_SEC)
        // 10 minutes really is under the 15-minute mark.
        expect(clock.band).toBe('warn')
    })

    it('counts prior trial usage against the allowance', () => {
        const clock = resolveSessionClock({
            ...base,
            sessionBalance: 0,
            trialSecondsUsed: 400
        })
        expect(clock.remainingSeconds).toBe(200)
        expect(clock.band).toBe('crit')
    })

    it('treats a spent trial as zero, not negative', () => {
        const clock = resolveSessionClock({
            ...base,
            sessionBalance: 0,
            trialSecondsUsed: 900
        })
        expect(clock.remainingSeconds).toBe(0)
    })
})

describe('resolveTimeBand', () => {
    it('maps the thresholds', () => {
        expect(resolveTimeBand(299, true)).toBe('crit')
        expect(resolveTimeBand(300, true)).toBe('warn')
        expect(resolveTimeBand(899, true)).toBe('warn')
        expect(resolveTimeBand(900, true)).toBe('ok')
    })

    it('is unconditionally ok when the balance is unknown', () => {
        expect(resolveTimeBand(0, false)).toBe('ok')
        expect(resolveTimeBand(1, false)).toBe('ok')
    })
})

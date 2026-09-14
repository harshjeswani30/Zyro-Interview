import { describe, it, expect } from 'vitest'
import { shouldAnswerFinalizedTurn } from './turnGating'

describe('shouldAnswerFinalizedTurn', () => {
    it('answers a VAD-detected pause in auto mode', () => {
        expect(shouldAnswerFinalizedTurn({ autoMode: true, userRequestedStop: false })).toBe(true)
    })

    it('answers when the user presses Stop in manual mode', () => {
        // The reported bug: Listen -> speak -> Stop showed the transcript but never
        // produced an answer, because the gate only looked at the mode.
        expect(shouldAnswerFinalizedTurn({ autoMode: false, userRequestedStop: true })).toBe(true)
    })

    it('ignores a VAD-detected pause in manual mode', () => {
        // Manual mode means the user owns the turn boundary; the detector noticing a
        // pause on its own must not end the turn for them.
        expect(shouldAnswerFinalizedTurn({ autoMode: false, userRequestedStop: false })).toBe(false)
    })

    it('still answers in auto mode when a stop was also pending', () => {
        // Mode switch mid-utterance: whichever way the race lands, the turn is answered.
        expect(shouldAnswerFinalizedTurn({ autoMode: true, userRequestedStop: true })).toBe(true)
    })
})

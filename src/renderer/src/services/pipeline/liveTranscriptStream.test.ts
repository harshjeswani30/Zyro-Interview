import { describe, it, expect } from 'vitest'
import {
    applyDeepgramMessage,
    emptyLiveTranscript,
    interimWordCount,
    liveTranscriptText,
    readTranscript
} from './liveTranscriptStream'

/** Shapes a Deepgram `Results` frame the way the live socket actually sends it. */
const results = (transcript: string, isFinal = false): unknown => ({
    type: 'Results',
    is_final: isFinal,
    channel: { alternatives: [{ transcript }] }
})

describe('readTranscript', () => {
    it('reads the first alternative', () => {
        expect(readTranscript(results('hello there'))).toBe('hello there')
    })

    it('returns empty for frames that carry no transcript', () => {
        expect(readTranscript({ type: 'Metadata' })).toBe('')
        expect(readTranscript({ type: 'Results', channel: { alternatives: [] } })).toBe('')
        expect(readTranscript(null)).toBe('')
        expect(readTranscript('not an object')).toBe('')
    })
})

describe('applyDeepgramMessage -- interim results revise the tail', () => {
    it('grows the tail word by word', () => {
        let s = emptyLiveTranscript()
        const seen: string[] = []
        for (const t of ['can', 'can you', 'can you explain', 'can you explain closures']) {
            s = applyDeepgramMessage(s, results(t))
            seen.push(liveTranscriptText(s))
        }
        // This is the behaviour the old segment model could not produce.
        expect(seen).toEqual([
            'can',
            'can you',
            'can you explain',
            'can you explain closures'
        ])
        expect(s.committed).toEqual([])
    })

    it('replaces rather than appends when the recogniser revises itself', () => {
        let s = emptyLiveTranscript()
        s = applyDeepgramMessage(s, results('recur shun'))
        s = applyDeepgramMessage(s, results('recursion'))
        expect(liveTranscriptText(s)).toBe('recursion')
    })

    it('returns the identical object when an interim repeats', () => {
        const s = applyDeepgramMessage(emptyLiveTranscript(), results('same'))
        expect(applyDeepgramMessage(s, results('same'))).toBe(s)
    })
})

describe('applyDeepgramMessage -- finals commit the phrase', () => {
    it('appends the final and clears the tail', () => {
        let s = emptyLiveTranscript()
        s = applyDeepgramMessage(s, results('what is a closure'))
        s = applyDeepgramMessage(s, results('what is a closure?', true))
        expect(s.committed).toEqual(['what is a closure?'])
        expect(s.interim).toBe('')
        expect(liveTranscriptText(s)).toBe('what is a closure?')
    })

    it('keeps accumulating across several phrases', () => {
        let s = emptyLiveTranscript()
        s = applyDeepgramMessage(s, results('first phrase.', true))
        s = applyDeepgramMessage(s, results('second phrase.', true))
        s = applyDeepgramMessage(s, results('and the third'))
        expect(liveTranscriptText(s)).toBe('first phrase. second phrase. and the third')
    })

    it('drops an abandoned hypothesis when the final is empty', () => {
        let s = applyDeepgramMessage(emptyLiveTranscript(), results('uhh'))
        s = applyDeepgramMessage(s, results('', true))
        expect(liveTranscriptText(s)).toBe('')
        expect(s.committed).toEqual([])
    })
})

describe('applyDeepgramMessage -- non-transcript frames', () => {
    it('ignores metadata, keep-alives and utterance-end frames', () => {
        const s = applyDeepgramMessage(emptyLiveTranscript(), results('hello'))
        for (const frame of [
            { type: 'Metadata', duration: 1.2 },
            { type: 'UtteranceEnd', last_word_end: 2.4 },
            { type: 'SpeechStarted' }
        ]) {
            expect(applyDeepgramMessage(s, frame)).toBe(s)
        }
    })
})

describe('interimWordCount', () => {
    it('counts only the unconfirmed tail', () => {
        let s = applyDeepgramMessage(emptyLiveTranscript(), results('committed part', true))
        s = applyDeepgramMessage(s, results('three more words'))
        expect(interimWordCount(s)).toBe(3)
    })

    it('is zero once everything is final', () => {
        const s = applyDeepgramMessage(emptyLiveTranscript(), results('done', true))
        expect(interimWordCount(s)).toBe(0)
    })
})

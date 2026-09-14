import { describe, it, expect } from 'vitest'
import { resolveSttLocale } from './languagePolicy'

describe('resolveSttLocale', () => {
    it('never pins when more than one answer language is configured', () => {
        // The reported bug: English + Hindi selected, but a pinned en-US locale meant
        // Hindi speech was transcribed as English, so both the question shown and the
        // answer given came out in English.
        expect(resolveSttLocale(['en', 'hi'], 'en-US')).toBe('auto')
        expect(resolveSttLocale(['hi', 'en'], 'hi-IN')).toBe('auto')
    })

    it('honours a pinned locale when only one answer language is configured', () => {
        expect(resolveSttLocale(['en'], 'en-US')).toBe('en-US')
        expect(resolveSttLocale(['hi'], 'hi-IN')).toBe('hi-IN')
    })

    it('falls back to auto when nothing was saved', () => {
        expect(resolveSttLocale(['en'], undefined)).toBe('auto')
        expect(resolveSttLocale(['en'], null)).toBe('auto')
        expect(resolveSttLocale(['en'], '')).toBe('auto')
    })

    it('passes an explicit auto straight through', () => {
        expect(resolveSttLocale(['en'], 'auto')).toBe('auto')
        expect(resolveSttLocale(['en', 'hi'], 'auto')).toBe('auto')
    })
})

import { describe, it, expect } from 'vitest'
import {
  buildLanguageDirective,
  coerceResponseLanguages,
  detectUtteranceLanguage,
  normalizeToLanguageCode,
  resolveResponseLanguage,
  type LanguageCode
} from './languagePolicy'
import { classifyIntent } from './intentClassifier'

describe('resolveResponseLanguage — fallback rule', () => {
  it('SINGLE Hindi: hi→hi, everything else→en', () => {
    const sel: LanguageCode[] = ['hi']
    expect(resolveResponseLanguage('hi', sel)).toBe('hi')
    expect(resolveResponseLanguage('en', sel)).toBe('en')
    expect(resolveResponseLanguage('es', sel)).toBe('en')
    expect(resolveResponseLanguage('ru', sel)).toBe('en')
  })

  it('SINGLE English: en→en, hi→en', () => {
    const sel: LanguageCode[] = ['en']
    expect(resolveResponseLanguage('en', sel)).toBe('en')
    expect(resolveResponseLanguage('hi', sel)).toBe('en')
  })

  it('DUAL Hindi+English', () => {
    const sel: LanguageCode[] = ['hi', 'en']
    expect(resolveResponseLanguage('hi', sel)).toBe('hi')
    expect(resolveResponseLanguage('en', sel)).toBe('en')
    expect(resolveResponseLanguage('es', sel)).toBe('en')
  })

  it('DUAL Hindi+Italian', () => {
    const sel: LanguageCode[] = ['hi', 'it']
    expect(resolveResponseLanguage('hi', sel)).toBe('hi')
    expect(resolveResponseLanguage('it', sel)).toBe('it')
    expect(resolveResponseLanguage('en', sel)).toBe('en')
    expect(resolveResponseLanguage('es', sel)).toBe('en')
  })

  it('DUAL Dutch+English (Hindi falls back)', () => {
    const sel: LanguageCode[] = ['nl', 'en']
    expect(resolveResponseLanguage('nl', sel)).toBe('nl')
    expect(resolveResponseLanguage('en', sel)).toBe('en')
    expect(resolveResponseLanguage('hi', sel)).toBe('en')
  })
})

describe('normalizeToLanguageCode', () => {
  it('folds locale tags and casing to a base code', () => {
    expect(normalizeToLanguageCode('HI')).toBe('hi')
    expect(normalizeToLanguageCode('hi-IN')).toBe('hi')
    expect(normalizeToLanguageCode('en-US')).toBe('en')
    expect(normalizeToLanguageCode('pt_BR')).toBe('pt')
  })

  it('maps Whisper full names', () => {
    expect(normalizeToLanguageCode('english')).toBe('en')
    expect(normalizeToLanguageCode('spanish')).toBe('es')
    expect(normalizeToLanguageCode('russian')).toBe('ru')
    expect(normalizeToLanguageCode('dutch')).toBe('nl')
    expect(normalizeToLanguageCode('italian')).toBe('it')
  })

  it('returns null for auto / empty / unknown', () => {
    expect(normalizeToLanguageCode('auto')).toBeNull()
    expect(normalizeToLanguageCode('')).toBeNull()
    expect(normalizeToLanguageCode(undefined)).toBeNull()
    expect(normalizeToLanguageCode('klingon')).toBeNull()
  })
})

describe('detectUtteranceLanguage — per-utterance, script-first', () => {
  it('Devanagari script → hi', () => {
    expect(detectUtteranceLanguage({ text: 'यह क्या है' })).toBe('hi')
  })

  it('devanagariPinned flag → hi even for Roman text', () => {
    expect(detectUtteranceLanguage({ text: 'aapka experience', devanagariPinned: true })).toBe('hi')
  })

  it('Cyrillic script → ru', () => {
    expect(detectUtteranceLanguage({ text: 'что это такое' })).toBe('ru')
  })

  it('isolated English tech word does NOT flip a Hindi question', () => {
    expect(detectUtteranceLanguage({ text: 'React kya hai' })).toBe('hi')
    expect(detectUtteranceLanguage({ text: 'API kaise kaam karta hai' })).toBe('hi')
  })

  it('plain English → en', () => {
    expect(detectUtteranceLanguage({ text: 'What is polymorphism' })).toBe('en')
  })

  it('empty text → en (fallback floor)', () => {
    expect(detectUtteranceLanguage({ text: '' })).toBe('en')
  })

  it('Latin-script Spanish resolved via whisperLang → es', () => {
    expect(
      detectUtteranceLanguage({ text: 'Que es la recursion', whisperLang: 'spanish' })
    ).toBe('es')
  })

  it('Japanese kana → ja (before Han)', () => {
    expect(detectUtteranceLanguage({ text: 'これは何ですか' })).toBe('ja')
  })

  it('a script outside the supported set falls back to English', () => {
    // Bengali and Arabic went out with the set: Nova-3 multilingual cannot hear them,
    // so there is no honest answer language left to resolve to.
    expect(detectUtteranceLanguage({ text: 'এটা কি' })).toBe('en')
    expect(detectUtteranceLanguage({ text: 'ما هذا' })).toBe('en')
  })
})

describe('buildLanguageDirective', () => {
  const codes: LanguageCode[] = ['en', 'hi', 'es', 'fr', 'de', 'it', 'ja', 'nl', 'pt', 'ru']

  it('every language yields a non-empty directive mentioning English tech terms', () => {
    for (const code of codes) {
      const out = buildLanguageDirective(code)
      expect(out.trim().length).toBeGreaterThan(0)
      expect(out.toLowerCase()).toContain('english')
    }
  })

  it('hi directive mentions Hinglish and Roman letters', () => {
    const out = buildLanguageDirective('hi').toLowerCase()
    expect(out).toContain('hinglish')
    expect(out).toContain('roman')
  })

  it('non-Latin languages instruct romanized / no native script', () => {
    for (const code of ['ja', 'ru'] as LanguageCode[]) {
      expect(buildLanguageDirective(code).toLowerCase()).toContain('roman')
    }
  })

  it('bulletFormat:false drops the bullet-format clause', () => {
    expect(buildLanguageDirective('hi')).toContain('bullet-point output format')
    expect(buildLanguageDirective('hi', { bulletFormat: false })).not.toContain(
      'bullet-point output format'
    )
    expect(buildLanguageDirective('ru', { bulletFormat: false })).not.toContain(
      'bullet-point output format'
    )
  })

  it('forVision keeps "Simple Indian English" for the English directive', () => {
    expect(buildLanguageDirective('en', { forVision: true })).toContain('Simple Indian English')
  })
})

describe('coerceResponseLanguages — migration / clamp / dedupe', () => {
  it('legacy STT language is ignored; missing selection defaults to English', () => {
    expect(coerceResponseLanguages(undefined, 'hi-IN')).toEqual(['en'])
    expect(coerceResponseLanguages(undefined, 'auto')).toEqual(['en'])
    expect(coerceResponseLanguages(undefined, 'en-US')).toEqual(['en'])
  })

  it('dedupes and clamps to 2', () => {
    expect(coerceResponseLanguages(['hi', 'hi', 'en'])).toEqual(['hi', 'en'])
    expect(coerceResponseLanguages(['hi', 'en', 'ru'])).toEqual(['hi', 'en'])
  })

  it('normalizes entries and drops invalid ones', () => {
    expect(coerceResponseLanguages(['en-US', 'spanish'])).toEqual(['en', 'es'])
    expect(coerceResponseLanguages(['auto', 'klingon'])).toEqual(['en'])
  })

  it('empty list → default English', () => {
    expect(coerceResponseLanguages([])).toEqual(['en'])
  })

  it('valid single selection is preserved', () => {
    expect(coerceResponseLanguages(['nl'])).toEqual(['nl'])
  })
})

describe('classifyIntent — snapshot guard (intent routing unchanged)', () => {
  const cases: Array<[string, string]> = [
    ['code likho', 'dsa_coding'],
    ['reverse a linked list', 'dsa_coding'],
    ['design a rate limiter', 'system_design'],
    ['tell me about yourself', 'identity'],
    ['regression testing kya hai', 'definitional'],
    ['What is polymorphism', 'definitional'],
    ['How does TCP work', 'technical_concept']
  ]

  it.each(cases)('%s → %s', (query, expected) => {
    expect(classifyIntent(query).intent).toBe(expected)
  })

  it('isHindi flag still set for a Hinglish question', () => {
    expect(classifyIntent('regression testing kya hai').isHindi).toBe(true)
    expect(classifyIntent('What is polymorphism').isHindi).toBe(false)
  })
})


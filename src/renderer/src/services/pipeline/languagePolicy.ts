// languagePolicy.ts — Centralized response-language decision + prompt text.
//
// This is the single home for "what language should the ANSWER be in?". It is a
// pure module: no Electron, DOM, or network imports, so it is trivially unit
// testable (see languagePolicy.test.ts).
//
// The decision is intentionally split from the TRANSCRIPT. The transcript always
// reflects what the interviewer actually said (handled by the STT layer). This
// module only decides the language the copilot ANSWERS in, per-utterance, with
// English as the universal fallback.

/**
 * Answer languages the copilot can be configured to reply in.
 *
 * This set is deliberately bounded by what Deepgram Nova-3 multilingual can hear on a
 * single streaming connection -- English, Spanish, French, German, Hindi, Italian,
 * Japanese, Dutch, Russian, Portuguese. Offering a language outside it was worse than
 * not offering it: the recogniser would hear the nearest language it does know and
 * return confident, wrong text, and there is no streaming alternative that covers more
 * (Flux Multilingual carries the same ten). Bengali, Chinese and Arabic were listed
 * here and have been removed for exactly that reason.
 */
export type LanguageCode = 'en' | 'hi' | 'es' | 'fr' | 'de' | 'it' | 'ja' | 'nl' | 'pt' | 'ru'

export const FALLBACK_LANGUAGE: LanguageCode = 'en'

/** Every answer language the copilot can be configured to produce. */
export const SUPPORTED_RESPONSE_LANGUAGES: LanguageCode[] = [
  'en',
  'hi',
  'es',
  'fr',
  'de',
  'it',
  'ja',
  'nl',
  'pt',
  'ru'
]

const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  en: 'English',
  hi: 'Hindi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  ja: 'Japanese',
  nl: 'Dutch',
  pt: 'Portuguese',
  ru: 'Russian'
}

export function languageLabel(code: LanguageCode): string {
  return LANGUAGE_LABELS[code] ?? code
}

// ── Script detectors ────────────────────────────────────────────────────────
// Disjoint Unicode blocks, so a positive hit on any one is unambiguous and free.
export const DEVANAGARI_RE = /[ऀ-ॿ]/
const CYRILLIC_RE = /[Ѐ-ӿ]/ // proves Russian, the only Cyrillic language in the set
const KANA_RE = /[぀-ヿ]/ // Hiragana + Katakana — proves Japanese
// CJK ideographs. These used to need a hint to split ja from zh; with Chinese out of
// the set, Japanese is the only language here that writes them, so they resolve to ja.
// Chinese speech now lands on the English fallback like any other unsupported language.
const HAN_RE = /[一-鿿]/

// ── Romanized Hindi heuristic ─────────────────────────────────────────────────
// Moved verbatim from intentClassifier.ts so there is ONE Hindi detector, not two
// competing ones. The intent classifier now derives `isHindi` from this same code
// path via detectUtteranceLanguage().

// Unambiguous Hindi/Hinglish tokens. None of these is an English word, so a single
// hit settles the language.
export const HINDI_STRONG =
  /\b(aap|aapka|aapke|aapko|hume|humein|mujhe|mera|mere|meri|kya|kyun|kyu|kaise|kaisa|kaisi|kab|kahan|konsa|kaunsa|kitna|kitne|batao|bataiye|bata|samjhao|karo|karein|karna|karte|karta|karti|kiya|kiye|karega|karenge|hota|hoti|hote|hai|hain|tha|thi|hoga|hogi|honge|mein|nahi|nahin|matlab|baare|bare|kabhi|accha|acha|theek|samajh|madad|chahiye|boliye|sunte|bilkul|zaroori|zyada)\b/i

// Short function words that are also plausible mis-hearings of English words
// ("ki"/"key", "se"/"say", "ko"/"co"). One of these on its own is not evidence —
// two independent ones are. Requiring two is what stops a single odd word from
// flipping an English question into the Hinglish answer path.
export const HINDI_WEAK =
  /\b(se|ko|ki|ke|par|pe|aur|ya|hum|kuch|bhi|toh|jo|woh|wo|yeh|ye|abhi|phir|lekin|magar|sirf|bahut|jaise|thoda)\b/gi

/**
 * True when the (lowercased) text reads as romanized Hindi/Hinglish. Counts Hindi
 * votes only — isolated English technical words (React, API, polymorphism) add no
 * English vote, so they can never flip a Hindi question to English.
 */
export function isRomanizedHindi(lowerText: string): boolean {
  if (!lowerText) return false
  const weakHits = new Set(lowerText.match(HINDI_WEAK) || [])
  return HINDI_STRONG.test(lowerText) || weakHits.size >= 2
}

// ── Normalization ─────────────────────────────────────────────────────────────
// Callers hand us a grab-bag of language identifiers: setup locale tags
// ('en-US', 'hi-IN'), bare ISO codes ('en'), Deepgram codes ('es'), and Whisper's
// full English names ('english', 'spanish'). Fold them all to a LanguageCode, or
// null for 'auto'/'' (i.e. "no opinion").
const NAME_TO_CODE: Record<string, LanguageCode> = {
  english: 'en',
  hindi: 'hi',
  spanish: 'es',
  castilian: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  japanese: 'ja',
  dutch: 'nl',
  flemish: 'nl',
  portuguese: 'pt',
  russian: 'ru'
}

export function normalizeToLanguageCode(raw?: string | null): LanguageCode | null {
  if (!raw) return null
  const lower = raw.trim().toLowerCase()
  if (!lower || lower === 'auto') return null
  // Locale tag or bare ISO code: take the part before any '-' / '_'.
  const base = lower.split(/[-_]/)[0]
  if ((SUPPORTED_RESPONSE_LANGUAGES as string[]).includes(base)) {
    return base as LanguageCode
  }
  // Whisper full-name form ('english', 'spanish', ...).
  if (NAME_TO_CODE[lower]) return NAME_TO_CODE[lower]
  if (NAME_TO_CODE[base]) return NAME_TO_CODE[base]
  return null
}

// ── Per-utterance detection ────────────────────────────────────────────────────
export interface UtteranceLangSignal {
  /** The finalized utterance text (transcript). */
  text: string
  /** True when the STT layer already saw Devanagari for this utterance and pinned it. */
  devanagariPinned?: boolean
  /** Whisper/Deepgram detected language for this utterance, if surfaced (Part B). */
  whisperLang?: string
}

/**
 * Decide the interviewer's language for a single utterance. Script-first (disjoint
 * Unicode blocks, unambiguous & free), then Whisper's detection (needed to tell
 * Latin-script es/fr/de/pt apart and to split Han-only ja/zh), then the romanized
 * Hindi heuristic, then English as the floor.
 */
export function detectUtteranceLanguage(signal: UtteranceLangSignal): LanguageCode {
  const text = signal.text || ''
  if (signal.devanagariPinned || DEVANAGARI_RE.test(text)) return 'hi'
  if (KANA_RE.test(text)) return 'ja'
  if (CYRILLIC_RE.test(text)) return 'ru'
  const whisper = normalizeToLanguageCode(signal.whisperLang)
  if (whisper && whisper !== 'en') return whisper
  if (HAN_RE.test(text)) return 'ja'
  if (isRomanizedHindi(text.toLowerCase())) return 'hi'
  return FALLBACK_LANGUAGE
}

// ── Response-language resolution ───────────────────────────────────────────────
/**
 * The core fallback rule. If the detected utterance language is one the user
 * selected, answer in it; otherwise answer in English (the universal fallback).
 * Works identically for SINGLE (1 selected) and DUAL (2 selected) modes.
 */
export function resolveResponseLanguage(
  detected: LanguageCode,
  selected: LanguageCode[]
): LanguageCode {
  if (selected && selected.includes(detected)) return detected
  return FALLBACK_LANGUAGE
}

/**
 * Normalize a persisted/legacy config into a clean 1–2 entry selection list.
 * - Dedupes and clamps to 2 (MODE 2 cap).
 * - Drops unknown/'auto' entries.
 * - Defaults to ['en'] when nothing valid is present, so users with no explicit
 *   responseLanguages saved answer in English (the universal fallback). The legacy
 *   STT `language` is intentionally NOT used to seed the answer language — the STT
 *   dropdown only ever pinned transcription, never the answer.
 */
export function coerceResponseLanguages(
  list?: Array<string | null | undefined> | null,
  _legacyLanguage?: string | null
): LanguageCode[] {
  const out: LanguageCode[] = []
  if (Array.isArray(list)) {
    for (const raw of list) {
      if (typeof raw !== 'string') continue
      const code = normalizeToLanguageCode(raw)
      if (code && !out.includes(code)) out.push(code)
      if (out.length >= 2) break
    }
  }
  if (out.length) return out
  return ['en']
}

/**
 * The natural "for example," connector in the answer language, used both for the
 * mandatory-example prompt lead-in and by the humanLikeness post-processor. Returns
 * null for languages where we have no safe connector — callers MUST skip injection
 * on null rather than fall back to English (never inject English into a non-English
 * answer).
 */
/**
 * The locale to run the recogniser with.
 *
 * Pinning a locale tells the recogniser what language to expect, which makes every
 * OTHER configured answer language unreachable: Hindi speech submitted as `en` comes
 * back as English-ish Latin text, and no downstream signal can recover the original
 * language from it. So a multi-language answer selection has to leave the recogniser
 * free to detect per utterance; only a single selection may pin.
 */
export function resolveSttLocale(
  configuredAnswerLanguages: LanguageCode[],
  savedLocale?: string | null
): string {
  if (configuredAnswerLanguages.length > 1) return 'auto'
  return savedLocale || 'auto'
}

export function exampleFillerFor(lang: LanguageCode): string | null {
  if (lang === 'en') return 'For example, '
  if (lang === 'hi') return 'Jaise ki, '
  return null
}

// ── Language directive (prompt block) ──────────────────────────────────────────
// One authoritative language instruction per resolved answer language. This
// REPLACES both the old conditional `hinglishLock` and the static "TONE & LANGUAGE
// RULES" block in aiService — the decision is now made once (per utterance) and
// emitted as a single unambiguous directive.

export interface LanguageDirectiveOptions {
  /** Vision/screen-scan surface — retains the "Simple Indian English" phrasing. */
  forVision?: boolean
  /**
   * Whether the surface emits the mandatory bullet-point answer format. Defaults to
   * true (the live overlay / vision answers). Set false for paragraph surfaces (e.g.
   * the phone panel) so the language lock does NOT tell the model to keep bullets.
   */
  bulletFormat?: boolean
}

// Hinglish wording preserved verbatim from the previous hinglishLock so Hindi
// answers are byte-for-byte identical to today's behavior. The bullet clause is
// split out so paragraph surfaces can drop it.
const HINGLISH_DIRECTIVE_BASE = `
🔴 LANGUAGE LOCK — THE INTERVIEWER JUST SPOKE HINDI / HINGLISH:
- Answer in conversational HINGLISH: Hindi grammar written in Roman/Latin letters. Example: "Main regression testing tab karta hoon jab kisi existing feature me change aata hai."
- The question may arrive in Devanagari (e.g. "आपका testing experience कैसा रहा"). You understand it completely — answer it directly. Never repeat, quote, or translate the question.
- NEVER output Devanagari script (no मैं, आप, यह). Roman letters only.
- NEVER answer in full English. Every sentence stays Hinglish.
- Technical nouns stay in English inside the Hinglish sentence: regression testing, test case, Selenium, Jira, sprint, API, database, CI/CD, deployment.`

const HINGLISH_BULLET_CLAUSE = `
- The bullet-point output format below applies UNCHANGED. Every bullet still starts with "- ", it is just written in Hinglish. Example: "- Regression testing ka matlab hai existing features ko dobara verify karna jab code me koi change aata hai."`

const ENGLISH_DIRECTIVE = `
🔴 LANGUAGE LOCK — ANSWER IN ENGLISH:
- The interviewer spoke English (or a language outside your configured set). Answer in clear, professional, natural spoken English.
- Use standard English for all technical terms, tool names, and processes.
`

const ENGLISH_VISION_DIRECTIVE = `
🔴 LANGUAGE — ANSWER IN ENGLISH:
- Answer in Simple Indian English: clear, direct, professional.
- Use standard English for all technical terms, tool names, and processes.
`

const LATIN_SCRIPT: LanguageCode[] = ['es', 'fr', 'de', 'it', 'nl', 'pt']

export function buildLanguageDirective(
  lang: LanguageCode,
  opts: LanguageDirectiveOptions = {}
): string {
  const withBullets = opts.bulletFormat !== false

  if (lang === 'hi') {
    return `${HINGLISH_DIRECTIVE_BASE}${withBullets ? HINGLISH_BULLET_CLAUSE : ''}\n`
  }
  if (lang === 'en') return opts.forVision ? ENGLISH_VISION_DIRECTIVE : ENGLISH_DIRECTIVE

  const label = languageLabel(lang)
  const upper = label.toUpperCase()
  const bulletLine = withBullets
    ? `\n- The bullet-point output format below applies UNCHANGED; each bullet is just written in ${LATIN_SCRIPT.includes(lang) ? label : `romanized ${label}`}.`
    : ''

  if (LATIN_SCRIPT.includes(lang)) {
    return `
🔴 LANGUAGE LOCK — ANSWER IN ${upper}:
- The interviewer just spoke ${label}. Answer entirely in natural, conversational ${label}.
- Keep all technical terms, tool/framework names, and processes in standard English (e.g. API, database, deployment, CI/CD, and product/framework names).
- Do NOT switch to full English — only the technical nouns stay English, everything else is ${label}.${bulletLine}
`
  }

  // Non-Latin scripts (bn, ja, zh, ar): romanized transliteration, no native script.
  return `
🔴 LANGUAGE LOCK — ANSWER IN ROMANIZED ${upper}:
- The interviewer just spoke ${label}. Answer in ${label}, but written in Roman/Latin letters (transliteration) — NOT in ${label}'s native script.
- NEVER output ${label} native-script characters. Roman letters only.
- Keep all technical terms, tool/framework names, and processes in standard English (e.g. API, database, deployment, CI/CD, and product/framework names).
- Do NOT answer in full English — only the technical nouns stay English, the rest is romanized ${label}.${bulletLine}
`
}


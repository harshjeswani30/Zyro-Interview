// devanagariToRoman.ts — Devanagari → Roman Hinglish transliteration (display only)
//
// Whisper returns Hindi speech in Devanagari ("आपका testing experience कैसा रहा"),
// but the overlay transcript ticker and the question header read far faster in the
// same Roman Hinglish the generated answer uses. So we romanise for DISPLAY only —
// the raw Devanagari string is what still goes to the LLM, because it understands
// native script better than any lossy transliteration.
//
// Runs synchronously on every partial transcript (~3x/sec), so this is a plain
// character walk: no network call, no LLM, no regex backtracking.

const DEVANAGARI_RANGE = /[ऀ-ॿ]/
const NUKTA = '़'
const VIRAMA = '्'
const ANUSVARA = 'ं'
const CHANDRABINDU = 'ँ'
const VISARGA = 'ः'

export function hasDevanagari(text: string): boolean {
  return DEVANAGARI_RANGE.test(text)
}

const CONSONANTS: Record<string, string> = {
  क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'ng',
  च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'ny',
  ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n',
  त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n', ऩ: 'n',
  प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm',
  य: 'y', र: 'r', ऱ: 'r', ल: 'l', ळ: 'l', ऴ: 'l',
  व: 'v', श: 'sh', ष: 'sh', स: 's', ह: 'h'
}

// Consonant + U+093C nukta. Whisper emits both precomposed (क़) and decomposed
// (क + ़) forms; we NFD-normalise first so only this map is needed.
const NUKTA_CONSONANTS: Record<string, string> = {
  क: 'q', ख: 'kh', ग: 'g', ज: 'z', झ: 'zh',
  ड: 'd', ढ: 'dh', फ: 'f', य: 'y', र: 'r'
}

const INDEPENDENT_VOWELS: Record<string, string> = {
  अ: 'a', आ: 'aa', इ: 'i', ई: 'ee', उ: 'u', ऊ: 'oo',
  ऋ: 'ri', ॠ: 'ri', ऌ: 'li', ॡ: 'li',
  ए: 'e', ऐ: 'ai', ऍ: 'e', ऎ: 'e',
  ओ: 'o', औ: 'au', ऑ: 'o', ऒ: 'o'
}

// Long vowels read naturally as "aa/ee/oo" mid-word ("काम" → kaam, "ठीक" → theek)
// but Hinglish convention shortens them at the end of a word ("कैसा" → kaisa, not
// kaisaa; "की" → ki, not kee). Hence two maps keyed on syllable position.
const MATRAS_MEDIAL: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo',
  'ृ': 'ri', 'ॄ': 'ri', 'ॢ': 'li',
  'े': 'e', 'ै': 'ai', 'ॅ': 'e', 'ॆ': 'e',
  'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॊ': 'o'
}

const MATRAS_FINAL: Record<string, string> = {
  ...MATRAS_MEDIAL,
  'ा': 'a', 'ी': 'i', 'ू': 'u'
}

const DIGITS: Record<string, string> = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
}

const PUNCTUATION: Record<string, string> = {
  '।': '.', '॥': '.', 'ऽ': '', 'ॐ': 'om', '॰': '.'
}

const LABIALS = new Set(['प', 'फ', 'ब', 'भ', 'म'])

// High-frequency Hindi function words plus tech terms Whisper spells in Devanagari.
// The syllable walk below handles everything else; these are the words where a
// mechanical transliteration reads awkwardly ("naheen" vs "nahi", "prōjekt" vs
// "project") and an interviewer glancing at the ticker would stumble.
const WORD_OVERRIDES: Record<string, string> = {
  // pronouns / function words
  नहीं: 'nahi', नहि: 'nahi', ना: 'na', में: 'mein', मैं: 'main',
  है: 'hai', हैं: 'hain', हूं: 'hoon', हूँ: 'hoon', था: 'tha', थी: 'thi', थे: 'the',
  और: 'aur', या: 'ya', क्या: 'kya', क्यों: 'kyun', क्यूं: 'kyun',
  कैसे: 'kaise', कैसा: 'kaisa', कैसी: 'kaisi', कहाँ: 'kahan', कहां: 'kahan',
  कब: 'kab', कौन: 'kaun', कौनसा: 'kaunsa', कितना: 'kitna', कितने: 'kitne',
  कुछ: 'kuch', कोई: 'koi', आप: 'aap', आपका: 'aapka', आपके: 'aapke',
  आपकी: 'aapki', आपको: 'aapko', आपने: 'aapne', हम: 'hum', हमें: 'humein',
  मुझे: 'mujhe', मेरा: 'mera', मेरे: 'mere', मेरी: 'meri', तुम: 'tum',
  वो: 'vo', वह: 'vah', यह: 'yah', ये: 'ye', इस: 'is', उस: 'us',
  को: 'ko', का: 'ka', की: 'ki', के: 'ke', से: 'se', पर: 'par',
  ही: 'hi', भी: 'bhi', तो: 'to', अगर: 'agar', लेकिन: 'lekin', जब: 'jab',
  बताइए: 'bataiye', बताइये: 'bataiye', बताएं: 'bataye', बताओ: 'batao',
  समझाइए: 'samjhaiye', समझाओ: 'samjhao', समझा: 'samjha', समझ: 'samajh',
  अच्छा: 'accha', ठीक: 'theek', हाँ: 'haan', हां: 'haan', जी: 'ji',
  फिर: 'phir', अब: 'ab', अभी: 'abhi', वहाँ: 'vahan', यहाँ: 'yahan',
  ज़्यादा: 'zyada', ज्यादा: 'zyada', थोड़ा: 'thoda', बहुत: 'bahut',
  सकते: 'sakte', सकता: 'sakta', सकती: 'sakti', चाहिए: 'chahiye',
  करना: 'karna', करते: 'karte', करता: 'karta', करती: 'karti', किया: 'kiya',
  होता: 'hota', होती: 'hoti', होते: 'hote', रहा: 'raha', रहे: 'rahe', रही: 'rahi',
  बारे: 'baare', मतलब: 'matlab', तरह: 'tarah', लिए: 'liye', वाला: 'wala',
  हुआ: 'hua', एक: 'ek', दो: 'do', फ़र्क: 'fark', फर्क: 'fark', अंतर: 'antar',
  // tech vocabulary
  टेस्टिंग: 'testing', टेस्ट: 'test', ऑटोमेशन: 'automation', डेटा: 'data',
  डाटा: 'data', डेटाबेस: 'database', प्रोजेक्ट: 'project', कोड: 'code',
  फंक्शन: 'function', फ़ंक्शन: 'function', क्लास: 'class', सर्वर: 'server',
  ऐरे: 'array', स्ट्रिंग: 'string', रिग्रेशन: 'regression',
  सॉफ्टवेयर: 'software', सॉफ़्टवेयर: 'software', डेवलपर: 'developer',
  कंपनी: 'company', टीम: 'team', फ्रेमवर्क: 'framework', वेबसाइट: 'website',
  यूजर: 'user', यूज़र: 'user', इंटरव्यू: 'interview', एक्सपीरियंस: 'experience',
  स्क्रिप्ट: 'script', बग: 'bug', फीचर: 'feature', मॉडल: 'model',
  ऐप: 'app', वेब: 'web', लूप: 'loop', वैरिएबल: 'variable', ऑब्जेक्ट: 'object'
}

// Normalise the override keys the same way input is normalised, so a decomposed
// nukta in the transcript still matches a precomposed key in the table above.
const NORMALISED_OVERRIDES: Record<string, string> = Object.fromEntries(
  Object.entries(WORD_OVERRIDES).map(([k, v]) => [k.normalize('NFD'), v])
)

interface Syllable {
  onset: string
  matra: string | null // null → inherent 'a' (or dead consonant when isDead)
  isDead: boolean // consonant carrying a virama — no vowel at all
  isVowelOnly: boolean // independent vowel, never schwa-deleted
  suffix: string // anusvara / chandrabindu / visarga tail
}

function transliterateWord(word: string): string {
  const override = NORMALISED_OVERRIDES[word]
  if (override) return override

  const syllables: Syllable[] = []
  let trailing = ''

  for (let i = 0; i < word.length; i++) {
    const ch = word[i]

    if (CONSONANTS[ch]) {
      const isNukta = word[i + 1] === NUKTA
      const onset = isNukta ? NUKTA_CONSONANTS[ch] || CONSONANTS[ch] : CONSONANTS[ch]
      if (isNukta) i++

      const next = word[i + 1]
      if (next === VIRAMA) {
        syllables.push({ onset, matra: null, isDead: true, isVowelOnly: false, suffix: '' })
        i++
      } else if (next && MATRAS_MEDIAL[next]) {
        syllables.push({ onset, matra: next, isDead: false, isVowelOnly: false, suffix: '' })
        i++
      } else {
        syllables.push({ onset, matra: null, isDead: false, isVowelOnly: false, suffix: '' })
      }
      continue
    }

    if (INDEPENDENT_VOWELS[ch]) {
      syllables.push({
        onset: '',
        matra: ch,
        isDead: false,
        isVowelOnly: true,
        suffix: ''
      })
      continue
    }

    // Nasal / visarga tails attach to the syllable they follow
    if (ch === ANUSVARA || ch === CHANDRABINDU || ch === VISARGA) {
      let tail = ch === VISARGA ? 'h' : 'n'
      if (ch === ANUSVARA) {
        const following = word[i + 1]
        if (following && LABIALS.has(following)) tail = 'm'
      }
      if (syllables.length > 0) syllables[syllables.length - 1].suffix += tail
      else trailing += tail
      continue
    }

    if (DIGITS[ch] !== undefined) {
      syllables.push({ onset: DIGITS[ch], matra: null, isDead: true, isVowelOnly: false, suffix: '' })
      continue
    }

    if (PUNCTUATION[ch] !== undefined) {
      trailing += PUNCTUATION[ch]
      continue
    }

    // Unknown combining mark (ZWJ, ZWNJ, rare signs) — drop it silently
  }

  // Schwa deletion: Hindi drops the inherent 'a' of a word-final consonant
  // ("राम" → ram) and of a medial consonant whose next syllable carries an
  // explicit vowel ("करता" → karta, not karataa).
  const lastSyllableIndex = syllables.length - 1
  const out: string[] = []

  for (let i = 0; i < syllables.length; i++) {
    const syl = syllables[i]

    if (syl.isVowelOnly) {
      const map = i === lastSyllableIndex ? MATRAS_FINAL : MATRAS_MEDIAL
      out.push((INDEPENDENT_VOWELS[syl.matra as string] || map[syl.matra as string] || '') + syl.suffix)
      continue
    }

    if (syl.isDead) {
      out.push(syl.onset + syl.suffix)
      continue
    }

    if (syl.matra) {
      const map = i === lastSyllableIndex ? MATRAS_FINAL : MATRAS_MEDIAL
      out.push(syl.onset + (map[syl.matra] || '') + syl.suffix)
      continue
    }

    // Inherent 'a'
    const isWordFinal = i === lastSyllableIndex
    const next = syllables[i + 1]
    const nextHasExplicitVowel = Boolean(next && (next.isVowelOnly || next.matra))
    const dropSchwa =
      (isWordFinal && syllables.length > 1) || (i > 0 && !isWordFinal && nextHasExplicitVowel)

    out.push(syl.onset + (dropSchwa ? '' : 'a') + syl.suffix)
  }

  return out.join('') + trailing
}

/**
 * Romanise the Devanagari runs in a mixed string, leaving Latin text, numbers and
 * punctuation untouched. "आपका testing experience कैसा रहा?" → "aapka testing
 * experience kaisa raha?"
 */
export function devanagariToRoman(text: string): string {
  if (!text || !DEVANAGARI_RANGE.test(text)) return text

  const normalised = text.normalize('NFD')
  let result = ''
  let word = ''

  const flush = (): void => {
    if (word) {
      result += transliterateWord(word)
      word = ''
    }
  }

  for (const ch of normalised) {
    // U+0900–U+097F letters/marks plus ZWJ/ZWNJ belong to the current word
    if ((ch >= 'ऀ' && ch <= 'ॿ') || ch === '‌' || ch === '‍') {
      word += ch
    } else {
      flush()
      result += ch
    }
  }
  flush()

  return result
}

/**
 * Display-safe transcript text: Hindi romanised to Hinglish, everything else
 * passed through unchanged. Use for UI only — send the original to the LLM.
 */
export function toDisplayTranscript(text: string): string {
  return devanagariToRoman(text)
}

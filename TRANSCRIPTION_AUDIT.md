# Transcription Pipeline Audit

Scope: microphone / system audio → capture → chunking → VAD → STT → interim → final →
language handling → normalization → transcript state → overlay display, plus the answer
hand-off. Audited against the working tree (the pre-change version was never pushed, so
git history is not a reference here).

**One thing to do before testing:** `ai-gateway/src/index.ts` runs on Cloudflare Workers.
Its changes take effect only after the Worker is deployed (`cd ai-gateway && npx wrangler deploy`).
Until then the desktop-side fixes are live but the gateway still sends the old Whisper
parameters, so hallucination rates will be between "before" and "after".

**Verification status.** Every file was type-checked continuously by the editor's TypeScript
language server while being edited, and it reports no errors or warnings across the changed
files. The batch commands below could **not** be run in the session that produced this
document — the shell was unavailable throughout — so run them before shipping:

```
npm run typecheck        # typecheck:node + typecheck:web
npm run build
cd ai-gateway && npx wrangler deploy
```

Note that `@electron-toolkit/tsconfig` enables `noUnusedLocals` and `noUnusedParameters`, so
the batch typecheck is stricter than a casual read: any leftover dead local is a hard error.
Everything the audit describes as "deleted" was deleted for that reason as well as for
correctness.

## Files touched

| File | Role |
| --- | --- |
| `src/renderer/src/services/vadWorker.ts` | rewritten — VAD is now a pure detector that owns no audio |
| `src/renderer/src/services/audioRing.ts` | **new** — single absolute-sample-offset audio buffer |
| `src/renderer/src/services/sttDiagnostics.ts` | **new** — dev-only per-chunk timing instrumentation |
| `src/renderer/src/components/OverlayPage.tsx` | capture loop, chunking, partial/commit/final lifecycle, filler gate, UI state |
| `src/renderer/src/services/aiService.ts` | `transcribeAudioOnly` — dropped transcript context, added per-utterance language pin |
| `src/renderer/src/services/pipeline/intentClassifier.ts` | Hindi detection regex |
| `src/renderer/src/services/pipeline/devanagariToRoman.ts` | Devanagari → Roman Hinglish, display only |
| `src/main/index.ts` | STT request construction, language resolution, prompt, retry policy, logging |
| `src/preload/index.ts`, `src/preload/index.d.ts` | removed `context` from the `transcribeOnly` payload |
| `ai-gateway/src/index.ts` | Whisper params + confidence-based segment filtering (**needs deploy**) |

---

## 1. Root Causes

Fourteen distinct defects. They are separate bugs with separate fixes — none of them is
"the" cause, but RC1, RC2 and RC4 account for most of what was reported.

### RC1 — Whisper's `prompt` was fed the previous transcript

- **Severity:** Critical
- **File:** `src/main/index.ts` (`transcribe-only`, `transcribe-audio`), `src/renderer/src/services/aiService.ts` (`transcribeAudioOnly`), `src/preload/index.ts`
- **Function/component:** `buildSttPrompt`, the `context` parameter threaded renderer → preload → main
- **Root cause:** the renderer passed the previous transcript as `context`, main built a
  prompt out of it and sent `prompt = buildSttPrompt(language, context).slice(-300)`.
  Whisper's `prompt` is **not** an instruction channel: it is fed to the decoder as *text
  that precedes the audio*. The decoder's job is to continue it. So every request told the
  model "the last thing said was `<previous question>`", and `.slice(-300)` left-truncated
  that text so the decoder's most recent context was a fragment cut mid-word. On short or
  quiet audio the highest-probability continuation is *more of the prompt* — which is
  exactly the reported "text from previous audio", "repeated words" and "invented phrases".
  The prompt also contained English instructions ("never translate", "write down exactly
  what is spoken"), which Whisper transcribed verbatim often enough that a dedicated
  `isWhisperPromptHallucination()` filter had to exist to catch them.
- **Fix:** the prompt is now a fixed, instruction-free technical vocabulary list
  (`STT_VOCABULARY_PROMPT`), sent whole and never containing transcript text or
  Devanagari. `context` was deleted from the IPC payload, the preload types and
  `transcribeAudioOnly`. The gateway uses `prompt.slice(0, 400)` instead of `slice(-400)`.
- **Why it works:** removes the mechanism. With no prior transcript in the decoder's
  context there is nothing for it to continue, and a vocabulary list biases spelling
  (`Selenium`, `CI/CD`) without supplying sentences to copy.
- **Possible side effects:** cross-utterance continuity is gone, so a sentence deliberately
  split across two utterances no longer benefits from context. That is handled at a higher
  level by the continuation logic (RC5), which joins *transcripts*, not decoder state.
  `isWhisperPromptHallucination` is kept as a net because the gateway may still be running
  the old prompt until it is deployed.

### RC2 — Hindi was never pinned; every request re-detected the language

- **Severity:** Critical (Hindi-specific)
- **File:** `src/main/index.ts`, `ai-gateway/src/index.ts`, `src/renderer/src/components/OverlayPage.tsx`, `src/renderer/src/services/aiService.ts`
- **Function/component:** `resolveSttLanguage`, `/gateway/stt`, `utteranceLangRef` / `noteScript` / `transcribeAudioOnly(..., languageOverride)`
- **Root cause:** two layers. (a) `resolveSttLanguage` returned `null` — i.e. omitted the
  `language` field, i.e. auto-detect — for `en`, `hi` *and* `auto`. Whisper decides the
  language from roughly the first second of a clip. This pipeline sends short clips, so
  detection flipped from clip to clip; a Hindi clip detected as English is not transcribed
  badly, it is decoded as **fluent invented English**, because the decoder is sampling from
  an English language model over Hindi phonemes. That is the single largest source of
  "words that were never spoken", and it is worse in Hindi for a structural reason: an
  English clip misdetected as Hindi is rare (English dominates Whisper's training
  distribution), while the reverse is common. (b) The default session language is `auto`
  (`SetupPage.tsx` → `LANGUAGES[0] = { code: 'auto', label: '🌐 Hinglish / Auto-detect' }`),
  so even after fixing (a), most sessions still send no language at all.
- **Fix:** (a) only `auto` now maps to auto-detect; an explicitly chosen `hi` or `en` is
  pinned, in both the main process and the gateway (duplicated deliberately, so installed
  clients get the fix without an app update). (b) for `auto` sessions, the language becomes
  **sticky per utterance**: the first result that comes back containing Devanagari is proof
  the speaker is talking Hindi, so `utteranceLangRef` pins `hi` for every remaining request
  of that utterance via the new `languageOverride` argument. Reset at each utterance
  boundary, so the next question is free to be English.
- **Why it works:** the flip can no longer happen mid-utterance. The first clip of an
  utterance still auto-detects (unavoidable, and it is the clip with the most audio to
  decide on); the quiet trailing clips — the ones that used to be misdetected — inherit the
  decision. Pinning a language is not translation: translation is `task=translate`, which
  this pipeline never sends.
- **Possible side effects:** a genuinely bilingual single utterance that *starts* Hindi and
  ends in a long English passage will have the English decoded with `language=hi`. Whisper
  handles English-in-Hindi code-switching well (this is the normal Hinglish case), and this
  is strictly better than the alternative failure. An explicit `hi` session with a
  fully-English question will be decoded as Hindi — that is the user's explicit choice, and
  `auto` remains the default for exactly this reason.

### RC3 — No pre-roll: the first phoneme of every utterance was cut

- **Severity:** High (Hindi-specific in effect)
- **File:** `src/renderer/src/services/vadWorker.ts`, `src/renderer/src/services/audioRing.ts`, `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** `processor.onaudioprocess`, worker onset detection, `AudioRing`
- **Root cause:** audio was only buffered *while* the VAD said speech was active. Buffering
  therefore began on the chunk that crossed `RMS ≥ 0.018` — after 50–200 ms of the first
  word had already been discarded, since a word's onset ramps up through the threshold
  rather than starting above it. Whisper given a clip that starts mid-phoneme invents a
  plausible leading word. This hurts Hindi more because Hindi words frequently begin with
  low-energy sounds (aspirated and unvoiced onsets — *kya*, *thoda*, *samjhao*) that sit
  below an RMS threshold tuned on English.
- **Fix:** `AudioRing`, a 90-second buffer addressed by a monotonic absolute sample offset
  that is never reset. Audio is pushed **unconditionally**, every chunk, no state flag. The
  worker reports *offsets* (`speech_start { atSample }`) rather than audio, requires two
  consecutive above-threshold chunks (~170 ms) to confirm an onset, and reports the offset
  of the *first* of those two. The renderer then rewinds a further `PRE_ROLL_SEC = 0.3`
  before slicing, and adds `POST_ROLL_SEC = 0.2` at the end.
- **Why it works:** the audio that used to be thrown away is still in the ring when the
  decision to keep it is made. Confirmation latency no longer costs anything, so the onset
  threshold can stay conservative without clipping words.
- **Possible side effects:** 300 ms of leading room noise is now sent with every clip.
  Whisper's own silence detection handles that far better than it handles a truncated word,
  and the gateway's `no_speech_prob` filter (RC6b) drops a segment that is purely noise.
  Memory cost is 90 s × 48 kHz × 4 B ≈ 17 MB, bounded and constant.

### RC4 — Partials re-sent up to 24 s of audio, three times a second

- **Severity:** Critical (this is the latency regression)
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** `schedulePartial` (previously a fixed-interval re-send of a sliding window)
- **Root cause:** every ~300 ms the renderer re-transcribed the **entire utterance so far**,
  up to a 24-second window. A 20-second question therefore sent on the order of 60 requests
  averaging ~12 s of audio each — roughly **80× realtime**. Consequences, in order:
  Groq's rate limiter rejected requests → `markKeyCooldown` parked each key for 45 s → the
  rotation exhausted → traffic fell through to the Deepgram fallback, and/or
  `withRetry(fn, 3, 800ms)` began adding backoff. The request that the user actually waits
  on — the **final**, which gates the LLM call — was competing with 60 cosmetic ones for a
  rate-limited key pool. The transcript "used to appear quickly" because before the audio
  pipeline grew a sliding window there was far less contention.
- **Fix:** four independent changes.
  1. A partial now transcribes **only the tail since the last committed boundary**, not the
     whole utterance.
  2. Cadence is adaptive: `delay = clamp(300 + tailSeconds × 120, 300, 1200) ms`, so a long
     tail is polled less often, not more expensively.
  3. **One partial in flight at a time** (`partialInFlightRef`).
  4. A growth gate — the tail must have grown by `PARTIAL_GROWTH_SEC = 0.35 s` since the
     last request, and must contain at least 0.2 s of voiced audio, or no request is made.
  Additionally partials get `timeout: 6000` and **no retry** (a retried partial is
  superseded before it lands), while finals keep `timeout: 15000` + `withRetry`.
- **Why it works:** audio sent per second of speech drops from ~80× realtime to roughly 3×.
  The rate limiter stops firing, the key rotation stops cooling down, Deepgram fallback
  stops being reached, and the final request gets a warm key on the first attempt.
- **Possible side effects:** the ticker updates a little less often on long tails (up to
  1.2 s between updates instead of 0.3 s). Accuracy of the *final* transcript is unaffected
  — it is a separate, full-clip request (RC13).

### RC5 — Continuation window glued unrelated questions together

- **Severity:** High
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** `finalizeQuestion`, `lastSpeechEndRef`, `GRACE_WINDOW_SEC`
- **Root cause:** two compounding errors. `GRACE_WINDOW_SEC` was **12 s**, and
  `lastSpeechEndRef` was stamped with `Date.now()` at the moment `finalizeQuestion`
  *completed* — i.e. after a Whisper round trip **and** a full LLM generation, up to ~10 s
  after the person stopped talking. Every measured gap was therefore under-reported by
  seconds, so a genuinely new question asked 8 s later measured as ~1 s and was appended to
  the previous one. The transcript sent to the LLM was two unrelated questions
  concatenated.
- **Fix:** the VAD worker now reports `speechEndAtMs = Date.now() - silenceDuration`, the
  wall-clock instant speech actually stopped, and that value is captured at the **top** of
  `finalizeQuestion` before any network work. The window is 4 s, and an `answeredSince`
  guard breaks the chain once an answer has already been delivered for the master question
  (more speech after an answer is a reaction to the answer, not the rest of the question).
- **Why it works:** the measurement is now honest. Since the VAD already waits
  `LONG_PAUSE_SEC = 2.4 s` of silence before finalizing at all, a further 4 s means the
  person paused, heard nothing, and started a new thought.
- **Possible side effects:** a speaker who pauses more than ~6.4 s mid-sentence gets two
  questions instead of one. Preferable to the reverse, which corrupted the LLM input.

### RC6 — The filler filter was language-biased in both directions

- **Severity:** High
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** `isFillerOrHallucination` → replaced by `cleanTranscript`
- **Root cause:** the old function early-returned "keep" for **any** text containing
  Devanagari — so a Hindi hesitation went to the LLM completely unfiltered — while English
  was judged by `/^(no|yes|ok|so|well|…)\b/` **prefix** match combined with a
  `length < 18` cutoff. That threw away real questions: *"no sql vs sql"*, *"right join
  kya hai"*, *"yes bank ka case"*. Separately, `rawSessionHistoryRef` was appended
  **before** the second filler check and was not cleared on the discard path, so a
  discarded *"hmm"* stayed in history and was prepended to the next real question.
- **Fix:** `cleanTranscript()` applies the same four checks to both scripts:
  (1) subtitle/prompt-echo watermark patterns, (2) whole-string sound tags and
  acknowledgements — **equality, never substring**, (3) filler stripping from the **edges
  only**, with lead-ins removed from the front only and only while ≥ 2 tokens survive,
  (4) a lone word is kept only if it names something specific (`STANDALONE_TECH_WORDS`) or
  is ≥ 12 characters. No word is ever removed from the middle of an utterance, nothing is
  reordered, rewritten or translated. On the discard path `rawSessionHistoryRef`, the
  pending transcript and the displayed words are all cleared.
- **Why it works:** filler removal is now positional (a word is filler because of *where*
  it sits) rather than lexical (a word is filler because it is on a list). That is what
  keeps "no sql" and "right join" intact while still dropping a leading "umm".
- **Possible side effects:** a question that legitimately begins with a stripped lead-in and
  is only two tokens long keeps its lead-in (the `> 2` guard). Intentional — dropping a
  token from a two-word question is worse than keeping a filler.

### RC6b — Nothing used Whisper's own confidence signals

- **Severity:** High
- **File:** `ai-gateway/src/index.ts`
- **Function/component:** `filterHallucinatedSegments`, `/gateway/stt`
- **Root cause:** the gateway requested the default `json` response format and returned
  `data.text` verbatim. Whisper publishes exactly the metadata needed to identify a
  hallucinated segment — `no_speech_prob`, `avg_logprob`, `compression_ratio` — and none of
  it was requested, so silence decoded into confident nonsense was indistinguishable from
  speech. The default temperature-fallback behaviour also re-samples a segment with
  increasing temperature until heuristics pass, which manufactures fluent invented text.
- **Fix:** request `response_format=verbose_json` and `temperature=0`, then drop segments
  by Whisper's own published thresholds: `no_speech_prob > 0.6 && avg_logprob < -1.0`
  (silence decoded as words), `compression_ratio > 2.4` (degenerate repetition loop —
  "haan haan haan haan"), `avg_logprob < -1.4` (decoder was guessing). If every segment
  fails, return empty rather than the unfiltered text.
- **Why it works:** this is the model's own uncertainty, per segment, rather than a
  word blacklist. It removes the *repetition* and *silence-into-words* classes of
  hallucination at the source, and `temperature=0` stops the decoder from re-rolling a
  segment until it looks plausible.
- **Possible side effects:** genuinely quiet or heavily-accented speech can score below the
  thresholds and be dropped. Thresholds are Whisper's published defaults, not tuned
  guesses, and the pre-roll (RC3) plus `MIN_STT_SEC` gate mean clips are less marginal than
  before. **Requires a Worker deploy.**

### RC7 — `the` and `me` were treated as Hindi markers

- **Severity:** High
- **File:** `src/renderer/src/services/pipeline/intentClassifier.ts`
- **Function/component:** Hindi detection regex
- **Root cause:** the Hindi cue list contained `the` and `me`. Any English sentence
  containing "the" was classified Hindi, which changed the downstream answer language and
  prompt path. One ordinary English word flipped the language for the whole turn — exactly
  the "randomly switches based on one unusual word" symptom.
- **Fix:** split into `HINDI_STRONG` (unambiguous markers — `aap`, `aapka`, `zyada`, …) and
  `HINDI_WEAK` (function words that also occur in English text — `se`, `ko`, `ki`, `ke`,
  `par`, `pe`, …). Devanagari or one strong marker is sufficient; weak markers require
  **two distinct** hits. `the` and `me` are gone entirely.
- **Why it works:** a single ambiguous token can no longer decide, and two distinct Hindi
  function words in one sentence is a reliable signal.
- **Possible side effects:** a very short Hinglish question with exactly one weak marker and
  no strong marker classifies as English. Devanagari input is unaffected, and the STT
  language pin (RC2) is a separate, earlier decision.

### RC8 — A second `AudioContext` and an uncancellable animation loop leaked

- **Severity:** Medium
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** `setupAnalyser`, `analyserRef`, `maxVolumeRef` — all deleted
- **Root cause:** `setupAnalyser` opened a **second** `AudioContext` on the same stream
  purely to drive a volume meter, and ran a `requestAnimationFrame` loop whose handle was
  never stored, so it could not be cancelled. Every start/stop/start cycle added another
  context (Chromium caps these) and another endless rAF loop holding the stream, the
  analyser and the surrounding closure alive.
- **Fix:** deleted. The speaking indicator is driven by the VAD worker's existing
  `speech_active` message, which is information the pipeline already computes.
- **Why it works:** removes a whole audio graph and a render-loop-per-session.
- **Possible side effects:** the indicator now reflects VAD state rather than raw amplitude,
  so it follows the same thresholds as the rest of the pipeline. That is more consistent,
  not less.

### RC9 — Manual STOP left the worker in manual mode forever

- **Severity:** Medium
- **File:** `src/renderer/src/components/OverlayPage.tsx`, `src/renderer/src/services/vadWorker.ts`
- **Function/component:** `handleToggleManual`, worker `config` handler
- **Root cause:** pressing STOP never cleared `isManual` in the worker. Manual mode
  suppresses the long-pause finalize (it waits for the button), so for the rest of the
  session the worker treated silence as an open utterance, never auto-finalized, and — in
  the old design where the worker owned the audio — grew its buffer without bound.
- **Fix:** STOP posts `{type:'manual_stop'}` **and then** `{type:'config', isManual:false}`.
  Order is load-bearing: a mode change calls `resetUtterance()`, so clearing the flag first
  would discard the utterance the user just finished speaking and turn every manual stop
  into a dropped turn.
- **Why it works:** the worker's mode now matches the UI's mode after every transition.
- **Possible side effects:** none. Previously-broken auto mode after a manual turn now
  works.

### RC10 — Audio was dropped for the entire duration of answer generation

- **Severity:** Medium (loses whole questions)
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** `processor.onaudioprocess`, `finalizeQuestion`
- **Root cause:** `onaudioprocess` returned early while `isFinalizingRef` was true — and
  that flag stayed true through the entire LLM generation, several seconds. `finalizeQuestion`
  *also* early-returned if called while generating. Anything said while an answer was
  streaming was therefore both un-buffered and un-finalizable: silently lost.
- **Fix:** the capture loop never returns early — it always pushes to the ring and always
  feeds the detector. A finalize that arrives mid-generation is stored in
  `queuedFinalizeRef` and replayed from the `finally` block of the in-flight one. A
  monotonic `generationSeqRef` is stamped before the LLM `await` and re-checked after, so a
  slower earlier answer can never overwrite a newer one.
- **Why it works:** capture is decoupled from processing state. The audio is in the ring
  regardless, so a queued finalize can still slice it (the ring holds 90 s).
- **Possible side effects:** the CPU cost of VAD + ring push continues during generation
  (negligible — one RMS pass over 4096 floats per 85 ms).

### RC11 — Unbounded audio buffer in the VAD worker

- **Severity:** Medium
- **File:** `src/renderer/src/services/vadWorker.ts`
- **Function/component:** the worker's internal utterance buffer
- **Root cause:** the worker accumulated the utterance in its own array with no cap, and
  posted the whole `Float32Array` back on finalize — a multi-megabyte structured clone at
  the worst possible moment, immediately before the LLM call. Combined with RC9 it grew for
  the remainder of the session.
- **Fix:** the worker owns no audio at all. It reports offsets on a shared monotonic sample
  clock; the renderer owns one bounded `AudioRing`.
- **Why it works:** there is only one buffer, and it has a fixed capacity with front-drop.
- **Possible side effects:** the two sides must agree on the sample clock. They do by
  construction — both count every chunk, in order, and neither ever resets the counter.

### RC12 — Two divergent audio buffers

- **Severity:** Medium
- **File:** `src/renderer/src/services/vadWorker.ts`, `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** worker buffer vs. renderer `vadBufferRef`
- **Root cause:** the worker and the renderer each kept a copy of the utterance, filled
  under different conditions. They could disagree about what had been said, so the clip
  used for a partial and the clip used for the final covered different audio — a source of
  text appearing, disappearing, or duplicating between interim and final.
- **Fix:** one `AudioRing`, sliced at worker-reported offsets. `vadBufferRef` deleted.
- **Why it works:** single source of truth; partial, commit and final are all slices of the
  same samples.
- **Possible side effects:** none.

### RC13 — Interim text was spliced into the final transcript

- **Severity:** Medium-High
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** `stitchPartial` / `tailChunks` — both deleted, replaced by `joinSegments`
- **Root cause:** because partials re-transcribed a sliding window (RC4), their text had to
  be *spliced* onto what was already displayed using a suffix/prefix overlap heuristic.
  When Whisper reworded the seam — which it does constantly, since each request is an
  independent decode — the heuristic found no overlap and fell back to **raw
  concatenation**, duplicating several words. The final transcript inherited that spliced
  text.
- **Fix:** the final transcript is produced by **one full-utterance Whisper pass** over the
  ring (`clipFrom → endSample`, capped at `MAX_FINAL_SEC = 28 s` — Whisper's encoder window
  is 30 s). Committed segments exist only to make the ticker feel live, are cut at VAD
  pauses so they never overlap, and are joined with a plain `joinSegments`. Committed text
  is used as the LLM input only as a **fallback** when the final request fails or returns
  empty.
- **Why it works:** no splice, so no splice bug. A single pass over the whole utterance is
  also more accurate than joining N independent decodes, because each independent decode
  carries its own language detection and its own boundary artefacts.
- **Possible side effects:** the final adds one STT round trip after speech ends (~0.4–1 s
  on a warm key) rather than reusing already-transcribed segments. Accepted deliberately:
  the stated priority is accuracy first, latency second. The trip is only reached once per
  utterance, and RC4 is what made it fast again.

### RC14 — Stale responses could overwrite newer transcript state

- **Severity:** Medium
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** partial/commit/final response handlers
- **Root cause:** responses carried no identity. A slow partial landing after a faster one
  overwrote newer text; a partial landing after the utterance had been finalized repainted
  the ticker for a question that had already been answered; a commit landing after the user
  pressed Clear repainted what had just been cleared.
- **Fix:** every request is stamped with `utteranceId` and a monotonic `seq`. On response,
  in order: wrong `utteranceId` → drop; finalizing/generating → drop; `seq <= appliedSeq` →
  drop; noise → drop. Commits are serialised through `commitChainRef` and each writes to
  its **own index** in `committedSegments`, so a late authoritative result replaces only its
  own optimistic placeholder. Every drop is reported through `diagDropped(handle, reason)`.
- **Why it works:** monotonic sequencing makes "newer wins" a structural property rather
  than a timing accident.
- **Possible side effects:** none. Dropped stale partials are cosmetic by definition; the
  final pass is authoritative.

---

## 2. Hindi Transcription Issues

Hindi was worse than English for four structural reasons, not one.

| # | Issue | Severity | Where | Why Hindi specifically | Status |
| --- | --- | --- | --- | --- | --- |
| H1 | Language auto-detected per clip | Critical | `resolveSttLanguage`, `/gateway/stt` | A Hindi clip misdetected as English is decoded as fluent **invented English**, because the decoder samples an English LM over Hindi phonemes. The reverse misdetection is rare. | Fixed (RC2) |
| H2 | `auto` is the default session language | Critical | `SetupPage.tsx` `LANGUAGES[0]` | Even with H1 fixed, most sessions send no language, so every request is an independent detection and short trailing clips flip. | Fixed by per-utterance sticky `hi` (RC2b) |
| H3 | Onset clipping | High | capture loop | Hindi words often begin with low-energy aspirated/unvoiced onsets (*kya*, *thoda*, *samjhao*) that ramp through an RMS threshold tuned on English, so more of the first phoneme was lost. | Fixed (RC3) |
| H4 | Devanagari bypassed the filler filter entirely | High | `isFillerOrHallucination` | Hindi hesitations reached the LLM unfiltered while short English questions were discarded. | Fixed (RC6) |
| H5 | Devanagari in the STT prompt | Medium | `buildSttPrompt` | A Devanagari prompt biases the decoder towards Hindi output even on pure English audio, i.e. it made the *English* path worse. | Fixed — the prompt is ASCII technical vocabulary only |

**English vs Hindi parity, after the fixes.** Everything below is now shared, by design:
model (`whisper-large-v3-turbo`), temperature (`0`), response format (`verbose_json`),
prompt (same ASCII vocabulary list for both `en` and `hi`; empty for other languages),
VAD thresholds, chunk duration, `LONG_PAUSE_SEC`, `COMMIT_PAUSE_SEC`, `MIN_VOICED_SEC`,
pre/post-roll, partial cadence, filler handling, interim/final handling, state updates,
rendering and retry policy. The **only** deliberate divergence is the `language` parameter
and the per-utterance sticky pin — which is the one thing that must differ. No English
setting was copied onto Hindi without a reason, and no Hindi accuracy was traded for
English.

**Hindi → Hinglish output.** `devanagariToRoman.ts` transliterates for **display only**:
`toDisplayTranscript()` is applied at exactly two places — the ticker
(`OverlayPage.tsx:626`) and the rendered question (`OverlayPage.tsx:2082`). The LLM and
`rawSessionHistoryRef` receive the raw Devanagari. This is a script mapping, not a
translation: it cannot change meaning because it never chooses words, and Hindi accuracy is
therefore untouched by the readability layer.

---

## 3. English Transcription Issues

| # | Issue | Severity | Where | Root cause | Fix |
| --- | --- | --- | --- | --- | --- |
| E1 | Short real questions discarded | High | `isFillerOrHallucination` | `/^(no\|yes\|ok\|so\|…)\b/` prefix match + `length < 18` cutoff killed "no sql vs sql", "right join kya hai", "yes bank ka case". | Whole-string equality + edge-only stripping (RC6) |
| E2 | Previous English question continued into the next | Critical | STT `prompt` | Decoder conditioned on the prior transcript (RC1). | Prompt no longer contains transcript text |
| E3 | `the` classified a sentence as Hindi | High | `intentClassifier.ts` | `the` was in the Hindi cue list. | Strong/weak split (RC7) |
| E4 | Devanagari prompt biased English audio towards Hindi | Medium | `buildSttPrompt` | Mixed-script prompt. | ASCII-only vocabulary prompt |
| E5 | Instruction text transcribed verbatim | Medium | STT `prompt` | Instructions in a decoder-conditioning field get transcribed. | Instruction-free prompt (RC1) |

---

## 4. Latency Issues

Measured stages, all instrumented in `sttDiagnostics.ts`:

```
audio chunk arrives (ring push, absolute sample offset)
  → chunk/clip creation (ring.slice at VAD-reported offsets)
  → STT request sent            diagStartStt()
  → STT response received       diagEndStt()   → logs stt=NNNms
  → transcript state update     renderTicker()
  → UI render                   diagDisplayed() → logs response→display and audio→display
```

| # | Issue | Severity | Where | Root cause | Fix | Effect |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | ~80× realtime request amplification | Critical | `schedulePartial` | 24 s sliding window re-sent every 300 ms → Groq 429 → 45 s key cooldowns → Deepgram fallback and/or `withRetry` backoff **on the final request the answer waits for**. | Tail-only clips, adaptive cadence, single in-flight, growth gate | ~3× realtime |
| L2 | Retry/backoff on cosmetic requests | High | `transcribe-only` | `withRetry(fn, 3, 800ms)` applied to partials, which are superseded ~3×/sec anyway. | Partials: `timeout 6000`, no retry. Finals: `timeout 15000` + retry | removes up to 2.4 s of pointless backoff per partial |
| L3 | Ticker blocked while an answer generated | Medium | `onaudioprocess`, `finalizeQuestion` | Both early-returned during generation, so the next question appeared only after the previous answer finished. | Always buffer; queue + replay finalize (RC10) | next question starts transcribing immediately |
| L4 | Long clips slower **and** less accurate | Medium | `finalizeQuestion` | Unbounded final clip; Whisper's encoder window is 30 s and beyond it cost rises while quality falls. | `MAX_FINAL_SEC = 28`, finalize from the tail | bounded worst case |
| L5 | Second `AudioContext` + uncancellable rAF | Medium | `setupAnalyser` | Extra audio graph and render loop per session (RC8). | deleted | less main-thread work, no per-session leak |

**Deliberately not done:** no timeout was increased or decreased at random, and no arbitrary
delay was added. `LONG_PAUSE_SEC` stays at **2.4 s** — shortening it would have bought
apparent latency by cutting people off mid-sentence. The latency was recovered structurally,
by not sending 80× more audio than necessary.

**UI is not the bottleneck, and is now measurable.** `diagDisplayed` reports
`response→display` separately from `audio→display`, so "STT is slow" and "the UI is sitting
on the result" can no longer be confused. The transcript path has **no** typewriter
animation: the effect on `pendingTranscript` pushes *all* new words in one `setDisplayedWords`
call. `useWordReveal` (8 ms/word) applies only to the **answer**, never the transcript.

---

## 5. Hallucination Issues

Every fix below is causal. Nothing was addressed by deleting suspicious words from the
output.

| # | Class of hallucination | Severity | Mechanism | Fix |
| --- | --- | --- | --- | --- |
| X1 | Text from previous audio; repeated/continued phrases | Critical | Previous transcript in Whisper's `prompt`, left-truncated mid-word (RC1) | Prompt is a fixed instruction-free vocabulary list; `context` removed from the IPC chain |
| X2 | Fluent invented words, Hindi far worse | Critical | Per-clip language auto-detection; Hindi decoded by an English LM (RC2) | Pin explicit languages; sticky `hi` per utterance for `auto` sessions |
| X3 | Invented leading word | High | Clip started mid-phoneme (RC3) | 300 ms pre-roll from the ring; 2-chunk onset confirmation |
| X4 | Silence/noise decoded as confident words | High | Whisper hallucinates on non-speech; no confidence signal requested (RC6b) | `verbose_json` + `no_speech_prob`/`avg_logprob` thresholds; VAD gates on voiced audio |
| X5 | Stuck repetition loops ("haan haan haan…") | High | Degenerate decoding; temperature fallback re-samples until heuristics pass | `temperature=0` + `compression_ratio > 2.4` segment drop |
| X6 | Duplicated words at seams | Medium-High | `stitchPartial` fell back to raw concatenation when Whisper reworded a seam (RC13) | One full-utterance final pass; non-overlapping pause-cut segments |
| X7 | Prompt instructions appearing as transcript | Medium | Instructions in a decoder-conditioning field | Instruction-free prompt; `isWhisperPromptHallucination` kept as a net until the gateway is deployed |
| X8 | Subtitle watermarks ("Amara.org", "thanks for watching") | Low | Whisper's training data leaking on near-silent input | `SUBTITLE_NOISE_PATTERNS`, plus X4 removes most of the input that triggers them |

---

## 6. Filler Handling

- **Severity:** High (it was both too aggressive and too weak, in different languages)
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** `cleanTranscript` (LLM gate) and `isTranscriptNoise` (ticker)
- **Root cause:** one function did both jobs with a Devanagari bypass and an English prefix
  match — see RC6. It also ran at the wrong stage for the ticker: applying the strict LLM
  gate to partials left the transcript bar blank until a whole sentence had landed.
- **Fix — two filters at two stages, deliberately:**
  - `cleanTranscript()` gates the **LLM**. Four checks, both scripts, in order: watermark
    patterns → whole-string sound tag / acknowledgement (**equality only**) → edge filler
    stripping → lone-word rule. `SOUND_FILLERS` (`um`, `uh`, `hmm`, `हम्म`, `उम्म`, `अरे`, …)
    strip from **both** ends; `LEADIN_FILLERS` (`so`, `basically`, `actually`, `haan`,
    `अच्छा`, `तो`, …) strip from the **front only**, and only while ≥ 2 tokens survive.
  - `isTranscriptNoise()` gates the **ticker** and is deliberately loose: watermarks and
    whole-string sound tags only. Everything else is shown as it arrives and superseded by
    the next partial.
- **Why it works:** filler removal is positional, not lexical. `no`, `not` and `matlab` are
  **explicitly excluded** from the lead-in set because "no sql" and "matlab kya hai" need
  them. Nothing is ever removed from the middle of an utterance, and both scripts are held
  to the same bar.
- **Possible side effects:** a two-token question opening with a lead-in keeps it (the
  `> 2` guard). A single spoken word under 12 characters that is not in
  `STANDALONE_TECH_WORDS` is treated as an acknowledgement and dropped.
- **On the "huge word list" concern:** the sets are intentionally small and each has a
  single job — sound tags are Whisper's own non-speech annotations, acknowledgements are
  matched by whole-string equality (so they cannot damage a sentence), and the filler sets
  are vocalised hesitations only. The *substance* of the hallucination fix is RC1/RC2/RC3/RC6b
  — audio, language, chunking and decoder confidence. This section is only the last, thin
  normalization layer, exactly as required.

---

## 7. Interim / Final Transcript Issues

- **Severity:** High
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** `schedulePartial`, `commitSegment`, `finalizeQuestion`, `renderTicker`
- **Root cause:** there was no clean separation between interim and committed text. Partials
  re-transcribed a sliding window and were *spliced* onto the display; the splice fell back
  to concatenation and duplicated text; a slow partial could rewind newer text; a partial
  landing after finalize repainted an answered question; and the final transcript was built
  from that spliced display text.
- **Fix — four explicit, separately-owned states:**

  | State | Owner | Meaning |
  | --- | --- | --- |
  | committed segments | `committedSegments[]` (index-addressed) | frozen at VAD pauses; a late authoritative result replaces only its own placeholder |
  | live tail (interim) | `partialTailTextRef` | re-transcribed tail since the last boundary; **replaced**, never appended |
  | final | one full-clip pass in `finalizeQuestion` | the only text the LLM sees |
  | displayed | `pendingTranscript` → `displayedWords` | `joinSegments(committed, tail)` |

  A partial **replaces** the tail (`partialTailTextRef.current = text`) — it is never pushed
  as a new transcript entry. A commit pushes exactly one entry per VAD pause and clears the
  tail. The final does not concatenate the display text; it re-transcribes the audio.
- **Why it works:** interim text lives in exactly one slot that is overwritten, so it cannot
  accumulate or duplicate. Commit indices are stable, so out-of-order commits cannot
  interleave. The final is derived from audio, not from display state, so no display bug can
  reach the LLM.
- **Possible side effects:** the ticker can briefly show an optimistic placeholder (the last
  partial's text) for a segment whose authoritative result is still in flight. It is
  replaced in place, and the alternative — blanking the segment — reads as a regression.

---

## 8. Audio Chunking

- **Severity:** High
- **File:** `src/renderer/src/components/OverlayPage.tsx`, `src/renderer/src/services/audioRing.ts`
- **Function/component:** `processor.onaudioprocess`, `AudioRing`, `transcribeSlice`
- **Root cause:** capture chunks (4096 samples ≈ 85 ms at 48 kHz) were appended to a buffer
  only while VAD said speech was active, and STT clips were carved from that buffer as a
  24-second sliding window. Consequences: onset dropped (RC3), boundaries fell wherever the
  window happened to land — often mid-word — overlapping windows re-sent the same audio 60×
  (RC4), and the two buffers could disagree (RC12).

| Property | Before | After |
| --- | --- | --- |
| capture chunk | 4096 samples ≈ 85 ms | unchanged |
| retained audio | conditional, unbounded (worker) | `AudioRing`, 90 s, front-drop, ≈17 MB |
| addressing | array index, shifted on trim | absolute sample offset, never reset |
| STT clip (partial) | 0–24 s sliding window | tail since last VAD pause |
| STT clip (commit) | n/a | one pause-to-pause span, `+0.2 s` post-roll |
| STT clip (final) | spliced display text | one pass over `[start − 0.3 s, end + 0.2 s]`, capped 28 s |
| overlap between clips | large and repeated | none between committed segments |
| boundaries | wherever the window landed | only at ≥ 0.35 s of silence |
| minimum clip | none | `MIN_STT_SEC = 0.5 s` |
| ordering | responses raced | `seq` + `utteranceId` + serialised commit chain |

- **Why it works:** cutting only at silence means a cut can never split a word. Absolute
  offsets mean a slice taken later still refers to the same audio. Non-overlapping segments
  mean no audio is transcribed twice, so no text can be duplicated by re-transcription.
- **Possible side effects:** a speaker who never pauses for 0.35 s produces one long segment
  and a long tail; the tail is capped by the adaptive cadence and the final by
  `MAX_FINAL_SEC`.

## 9. VAD

- **Severity:** High
- **File:** `src/renderer/src/services/vadWorker.ts`
- **Function/component:** the whole worker (rewritten as a pure detector)
- **Root cause:** the worker owned audio, buffered without a cap, never cleared `isManual`,
  detected onset from a single chunk, recorded the *end* of a pause rather than its start,
  and posted whole `Float32Array`s back to the main thread.

| Parameter | Value | Rationale |
| --- | --- | --- |
| `SPEECH_START_RMS` | 0.018 | onset; combined with a 300 ms pre-roll so it need not be low |
| `SPEECH_END_RMS` | 0.01 | hysteresis — a lower release threshold stops flapping inside a word |
| onset confirmation | 2 consecutive chunks (~170 ms) | one click or key press cannot open an utterance |
| `COMMIT_PAUSE_SEC` | 0.35 | short enough to happen several times per sentence, long enough to be a word boundary |
| `LONG_PAUSE_SEC` | 2.4 | **unchanged** — shortening it would cut people off mid-sentence |
| `MIN_VOICED_SEC` | 0.4 | measured on **voiced** audio only, so trailing silence never counts towards it |
| `VOICED_RMS` | 0.008 | renderer-side voiced-sample counter that gates STT calls |
| `PRE_ROLL_SEC` | 0.3 | recovers the onset the threshold necessarily misses |
| `POST_ROLL_SEC` | 0.2 | protects the final consonant |

- **Fix:** the worker reports offsets only (`speech_start`, `segment_boundary`, `finalize`,
  `discard`) on a monotonic sample clock shared with the renderer. Offset is recorded at the
  **first quiet chunk**, so a boundary lands on the real end of the word rather than
  `COMMIT_PAUSE_SEC` later. `finalize` carries `speechEndAtMs` for the continuation window
  (RC5). A `discard` in manual mode is **recovered**: if the user pressed Listen and the
  renderer counted ≥ `MIN_VOICED_SEC` of voiced audio, the turn is finalized from the button
  press rather than thrown away — quiet speech that never crossed `SPEECH_START_RMS` is
  still audio the user explicitly asked to have transcribed.
- **Why silence is not sent to STT:** four independent gates, all cheap and all
  pre-request — `MIN_STT_SEC = 0.5 s` of audio, ≥ 0.2 s of voiced audio since the last
  commit, tail growth ≥ 0.35 s since the last partial, and `MIN_VOICED_SEC = 0.4 s` of
  voiced audio before an utterance finalizes at all. Pure silence produces **zero** STT
  requests.
- **Why it is not too aggressive for Hindi:** nothing is cut at the threshold. The pre-roll
  restores audio from *before* onset detection and the post-roll extends past offset, so a
  low-energy Hindi onset or a soft final consonant survives even though the threshold itself
  is conservative.
- **Possible side effects:** loud continuous background noise above `SPEECH_END_RMS` keeps an
  utterance open until `LONG_PAUSE_SEC` of genuine quiet. The gateway's `no_speech_prob`
  filter (RC6b) is the second line of defence there.

## 10. Race Conditions

- **Severity:** Medium-High
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** `schedulePartial`, `commitSegment`, `finalizeQuestion`, `handleClearTranscript`, `handleToggleManual`

| Race | Before | Guard now |
| --- | --- | --- |
| Slow partial overwrites a faster one | last response won | `seq <= partialAppliedSeqRef` → drop |
| Partial lands after finalize | repainted an answered question | `utteranceId` mismatch → drop |
| Two partials in flight | unbounded concurrency | `partialInFlightRef` — one at a time |
| Two commits interleave their text | string concatenation raced | `commitChainRef` promise chain + per-commit index |
| Commit lands after Clear | repainted cleared text | `utteranceIdRef` bumped by Clear → drop |
| Finalize during generation | **silently dropped the question** | `queuedFinalizeRef`, replayed in `finally` |
| Older answer overwrites a newer one | last response won | `generationSeqRef` stamped before the `await`, re-checked after |
| Manual STOP racing the mode change | mode reset discarded the utterance | `manual_stop` posted **before** the `config` message |
| Manual STOP producing a `discard` | turn lost | `manualStopPendingRef` + voiced-sample check → finalize from the button press |

Every request carries chunk identity (absolute `from`/`to` offsets), a sequence number, a
timestamp (via the diagnostics handle) and its kind (`partial` / `commit` / `final`). Every
drop is reported with a reason through `diagDropped`. A stale result can no longer overwrite
newer transcript state on any path.

## 11. UI Rendering

- **Severity:** Medium
- **File:** `src/renderer/src/components/OverlayPage.tsx`
- **Function/component:** the `pendingTranscript` → `displayedWords` effect, `useWordReveal`, `computePacketsFromWords`
- **Root cause / finding:** the UI was **not** the primary cause, but it was also not
  exonerated by inspection — the data path was traced. `setPendingTranscript` is called from
  `renderTicker()` only, which is called from exactly three places (partial applied, commit
  applied, reset). The recent UI change did not alter interim/final handling, buffering,
  debounce or the transcript queue; it changed layout and animation.
- **Verified properties:**
  - **No artificial latency on the transcript.** The effect pushes *all* new words in one
    `setDisplayedWords` call. `useWordReveal` (8 ms/word) is applied to the **answer** only.
  - **Corrections update in place.** Existing word objects keep their `id` and only their
    `text` changes, so a Whisper rewording does not re-trigger enter animations for the
    whole line (`AnimatePresence mode="popLayout"` keys on `id`).
  - **The bar shows exactly the current state.** `joinSegments(committed, tail)` — no
    history, no accumulation.
  - **Romanisation happens at one choke point.** `toDisplayTranscript` is applied at
    `OverlayPage.tsx:626` (ticker) and `:2082` (question). Everything upstream, including the
    LLM input, is raw Devanagari.
  - **Render cost is measured, not asserted.** `diagDisplayed` reports `response→display`
    separately from `audio→display`.
- **Possible side effects:** none introduced. If `response→display` ever shows a meaningful
  figure, the animation is the culprit and the data now exists to say so.

## 12. Memory / Listener Cleanup

- **Severity:** Medium
- **File:** `src/renderer/src/components/OverlayPage.tsx`, `src/renderer/src/services/vadWorker.ts`
- **Function/component:** the capture `useEffect` teardown, `handleToggleManual`, `handleClearTranscript`
- **Root cause:** `setupAnalyser` created a second `AudioContext` and a
  `requestAnimationFrame` loop whose handle was never kept, so it could not be cancelled
  (RC8). `ScriptProcessorNode.onaudioprocess` was not cleared before `disconnect()` — a
  script processor keeps firing, and keeps its whole closure reachable, until the handler is
  nulled — so every start/stop/start cycle leaked the graph, the ring and the worker. The
  partial timer was not cleared. The worker's audio buffer grew without bound (RC11).
- **Fix — teardown now, in order:** clear the partial timer → **null
  `onaudioprocess`** → `disconnect()` → null the node → `close()` and null the
  `AudioContext` → stop and null every `MediaStreamTrack` → null `worker.onmessage` →
  `worker.terminate()` → null the worker → null the ring → bump `utteranceIdRef` and retire
  pending partials → clear `queuedFinalizeRef`, `finalizeQuestionRef`,
  `resetTranscriptStateRef`.
- **Also fixed:** committed-segment state lives in the capture closure and is now cleared
  through a single `resetTranscriptStateRef` indirection. An earlier version kept a mirror
  ref; clearing the mirror left the real array intact, so the next partial repainted the
  transcript the user had just cleared. There is now one owner and one reset path, used by
  Clear, manual start, `discard` and finalize alike.
- **Also fixed:** a **failed** `startCapture` released nothing. Throwing on the common
  "System audio missing — ensure Share system audio is checked" path left the screen-capture
  `MediaStream` live, with its recording indicator on, for the rest of the session, and left
  the VAD worker running. The `catch` block now stops every track, nulls
  `onaudioprocess` before disconnecting the node, closes the `AudioContext`, terminates the
  worker and drops the ring.
- **Why it works:** each retained reference is dropped explicitly, and the one that actually
  kept the graph alive (`onaudioprocess`) is dropped **first**.
- **Possible side effects:** none. START→STOP→START now rebuilds a clean graph.

---

## 13. Fixes Implemented

**`ai-gateway/src/index.ts`** *(requires `wrangler deploy`)*
1. `WhisperSegment` interface + `filterHallucinatedSegments()` — confidence-based segment
   filtering using `no_speech_prob`, `avg_logprob`, `compression_ratio`.
2. `sttLanguage`: only `auto` maps to auto-detect; `en`/`hi` are pinned.
3. `prompt.slice(0, 400)` instead of `slice(-400)`.
4. `temperature=0` — disables Whisper's temperature-fallback re-sampling.
5. `response_format=verbose_json` — makes the confidence fields available.
6. Success path returns `{ text: filterHallucinatedSegments(data) }`.

**`src/main/index.ts`**
7. `resolveSttLanguage()` — only `auto` is unpinned.
8. `STT_VOCABULARY_PROMPT` + `buildSttPrompt(language)` — fixed, instruction-free,
   ASCII-only, no transcript context; empty for non-`en`/`hi` sessions.
9. `transcribe-only`: `context` no longer destructured; `.slice(-300)` removed; partials get
   `timeout: 6000` and no retry, finals `timeout: 15000` + `withRetry`.
10. `transcribe-audio`: same prompt policy.
11. `isWhisperPromptHallucination` extended with the vocabulary-list echo pattern; the
    instruction-echo patterns kept as a net until the gateway is deployed.
12. Logging reduced to lengths; the hallucination-discard log gated behind `is.dev`.

**`src/preload/index.ts`, `src/preload/index.d.ts`**
13. `context?: string` removed from the `transcribeOnly` payload type.

**`src/renderer/src/services/aiService.ts`**
14. `transcribeAudioOnly` takes no transcript context and accepts `languageOverride` for the
    per-utterance Hindi pin. Documented why both decisions are load-bearing.

**`src/renderer/src/services/vadWorker.ts`** — rewritten
15. Pure detector, owns no audio; reports absolute sample offsets.
16. 2-chunk onset confirmation; offset recorded at the first quiet chunk.
17. `segment_boundary` at `COMMIT_PAUSE_SEC`, once per pause.
18. `finalize` carries `startSample`, `endSample`, `voicedSamples`, `speechEndAtMs`.
19. `MIN_VOICED_SEC` measured on voiced audio only; `discard` when it is not met.
20. A mode change resets the utterance; `manual_stop` handled before that reset.

**`src/renderer/src/services/audioRing.ts`** — new
21. Absolute-offset ring buffer with front-drop and a `slice()` that returns views rather
    than copies except at the two boundaries.

**`src/renderer/src/services/sttDiagnostics.ts`** — new
22. Dev-only per-request instrumentation; see §15.

**`src/renderer/src/components/OverlayPage.tsx`**
23. `cleanTranscript()` replaces `isFillerOrHallucination`; `isTranscriptNoise()` added for
    the ticker.
24. Filler sets rebuilt: whole-string acknowledgements, edge-only sound fillers, front-only
    lead-ins, `STANDALONE_TECH_WORDS`. Devanagari spellings corrected (`अच्छा`, `हाँ`).
25. `stitchPartial` / `tailChunks` deleted; `joinSegments()` added.
26. `setupAnalyser`, `analyserRef`, `maxVolumeRef`, `vadBufferRef`, `pendingTranscriptRef`,
    `targetTranscriptRef`, `lastActiveSpeechRef`, `vadSampleRateRef`, `vadSpeechActiveRef`
    deleted — all dead or leaking.
27. `startCapture` rewritten around the ring: `transcribeSlice`, `commitSegment`,
    `finalizeQuestion`, `schedulePartial`, and the worker event handler.
28. Final transcript = **one full-utterance pass**, capped at 28 s, with committed text as a
    fallback only.
29. Sequence numbers, `utteranceId` stamping, `commitChainRef`, index-addressed segments.
30. `queuedFinalizeRef` + `generationSeqRef` — no question is lost during generation and no
    stale answer wins.
31. Continuation window anchored on `speechEndAtMs`, `GRACE_WINDOW_SEC = 12 → 4`, plus the
    `answeredSince` guard.
32. `onaudioprocess` never returns early; voiced-sample counters feed the STT gates.
33. Teardown hardened (§12); `resetTranscriptStateRef` gives Clear / manual start / discard /
    finalize a single reset path.
34. Diagnostics effect on `displayedWords` closes the response→display measurement.
35. `startCapture`'s `catch` now releases the media stream, script processor, `AudioContext`,
    worker and ring — a failed start used to leave the screen capture running.

**`src/renderer/src/services/pipeline/intentClassifier.ts`**
36. `HINDI_STRONG` / `HINDI_WEAK` split; `the` and `me` removed; weak markers need two
    distinct hits.

---

## 14. Remaining Issues

1. **The gateway is not deployed.** `ai-gateway/src/index.ts` changes (segment filtering,
   `temperature=0`, `verbose_json`, language pinning, prompt truncation direction) are inert
   until `cd ai-gateway && npx wrangler deploy` runs. Highest-priority follow-up: RC6b and
   half of RC2 live there.
2. **`transcribe-only`'s other three callers were left alone**, deliberately, to avoid
   widening the change surface: `PhoneInterviewPanel.tsx:432`, `aiService.ts:620`
   (`generateAudioResponse`), `audioTranscription.ts:146`. They benefit from the prompt and
   language fixes (those live in main) but not from the ring, VAD, partial-lifecycle or
   race-condition work. `PhoneInterviewPanel` in particular still has its own capture path.
3. **The first clip of an `auto` session still auto-detects.** Unavoidable without asking the
   user, and it is the clip with the most audio to decide on. The sticky pin protects
   everything after it. A user who knows they will speak Hindi should pick `hi` explicitly.
4. **`temperature=0` removes Whisper's fallback re-sampling.** On genuinely hard audio a
   segment that the fallback would have recovered may now come back empty. The trade is
   deliberate: the fallback's output on hard audio was fluent invention, which is worse than
   nothing.
5. **`ScriptProcessorNode` is deprecated.** `AudioWorkletNode` would move RMS off the main
   thread. Out of scope here — it is a performance improvement, not a correctness one.
6. **No automated tests exist for this pipeline.** Everything in §15 is manual. Unit-testable
   pieces are `AudioRing.slice`, `cleanTranscript`, `joinSegments` and the VAD state machine
   (all pure); adding them is the obvious next step.
7. **`compression_ratio > 2.4` can in principle fire on legitimate repetition** ("no, no,
   no, that's not what I meant"). Whisper's published default; left as-is rather than tuned
   on a guess.

---

## 15. Manual Testing Required

### Diagnostic mode

Automatic in a dev build. In a packaged build, run this in the overlay devtools and restart
the session:

```js
localStorage.setItem('zyro:stt-diag', '1')
```

Per-request output — kind, sequence number, audio-clock position, clip duration, language,
STT round-trip, character count, and (dev builds only) the text:

```
[STT-Diag] #42 partial/17 audio@12.4s dur=1.85s lang=hi stt=380ms chars=41 text="..."
[STT-Diag] #42 partial/17 response→display=6ms audio→display=2241ms
[STT-Diag] #43 commit/18 dropped: stale seq 18
[STT-Diag] utterance voiced=6.2s segments=3 finalize=910ms chars=88 | session: 14 reqs,
           19s audio sent over 62s wall (0.3x realtime), 2 dropped
```

**Production safety:** transcript text is printed only when `import.meta.env.DEV` is true.
A production session with the flag on logs lengths and timings only, so it cannot leak what
was said. All other pipeline logging was reduced to lengths or gated behind `is.dev`.

**The number to watch** is `Nx realtime` in the utterance summary. Before the fixes a single
long question drove it towards 80×; it should now sit near or below 3×. If it climbs, the
partial gates have regressed and the latency problem is back.

### English

| # | Case | Expected |
| --- | --- | --- |
| 1 | Short question ("What is polymorphism?") | exact; single transcript entry |
| 2 | Long multi-sentence question | complete; no duplicated clause at any segment seam |
| 3 | Fast speech | no dropped words; commits still land at pauses |
| 4 | Slow speech with 1–2 s pauses | one question, not several — pauses under 2.4 s must not finalize |
| 5 | Fillers ("umm, so, what is, uh, indexing?") | leading `umm`/`so` gone, `what is indexing` intact |
| 6 | Background noise, no speech | **zero** STT requests; ticker stays empty |
| 7 | "no sql vs sql", "right join kya hai", "yes bank ka case" | kept in full — these are the E1 regression cases |
| 8 | A single word ("polymorphism") | kept (`STANDALONE_TECH_WORDS`) |
| 9 | A bare "ok" / "thanks" | dropped, and **not** prepended to the next question |

### Hindi / Hinglish

| # | Case | Expected |
| --- | --- | --- |
| 10 | Short Hindi question | Devanagari recognised, displayed as Roman Hinglish |
| 11 | Long Hindi question | no invented words at the end; the tail must not flip language |
| 12 | Hindi with English technical words ("regression testing kya hai?") | technical terms stay English |
| 13 | English sentence with one Hindi word | must **not** flip the whole turn to Hindi (RC7) |
| 14 | Hindi sentence with several English words | one coherent Hinglish transcript |
| 15 | Hindi with fillers ("हम्म, तो अच्छा, indexing kya hai?") | fillers gone, question intact |
| 16 | Soft-onset Hindi words (*kya*, *thoda*, *samjhao*) | first syllable present — the RC3 case |
| 17 | Hindi then English in consecutive questions | second question is English; the pin resets per utterance |
| 18 | Explicit `hi` session | never English-detected |
| 19 | Compare the transcript against what was actually said, aloud | **word count must not exceed what was spoken** — the headline symptom |

### Lifecycle

| # | Case | Expected |
| --- | --- | --- |
| 20 | START → STOP → START → STOP → START | works every time; no duplicate transcripts |
| 21 | After #20, check `getEventListeners`/devtools Memory | one `AudioContext`, one worker, one script processor; heap flat across cycles |
| 22 | Manual STOP, then switch to auto | auto mode finalizes on its own (the RC9 case) |
| 23 | Speak while an answer is streaming | the question is queued and answered next, not lost (RC10) |
| 24 | Clear during an in-flight partial | bar stays clear; the late response does not repaint it |
| 25 | Switch language in setup and back | each session uses the chosen language |
| 26 | Refresh / reopen the overlay | clean start; no text from the previous session |
| 27 | 20+ minute session | latency flat, `Nx realtime` flat, heap flat, no duplicated or reprocessed transcript |
| 28 | Two unrelated questions ~5 s apart | two separate questions, not one concatenated (RC5) |
| 29 | One question split by a 3 s pause | two questions — expected consequence of the 4 s window; verify it is not worse |

### Acceptance criteria to sign off against

- Transcript length matches what was spoken (no amplification) — cases 1, 2, 11, 19
- Latency at or better than the pre-regression feel; `Nx realtime` ≤ ~3 — diagnostic output
- Hindi reliable, displayed as Hinglish, meaning unchanged — cases 10–19
- Fillers not dominating; legitimate words not deleted — cases 5, 7, 9, 15
- Interim updates without duplication; final commits cleanly — cases 2, 3, 24
- Strict ordering; no stale overwrite — cases 23, 24
- UI shows exactly the current state with no artificial latency — `response→display` ≈ 0
- No duplicate listeners across restarts — cases 20, 21
- Stable latency and memory over a long session — case 27

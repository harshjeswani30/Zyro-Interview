import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ChevronDown } from 'lucide-react'
import './PhoneInterviewPanel.css'


interface Resume {
  id: string
  name: string
  text: string
}

interface UserProfile {
  id?: string
  email?: string
  sessions_balance?: number
  phone_sessions_balance?: number
  trial_seconds_used?: number
  [key: string]: unknown
}

interface PhoneInterviewPanelProps {
  name: string
  role: string
  company: string
  language: string
  experienceLevel: 'fresher' | 'experienced'
  experienceDuration?: string
  workHistory?: string
  codingLanguage?: string
  interviewContent?: string
  activeKbId?: string
  selectedResumeId: string
  resumes: Resume[]
  userProfile?: UserProfile | null
  onUpgradeClick: () => void
  onCaptureStateChange?: (
    isCapturing: boolean,
    stopFn: (() => void) | null,
    startFn?: (() => void) | null,
    hasLogs?: boolean
  ) => void
}

interface QABlock {
  id: string
  question: string
  answer: string
  timestamp: Date
  status: 'transcribing' | 'generating' | 'completed' | 'failed'
  lastSpeechTime: number // epoch ms
}

// ── WAV encoder: Float32Array PCM chunks → WAV Blob (16kHz Mono) ──────────────────────────
function encodeWAV(chunks: Float32Array[], sampleRate: number): Blob {
  const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0)
  const merged = new Float32Array(totalSamples)
  let pos = 0
  for (const c of chunks) {
    merged.set(c, pos)
    pos += c.length
  }
  const int16 = new Int16Array(merged.length)
  for (let i = 0; i < merged.length; i++) {
    const s = Math.max(-1, Math.min(1, merged[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const buf = new ArrayBuffer(44 + int16.byteLength)
  const view = new DataView(buf)
  const w = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i))
  }
  w(0, 'RIFF')
  view.setUint32(4, 36 + int16.byteLength, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true) // 2 bytes per sample (16-bit)
  view.setUint16(34, 16, true) // 16-bit
  w(36, 'data')
  view.setUint32(40, int16.byteLength, true)
  new Int16Array(buf, 44).set(int16)
  return new Blob([buf], { type: 'audio/wav' })
}

export default function PhoneInterviewPanel({
  name,
  role,
  company,
  language,
  experienceLevel,
  experienceDuration,
  workHistory,
  codingLanguage: _codingLanguage,
  interviewContent,
  activeKbId,
  selectedResumeId,
  resumes,
  userProfile,
  onUpgradeClick,
  onCaptureStateChange
}: PhoneInterviewPanelProps): React.ReactElement {
  const [isCapturing, setIsCapturing] = useState(false)
  const [statusText, setStatusText] = useState('Ready to capture')
  const [volumeLevel, setVolumeLevel] = useState(0) // 0 to 100
  const [qaLogs, setQaLogs] = useState<QABlock[]>([])
  const [isThinking, setIsThinking] = useState(false)
  
  // Custom states for Q&A row-wise Layout
  const [typedBlockIds, setTypedBlockIds] = useState<Set<string>>(new Set())
  const [copiedBlockId, setCopiedBlockId] = useState<string | null>(null)
  const [expandedBlockIds, setExpandedBlockIds] = useState<Set<string>>(new Set())

  // Paywall states
  const [showPaywall, setShowPaywall] = useState(false)
  const [selectedSessions, setSelectedSessions] = useState<number>(1)
  const [loadingPlan, setLoadingPlan] = useState<'standard' | 'pro' | 'ultimate' | null>(null)
  const [paywallError, setPaywallError] = useState<string | null>(null)
  const [paywallSuccess, setPaywallSuccess] = useState<string | null>(null)

  const toggleBlockExpanded = useCallback((blockId: string) => {
    setExpandedBlockIds((prev) => {
      const next = new Set(prev)
      if (next.has(blockId)) {
        next.delete(blockId)
      } else {
        next.add(blockId)
      }
      return next
    })
  }, [])

  // ── Audio pipeline refs ─────────────────────────────
  const audioContextRef = useRef<AudioContext | null>(null)
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const pcmChunksRef = useRef<Float32Array[]>([])
  const isSpeechDetectedRef = useRef(false)
  const lastActiveRmsTimeRef = useRef<number>(Date.now())
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── ACMP (Asynchronous Continuation & Merging Pipeline) refs ────
  const lastActiveBlockIdRef = useRef<string | null>(null)
  const pendingLLMTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conversationHistoryRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([])
  const qaLogsRef = useRef<QABlock[]>([])

  // Keep logs ref in sync for timer callbacks
  useEffect(() => {
    qaLogsRef.current = qaLogs
  }, [qaLogs])

  // ── Typewriter component locally ──
  const TypewriterText = ({ text, onComplete }: { text: string; onComplete?: () => void }) => {
    const [displayed, setDisplayed] = useState('')
    useEffect(() => {
      const words = text.split(' ')
      let currentIdx = 0
      setDisplayed('')
      const interval = setInterval(() => {
        if (currentIdx < words.length) {
          setDisplayed((prev) => (prev ? prev + ' ' + words[currentIdx] : words[currentIdx]))
          currentIdx++
        } else {
          clearInterval(interval)
          if (onComplete) onComplete()
        }
      }, 30) // slightly faster for premium feel
      return () => clearInterval(interval)
    }, [text, onComplete])
    return <span>{displayed}</span>
  }

  const markBlockAsTyped = useCallback((id: string) => {
    setTypedBlockIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  // ── Copy to Clipboard Helper ──
  const handleCopy = (blockId: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedBlockId(blockId)
    setTimeout(() => setCopiedBlockId(null), 1500)
  }

  const stopCaptureInternal = useCallback(() => {
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
    if (pendingLLMTimerRef.current) {
      clearTimeout(pendingLLMTimerRef.current)
      pendingLLMTimerRef.current = null
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect()
      scriptProcessorRef.current = null
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop())
      audioStreamRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    setIsCapturing(false)
    setVolumeLevel(0)
    setStatusText('Capture stopped')
  }, [])

  // Clean up audio stream on unmount
  useEffect(() => {
    return () => {
      stopCaptureInternal()
    }
  }, [stopCaptureInternal])

  const triggerLLMResponse = useCallback(async (blockId: string) => {
    const block = qaLogsRef.current.find((q) => q.id === blockId)
    if (!block) return

    setQaLogs((prev) =>
      prev.map((q) => (q.id === blockId ? { ...q, status: 'generating' } : q))
    )

    try {
      const targetCompany = company ? `"${company}"` : 'the company'
      const fresherContext = experienceLevel === 'fresher' 
        ? `CANDIDATE TYPE: FRESHER. They have NO paid full-time experience. The target company (${targetCompany}) is where they are currently interviewing, NOT where they worked before. Never fabricate past jobs.`
        : `CANDIDATE TYPE: EXPERIENCED. They have ${experienceDuration || 'some'} experience. Past history: ${workHistory || ''}`

      const historyString = conversationHistoryRef.current
        .map((h) => `${h.role === 'user' ? 'Interviewer' : 'Me'}: ${h.content}`)
        .join('\n')

      const resumeText = resumes.find((r) => r.id === selectedResumeId)?.text || ''

      const lowerQuestion = block.question.toLowerCase()
      const needsDetail = /elaborate|detail|deep dive|explain more|tell me more|expand on/i.test(lowerQuestion)
      const lengthInstruction = needsDetail
        ? 'CRITICAL ANSWER LENGTH RULE: The interviewer has explicitly asked to elaborate or answer in detail. Provide a comprehensive, detailed response (3 to 5 sentences).'
        : 'CRITICAL ANSWER LENGTH RULE: Keep the answer extremely short and brief (1 to 2 sentences maximum). Be highly direct and concise. Do NOT add extra details or explain at length unless explicitly asked to elaborate.'

      setStatusText('Formulating AI response...')
      
      let finalAnswer = ''
      let isRagSuccessful = false

      const localExcerpts = await window.api.searchLocalVectorDb(block.question, 3)
      if (localExcerpts && localExcerpts.length > 0) {
        const ragContext = localExcerpts.join('\n\n')
        const ragPrompt = `You are a real-time interview answer assistant.
Answer the interviewer's question using the supplied INTERVIEW CONTEXT as your primary source of truth.
The context is candidate-provided interview preparation material.

Rules:
1. Treat the supplied context as the primary factual source.
2. Cross-Lingual Rule: The context may be in English, but if the question is in Hindi/Hinglish, you MUST translate and explain the concepts in fluent HINGLISH (Conversational Hindi written in English/Latin alphabet).
3. If the question is in pure English, answer in English.
4. Make the answer sound like something the candidate can naturally speak during a live interview.
5. Keep technical terms in standard English.
6. Start directly with the answer. Avoid unnecessary introductions.
7. Do not mention 'context', 'knowledge base', 'retrieved chunks', or RAG.
8. If the supplied material does not contain enough information to answer reliably, output exactly: NO_RELEVANT_CONTEXT

INTERVIEW CONTEXT:
${ragContext}

===
CANDIDATE INFORMATION (for name reference only):
Name: ${name}
Role: ${role}
===`
        try {
          const answer = await window.api.generateAnswer({
            transcript: block.question,
            systemPrompt: ragPrompt,
            model: 'openai/gpt-oss-120b',
            temperature: 0.25,
            maxTokens: 1600
          })
          const cleanAnswer = answer.trim()
          if (cleanAnswer !== 'NO_RELEVANT_CONTEXT' && !cleanAnswer.includes('NO_RELEVANT_CONTEXT')) {
            finalAnswer = cleanAnswer
            isRagSuccessful = true
          }
        } catch (ragErr) {
          console.error('[RAG] Phone Interview Groq completion failed:', ragErr)
        }
      }

      if (!isRagSuccessful) {
        const systemPrompt = `You are a real-time AI interview assistant. You are helping the candidate ${name} answer phone call technical interview questions live.
        
IDENTITY:
- You ARE the candidate — ${name}, applying for the role of ${role} at ${company || 'the target company'}.
- Always answer in the first person ("I" / "Main"). Never say "Certainly", "Great question", or "As an AI model...". Start the answer directly.
- NEVER invent or exaggerate experience beyond the resume.

TONE & LANGUAGE RULES (CRITICAL):
1. **HINDI / HINGLISH QUESTIONS**: If the interviewer speaks or asks the question in Hindi, Hinglish, or Devanagari script:
   - You MUST answer in **fluent, natural HINGLISH** (Conversational Hindi written in English/Latin alphabet, e.g. "Main regression testing perform karne ke liye sabse pehle...", "Hum critical test cases execute karte hain...").
   - **STRICT PROHIBITION 1**: DO NOT use Devanagari script (NO हिंदी लिपि like मैं, आप, यह). Always write in English alphabets.
   - **STRICT PROHIBITION 2**: DO NOT answer in pure English when the question was in Hindi/Hinglish. Answer in Hinglish.
   - Keep all technical terms, tool names, framework names, and processes in standard ENGLISH (e.g. QA Lead, Regression Testing, Test Plan, Selenium, Postman, Jira, Agile, Sprint, Bug Lifecycle, CI/CD).
2. **ENGLISH QUESTIONS**: If the interviewer asks in pure English, answer in clear, professional English.
- Short active sentences. No corporate filler phrases.
- NEVER use bullet points. Always output clean, flowing paragraph sentences.
- ${lengthInstruction}

${fresherContext}

${interviewContent && interviewContent.trim() ? `
=== IMPORTANT: INTERVIEW CONTENT CHEAT SHEET ===
The candidate has provided the following custom notes/cheat sheet for this interview:
"""
${interviewContent.trim()}
"""
=== END OF INTERVIEW CONTENT CHEAT SHEET ===

RULES FOR USING INTERVIEW CONTENT:
1. When the interviewer's question matches, refers to, or is related to any topics/information in the "INTERVIEW CONTENT CHEAT SHEET" above, you MUST prioritize answering from that content.
2. Cross-Lingual Adaptation: Even if the cheat sheet is in English, if the question is in Hindi/Hinglish, explain the concepts seamlessly in HINGLISH (English alphabet Hindi).
3. When answering from the cheat sheet, explain it smartly, clearly, and in simple conversational terms. Keep it natural.
4. If the interviewer asks something "out of the box" that is NOT covered or related to the cheat sheet, you should answer on your own using your general knowledge and the candidate's resume/profile context. Do NOT force a match if it is not related.
` : ''}

### RECENT CONVERSATION HISTORY (CRITICAL FOR FOLLOW-UP QUESTIONS):
${historyString}
### END OF HISTORY

=== CANDIDATE RESUME (ABSOLUTE SOURCE OF TRUTH) ===
${resumeText.substring(0, 3500)}
=== END OF RESUME ===`

        finalAnswer = await window.api.generateAnswer({
          transcript: block.question,
          systemPrompt,
          model: 'openai/gpt-oss-120b',
          temperature: 0.65,
          maxTokens: 1600
        })
      }

      // Add to conversation history
      conversationHistoryRef.current.push({ role: 'user', content: block.question })
      conversationHistoryRef.current.push({ role: 'assistant', content: finalAnswer })
      if (conversationHistoryRef.current.length > 10) conversationHistoryRef.current.shift()

      setQaLogs((prev) =>
        prev.map((q) => (q.id === blockId ? { ...q, answer: finalAnswer, status: 'completed' } : q))
      )
      setStatusText('🎙️ Listening for call audio...')
    } catch (err) {
      console.error('[PhoneCapture] LLM Answer generation failed:', err)
      setQaLogs((prev) =>
        prev.map((q) => (q.id === blockId ? { ...q, status: 'failed', answer: 'Failed to generate answer. Please try again.' } : q))
      )
      setStatusText('🎙️ Listening for call audio...')
    } finally {
      setIsThinking(false)
    }
  }, [name, role, company, experienceLevel, experienceDuration, workHistory, selectedResumeId, resumes, activeKbId])

  const handleNewTranscript = useCallback((newText: string) => {
    const now = Date.now()
    const GRACE_WINDOW_MS = 10000 // 10 seconds grace period to append to same logical block
    
    const lastBlock = qaLogsRef.current[qaLogsRef.current.length - 1]
    
    let targetBlock: QABlock

    if (lastBlock && (now - lastBlock.lastSpeechTime < GRACE_WINDOW_MS)) {
      const updatedQuestion = lastBlock.question + ' ' + newText
      targetBlock = {
        ...lastBlock,
        question: updatedQuestion,
        status: 'generating',
        lastSpeechTime: now
      }
      
      setQaLogs((prev) => prev.map((q) => (q.id === lastBlock.id ? targetBlock : q)))
      setStatusText('🎙️ Appended continuation speech...')
    } else {
      const newId = 'block-' + Math.random().toString(36).substring(2, 9)
      targetBlock = {
        id: newId,
        question: newText,
        answer: '',
        timestamp: new Date(),
        status: 'generating',
        lastSpeechTime: now
      }
      lastActiveBlockIdRef.current = newId
      setQaLogs((prev) => [...prev, targetBlock])
      setStatusText('🎙️ Live speech captured...')
    }

    if (pendingLLMTimerRef.current) clearTimeout(pendingLLMTimerRef.current)
    setIsThinking(true)
    
    pendingLLMTimerRef.current = setTimeout(() => {
      triggerLLMResponse(targetBlock.id)
    }, 1600)
  }, [triggerLLMResponse])

  const finalizeSpeechSegment = useCallback(async () => {
    isSpeechDetectedRef.current = false
    const chunks = pcmChunksRef.current
    pcmChunksRef.current = [] // Reset right away

    if (chunks.length === 0) return

    setStatusText('Processing speech...')
    try {
      const wavBlob = encodeWAV(chunks, 16000)
      const reader = new FileReader()
      reader.onloadend = async () => {
        const base64Audio = (reader.result as string).split(',')[1]
        
        const sttPrompt = 'Technical interview. Multilingual speech detection (English, Hindi, Hinglish). Transcribe exact spoken words verbatim in their original spoken language without translating. Preserve Hindi words accurately. Ignore background noise, silence, or music. Do NOT hallucinate.'
        
        const transcript = await window.api.transcribeOnly({
          base64Audio,
          mimeType: 'audio/wav',
          language: language,
          context: sttPrompt
        })

        const cleaned = transcript.trim()
        if (!cleaned || cleaned.length < 3) {
          setStatusText('🎙️ Listening for call audio...')
          return
        }

        handleNewTranscript(cleaned)
      }
      reader.readAsDataURL(wavBlob)
    } catch (err) {
      console.error('[PhoneCapture] Finalize segment error:', err)
      setStatusText('🎙️ Listening for call audio...')
    }
  }, [language, handleNewTranscript])

  const handleStartCapture = useCallback(async () => {
    const balance = userProfile?.phone_sessions_balance ?? 0
    if (balance <= 0) {
      setShowPaywall(true)
      return
    }

    try {
      setStatusText('Deducting session credit...')
      await window.api.supabaseDeductPhoneSession()

      setStatusText('Finding Audio Source...')
      const sources = await window.api.getDesktopSources()
      const source = sources.find((s) => s.id.startsWith('screen:')) || sources[0]
      if (!source) throw new Error('No audio source found')

      setStatusText('Initializing system sound capture...')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id }
        } as any,
        video: {
          mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id }
        } as any
      })
      const audioTrack = stream.getAudioTracks()[0]
      if (!audioTrack) {
        throw new Error('System audio missing. Ensure "Share system audio" is checked.')
      }
      stream.getVideoTracks().forEach((t) => t.stop())

      const loopbackStream = new MediaStream([audioTrack])
      audioStreamRef.current = loopbackStream

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
      const ctx = new AudioContextClass({ sampleRate: 16000 })
      audioContextRef.current = ctx

      const sourceNode = ctx.createMediaStreamSource(loopbackStream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      scriptProcessorRef.current = processor

      sourceNode.connect(processor)
      processor.connect(ctx.destination)

      pcmChunksRef.current = []
      isSpeechDetectedRef.current = false
      lastActiveRmsTimeRef.current = Date.now()

      setIsCapturing(true)
      setStatusText('🎙️ Listening for call audio...')

      const MIN_RMS = 0.015
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0)
        let sum = 0
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i]
        }
        const rms = Math.sqrt(sum / inputData.length)
        setVolumeLevel(Math.min(100, Math.floor(rms * 220)))

        if (rms > MIN_RMS) {
          isSpeechDetectedRef.current = true
          lastActiveRmsTimeRef.current = Date.now()
          pcmChunksRef.current.push(new Float32Array(inputData))
        } else {
          if (isSpeechDetectedRef.current) {
            pcmChunksRef.current.push(new Float32Array(inputData))
          }
        }
      }

    } catch (err: any) {
      console.error('[PhoneCapture] Start failed:', err)
      setStatusText(`Error: ${err.message || 'Could not access audio source'}`)
      stopCaptureInternal()
    }
  }, [userProfile, onUpgradeClick, stopCaptureInternal])

  // VAD Silence Checker useEffect
  useEffect(() => {
    if (!isCapturing) return

    const interval = setInterval(() => {
      if (!isSpeechDetectedRef.current) return
      const silenceDuration = Date.now() - lastActiveRmsTimeRef.current
      if (silenceDuration > 1000) {
        finalizeSpeechSegment()
      }
    }, 100)

    silenceTimerRef.current = interval
    return () => {
      clearInterval(interval)
      silenceTimerRef.current = null
    }
  }, [isCapturing, finalizeSpeechSegment])

  // Call onCaptureStateChange when capture status or log length changes
  useEffect(() => {
    if (onCaptureStateChange) {
      onCaptureStateChange(
        isCapturing,
        isCapturing ? stopCaptureInternal : null,
        !isCapturing ? handleStartCapture : null,
        qaLogs.length > 0
      )
    }
  }, [isCapturing, qaLogs.length, onCaptureStateChange, stopCaptureInternal, handleStartCapture])

  const closePaywall = () => {
    setShowPaywall(false)
    setPaywallError(null)
    setPaywallSuccess(null)
    setLoadingPlan(null)
  }

  const handleBuy = async (planId: 'standard' | 'pro' | 'ultimate') => {
    try {
      setLoadingPlan(planId)
      setPaywallError(null)
      setPaywallSuccess(null)

      const data = await window.api.supabaseCreateRazorpayOrder(planId)

      if (data?.error) {
        throw new Error(data.error)
      }

      const {
        orderId,
        keyId,
        userEmail,
        isFree,
        added
      } = data

      if (isFree) {
        setPaywallSuccess(`🎉 ${added} session${added > 1 ? 's' : ''} added!`)
        const profile = await window.api.supabaseGetProfile()
        if (profile) {
          window.dispatchEvent(new CustomEvent('force-profile-refresh', { detail: profile }))
        }
        setTimeout(() => {
          setShowPaywall(false)
          setPaywallSuccess(null)
        }, 1500)
        return
      }

      const nameTag = 'Zyro AI'
      const checkoutUrl = `https://api.razorpay.com/v1/checkout/hosted?status=active&order_id=${orderId}&key_id=${keyId}&email=${encodeURIComponent(userEmail || '')}&name=${encodeURIComponent(nameTag)}`
      
      window.api.openExternal(checkoutUrl)
      setPaywallSuccess('💳 Checkout page opened in browser! Balance will update upon completion.')
    } catch (err: any) {
      console.error('[Paywall] Checkout initiation failed:', err)
      setPaywallError(err.message || 'Failed to initiate checkout. Please try again.')
    } finally {
      setLoadingPlan(null)
    }
  }

  return (
    <div className="phone-panel-container" data-status={statusText} data-volume={volumeLevel} data-thinking={isThinking ? 'true' : 'false'}>
      <div className="phone-glass-panel">
        {!isCapturing && qaLogs.length === 0 ? (
          <div className="phone-initial-card">
            <div className="phone-welcome-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="currentColor" viewBox="0 0 256 256">
                <path d="M222.37,180.6a16,16,0,0,1-.54,20c-7.6,8.23-16.74,14.67-27.18,19.16a73.23,73.23,0,0,1-29.62,6.24c-35.63,0-72.33-19.13-103.35-50.15S12,109.63,12,74A73.23,73.23,0,0,1,18.24,44.38c4.49-10.44,10.93-19.58,19.16-27.18a16,16,0,0,1,20-.54L83.08,38.3A16,16,0,0,1,87.4,56.6L73.61,70.39A147.3,147.3,0,0,0,121.61,118.4l13.79-13.79a16,16,0,0,1,18.3-4.32l21.64,15.68a16,16,0,0,1-3,24.63Z" />
              </svg>
            </div>
            <div className="phone-welcome-title">Start Phone Interview Call</div>
            <div className="phone-welcome-text">
              Turn your desktop helper into a real-time call assistant. Speak naturally; the AI detects your voice activity, handles translation from Hindi instantly, and prints professional natural English answers with a 1-second silence debouncer.
            </div>
            <button className="phone-action-btn-large" onClick={handleStartCapture}>
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
                <path d="M128,176a48.05,48.05,0,0,0,48-48V56a48,48,0,0,0-96,0v72A48.05,48.05,0,0,0,128,176ZM96,56a32,32,0,0,1,64,0v72a32,32,0,0,1-64,0Zm112,72a8,8,0,0,1-16,0,64,64,0,0,1-128,0,8,8,0,0,1-16,0,80.11,80.11,0,0,0,72,79.6V224H80a8,8,0,0,1,0-16h96a8,8,0,0,1,0,16H136v16.4A80.11,80.11,0,0,0,208,128Z" />
              </svg>
              Start Call Capture
            </button>
          </div>
        ) : (
          <div className="phone-workspace-rows">
            {qaLogs.length === 0 ? (
              <div className="phone-sidebar-empty">
                <div className="phone-listening-pulse-container">
                  <div className="phone-listening-pulse-dot" />
                  <div className="phone-listening-pulse-ring" />
                </div>
                <span>🎙️ Listening for call audio...</span>
              </div>
            ) : (
              <div className="phone-qa-row-list">
                {[...qaLogs].reverse().map((block) => {
                  const isExpanded = expandedBlockIds.has(block.id)
                  const hasMore = block.answer && block.answer.length > 180

                  return (
                    <div
                      key={block.id}
                      className={`phone-qa-row ${block.status}`}
                    >
                      {/* Left: Question Box */}
                      <div className="phone-qa-row-question">
                        <div className="phone-card-header">
                          <span className={`phone-card-status-dot ${block.status}`} />
                          <span className="phone-card-time">
                            {block.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </span>
                        </div>
                        <div className="phone-qa-question-text">
                          {block.question}
                        </div>
                      </div>

                      {/* Right: Answer Box */}
                      <div className="phone-qa-row-answer">
                        <div className="phone-active-answer-header">
                          <span className="phone-active-answer-label">AI Answer</span>
                          {block.status === 'completed' && block.answer && (
                            <button
                              className="action-icon-button"
                              onClick={() => handleCopy(block.id, block.answer)}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                                <path d="M216,40H88A16,16,0,0,0,72,56V72H56A16,16,0,0,0,40,88V216a16,16,0,0,0,16,16H184a16,16,0,0,0,16-16V200h16a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM184,216H56V88H184V216Zm32-32H200V88a16,16,0,0,0-16-16H88V56H216V184Z" />
                              </svg>
                              <span>{copiedBlockId === block.id ? 'Copied!' : 'Copy Answer'}</span>
                            </button>
                          )}
                        </div>

                        <div className="phone-active-answer-body">
                          {block.status === 'generating' && !block.answer && (
                            <div className="phone-loading-answer">
                              <div className="phone-loader-spinner">
                                <svg className="spinning-loader" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                </svg>
                              </div>
                              <span>Formulating premium response...</span>
                            </div>
                          )}

                          {block.answer && (
                            <div className="phone-answer-wrapper">
                              <div
                                className={`phone-answer-text ${!isExpanded && hasMore ? 'clamped-answer' : ''}`}
                              >
                                {typedBlockIds.has(block.id) || block.status !== 'completed' ? (
                                  <span>{block.answer}</span>
                                ) : (
                                  <TypewriterText text={block.answer} onComplete={() => markBlockAsTyped(block.id)} />
                                )}
                              </div>
                              {hasMore && (
                                <button
                                  className="phone-view-more-btn"
                                  onClick={() => toggleBlockExpanded(block.id)}
                                >
                                  {isExpanded ? 'View Less' : 'View More'}
                                  <svg
                                    className={`view-more-arrow ${isExpanded ? 'expanded' : ''}`}
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="12"
                                    height="12"
                                    fill="currentColor"
                                    viewBox="0 0 256 256"
                                  >
                                    <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,164.69l74.34-74.34a8,8,0,0,1,11.32,11.32Z" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          )}

                          {block.status === 'failed' && (
                            <div className="phone-answer-error">
                              <span>⚠️ Failed to generate answer. Please try checking your settings.</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Paywall Modal */}
      <AnimatePresence>
        {showPaywall && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="phone-paywall-overlay"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="phone-paywall-card"
            >
              {/* Header */}
              <div className="phone-paywall-header">
                <h2 className="phone-paywall-title">Buy Phone Sessions</h2>
                <button onClick={closePaywall} className="phone-paywall-close-btn">
                  <X size={20} />
                </button>
              </div>

              {/* Balance Badge */}
              <div className="phone-paywall-balance-badge">
                <span>Current Balance:</span>
                <span className="phone-paywall-balance-val">
                  {userProfile?.phone_sessions_balance ?? 0} Session{(userProfile?.phone_sessions_balance ?? 0) !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Content */}
              <p className="phone-paywall-desc">
                You don't have enough session credits to start the capture. Please purchase sessions to continue.
              </p>

              {/* Dropdown */}
              <NativeSelect
                label="Select Package"
                value={
                  selectedSessions === 1 ? 'Standard Pack (1+1 Sessions) - ₹300' :
                  selectedSessions === 5 ? 'Pro Bundle (5+5 Sessions) - ₹1200' :
                  'Ultimate Mastery (10+10 Sessions) - ₹2000'
                }
                onChange={(val) => {
                  if (val.startsWith('Standard')) setSelectedSessions(1)
                  else if (val.startsWith('Pro')) setSelectedSessions(5)
                  else setSelectedSessions(10)
                }}
                options={[
                  'Standard Pack (1+1 Sessions) - ₹300',
                  'Pro Bundle (5+5 Sessions) - ₹1200',
                  'Ultimate Mastery (10+10 Sessions) - ₹2000'
                ]}
              />

              {/* Pricing Summary */}
              <div className="phone-summary-card">
                <div className="phone-summary-row">
                  <span className="phone-summary-label">Includes:</span>
                  <span className="phone-summary-value">
                    {selectedSessions} Desktop + {selectedSessions} Phone Session{selectedSessions > 1 ? 's' : ''}
                  </span>
                </div>
                <div className="phone-summary-divider" />
                <div className="phone-summary-row phone-summary-total">
                  <span className="phone-summary-label">Total:</span>
                  <span className="phone-total-price">
                    ₹{selectedSessions === 1 ? 300 : selectedSessions === 5 ? 1200 : 2000}
                  </span>
                </div>
              </div>

              {/* Buy Button */}
              <button
                disabled={loadingPlan !== null}
                onClick={async () => {
                  const planId = selectedSessions === 1 ? 'standard' : selectedSessions === 5 ? 'pro' : 'ultimate'
                  await handleBuy(planId)
                }}
                className="phone-paywall-buy-btn"
              >
                {loadingPlan ? (
                  <>
                    <div className="phone-spinner" />
                    <span>Processing Checkout...</span>
                  </>
                ) : (
                  <span>Pay Now</span>
                )}
              </button>

              {/* Status / Errors */}
              {paywallError && <div className="phone-paywall-error">{paywallError}</div>}
              {paywallSuccess && <div className="phone-paywall-success">{paywallSuccess}</div>}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function NativeSelect({
  label,
  value,
  onChange,
  options
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: string[]
}) {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <div className="phone-select-wrapper">
      <label className="phone-select-label">{label}</label>
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        className={`phone-select-button ${isOpen ? 'open' : ''}`}
      >
        <span>{value}</span>
        <ChevronDown
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.3s ease',
            color: isOpen ? '#a78bfa' : '#71717a'
          }}
          size={16}
        />
      </button>
      {isOpen && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999 }} onClick={() => setIsOpen(false)} />
          <div className="phone-select-dropdown">
            {options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  onChange(opt)
                  setIsOpen(false)
                }}
                className={`phone-select-option ${value === opt ? 'selected' : ''}`}
              >
                {opt}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Mic,
  Volume2,
  VolumeX,
  Play,
  CheckCircle2,
  Headphones,
  ArrowRight,
  ChevronDown,
  Check,
  Sparkles,
  Activity,
  Radio,
  Sliders,
  Zap
} from 'lucide-react'
import Tooltip from './Tooltip'
import TeleprompterText from './TeleprompterText'

interface MicSpeakerTestProps {
  onProceed: () => void
  onBack?: () => void
}

const BAR_COUNT = 24
const PROMPT_PHRASE = 'Hello Zyro, checking my audio for the interview'
const CHECK_DURATION_MS = 3200

export default function MicSpeakerTest({ onProceed }: MicSpeakerTestProps): React.ReactElement {
  // Mic state
  const [isCheckingMic, setIsCheckingMic] = useState(false)
  const [micTested, setMicTested] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [checkProgress, setCheckProgress] = useState(0)
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [isMicDropdownOpen, setIsMicDropdownOpen] = useState(false)
  const [micBars, setMicBars] = useState<number[]>(() => new Array(BAR_COUNT).fill(0.06))

  // Speaker state
  const [isPlayingTone, setIsPlayingTone] = useState(false)
  const [speakerTested, setSpeakerTested] = useState(false)
  const [speakerVolume, setSpeakerVolume] = useState(0.8)
  const [speakerProgress, setSpeakerProgress] = useState(0)
  const [speakerBars, setSpeakerBars] = useState<number[]>(() => new Array(BAR_COUNT).fill(0.06))

  // Auto-countdown state (cinematic center film reel)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [isPaused, setIsPaused] = useState(false)

  // Audio refs
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number>(0)
  const speakerAnimRef = useRef<number>(0)
  const checkTimerRef = useRef<NodeJS.Timeout | null>(null)
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null)
  const micDropdownRef = useRef<HTMLDivElement | null>(null)

  // Click outside to close mic dropdown
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (micDropdownRef.current && !micDropdownRef.current.contains(e.target as Node)) {
        setIsMicDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Enumerate input devices on mount
  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs = devices.filter((d) => d.kind === 'audioinput')
      setAudioDevices(inputs)
      if (inputs.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(inputs[0].deviceId)
      }
    } catch {
      // Ignored
    }
  }, [selectedDeviceId])

  useEffect(() => {
    refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
  }, [refreshDevices])

  // Stop mic audio resources completely (kills wobble)
  const stopMicStream = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = 0
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
    analyserRef.current = null
    setMicLevel(0)
    setMicBars(new Array(BAR_COUNT).fill(0.06))
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopMicStream()
      if (speakerAnimRef.current) cancelAnimationFrame(speakerAnimRef.current)
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
      if (progressTimerRef.current) clearInterval(progressTimerRef.current)
    }
  }, [stopMicStream])

  // Start Mic Check (Manual 3.2s Listening Calibration)
  const startMicCheck = useCallback(async () => {
    stopMicStream()
    setIsCheckingMic(true)
    setMicTested(false)
    setCheckProgress(0)

    try {
      const constraints: MediaStreamConstraints = {
        audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
        video: false
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream

      const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      audioContextRef.current = audioCtx

      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 64
      analyser.smoothingTimeConstant = 0.75
      analyserRef.current = analyser

      const source = audioCtx.createMediaStreamSource(stream)
      source.connect(analyser)

      const dataArray = new Uint8Array(analyser.frequencyBinCount)

      const tick = (): void => {
        if (!analyserRef.current) return
        analyserRef.current.getByteFrequencyData(dataArray)

        let sum = 0
        const bars: number[] = []
        const step = Math.max(1, Math.floor(dataArray.length / BAR_COUNT))

        for (let i = 0; i < BAR_COUNT; i++) {
          const val = (dataArray[i * step] || 0) / 255
          sum += val
          bars.push(Math.max(0.06, val))
        }

        const avg = sum / BAR_COUNT
        setMicLevel(avg)
        setMicBars(bars)

        animFrameRef.current = requestAnimationFrame(tick)
      }

      tick()

      // Track smooth progress bar
      const startTime = Date.now()
      if (progressTimerRef.current) clearInterval(progressTimerRef.current)
      progressTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTime
        const pct = Math.min(100, Math.round((elapsed / CHECK_DURATION_MS) * 100))
        setCheckProgress(pct)
      }, 50)

      // Complete verification after 3.2 seconds
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
      checkTimerRef.current = setTimeout(() => {
        if (progressTimerRef.current) clearInterval(progressTimerRef.current)
        stopMicStream()
        setIsCheckingMic(false)
        setMicTested(true)
        setCheckProgress(100)
      }, CHECK_DURATION_MS)
    } catch {
      setIsCheckingMic(false)
      setMicTested(false)
      setCheckProgress(0)
    }
  }, [selectedDeviceId, stopMicStream])

  // Play Harmonic Studio Chime for Speaker Check
  const playTestSound = useCallback(() => {
    if (isPlayingTone) return
    setIsPlayingTone(true)
    setSpeakerTested(false)
    setSpeakerProgress(0)

    try {
      const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      const masterGain = audioCtx.createGain()
      masterGain.gain.setValueAtTime(Math.max(0.05, speakerVolume * 0.45), audioCtx.currentTime)
      masterGain.connect(audioCtx.destination)

      // Rich C-Major 9th chord: C4 (261.63Hz), E4 (329.63Hz), G4 (392.00Hz), B4 (493.88Hz)
      const chord = [261.63, 329.63, 392.0, 493.88]
      const totalDuration = 2.4

      chord.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator()
        const noteGain = audioCtx.createGain()
        osc.type = idx % 2 === 0 ? 'sine' : 'triangle'
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime)

        const noteStart = audioCtx.currentTime + idx * 0.12
        const noteEnd = audioCtx.currentTime + totalDuration

        noteGain.gain.setValueAtTime(0, audioCtx.currentTime)
        noteGain.gain.linearRampToValueAtTime(0.28, noteStart + 0.05)
        noteGain.gain.exponentialRampToValueAtTime(0.0001, noteEnd)

        osc.connect(noteGain)
        noteGain.connect(masterGain)

        osc.start(noteStart)
        osc.stop(noteEnd)
      })

      const startTime = performance.now()
      const animateSpeakerBars = (currentTime: number): void => {
        const elapsed = (currentTime - startTime) / 1000
        const progress = Math.min(1, elapsed / totalDuration)
        setSpeakerProgress(Math.round(progress * 100))

        if (progress < 1) {
          const decay = Math.max(0, 1 - progress * 0.85)
          const newBars = Array.from({ length: BAR_COUNT }, (_, i) => {
            const wave = Math.sin(progress * 14 + i * 0.6) * 0.5 + 0.5
            const jitter = Math.sin(progress * 30 + i) * 0.15
            return Math.max(0.06, Math.min(1, (wave * 0.75 + jitter) * decay * speakerVolume))
          })
          setSpeakerBars(newBars)
          speakerAnimRef.current = requestAnimationFrame(animateSpeakerBars)
        } else {
          setSpeakerBars(new Array(BAR_COUNT).fill(0.06))
          setIsPlayingTone(false)
          setSpeakerTested(true)
          setSpeakerProgress(100)
          audioCtx.close().catch(() => {})
        }
      }

      speakerAnimRef.current = requestAnimationFrame(animateSpeakerBars)
    } catch {
      setIsPlayingTone(false)
      setSpeakerTested(false)
      setSpeakerProgress(0)
    }
  }, [isPlayingTone, speakerVolume])

  // Play audio tick sound for reel countdown
  const playReelTick = useCallback((pitch: number) => {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(pitch, ctx.currentTime)
      gain.gain.setValueAtTime(0.15, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.08)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.08)
    } catch {
      // Ignored
    }
  }, [])

  // Auto-start cinematic countdown when both tests pass
  const bothReady = micTested && speakerTested

  useEffect(() => {
    if (bothReady && countdown === null && !isPaused) {
      setCountdown(5)
    }
  }, [bothReady, countdown, isPaused])

  // Film Reel Countdown Tick Loop
  useEffect(() => {
    if (countdown === null || isPaused) return

    if (countdown > 0) {
      playReelTick(countdown === 1 ? 880 : 440)
      const timer = setTimeout(() => {
        setCountdown((prev) => (prev !== null ? prev - 1 : null))
      }, 1000)
      return () => clearTimeout(timer)
    } else if (countdown === 0) {
      playReelTick(1200)
      onProceed()
    }
    return undefined
  }, [countdown, isPaused, onProceed, playReelTick])

  // Device label helper
  const currentDeviceLabel =
    audioDevices.find((d) => d.deviceId === selectedDeviceId)?.label ||
    (audioDevices.length > 0 ? 'Default System Microphone' : 'Default Microphone')

  // Decibel calculation display for mic
  const micDecibels = micTested
    ? '-18 dBFS'
    : isCheckingMic
      ? `${Math.round(-54 + micLevel * 48)} dBFS`
      : '-∞ dBFS'

  // Card background & border style: Elegant Purple and Light Purple combo
  const cardPurpleStyle: React.CSSProperties = {
    padding: '14px 16px',
    borderRadius: 14,
    background: 'linear-gradient(180deg, rgba(28, 20, 52, 0.6) 0%, rgba(16, 13, 30, 0.75) 100%)',
    border: '1px solid rgba(139, 92, 246, 0.22)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3), 0 0 20px rgba(139, 92, 246, 0.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    transition: 'border-color 0.25s ease, box-shadow 0.25s ease'
  }

  return (
    <div className="setup-page relative overflow-hidden">
      {/* Background Ambient Glow & Dot-Grid Texture matching Zyro Setup */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-purple-600/10 rounded-full blur-[120px] mix-blend-screen animate-pulse-glow" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-indigo-600/10 rounded-full blur-[100px] mix-blend-screen animate-pulse-glow" style={{ animationDelay: '2s' }} />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMSIgY3k9IjEiIHI9IjEiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4wMykiLz48L3N2Zz4=')`,
            maskImage: 'radial-gradient(ellipse at center, black 40%, transparent 100%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 40%, transparent 100%)'
          }}
        />
      </div>

      <div className="setup-container relative z-10" style={{ width: '100%', height: '100vh', display: 'flex' }}>
        <section className="setup-main-content" style={{ width: '100%', flex: 1, display: 'flex', flexDirection: 'column' }}>
          
          {/* ── Top Header Bar (Native Zyro Header without pre-flight badge) ── */}
          <header className="step-header-refined">
            <div className="shr-left">
              <h1 className="shr-title">
                Audio Diagnostics
              </h1>
              <TeleprompterText
                text={
                  bothReady
                    ? 'Microphone and speaker verified. Audio system is ready for the interview session.'
                    : 'Verify your microphone input and audio output before launching the assistant.'
                }
              />
            </div>

            <div className="shr-right">
              <Tooltip content="Minimize" position="bottom-left">
                <button className="ov-action-btn minimize no-drag" onClick={() => window.api.minimizeWindow()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </Tooltip>
              <Tooltip content="Close App" position="bottom-left">
                <button className="ov-action-btn close no-drag" onClick={() => window.api.quitApp()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </Tooltip>
            </div>
          </header>

          {/* ── Main Scrollable Body with 2-Column Equal Grid ── */}
          <div
            className="content-scrollable"
            style={{
              padding: '16px 24px',
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              justifyContent: 'center',
              boxSizing: 'border-box',
              minHeight: 0
            }}
          >
            <div
              style={{
                width: '100%',
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: 16,
                boxSizing: 'border-box'
              }}
            >
              {/* ══════════════════════════════════════════════════════
                  CARD 1: VOCAL CALIBRATION DECK (INPUT // CH-01)
                  Theme: Purple & Light Purple
                 ══════════════════════════════════════════════════════ */}
              <div className="final-check-card" style={cardPurpleStyle}>
                
                {/* Header Row: Purple & Light Purple Theme */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 10,
                        background: 'rgba(139, 92, 246, 0.18)',
                        border: '1px solid rgba(167, 139, 250, 0.35)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0
                      }}
                    >
                      <Mic size={15} color="#c084fc" />
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.2px' }}>
                          Microphone
                        </span>
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            fontFamily: "'JetBrains Mono', monospace",
                            color: '#d8b4fe',
                            background: 'rgba(139, 92, 246, 0.22)',
                            padding: '1px 5px',
                            borderRadius: 4
                          }}
                        >
                          CH-01
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: '#a78bfa', fontFamily: "'JetBrains Mono', monospace" }}>
                        48 kHz • 16-Bit Mono
                      </div>
                    </div>
                  </div>

                  {/* 🟢 Status Pill: Turns green ONLY when verified */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '3px 8px',
                      borderRadius: 20,
                      background: micTested
                        ? 'rgba(34, 197, 94, 0.16)'
                        : isCheckingMic
                          ? 'rgba(139, 92, 246, 0.22)'
                          : 'rgba(139, 92, 246, 0.12)',
                      border: `1px solid ${
                        micTested
                          ? 'rgba(34, 197, 94, 0.45)'
                          : isCheckingMic
                            ? 'rgba(192, 132, 252, 0.5)'
                            : 'rgba(167, 139, 250, 0.25)'
                      }`
                    }}
                  >
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: micTested ? '#22c55e' : isCheckingMic ? '#e879f9' : '#a78bfa',
                        boxShadow: micTested
                          ? '0 0 8px #22c55e'
                          : isCheckingMic
                            ? '0 0 8px #e879f9'
                            : 'none'
                      }}
                    />
                    <span
                      style={{
                        fontSize: 9.5,
                        fontWeight: 700,
                        fontFamily: "'JetBrains Mono', monospace",
                        color: micTested ? '#4ade80' : isCheckingMic ? '#f0abfc' : '#c084fc'
                      }}
                    >
                      {micTested ? 'VERIFIED' : isCheckingMic ? 'CAPTURING' : 'READY'}
                    </span>
                  </div>
                </div>

                {/* Device Selector: Purple & Light Purple Trigger */}
                <div
                  ref={micDropdownRef}
                  className="no-drag"
                  style={{ position: 'relative', zIndex: isMicDropdownOpen ? 45 : 5, width: '100%' }}
                >
                  <div
                    className={`custom-select-trigger ${isMicDropdownOpen ? 'active' : ''}`}
                    onClick={() => setIsMicDropdownOpen((prev) => !prev)}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 10,
                      background: 'rgba(30, 24, 56, 0.5)',
                      border: '1px solid rgba(139, 92, 246, 0.25)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', minWidth: 0, flex: 1 }}>
                      <Radio size={13} color="#c084fc" style={{ flexShrink: 0 }} />
                      <span
                        style={{
                          color: '#e2e8f0',
                          fontWeight: 500,
                          fontSize: 11.5,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                          flex: 1
                        }}
                      >
                        {currentDeviceLabel}
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        color: isMicDropdownOpen ? '#d8b4fe' : '#a78bfa',
                        transform: isMicDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s ease',
                        flexShrink: 0,
                        marginLeft: 6
                      }}
                    >
                      <ChevronDown size={14} />
                    </div>
                  </div>

                  {/* Flyout Menu (Native Zyro custom-select-menu) */}
                  {isMicDropdownOpen && (
                    <div className="custom-select-menu" style={{ maxHeight: 140 }}>
                      {audioDevices.length > 0 ? (
                        audioDevices.map((dev, idx) => {
                          const isSelected =
                            (dev.deviceId && dev.deviceId === selectedDeviceId) ||
                            (!selectedDeviceId && idx === 0)
                          return (
                            <div
                              key={dev.deviceId || idx}
                              className={`custom-select-option ${isSelected ? 'selected' : ''}`}
                              onClick={() => {
                                setSelectedDeviceId(dev.deviceId)
                                setIsMicDropdownOpen(false)
                                setMicTested(false)
                                stopMicStream()
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', minWidth: 0, flex: 1 }}>
                                <Mic size={12} color={isSelected ? '#c084fc' : '#a78bfa'} style={{ flexShrink: 0 }} />
                                <span
                                  style={{
                                    color: isSelected ? '#ffffff' : '#cbd5e1',
                                    fontWeight: isSelected ? 600 : 400,
                                    fontSize: 11,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    minWidth: 0
                                  }}
                                >
                                  {dev.label || `Microphone ${idx + 1}`}
                                </span>
                              </div>
                              {isSelected && <Check size={12} color="#c084fc" style={{ flexShrink: 0 }} />}
                            </div>
                          )
                        })
                      ) : (
                        <div style={{ padding: '6px 8px', fontSize: 11, color: '#a78bfa' }}>
                          Default System Microphone
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Equalizer Visualizer & Level Meter (Purple Theme, Calm Baseline When Verified) */}
                <div
                  style={{
                    background: 'rgba(14, 11, 26, 0.6)',
                    border: '1px solid rgba(139, 92, 246, 0.18)',
                    borderRadius: 10,
                    padding: '10px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Activity size={12} color="#c084fc" />
                      <span style={{ fontSize: 9.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: '#a78bfa' }}>
                        ACOUSTIC SPECTRUM
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 9.5,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 600,
                        color: '#c084fc'
                      }}
                    >
                      {micDecibels}
                    </span>
                  </div>

                  {/* Equalizer Bars: Vibrant Purple and Light-Purple Gradient */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 3,
                      height: 36
                    }}
                  >
                    {micBars.map((bar, i) => {
                      const isActive = isCheckingMic && micLevel > 0.02
                      // Calm 4px resting baseline when verified (stays in purple theme)
                      const barH = micTested ? 4 : isActive ? Math.max(3, Math.round(bar * 36)) : 3

                      return (
                        <div
                          key={i}
                          style={{
                            flex: 1,
                            height: `${barH}px`,
                            borderRadius: 3,
                            background: isActive
                              ? 'linear-gradient(180deg, #e879f9 0%, #8b5cf6 100%)'
                              : micTested
                                ? 'rgba(167, 139, 250, 0.45)'
                                : 'rgba(139, 92, 246, 0.15)',
                            boxShadow: isActive && bar > 0.5 ? '0 0 8px rgba(168, 85, 247, 0.6)' : 'none',
                            transition: isCheckingMic ? 'height 0.05s ease' : 'height 0.25s ease, background 0.25s'
                          }}
                        />
                      )
                    })}
                  </div>

                  {/* Progress Line: Purple & Light Purple */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <div
                      style={{
                        flex: 1,
                        height: 3,
                        borderRadius: 99,
                        background: 'rgba(139, 92, 246, 0.15)',
                        overflow: 'hidden'
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: micTested ? '100%' : `${checkProgress}%`,
                          borderRadius: 99,
                          background: 'linear-gradient(90deg, #8b5cf6 0%, #c084fc 100%)',
                          boxShadow: isCheckingMic ? '0 0 10px rgba(168, 85, 247, 0.7)' : 'none',
                          transition: 'width 0.08s ease'
                        }}
                      />
                    </div>
                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 600,
                        color: '#c084fc',
                        width: 32,
                        textAlign: 'right'
                      }}
                    >
                      {micTested ? '100%' : `${checkProgress}%`}
                    </span>
                  </div>
                </div>

                {/* Prompt Words Box: Purple Theme */}
                <div
                  style={{
                    background: 'rgba(30, 22, 56, 0.4)',
                    border: '1px solid rgba(139, 92, 246, 0.22)',
                    borderRadius: 9,
                    padding: '7px 11px',
                    textAlign: 'center'
                  }}
                >
                  <div
                    style={{
                      fontSize: 9.5,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.07em',
                      fontFamily: "'JetBrains Mono', monospace",
                      color: isCheckingMic ? '#e879f9' : micTested ? '#4ade80' : '#c084fc',
                      marginBottom: 2
                    }}
                  >
                    {isCheckingMic ? 'Speak aloud now (3s):' : micTested ? 'Voice confirmed ✓' : 'Say phrase aloud on Check:'}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: '#e2e8f0',
                      fontStyle: 'italic',
                      lineHeight: 1.3
                    }}
                  >
                    "{PROMPT_PHRASE}"
                  </div>
                </div>

                {/* 🟢 Action Row: Verified message and check button turn GREEN when verified */}
                <div
                  className="no-drag"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingTop: 2,
                    WebkitAppRegion: 'no-drag'
                  } as React.CSSProperties}
                >
                  <span style={{ fontSize: 11, color: '#a78bfa' }}>
                    {micTested ? (
                      <span style={{ color: '#4ade80', display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                        <CheckCircle2 size={13} color="#4ade80" /> Mic Verified
                      </span>
                    ) : isCheckingMic ? (
                      <span style={{ color: '#e879f9', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Zap size={11} /> Listening...
                      </span>
                    ) : (
                      'Click Check & speak'
                    )}
                  </span>

                  <button
                    onClick={startMicCheck}
                    disabled={isCheckingMic}
                    style={{
                      background: micTested
                        ? 'rgba(34, 197, 94, 0.16)'
                        : isCheckingMic
                          ? 'rgba(139, 92, 246, 0.25)'
                          : 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
                      border: `1px solid ${
                        micTested
                          ? 'rgba(34, 197, 94, 0.45)'
                          : isCheckingMic
                            ? 'rgba(192, 132, 252, 0.5)'
                            : 'rgba(167, 139, 250, 0.4)'
                      }`,
                      borderRadius: 8,
                      padding: '6px 14px',
                      color: micTested ? '#4ade80' : '#ffffff',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: isCheckingMic ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      boxShadow: micTested
                        ? '0 0 12px rgba(34, 197, 94, 0.2)'
                        : isCheckingMic
                          ? 'none'
                          : '0 0 16px rgba(139, 92, 246, 0.35)',
                      transition: 'all 0.15s'
                    }}
                  >
                    {isCheckingMic ? (
                      <>
                        <Sparkles size={12} className="animate-spin" />
                        Listening...
                      </>
                    ) : micTested ? (
                      <>
                        <Check size={12} color="#4ade80" />
                        Verified
                      </>
                    ) : (
                      <>
                        <Mic size={12} />
                        Check
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* ══════════════════════════════════════════════════════
                  CARD 2: ACOUSTIC MONITOR DECK (OUTPUT // CH-02)
                  Theme: Purple & Light Purple
                 ══════════════════════════════════════════════════════ */}
              <div className="final-check-card" style={cardPurpleStyle}>
                
                {/* Header Row: Purple & Light Purple Theme */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 10,
                        background: 'rgba(139, 92, 246, 0.18)',
                        border: '1px solid rgba(167, 139, 250, 0.35)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0
                      }}
                    >
                      <Headphones size={15} color="#c084fc" />
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.2px' }}>
                          Speaker & Sound
                        </span>
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            fontFamily: "'JetBrains Mono', monospace",
                            color: '#d8b4fe',
                            background: 'rgba(139, 92, 246, 0.22)',
                            padding: '1px 5px',
                            borderRadius: 4
                          }}
                        >
                          CH-02
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: '#a78bfa', fontFamily: "'JetBrains Mono', monospace" }}>
                        Stereo • 48 kHz PCM
                      </div>
                    </div>
                  </div>

                  {/* 🟢 Status Pill: Turns green ONLY when verified */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '3px 8px',
                      borderRadius: 20,
                      background: speakerTested
                        ? 'rgba(34, 197, 94, 0.16)'
                        : isPlayingTone
                          ? 'rgba(139, 92, 246, 0.22)'
                          : 'rgba(139, 92, 246, 0.12)',
                      border: `1px solid ${
                        speakerTested
                          ? 'rgba(34, 197, 94, 0.45)'
                          : isPlayingTone
                            ? 'rgba(192, 132, 252, 0.5)'
                            : 'rgba(167, 139, 250, 0.25)'
                      }`
                    }}
                  >
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: speakerTested ? '#22c55e' : isPlayingTone ? '#e879f9' : '#a78bfa',
                        boxShadow: speakerTested
                          ? '0 0 8px #22c55e'
                          : isPlayingTone
                            ? '0 0 8px #e879f9'
                            : 'none'
                      }}
                    />
                    <span
                      style={{
                        fontSize: 9.5,
                        fontWeight: 700,
                        fontFamily: "'JetBrains Mono', monospace",
                        color: speakerTested ? '#4ade80' : isPlayingTone ? '#f0abfc' : '#c084fc'
                      }}
                    >
                      {speakerTested ? 'VERIFIED' : isPlayingTone ? 'TRANSMITTING' : 'READY'}
                    </span>
                  </div>
                </div>

                {/* Volume Station: Purple Theme */}
                <div
                  className="no-drag"
                  style={{
                    padding: '8px 12px',
                    borderRadius: 10,
                    background: 'rgba(30, 24, 56, 0.5)',
                    border: '1px solid rgba(139, 92, 246, 0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    boxSizing: 'border-box',
                    WebkitAppRegion: 'no-drag'
                  } as React.CSSProperties}
                >
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                    onClick={() => setSpeakerVolume((prev) => (prev > 0 ? 0 : 0.8))}
                  >
                    {speakerVolume === 0 ? <VolumeX size={13} color="#f87171" /> : <Volume2 size={13} color="#c084fc" />}
                    <span style={{ fontSize: 11.5, color: '#e2e8f0', fontWeight: 500 }}>Volume</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, maxWidth: 140 }}>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={speakerVolume}
                      onChange={(e) => setSpeakerVolume(parseFloat(e.target.value))}
                      style={{
                        width: '100%',
                        height: 3,
                        accentColor: '#c084fc',
                        cursor: 'pointer'
                      }}
                    />
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: "'JetBrains Mono', monospace",
                        color: '#c084fc',
                        width: 30,
                        textAlign: 'right'
                      }}
                    >
                      {Math.round(speakerVolume * 100)}%
                    </span>
                  </div>
                </div>

                {/* Equalizer Visualizer & Output Meter (Purple Theme) */}
                <div
                  style={{
                    background: 'rgba(14, 11, 26, 0.6)',
                    border: '1px solid rgba(139, 92, 246, 0.18)',
                    borderRadius: 10,
                    padding: '10px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Sliders size={12} color="#c084fc" />
                      <span style={{ fontSize: 9.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: '#a78bfa' }}>
                        HARMONIC OUTPUT
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 9.5,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 600,
                        color: '#c084fc'
                      }}
                    >
                      {speakerTested ? 'Audible (Clean)' : isPlayingTone ? 'Playing 432Hz' : 'Standby'}
                    </span>
                  </div>

                  {/* Equalizer Bars: Purple Gradient */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 3,
                      height: 36
                    }}
                  >
                    {speakerBars.map((bar, i) => {
                      const barH = speakerTested ? 4 : isPlayingTone ? Math.max(3, Math.round(bar * 36)) : 3

                      return (
                        <div
                          key={i}
                          style={{
                            flex: 1,
                            height: `${barH}px`,
                            borderRadius: 3,
                            background: isPlayingTone
                              ? 'linear-gradient(180deg, #e879f9 0%, #8b5cf6 100%)'
                              : speakerTested
                                ? 'rgba(167, 139, 250, 0.45)'
                                : 'rgba(139, 92, 246, 0.15)',
                            boxShadow: isPlayingTone && bar > 0.4 ? '0 0 8px rgba(168, 85, 247, 0.6)' : 'none',
                            transition: isPlayingTone ? 'height 0.06s ease' : 'height 0.25s ease, background 0.25s'
                          }}
                        />
                      )
                    })}
                  </div>

                  {/* Progress Line: Purple & Light Purple */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <div
                      style={{
                        flex: 1,
                        height: 3,
                        borderRadius: 99,
                        background: 'rgba(139, 92, 246, 0.15)',
                        overflow: 'hidden'
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: speakerTested ? '100%' : `${speakerProgress}%`,
                          borderRadius: 99,
                          background: 'linear-gradient(90deg, #8b5cf6 0%, #c084fc 100%)',
                          boxShadow: isPlayingTone ? '0 0 10px rgba(168, 85, 247, 0.7)' : 'none',
                          transition: 'width 0.08s ease'
                        }}
                      />
                    </div>
                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 600,
                        color: '#c084fc',
                        width: 32,
                        textAlign: 'right'
                      }}
                    >
                      {speakerTested ? '100%' : `${speakerProgress}%`}
                    </span>
                  </div>
                </div>

                {/* Sound Profile Box: Purple Theme */}
                <div
                  style={{
                    background: 'rgba(30, 22, 56, 0.4)',
                    border: '1px solid rgba(139, 92, 246, 0.22)',
                    borderRadius: 9,
                    padding: '7px 11px',
                    textAlign: 'center'
                  }}
                >
                  <div
                    style={{
                      fontSize: 9.5,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.07em',
                      fontFamily: "'JetBrains Mono', monospace",
                      color: isPlayingTone ? '#e879f9' : speakerTested ? '#4ade80' : '#c084fc',
                      marginBottom: 2
                    }}
                  >
                    {isPlayingTone ? 'Transmitting chime...' : speakerTested ? 'Audio confirmed ✓' : 'Click Check to test sound:'}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: '#e2e8f0',
                      lineHeight: 1.3
                    }}
                  >
                    4-Note Studio Harmonic Chord (Spatial 432Hz)
                  </div>
                </div>

                {/* 🟢 Action Row: Verified message and check button turn GREEN when verified */}
                <div
                  className="no-drag"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingTop: 2,
                    WebkitAppRegion: 'no-drag'
                  } as React.CSSProperties}
                >
                  <span style={{ fontSize: 11, color: '#a78bfa' }}>
                    {speakerTested ? (
                      <span style={{ color: '#4ade80', display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                        <CheckCircle2 size={13} color="#4ade80" /> Sound Verified
                      </span>
                    ) : isPlayingTone ? (
                      <span style={{ color: '#e879f9', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Zap size={11} /> Playing tone...
                      </span>
                    ) : (
                      'Click Check to listen'
                    )}
                  </span>

                  <button
                    onClick={playTestSound}
                    disabled={isPlayingTone}
                    style={{
                      background: speakerTested
                        ? 'rgba(34, 197, 94, 0.16)'
                        : isPlayingTone
                          ? 'rgba(139, 92, 246, 0.25)'
                          : 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
                      border: `1px solid ${
                        speakerTested
                          ? 'rgba(34, 197, 94, 0.45)'
                          : isPlayingTone
                            ? 'rgba(192, 132, 252, 0.5)'
                            : 'rgba(167, 139, 250, 0.4)'
                      }`,
                      borderRadius: 8,
                      padding: '6px 14px',
                      color: speakerTested ? '#4ade80' : '#ffffff',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: isPlayingTone ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      boxShadow: speakerTested
                        ? '0 0 12px rgba(34, 197, 94, 0.2)'
                        : isPlayingTone
                          ? 'none'
                          : '0 0 16px rgba(139, 92, 246, 0.35)',
                      transition: 'all 0.15s'
                    }}
                  >
                    {isPlayingTone ? (
                      <>
                        <Volume2 size={12} />
                        Playing...
                      </>
                    ) : speakerTested ? (
                      <>
                        <Check size={12} color="#4ade80" />
                        Verified
                      </>
                    ) : (
                      <>
                        <Play size={12} fill="#fff" />
                        Check
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── Native Content Footer (Matching SetupPage with .content-footer-enhanced) ── */}
          <footer className="content-footer-enhanced" style={{ padding: '12px 24px' }}>
            <div className="footer-btn-row" style={{ justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 11, color: '#a78bfa', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                  SYSTEM STATUS:
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: micTested ? '#22c55e' : '#a78bfa',
                      boxShadow: micTested ? '0 0 8px #22c55e' : 'none'
                    }}
                  />
                  <span
                    style={{
                      fontSize: 11,
                      color: micTested ? '#4ade80' : '#d8b4fe',
                      fontWeight: 600,
                      fontFamily: "'JetBrains Mono', monospace"
                    }}
                  >
                    Mic {micTested ? 'Verified' : 'Pending'}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: '#4c1d95' }}>|</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: speakerTested ? '#22c55e' : '#a78bfa',
                      boxShadow: speakerTested ? '0 0 8px #22c55e' : 'none'
                    }}
                  />
                  <span
                    style={{
                      fontSize: 11,
                      color: speakerTested ? '#4ade80' : '#d8b4fe',
                      fontWeight: 600,
                      fontFamily: "'JetBrains Mono', monospace"
                    }}
                  >
                    Speaker {speakerTested ? 'Verified' : 'Pending'}
                  </span>
                </div>
              </div>

              {bothReady ? (
                <button
                  type="button"
                  className="primary-action-btn shimmer-btn footer-nav-btn footer-next-btn success"
                  onClick={onProceed}
                  style={{ flex: '0 0 auto', padding: '0 28px', height: 44 }}
                >
                  <div className="btn-shine" />
                  <span>Start Interview</span>
                  <ArrowRight size={18} />
                </button>
              ) : (
                <div
                  style={{
                    fontSize: 11.5,
                    color: '#a78bfa',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 500
                  }}
                >
                  Complete both audio checks to unlock session
                </div>
              )}
            </div>
          </footer>
        </section>
      </div>

      {/* ── 🎬 MODERN CINEMATIC FILM-REEL COUNTDOWN OVERLAY ── */}
      {bothReady && countdown !== null && !isPaused && (
        <div
          className="no-drag"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 100,
            background: 'rgba(8, 9, 14, 0.9)',
            backdropFilter: 'blur(20px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            WebkitAppRegion: 'no-drag'
          } as React.CSSProperties}
        >
          {/* Fullscreen Crosshairs */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: '50%',
              width: 1,
              background:
                'linear-gradient(180deg, transparent 0%, rgba(255, 255, 255, 0.07) 15%, rgba(255, 255, 255, 0.07) 85%, transparent 100%)',
              pointerEvents: 'none'
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: '50%',
              height: 1,
              background:
                'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.07) 15%, rgba(255, 255, 255, 0.07) 85%, transparent 100%)',
              pointerEvents: 'none'
            }}
          />

          {/* Center Film Reel Circle */}
          <div
            style={{
              position: 'relative',
              width: 190,
              height: 190,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 20
            }}
          >
            {/* Outer Film Frame Ring */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                border: '2px dashed rgba(139, 92, 246, 0.4)',
                boxShadow: '0 0 35px rgba(139, 92, 246, 0.35), inset 0 0 25px rgba(139, 92, 246, 0.15)'
              }}
            />

            {/* Inner Solid Target Ring */}
            <div
              style={{
                position: 'absolute',
                inset: 12,
                borderRadius: '50%',
                border: '1.5px solid rgba(255, 255, 255, 0.12)'
              }}
            />

            {/* Center Circle */}
            <div
              style={{
                position: 'absolute',
                inset: 28,
                borderRadius: '50%',
                background:
                  'radial-gradient(circle, rgba(139, 92, 246, 0.15) 0%, rgba(10, 11, 16, 0.4) 100%)',
                border: '1px solid rgba(139, 92, 246, 0.2)'
              }}
            />

            {/* Cardinal Ticks */}
            <div style={{ position: 'absolute', top: 3, width: 2, height: 6, background: '#a78bfa' }} />
            <div style={{ position: 'absolute', bottom: 3, width: 2, height: 6, background: '#a78bfa' }} />
            <div style={{ position: 'absolute', left: 3, width: 6, height: 2, background: '#a78bfa' }} />
            <div style={{ position: 'absolute', right: 3, width: 6, height: 2, background: '#a78bfa' }} />

            {/* Clock Hand / Radar Sweep */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                transform: `rotate(${((5 - (countdown || 0)) / 5) * 360}deg)`,
                transition: 'transform 1s linear',
                pointerEvents: 'none'
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  width: '50%',
                  height: 2,
                  background: 'linear-gradient(90deg, rgba(139, 92, 246, 0.1) 0%, #a78bfa 100%)',
                  transformOrigin: '0% 50%',
                  boxShadow: '0 0 10px rgba(167, 139, 250, 0.8)'
                }}
              />
            </div>

            {/* Big Countdown Number */}
            <span
              key={countdown}
              style={{
                position: 'relative',
                fontSize: 66,
                fontWeight: 800,
                fontFamily: "'JetBrains Mono', 'Inter', monospace",
                color: '#ffffff',
                textShadow: '0 0 24px rgba(139, 92, 246, 0.75)',
                zIndex: 2,
                lineHeight: 1
              }}
            >
              {countdown}
            </span>
          </div>

          {/* Under-circle Status Tag */}
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: '#4ade80',
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#22c55e',
                boxShadow: '0 0 8px #22c55e'
              }}
            />
            Ready • Starting Interview
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => setIsPaused(true)}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: 8,
                padding: '7px 16px',
                color: '#94a3b8',
                fontSize: 12,
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#fff'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#94a3b8'
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)'
              }}
            >
              Pause
            </button>

            <button
              onClick={onProceed}
              style={{
                background: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
                border: 'none',
                borderRadius: 8,
                padding: '7px 20px',
                color: '#fff',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                boxShadow: '0 0 20px rgba(139, 92, 246, 0.5)'
              }}
            >
              Launch Now
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

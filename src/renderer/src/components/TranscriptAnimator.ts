/**
 * TranscriptAnimator - Real-time transcript animation with right-to-left word slides
 * Similar to ParakeetAI style
 */

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface TranscriptWord {
  element: HTMLSpanElement
  index: number
  timestamp: number
}

type TranscriptCallback = (text: string, isFinal: boolean) => void

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionResultList {
  length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionResult {
  isFinal: boolean
  length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: ((this: SpeechRecognition, ev: Event) => any) | null
  onend: ((this: SpeechRecognition, ev: Event) => any) | null
  onerror: ((this: SpeechRecognition, ev: Event) => any) | null
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => any) | null
  start(): void
  stop(): void
  abort(): void
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition
    webkitSpeechRecognition: new () => SpeechRecognition
  }
}

interface WebSocketMessage {
  type: string
  text: string
  isFinal: boolean
}

// ============================================================================
// TRANSCRIPT ANIMATOR CLASS
// ============================================================================

export class TranscriptAnimator {
  private container: HTMLElement
  private cursor: HTMLElement
  private words: TranscriptWord[] = []
  private wordIndex = 0

  constructor(containerSelector: string) {
    const container = document.querySelector(containerSelector)
    if (!container) {
      throw new Error(`Container not found: ${containerSelector}`)
    }
    this.container = container as HTMLElement

    // Find or create cursor
    let cursor = this.container.querySelector('.transcript-cursor') as HTMLElement
    if (!cursor) {
      cursor = document.createElement('span')
      cursor.className = 'transcript-cursor'
      cursor.textContent = '|'
      this.container.appendChild(cursor)
    }
    this.cursor = cursor
  }

  /**
   * Animate an entire sentence by splitting into words and animating each
   */
  async animateSentence(text: string): Promise<void> {
    const words = text
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0)

    for (const word of words) {
      await this.addWord(word)
      // 60ms delay between words
      await this.delay(60)
    }
  }

  /**
   * Add a single word with slide-in animation from right
   */
  async addWord(word: string): Promise<void> {
    // Create word span
    const span = document.createElement('span')
    span.className = 'transcript-word latest'
    span.textContent = word
    span.style.opacity = '0'
    span.style.transform = 'translateX(40px)'

    // Insert before cursor
    this.container.insertBefore(span, this.cursor)

    // Force reflow to ensure initial state is applied
    span.offsetHeight

    // Trigger animation
    requestAnimationFrame(() => {
      span.style.transition = 'all 0.35s cubic-bezier(0.22, 0.61, 0.36, 1)'
      span.style.opacity = '1'
      span.style.transform = 'translateX(0)'
    })

    // Update previous word classes
    if (this.words.length > 0) {
      const prevWord = this.words[this.words.length - 1]
      prevWord.element.classList.remove('latest')
      prevWord.element.classList.add('previous')
    }

    // Mark words older than 12 tokens as "old"
    if (this.words.length >= 12) {
      const oldWord = this.words[this.words.length - 12]
      oldWord.element.classList.remove('previous')
      oldWord.element.classList.add('old')
    }

    // Store word reference
    this.words.push({
      element: span,
      index: this.wordIndex++,
      timestamp: Date.now()
    })

    // Wait for animation to complete
    await this.delay(350)
  }

  /**
   * Clear all words from the transcript
   */
  clear(): void {
    this.words.forEach((word) => {
      if (word.element.parentNode) {
        word.element.parentNode.removeChild(word.element)
      }
    })
    this.words = []
    this.wordIndex = 0
  }

  /**
   * Get current transcript text
   */
  getText(): string {
    return this.words.map((w) => w.element.textContent).join(' ')
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// ============================================================================
// AUDIO TRANSCRIPTION MANAGER (Web Speech API)
// ============================================================================

export class AudioTranscriptionManager {
  private recognition: SpeechRecognition | null = null
  private isListening = false
  private shouldRestart = false
  private callbacks: TranscriptCallback[] = []
  private indicator: HTMLElement | null = null

  constructor(indicatorSelector?: string) {
    // Check if browser supports Speech Recognition
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognitionAPI) {
      console.error('Speech Recognition API not supported in this browser')
      return
    }

    this.recognition = new SpeechRecognitionAPI()
    this.recognition.continuous = true
    this.recognition.interimResults = true
    this.recognition.lang = 'en-US'

    // Setup event handlers
    this.setupRecognitionHandlers()

    // Find listening indicator
    if (indicatorSelector) {
      this.indicator = document.querySelector(indicatorSelector)
    }
  }

  private setupRecognitionHandlers(): void {
    if (!this.recognition) return

    this.recognition.onstart = () => {
      console.log('[AudioTranscription] Recognition started')
      this.showIndicator()
    }

    this.recognition.onend = () => {
      console.log('[AudioTranscription] Recognition ended')

      // Auto-restart if still supposed to be listening (Chrome timeout workaround)
      if (this.shouldRestart && this.isListening) {
        console.log('[AudioTranscription] Auto-restarting recognition')
        setTimeout(() => {
          if (this.recognition && this.isListening) {
            try {
              this.recognition.start()
            } catch (err) {
              console.error('[AudioTranscription] Restart failed:', err)
            }
          }
        }, 100)
      } else {
        this.hideIndicator()
      }
    }

    this.recognition.onerror = (event: any) => {
      console.error('[AudioTranscription] Error:', event.error)

      // Don't restart on abort errors
      if (event.error === 'aborted') {
        this.shouldRestart = false
      }
    }

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Get the latest result
      const result = event.results[event.resultIndex]
      const transcript = result[0].transcript
      const isFinal = result.isFinal

      console.log('[AudioTranscription] Result:', { transcript, isFinal })

      // Notify all callbacks
      this.callbacks.forEach((cb) => cb(transcript, isFinal))
    }
  }

  /**
   * Start listening for audio
   */
  startListening(): void {
    if (!this.recognition) {
      console.error('Speech Recognition not initialized')
      return
    }

    if (this.isListening) {
      console.warn('Already listening')
      return
    }

    this.isListening = true
    this.shouldRestart = true

    try {
      this.recognition.start()
    } catch (err) {
      console.error('[AudioTranscription] Failed to start:', err)
      this.isListening = false
      this.shouldRestart = false
    }
  }

  /**
   * Stop listening
   */
  stopListening(): void {
    if (!this.recognition) return

    this.isListening = false
    this.shouldRestart = false

    try {
      this.recognition.stop()
    } catch (err) {
      console.error('[AudioTranscription] Failed to stop:', err)
    }

    this.hideIndicator()
  }

  /**
   * Register callback for transcript updates
   */
  onTranscript(callback: TranscriptCallback): void {
    this.callbacks.push(callback)
  }

  /**
   * Remove all callbacks
   */
  clearCallbacks(): void {
    this.callbacks = []
  }

  private showIndicator(): void {
    if (this.indicator) {
      this.indicator.style.display = 'flex'
    }
  }

  private hideIndicator(): void {
    if (this.indicator) {
      this.indicator.style.display = 'none'
    }
  }

  /**
   * Check if currently listening
   */
  getIsListening(): boolean {
    return this.isListening
  }
}

// ============================================================================
// WEBSOCKET TRANSCRIPTION BRIDGE
// ============================================================================

export class WebSocketTranscriptionBridge {
  private ws: WebSocket | null = null
  private animator: TranscriptAnimator
  private indicator: HTMLElement | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 2000

  constructor(animator: TranscriptAnimator, indicatorSelector?: string) {
    this.animator = animator

    if (indicatorSelector) {
      this.indicator = document.querySelector(indicatorSelector)
    }
  }

  /**
   * Connect to WebSocket server
   */
  connect(url: string): void {
    console.log('[WebSocket] Connecting to:', url)

    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      console.log('[WebSocket] Connected')
      this.reconnectAttempts = 0
      this.showIndicator()
    }

    this.ws.onclose = () => {
      console.log('[WebSocket] Connection closed')
      this.hideIndicator()
      this.attemptReconnect(url)
    }

    this.ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error)
    }

    this.ws.onmessage = async (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data)

        if (message.type === 'transcript') {
          console.log('[WebSocket] Transcript:', { text: message.text, isFinal: message.isFinal })

          // Only animate on final results
          if (message.isFinal && message.text) {
            await this.animator.animateSentence(message.text)
          }
        }
      } catch (err) {
        console.error('[WebSocket] Failed to parse message:', err)
      }
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.ws) {
      this.reconnectAttempts = this.maxReconnectAttempts // Prevent reconnect
      this.ws.close()
      this.ws = null
    }
    this.hideIndicator()
  }

  /**
   * Attempt to reconnect if connection drops
   */
  private attemptReconnect(url: string): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WebSocket] Max reconnect attempts reached')
      return
    }

    this.reconnectAttempts++
    console.log(
      `[WebSocket] Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts}`
    )

    setTimeout(() => {
      this.connect(url)
    }, this.reconnectDelay)
  }

  private showIndicator(): void {
    if (this.indicator) {
      this.indicator.style.display = 'flex'
    }
  }

  private hideIndicator(): void {
    if (this.indicator) {
      this.indicator.style.display = 'none'
    }
  }

  /**
   * Check connection status
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

// ============================================================================
// STYLES INJECTION
// ============================================================================

function injectStyles(): void {
  const styleId = 'transcript-animator-styles'

  // Don't inject twice
  if (document.getElementById(styleId)) {
    return
  }

  const styles = `
    /* Transcript Container - Dark theme matching Parakeet */
    .transcript-container {
      background: #0d0d0d;
      border: 1px solid #1e1e1e;
      border-radius: 12px;
      padding: 20px 24px;
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 15px;
      line-height: 1.6;
      color: #e5e5e5;
      min-height: 120px;
      position: relative;
    }

    /* Listening Indicator */
    .listening-indicator {
      display: none;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      animation: fadeIn 0.3s ease;
    }

    .listening-dot {
      width: 8px;
      height: 8px;
      background: #4ade80;
      border-radius: 50%;
      animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
      box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.7);
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
        box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.7);
      }
      50% {
        opacity: 0.7;
        box-shadow: 0 0 0 8px rgba(74, 222, 128, 0);
      }
    }

    .listening-label {
      color: #4ade80;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    /* Transcript Track - wrapper with overflow hidden for slide animation */
    .transcript-track {
      overflow: hidden;
      position: relative;
      min-height: 24px;
    }

    /* Individual Word Styling */
    .transcript-word {
      display: inline;
      margin-right: 0.35em;
      transition: color 0.3s ease;
      will-change: transform, opacity;
    }

    .transcript-word.latest {
      color: #ffffff;
      font-weight: 500;
    }

    .transcript-word.previous {
      color: #e5e5e5;
      font-weight: 400;
    }

    .transcript-word.old {
      color: #555555;
      font-weight: 400;
    }

    /* Blinking Cursor */
    .transcript-cursor {
      display: inline-block;
      width: 2px;
      height: 16px;
      background: #4ade80;
      vertical-align: middle;
      margin-left: 2px;
      animation: blink 0.9s step-end infinite;
    }

    @keyframes blink {
      0%, 50% {
        opacity: 1;
      }
      51%, 100% {
        opacity: 0;
      }
    }

    /* Control Buttons */
    .transcript-controls {
      display: flex;
      gap: 12px;
      margin-top: 16px;
    }

    .transcript-btn {
      padding: 8px 16px;
      border: 1px solid #2a2a2a;
      background: #1a1a1a;
      color: #e5e5e5;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .transcript-btn:hover {
      background: #2a2a2a;
      border-color: #3a3a3a;
    }

    .transcript-btn.primary {
      background: #4ade80;
      color: #000;
      border-color: #4ade80;
    }

    .transcript-btn.primary:hover {
      background: #22c55e;
      border-color: #22c55e;
    }

    .transcript-btn.danger {
      background: #ef4444;
      color: #fff;
      border-color: #ef4444;
    }

    .transcript-btn.danger:hover {
      background: #dc2626;
      border-color: #dc2626;
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `

  const styleElement = document.createElement('style')
  styleElement.id = styleId
  styleElement.textContent = styles
  document.head.appendChild(styleElement)
}

// ============================================================================
// INITIALIZATION FUNCTION
// ============================================================================

export function initTranscriptAnimator(options: {
  containerId?: string
  useWebSocket?: boolean
  websocketUrl?: string
}): {
  animator: TranscriptAnimator
  audioManager?: AudioTranscriptionManager
  wsbridge?: WebSocketTranscriptionBridge
  startListening: () => void
  stopListening: () => void
  clear: () => void
} {
  const containerId = options.containerId || 'transcript-root'

  // Inject styles
  injectStyles()

  // Create HTML structure if it doesn't exist
  let container = document.getElementById(containerId)
  if (!container) {
    container = document.createElement('div')
    container.id = containerId
    document.body.appendChild(container)
  }

  container.innerHTML = `
    <div class="transcript-container">
      <div class="listening-indicator" id="listening-indicator">
        <div class="listening-dot"></div>
        <span class="listening-label">Listening...</span>
      </div>
      
      <div class="transcript-track" id="transcript-track">
        <!-- Words will be inserted here dynamically -->
      </div>

      <div class="transcript-controls">
        <button class="transcript-btn primary" id="start-btn">Start Listening</button>
        <button class="transcript-btn danger" id="stop-btn" style="display:none;">Stop</button>
        <button class="transcript-btn" id="clear-btn">Clear</button>
      </div>
    </div>
  `

  // Initialize animator
  const animator = new TranscriptAnimator('#transcript-track')

  let audioManager: AudioTranscriptionManager | undefined
  let wsBridge: WebSocketTranscriptionBridge | undefined

  // Initialize based on mode
  if (options.useWebSocket && options.websocketUrl) {
    // WebSocket mode
    wsBridge = new WebSocketTranscriptionBridge(animator, '#listening-indicator')
    wsBridge.connect(options.websocketUrl)
  } else {
    // Web Speech API mode (default)
    audioManager = new AudioTranscriptionManager('#listening-indicator')

    // Setup transcript callback - only animate final results
    audioManager.onTranscript(async (text: string, isFinal: boolean) => {
      if (isFinal) {
        await animator.animateSentence(text)
      }
    })
  }

  // Wire up buttons
  const startBtn = document.getElementById('start-btn')
  const stopBtn = document.getElementById('stop-btn')
  const clearBtn = document.getElementById('clear-btn')

  const startListening = () => {
    if (audioManager) {
      audioManager.startListening()
      if (startBtn) startBtn.style.display = 'none'
      if (stopBtn) stopBtn.style.display = 'inline-block'
    }
  }

  const stopListening = () => {
    if (audioManager) {
      audioManager.stopListening()
      if (startBtn) startBtn.style.display = 'inline-block'
      if (stopBtn) stopBtn.style.display = 'none'
    } else if (wsBridge) {
      wsBridge.disconnect()
    }
  }

  const clear = () => {
    animator.clear()
  }

  startBtn?.addEventListener('click', startListening)
  stopBtn?.addEventListener('click', stopListening)
  clearBtn?.addEventListener('click', clear)

  return {
    animator,
    audioManager,
    wsbridge: wsBridge,
    startListening,
    stopListening,
    clear
  }
}

// ============================================================================
// USAGE EXAMPLE (commented out)
// ============================================================================

/*
// Example 1: Using Web Speech API (default)
const { animator, audioManager, startListening, stopListening, clear } = initTranscriptAnimator({
  containerId: 'my-transcript-container'
})

// Start listening
startListening()

// Stop listening
stopListening()

// Clear transcript
clear()

// ============================================================================

// Example 2: Using WebSocket Bridge
const { animator, wsbridge } = initTranscriptAnimator({
  containerId: 'my-transcript-container',
  useWebSocket: true,
  websocketUrl: 'ws://localhost:8080/transcript'
})

// WebSocket server should send messages like:
// { type: "transcript", text: "Hello world", isFinal: true }

// Disconnect when done
wsbridge?.disconnect()

// ============================================================================

// Example 3: Manual control
import { TranscriptAnimator, AudioTranscriptionManager } from './TranscriptAnimator'

const animator = new TranscriptAnimator('#transcript-track')
const audioManager = new AudioTranscriptionManager('#listening-indicator')

audioManager.onTranscript(async (text, isFinal) => {
  if (isFinal) {
    await animator.animateSentence(text)
  }
})

audioManager.startListening()

// Later...
audioManager.stopListening()
animator.clear()
*/

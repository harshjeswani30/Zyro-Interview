export type TranscriptCallback = (text: string, isFinal: boolean) => void

export interface AudioDevice {
  deviceId: string
  label: string
  isSystem?: boolean
}

// List all mic input devices + a special "System Audio" option
export async function listAudioDevices(): Promise<AudioDevice[]> {
  try {
    await navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => s.getTracks().forEach((t) => t.stop()))
  } catch {
    /* ignore */
  }

  const devices = await navigator.mediaDevices.enumerateDevices()
  const mics: AudioDevice[] = devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label || `Microphone (${d.deviceId.substring(0, 6)})`
    }))

  // Prepend the system audio option (captures interviewer voice from speakers)
  return [
    { deviceId: '__system__', label: '🔊 System Audio (Interviewer Voice)', isSystem: true },
    ...mics
  ]
}

export class AudioTranscriptionService {
  private mediaRecorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private isRunning = false
  private onTranscript: TranscriptCallback
  private deviceId: string
  private chunkIntervalMs: number
  private chunkTimer: NodeJS.Timeout | null = null
  private audioChunks: Blob[] = []
  private language: string

  constructor(
    onTranscript: TranscriptCallback,
    deviceId = '__system__',
    chunkIntervalMs = 4000,
    language = 'en-US'
  ) {
    this.onTranscript = onTranscript
    this.deviceId = deviceId
    this.chunkIntervalMs = chunkIntervalMs
    this.language = language
  }

  // No longer needs an AI instance — transcription is handled via Groq IPC in the main process
  setAI(_genAI: any, _modelName: string, _genAIInstance: any): void {
    // no-op: kept for API compatibility
  }

  async start(): Promise<boolean> {
    if (this.isRunning) return true
    try {
      if (this.deviceId === '__system__') {
        // Capture system audio — what the interviewer says through speakers
        this.stream = await this.getSystemAudioStream()
      } else {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: this.deviceId === 'default' ? undefined : { exact: this.deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            sampleRate: 16000
          }
        })
      }

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      this.mediaRecorder = new MediaRecorder(this.stream, { mimeType })
      this.audioChunks = []

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data)
      }

      this.mediaRecorder.start(1000) // buffer in 1s slices
      this.isRunning = true

      // Transcribe every N seconds
      this.chunkTimer = setInterval(() => {
        if (!this.isRunning || this.audioChunks.length === 0) return
        this.processChunks()
      }, this.chunkIntervalMs)

      return true
    } catch (e: any) {
      console.error('Audio capture error:', e.message)
      return false
    }
  }

  // Uses getDisplayMedia which captures system/speaker audio on Windows
  private async getSystemAudioStream(): Promise<MediaStream> {
    try {
      // Electron/Chromium: getDisplayMedia with audio=true captures system audio
      const display = (await (navigator.mediaDevices as any).getDisplayMedia({
        video: { width: 1, height: 1, frameRate: 1 }, // minimal video needed for some platforms
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 16000
        }
      })) as MediaStream

      // Stop the video track — we only need audio
      display.getVideoTracks().forEach((t) => t.stop())

      // If no audio track (user didn't share audio), fallback to mic
      if (display.getAudioTracks().length === 0) {
        throw new Error(
          'No system audio track received. Try selecting "Share system audio" in the picker.'
        )
      }

      return display
    } catch (e: any) {
      throw new Error(`System audio capture failed: ${e.message}`)
    }
  }

  private async processChunks(): Promise<void> {
    const chunks = [...this.audioChunks]
    this.audioChunks = []
    if (chunks.length === 0) return

    const blob = new Blob(chunks, { type: this.mediaRecorder?.mimeType || 'audio/webm' })
    const base64 = await this.blobToBase64(blob)
    if (!base64) return

    try {
      this.onTranscript('…', false)
      const text: string = await (window as any).api.transcribeOnly({
        base64Audio: base64,
        mimeType: blob.type || 'audio/webm',
        language: this.language
      })
      if (text && text.trim().length > 2 && text.trim() !== '…') {
        this.onTranscript(text.trim(), true)
      }
    } catch (e: any) {
      console.warn('Transcription error:', e.message?.substring(0, 80))
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const r = reader.result as string
        resolve(r.split(',')[1] || '')
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  stop(): void {
    this.isRunning = false
    if (this.chunkTimer) clearInterval(this.chunkTimer)
    this.chunkTimer = null
    this.mediaRecorder?.stop()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.mediaRecorder = null
    this.stream = null
    this.audioChunks = []
  }
}

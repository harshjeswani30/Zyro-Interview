/**
 * VAD Worker:
 * Runs in a separate thread to handle audio buffering and pause detection
 * without blocking the UI. Emits 'speech_active' events so the main thread
 * knows when real speech is happening vs background noise.
 */

let vadBuffer: Float32Array[] = [];
let vadSpeechActive = false;
let vadPauseStart: number | null = null;
let vadSpeechStart: number | null = null;
let isAuto = true;
let isManual = false;

// Config (sent from main thread)
let LONG_PAUSE_SEC = 2.4;
let MIN_SEC = 0.5;
// Raised thresholds to be less sensitive to background hum/noise
let SPEECH_START_RMS = 0.018;
let SPEECH_END_RMS = 0.010;
let sampleRate = 48000;

function computeRMS(buffer: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
}

self.onmessage = (e: MessageEvent) => {
    const { type, data } = e.data;

    if (type === 'config') {
        LONG_PAUSE_SEC = data.LONG_PAUSE_SEC || LONG_PAUSE_SEC;
        MIN_SEC = data.MIN_SEC || MIN_SEC;
        SPEECH_START_RMS = data.SPEECH_START_RMS || SPEECH_START_RMS;
        SPEECH_END_RMS = data.SPEECH_END_RMS || SPEECH_END_RMS;
        sampleRate = data.sampleRate || sampleRate;
        isAuto = data.isAuto;
        isManual = data.isManual;
    }

    if (type === 'audio') {
        const chunk: Float32Array = data;
        const rms = computeRMS(chunk);
        const nowSec = Date.now() / 1000;

        // In manual mode, always buffer. In auto, only buffer when speech is active or just started.
        const shouldBuffer = isAuto ? (rms >= SPEECH_START_RMS || vadSpeechActive) : isManual;

        if (shouldBuffer) {
            vadBuffer.push(chunk);

            // Silence after speech
            if (isAuto && vadSpeechActive && rms < SPEECH_END_RMS) {
                vadSpeechActive = false;
                vadPauseStart = nowSec;
                self.postMessage({ type: 'status', data: 'Waiting...' });
                self.postMessage({ type: 'speech_active', data: false });
            }
            // Speech started / resumed
            else if (!vadSpeechActive && rms >= SPEECH_START_RMS) {
                vadSpeechActive = true;
                vadPauseStart = null;
                if (vadSpeechStart === null) {
                    vadSpeechStart = nowSec;
                }
                self.postMessage({ type: 'status', data: 'Listening...' });
                self.postMessage({ type: 'speech_active', data: true });
            }
        }

        // Auto-Finalize Logic: send chunks to main thread when silence long enough
        if (isAuto && !vadSpeechActive && vadPauseStart !== null && vadSpeechStart !== null) {
            const silence = nowSec - vadPauseStart;
            if (silence >= LONG_PAUSE_SEC) {
                const totalSamples = vadBuffer.reduce((s, c) => s + c.length, 0);
                if (totalSamples >= sampleRate * MIN_SEC) {
                    self.postMessage({ type: 'finalize', data: vadBuffer });
                } else {
                    self.postMessage({ type: 'status', data: 'Ready (Auto)' });
                }
                // Reset
                vadBuffer = [];
                vadPauseStart = null;
                vadSpeechStart = null;
            }
        }
    }

    if (type === 'reset') {
        vadBuffer = [];
        vadPauseStart = null;
        vadSpeechStart = null;
        vadSpeechActive = false;
        self.postMessage({ type: 'speech_active', data: false });
    }

    if (type === 'manual_stop') {
        self.postMessage({ type: 'finalize', data: vadBuffer });
        vadBuffer = [];
        vadPauseStart = null;
        vadSpeechStart = null;
    }
};

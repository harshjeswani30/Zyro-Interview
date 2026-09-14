import { describe, it, expect } from 'vitest'
import { buildLiveUrl, floatTo16BitPCM } from './deepgramLiveClient'

const opts = { sampleRate: 48000, apiKey: 'k', onText: () => {} }

describe('floatTo16BitPCM', () => {
    it('produces two little-endian bytes per sample', () => {
        const buf = floatTo16BitPCM(new Float32Array([0, 1, -1]))
        expect(buf.byteLength).toBe(6)
        const view = new DataView(buf)
        expect(view.getInt16(0, true)).toBe(0)
        expect(view.getInt16(2, true)).toBe(32767)
        expect(view.getInt16(4, true)).toBe(-32768)
    })

    it('clamps samples that overshoot the [-1, 1] range', () => {
        const view = new DataView(floatTo16BitPCM(new Float32Array([2.5, -2.5])))
        expect(view.getInt16(0, true)).toBe(32767)
        expect(view.getInt16(2, true)).toBe(-32768)
    })

    it('keeps quiet audio quiet rather than rounding it away', () => {
        const view = new DataView(floatTo16BitPCM(new Float32Array([0.5])))
        expect(view.getInt16(0, true)).toBeGreaterThan(16000)
    })
})

describe('buildLiveUrl', () => {
    it('asks for interim results -- without them there is nothing to stream', () => {
        expect(buildLiveUrl(opts)).toContain('interim_results=true')
    })

    it('pins nova-3 and multilingual mode by default, matching the batch path', () => {
        const url = buildLiveUrl(opts)
        expect(url).toContain('model=nova-3')
        expect(url).toContain('language=multi')
    })

    it('passes the real capture sample rate through', () => {
        expect(buildLiveUrl({ ...opts, sampleRate: 44100 })).toContain('sample_rate=44100')
        expect(buildLiveUrl({ ...opts, sampleRate: 48000.7 })).toContain('sample_rate=48001')
    })

    it('declares linear16 mono, which is what push() sends', () => {
        const url = buildLiveUrl(opts)
        expect(url).toContain('encoding=linear16')
        expect(url).toContain('channels=1')
    })

    it('honours an explicit language', () => {
        expect(buildLiveUrl({ ...opts, language: 'en' })).toContain('language=en')
    })

    it('targets Deepgram by default and a proxy when given one', () => {
        expect(buildLiveUrl(opts).startsWith('wss://api.deepgram.com/v1/listen?')).toBe(true)
        expect(
            buildLiveUrl({ ...opts, endpoint: 'wss://gw.example.com/gateway/stt-stream' })
        ).toContain('wss://gw.example.com/gateway/stt-stream?')
    })
})

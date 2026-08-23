/**
 * Rolling PCM buffer addressed by absolute sample offset.
 *
 * The capture pipeline needs to slice audio at positions the VAD reports
 * (utterance start, pause boundaries) some time after the audio arrived, and it
 * needs a little audio from *before* speech was detected so the first phoneme of a
 * word is never clipped. A plain "push while speech is active" array cannot do
 * either: it starts at the chunk that crossed the threshold, and its indices shift
 * as it is trimmed.
 *
 * So: keep every chunk in arrival order, tag positions with a monotonic sample
 * counter that is never reset, and drop from the front once the retained audio
 * exceeds the capacity.
 */
export class AudioRing {
    private chunks: Float32Array[] = []
    /** Absolute offset of the first sample still retained. */
    private firstSample = 0
    /** Absolute offset one past the last sample written. */
    private nextSample = 0
    private retained = 0

    constructor(private readonly capacitySamples: number) {}

    /** Absolute offset one past the newest sample. */
    get head(): number {
        return this.nextSample
    }

    /** Absolute offset of the oldest sample still available. */
    get tail(): number {
        return this.firstSample
    }

    push(chunk: Float32Array): void {
        this.chunks.push(chunk)
        this.retained += chunk.length
        this.nextSample += chunk.length
        while (this.retained > this.capacitySamples && this.chunks.length > 1) {
            const dropped = this.chunks.shift() as Float32Array
            this.retained -= dropped.length
            this.firstSample += dropped.length
        }
    }

    /**
     * Chunks covering `[from, to)`, clamped to what is still retained. Returns
     * views where a chunk is fully inside the range and subarrays at the edges, so
     * no audio is copied except at the two boundaries.
     */
    slice(from: number, to: number): Float32Array[] {
        const start = Math.max(from, this.firstSample)
        const end = Math.min(to, this.nextSample)
        if (end <= start) return []

        const out: Float32Array[] = []
        let cursor = this.firstSample
        for (const chunk of this.chunks) {
            const chunkEnd = cursor + chunk.length
            if (chunkEnd > start && cursor < end) {
                const localFrom = Math.max(0, start - cursor)
                const localTo = Math.min(chunk.length, end - cursor)
                out.push(localFrom === 0 && localTo === chunk.length ? chunk : chunk.subarray(localFrom, localTo))
            }
            cursor = chunkEnd
            if (cursor >= end) break
        }
        return out
    }
}

/**
 * useEyeContact — Real-time eye gaze correction using MediaPipe Face Landmarker
 *
 * How it works:
 * 1. Opens webcam via getUserMedia
 * 2. Runs MediaPipe FaceLandmarker (WASM, 60fps) to get 478 face landmarks
 * 3. Extracts iris positions (left: 473-477, right: 468-472)
 * 4. Measures how far each iris is from its "looking-at-camera" center
 * 5. On a canvas, draws the full frame then warps only the eye regions
 *    using affine transforms to shift irises back toward center
 * 6. Returns the canvas stream + enable/disable toggle
 */

import { useRef, useState, useCallback, useEffect } from 'react'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// ── Iris landmark indices in MediaPipe 478-point mesh ────────────────────────
const LEFT_IRIS  = [474, 475, 476, 477] // left iris ring (from user POV: right side)
const RIGHT_IRIS = [469, 470, 471, 472] // right iris ring
const LEFT_EYE_CORNERS  = [362, 263]    // left eye corners
const RIGHT_EYE_CORNERS = [33, 133]     // right eye corners

// ── Config ───────────────────────────────────────────────────────────────────
const MAX_CORRECTION_PX = 18   // max pixels to shift iris (clamp)
const SMOOTHING         = 0.15 // lerp factor (lower = smoother but laggier)
const EYE_REGION_PAD    = 0.35 // padding around eye box as fraction of eye width

export interface EyeContactState {
  enabled: boolean
  tracking: boolean  // true when a face is detected
  correctionX: number
  correctionY: number
}

interface SmoothVec2 { x: number; y: number }

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function irisCenter(landmarks: { x: number; y: number }[], indices: number[]): SmoothVec2 {
  let sx = 0, sy = 0
  for (const i of indices) {
    sx += landmarks[i].x
    sy += landmarks[i].y
  }
  return { x: sx / indices.length, y: sy / indices.length }
}

function eyeCenter(landmarks: { x: number; y: number }[], cornerIndices: number[]): SmoothVec2 {
  const a = landmarks[cornerIndices[0]]
  const b = landmarks[cornerIndices[1]]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function useEyeContact() {
  const [enabled, setEnabled] = useState(false)
  const [tracking, setTracking] = useState(false)
  const [correctionVec, setCorrectionVec] = useState<SmoothVec2>({ x: 0, y: 0 })

  // Refs
  const videoRef    = useRef<HTMLVideoElement | null>(null)
  const canvasRef   = useRef<HTMLCanvasElement | null>(null)
  const landmarkerRef = useRef<FaceLandmarker | null>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const rafRef      = useRef<number | null>(null)
  const enabledRef  = useRef(false)
  const smoothedRef = useRef<SmoothVec2>({ x: 0, y: 0 })
  const loadingRef  = useRef(false)
  const strengthRef = useRef(1.0) // 0–1 correction strength

  // Keep enabledRef in sync
  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  // ── Load MediaPipe FaceLandmarker ─────────────────────────────────────────
  const loadLandmarker = useCallback(async () => {
    if (landmarkerRef.current || loadingRef.current) return
    loadingRef.current = true

    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      )
      landmarkerRef.current = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'CPU',
        },
        outputFaceBlendshapes: false,
        runningMode: 'IMAGE',
        numFaces: 1,
      })
      console.log('[EyeContact] FaceLandmarker loaded ✅')
    } catch (err) {
      console.error('[EyeContact] Failed to load FaceLandmarker:', err)
    } finally {
      loadingRef.current = false
    }
  }, [])

  // ── Open webcam ───────────────────────────────────────────────────────────
  const openCamera = useCallback(async () => {
    if (streamRef.current) return // already open

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    })
    streamRef.current = stream

    const video = document.createElement('video')
    video.style.display = 'none'
    video.style.position = 'absolute'
    video.style.width = '1px'
    video.style.height = '1px'
    video.style.opacity = '0'
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    document.body.appendChild(video)
    await video.play()
    videoRef.current = video

    const canvas = document.createElement('canvas')
    canvas.width  = 640
    canvas.height = 480
    canvasRef.current = canvas

    console.log('[EyeContact] Camera opened ✅')
  }, [])

  // ── Warp an eye region on canvas to correct gaze ─────────────────────────
  function warpEyeRegion(
    ctx: CanvasRenderingContext2D,
    sourceCanvas: HTMLCanvasElement,
    landmarks: { x: number; y: number }[],
    corners: number[],
    iris: number[],
    frameW: number,
    frameH: number
  ) {
    const a = landmarks[corners[0]]
    const b = landmarks[corners[1]]

    // Eye bounding box in pixels
    const eyeW = Math.abs(b.x - a.x) * frameW
    const eyeH = eyeW * 0.6
    const pad  = eyeW * EYE_REGION_PAD

    const cx = ((a.x + b.x) / 2) * frameW
    const cy = ((a.y + b.y) / 2) * frameH

    const x0 = Math.max(0, cx - eyeW / 2 - pad)
    const y0 = Math.max(0, cy - eyeH / 2 - pad)
    const rw = Math.min(frameW - x0, eyeW + pad * 2)
    const rh = Math.min(frameH - y0, eyeH + pad * 2)

    // Get iris actual center vs eye geometric center
    const irisC = irisCenter(landmarks, iris)
    const eyeC  = eyeCenter(landmarks, corners)

    // Offset: how far iris is from center (normalized → pixels)
    const irisDx = (irisC.x - eyeC.x) * frameW
    const irisDy = (irisC.y - eyeC.y) * frameH

    // Clamped correction
    const strength = strengthRef.current
    const shiftX   = Math.max(-MAX_CORRECTION_PX, Math.min(MAX_CORRECTION_PX, -irisDx * strength))
    const shiftY   = Math.max(-MAX_CORRECTION_PX, Math.min(MAX_CORRECTION_PX, -irisDy * strength))

    // Clip & redraw the eye region shifted
    ctx.save()
    ctx.beginPath()
    ctx.rect(x0, y0, rw, rh)
    ctx.clip()
    ctx.drawImage(
      sourceCanvas,
      x0, y0, rw, rh,                  // source: static snapshot
      x0 + shiftX, y0 + shiftY, rw, rh  // dest: shifted on destination canvas
    )
    ctx.restore()
  }

  // ── Main render loop ──────────────────────────────────────────────────────
  const renderLoop = useCallback(() => {
    const video  = videoRef.current
    const canvas = canvasRef.current
    const fl     = landmarkerRef.current

    if (!video || !canvas || !fl) {
      rafRef.current = setTimeout(renderLoop, 16) as unknown as number
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      rafRef.current = setTimeout(renderLoop, 16) as unknown as number
      return
    }

    // Step 1: Draw the RAW video frame to canvas first (no mirror).
    // MediaPipe model detects best on unmirrored raw camera coordinates.
    ctx.save()
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    ctx.restore()

    if (enabledRef.current && video.readyState >= 4) {
      try {
        const results = fl.detect(canvas)

        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
          setTracking(true)
          const lm = results.faceLandmarks[0]
          const W  = canvas.width
          const H  = canvas.height

          // Create a snapshot of the raw unmirrored frame
          const snapshotCanvas = document.createElement('canvas')
          snapshotCanvas.width = W
          snapshotCanvas.height = H
          const snapCtx = snapshotCanvas.getContext('2d')
          if (snapCtx) {
            snapCtx.drawImage(canvas, 0, 0)

            // Warp the eye regions directly on the raw canvas (unmirrored)
            warpEyeRegion(ctx, snapshotCanvas, lm, LEFT_EYE_CORNERS, LEFT_IRIS, W, H)
            warpEyeRegion(ctx, snapshotCanvas, lm, RIGHT_EYE_CORNERS, RIGHT_IRIS, W, H)

            // Compute smoothed overall gaze delta
            const leftIrisC  = irisCenter(lm, LEFT_IRIS)
            const leftEyeC   = eyeCenter(lm, LEFT_EYE_CORNERS)
            const rawDx = (leftEyeC.x - leftIrisC.x) * W
            const rawDy = (leftEyeC.y - leftIrisC.y) * H

            smoothedRef.current.x = lerp(smoothedRef.current.x, rawDx, SMOOTHING)
            smoothedRef.current.y = lerp(smoothedRef.current.y, rawDy, SMOOTHING)
            setCorrectionVec({ ...smoothedRef.current })
          }

          // Step 2: Now that eye warp is done on raw coordinates, mirror the entire canvas visually.
          // We can do this by copying to a temp, clearing canvas, and drawing mirrored.
          const finalSnapshot = document.createElement('canvas')
          finalSnapshot.width = W
          finalSnapshot.height = H
          const finalCtx = finalSnapshot.getContext('2d')
          if (finalCtx) {
            finalCtx.drawImage(canvas, 0, 0)
            ctx.clearRect(0, 0, W, H)
            ctx.save()
            ctx.translate(W, 0)
            ctx.scale(-1, 1)
            ctx.drawImage(finalSnapshot, 0, 0)
            ctx.restore()
          }

        } else {
          setTracking(false)
          // Mirror even if no face detected
          const W = canvas.width
          const H = canvas.height
          const finalSnapshot = document.createElement('canvas')
          finalSnapshot.width = W
          finalSnapshot.height = H
          const finalCtx = finalSnapshot.getContext('2d')
          if (finalCtx) {
            finalCtx.drawImage(canvas, 0, 0)
            ctx.clearRect(0, 0, W, H)
            ctx.save()
            ctx.translate(W, 0)
            ctx.scale(-1, 1)
            ctx.drawImage(finalSnapshot, 0, 0)
            ctx.restore()
          }

          smoothedRef.current.x = lerp(smoothedRef.current.x, 0, SMOOTHING)
          smoothedRef.current.y = lerp(smoothedRef.current.y, 0, SMOOTHING)
        }
      } catch (err) {
        console.error('[EyeContact] Error during detection loop:', err)
      }
    } else {
      setTracking(false)
    }

    rafRef.current = setTimeout(renderLoop, 33) as unknown as number
  }, [])

  // ── Enable ────────────────────────────────────────────────────────────────
  const enable = useCallback(async () => {
    await loadLandmarker()
    await openCamera()
    setEnabled(true)
    enabledRef.current = true
    if (!rafRef.current) {
      rafRef.current = setTimeout(renderLoop, 33) as unknown as number
    }
    console.log('[EyeContact] Enabled')
  }, [loadLandmarker, openCamera, renderLoop])

  // ── Disable ───────────────────────────────────────────────────────────────
  const disable = useCallback(() => {
    setEnabled(false)
    setTracking(false)
    enabledRef.current = false

    if (rafRef.current) {
      clearTimeout(rafRef.current)
      rafRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
      videoRef.current.remove()
      videoRef.current = null
    }
    console.log('[EyeContact] Disabled')
  }, [])

  const toggle = useCallback(() => {
    if (enabled) disable()
    else enable()
  }, [enabled, enable, disable])

  const setStrength = useCallback((v: number) => {
    strengthRef.current = Math.max(0, Math.min(1, v))
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disable()
      landmarkerRef.current?.close()
      landmarkerRef.current = null
    }
  }, [disable])

  return {
    enabled,
    tracking,
    correctionVec,
    canvasRef,
    enable,
    disable,
    toggle,
    setStrength,
  }
}

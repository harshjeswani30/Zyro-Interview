import { describe, expect, it } from 'vitest'
import { shouldApplyVadStatus } from './captureStatus'

describe('shouldApplyVadStatus', () => {
  it('accepts Waiting/Listening while auto capture is idle', () => {
    expect(shouldApplyVadStatus(true, false, false)).toBe(true)
  })

  it('does not let a late VAD event overwrite final STT status', () => {
    expect(shouldApplyVadStatus(true, true, false)).toBe(false)
  })

  it('does not let a late VAD event overwrite answer-generation status', () => {
    expect(shouldApplyVadStatus(true, false, true)).toBe(false)
  })

  it('never applies VAD status in manual mode', () => {
    expect(shouldApplyVadStatus(false, false, false)).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { classifyIntent } from './intentClassifier'

describe('classifyIntent', () => {
  it('correctly classifies practical and situational questions as behavioral', () => {
    // The user's exact query
    const res1 = classifyIntent('tum as a generalist image annotation kese kroge')
    expect(res1.intent).toBe('behavioral')
    expect(res1.isHindi).toBe(true)

    // Variations
    const res2 = classifyIntent('tum image annotation kaise karoge')
    expect(res2.intent).toBe('behavioral')
    expect(res2.isHindi).toBe(true)

    const res3 = classifyIntent('as a generalist image annotator, how would you approach this task?')
    expect(res3.intent).toBe('behavioral')
    expect(res3.isHindi).toBe(false)

    const res4 = classifyIntent('how would you handle edge cases in bounding box labeling?')
    expect(res4.intent).toBe('behavioral')
    expect(res4.isHindi).toBe(false)

    const res5 = classifyIntent('mushkil situation kaise handle karoge')
    expect(res5.intent).toBe('behavioral')
    expect(res5.isHindi).toBe(true)
  })

  it('preserves technical concept classification for theoretical queries', () => {
    const res1 = classifyIntent('How does TCP 3-way handshake work')
    expect(res1.intent).toBe('technical_concept')

    const res2 = classifyIntent('difference between process and thread')
    expect(res2.intent).toBe('technical_concept')
  })

  it('preserves dsa coding classification', () => {
    const res1 = classifyIntent('reverse a binary tree')
    expect(res1.intent).toBe('dsa_coding')
    expect(res1.isCoding).toBe(true)

    const res2 = classifyIntent('two sum problem leetcode')
    expect(res2.intent).toBe('dsa_coding')
    expect(res2.isCoding).toBe(true)
  })

  it('preserves system design classification', () => {
    const res = classifyIntent('design a distributed cache like redis')
    expect(res.intent).toBe('system_design')
  })
})


import { describe, expect, it } from 'vitest'
import { isProviderUsageLimitMessage } from './providerResponse'

describe('isProviderUsageLimitMessage', () => {
  it('recognizes ChatGPT free-plan limit text rendered in a successful page', () => {
    expect(isProviderUsageLimitMessage("You've reached the free plan limit for GPT-5. Try again later.")).toBe(true)
  })

  it('recognizes Claude usage-cap text', () => {
    expect(isProviderUsageLimitMessage("You've hit your limit for messages. Please try again later.")).toBe(true)
  })

  it('recognizes an API-style 429 message', () => {
    expect(isProviderUsageLimitMessage('Too many requests. Please try again in 30 seconds.')).toBe(true)
  })

  it('does not mistake a valid interview answer about rate limiting for an error', () => {
    expect(
      isProviderUsageLimitMessage(
        'A token bucket is a useful rate limiter: when the bucket is empty, the request waits until tokens refill.'
      )
    ).toBe(false)
  })

  it('does not classify ordinary advice that says to try again later', () => {
    expect(isProviderUsageLimitMessage('If the deployment fails, try again later after checking the logs.')).toBe(false)
  })

  it('does not classify an empty response', () => {
    expect(isProviderUsageLimitMessage('')).toBe(false)
  })
})

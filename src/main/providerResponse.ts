/**
 * Classifies provider UI/API text that means the user's subscription cannot
 * accept another message right now. Web ChatGPT/Claude often render a 200-page
 * error instead of returning HTTP 429, so status-code-only failover is not
 * enough.
 *
 * Keep the patterns error-shaped. An interview answer can legitimately discuss
 * "rate limits" or "usage limits"; those words alone must never make us throw
 * away a valid answer and switch providers.
 */
const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /you[’']?ve\s+(?:reached|hit)\s+(?:the\s+)?(?:current\s+|free\s+plan\s+|message\s+|usage\s+|model\s+)?limit\b/i,
  /(?:free\s+(?:plan|tier)|usage|message|model)\s+limit\s+(?:reached|exceeded|reset)/i,
  /rate\s+limit\s+(?:reached|exceeded)/i,
  /too\s+many\s+requests/i,
  /(?:limit|capacity)\s+(?:has\s+been\s+)?reached[\s.!]*(?:please\s+)?try\s+again/i,
  /(?:limit|capacity|quota|usage|message).{0,80}try\s+again\s+(?:later|in\s+\d+)/i
]

/** True only for a provider-generated limit/capacity message, not normal prose. */
export function isProviderUsageLimitMessage(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > 1200) return false
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(normalized))
}

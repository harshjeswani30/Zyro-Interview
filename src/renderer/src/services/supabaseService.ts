// ─────────────────────────────────────────────────────────────────────────────
//  trialUtils.ts  (formerly supabaseService.ts)
//  Plain utility helpers — no Supabase dependency.
// ─────────────────────────────────────────────────────────────────────────────

export function calculateTrialRemainingFromSeconds(secondsUsed: number): number {
  return Math.max(0, 600 - secondsUsed)
}

/*
 * Turn-boundary gating for the VAD worker's messages.
 *
 * The worker emits the same `finalize` message for two very different events:
 *   1. it noticed a long enough pause by itself -- auto mode's normal path, and
 *   2. the user pressed Stop and the renderer forwarded `manual_stop` to it
 *      (see the manual_stop branch in services/vadWorker.ts, which posts
 *      `finalize` whenever the turn held real speech).
 *
 * Manual mode wants the second and not the first: there, the user decides when a
 * turn ends. The only signal that separates them is the pending-stop flag the
 * Listen button raises just before posting `manual_stop` -- so it has to be read
 * before it is cleared. A guard that tested the mode alone swallowed the user's own
 * stop, which showed up as a transcript on screen and no answer under it.
 */

export interface FinalizedTurn {
    /** True when the overlay is in auto-answer mode. */
    autoMode: boolean
    /** True when this finalize is the result of the user pressing Stop. */
    userRequestedStop: boolean
}

/**
 * Whether a finalized turn should go on to produce an answer.
 *
 * Auto mode answers every finalized turn. Manual mode answers only the turns the
 * user ended deliberately.
 */
export function shouldAnswerFinalizedTurn({ autoMode, userRequestedStop }: FinalizedTurn): boolean {
    return autoMode || userRequestedStop
}

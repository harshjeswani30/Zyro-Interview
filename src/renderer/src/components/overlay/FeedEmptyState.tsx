import React from 'react'

export interface FeedEmptyStateProps {
    autoMode: boolean
}

/**
 * Shown when no answer exists yet. The bare <i>/<b>/<u>/<em> tags inside
 * `.orbits` are decorative rings the stylesheet targets by tag name.
 */
function FeedEmptyStateBase({ autoMode }: FeedEmptyStateProps): React.ReactElement {
    return (
        <div className="empty">
            <div className="orbits">
                <i />
                <i />
                <i />
                <b />
                <u />
                <em />
            </div>
            <h3>Zyro is standing by</h3>
            <p>
                {autoMode
                    ? 'Auto mode is on — the next question you hear gets answered here, instantly.'
                    : 'Manual mode — hit Listen to capture audio, or type a question below.'}
            </p>
            <div className="hints">
                <span>
                    <kbd>Ctrl</kbd>
                    <kbd>Space</kbd> Listen
                </span>
                <span>
                    <kbd>Ctrl</kbd>
                    <kbd>S</kbd> Capture
                </span>
                <span>
                    <kbd>Ctrl</kbd>
                    <kbd>A</kbd> Mode
                </span>
                {/* Ctrl+B, not Ctrl+M: B is registered as an OS-level global shortcut in
                    the main process, so it works while the meeting app has focus. Ctrl+M
                    only collapses the deck and only when the overlay is focused, so it
                    stays on the minimize button's own tooltip instead. */}
                <span>
                    <kbd>Ctrl</kbd>
                    <kbd>B</kbd> Hide
                </span>
                <span>
                    <kbd>Ctrl</kbd>
                    <kbd>⌫</kbd> Clear
                </span>
                <span>
                    <kbd>←</kbd>
                    <kbd>→</kbd> History
                </span>
            </div>
        </div>
    )
}

/* Memoised: the overlay pushes a fresh audio level into state ~10x a second while the
   mic is open, which re-renders the container. Nothing here depends on that, so the
   props comparison is what keeps those ticks off this subtree. */
export const FeedEmptyState = React.memo(FeedEmptyStateBase)

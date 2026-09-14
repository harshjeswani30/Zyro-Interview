import React from 'react'
import { IconAlert, IconArrowDown, IconChevronLeft, IconChevronRight, IconClickThrough, IconClock } from './icons'

export interface ConversationFeedProps {
    /** Total answered pairs in history. */
    total: number
    /** 1-based index of the pair currently shown. */
    position: number
    canPrev: boolean
    canNext: boolean
    onPrev: () => void
    onNext: () => void
    /** Reveals the "New answer" jump pill when the user has scrolled away. */
    showNewPill: boolean
    onJumpNewest: () => void
    /** Session-time warning copy; falsy hides the banner. */
    warnMsg?: string
    onDismissWarn: () => void
    /** Error copy; falsy hides the banner. */
    errorMsg?: string
    onDismissError: () => void
    /** Attached to the scroll region so the container can drive stick-to-bottom. */
    scrollRef?: React.Ref<HTMLDivElement>
    /** Rendered below the scroll region -- normally the Composer. */
    composer?: React.ReactNode
    children: React.ReactNode
    opacity?: number
    onOpacityChange?: (val: number) => void
    clickThrough?: boolean
    onToggleClickThrough?: () => void
}

/** Layout shell for the answer feed: header, scroll region, pill, composer, banners. */
export function ConversationFeed({
    total,
    position,
    canPrev,
    canNext,
    onPrev,
    onNext,
    showNewPill,
    onJumpNewest,
    warnMsg,
    onDismissWarn,
    errorMsg,
    onDismissError,
    scrollRef,
    composer,
    children,
    opacity,
    onOpacityChange,
    clickThrough,
    onToggleClickThrough
}: ConversationFeedProps): React.ReactElement {
    return (
        <main className="feed">
            <div className="panel-head">
                <div className="panel-head__left">
                    <span className="l">
                        Conversation{' '}
                        <span className="count">{total > 0 ? `${position} / ${total}` : '0'}</span>
                    </span>

                    {typeof opacity === 'number' && onOpacityChange && (
                        <div
                            className="opacity-bar no-drag"
                            title={`Overlay Opacity: ${Math.round(opacity * 100)}%`}
                            onPointerDown={(e) => {
                                e.stopPropagation()
                                ;(window as any).__isInteractingWithOverlay = true
                                const onUp = () => {
                                    ;(window as any).__isInteractingWithOverlay = false
                                    window.removeEventListener('pointerup', onUp)
                                    window.removeEventListener('pointercancel', onUp)
                                }
                                window.addEventListener('pointerup', onUp)
                                window.addEventListener('pointercancel', onUp)
                            }}
                        >
                            <span className="opacity-bar__icon" aria-hidden="true">
                                <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="9" />
                                    <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" opacity="0.5" />
                                </svg>
                            </span>
                            <span className="opacity-bar__lbl">Opacity</span>
                            <div className="opacity-bar__slider-wrap">
                                <div
                                    className="opacity-bar__fill"
                                    style={{ width: `${Math.max(0, Math.min(100, opacity * 100))}%` }}
                                />
                                <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.02"
                                    value={opacity}
                                    onPointerDown={(e) => {
                                        e.stopPropagation()
                                        ;(window as any).__isInteractingWithOverlay = true
                                        const onUp = () => {
                                            ;(window as any).__isInteractingWithOverlay = false
                                            window.removeEventListener('pointerup', onUp)
                                            window.removeEventListener('pointercancel', onUp)
                                        }
                                        window.addEventListener('pointerup', onUp, { once: true })
                                        window.addEventListener('pointercancel', onUp, { once: true })
                                    }}
                                    onChange={(e) => onOpacityChange(parseFloat(e.target.value))}
                                    className="opacity-bar__range no-drag"
                                    aria-label="Overlay opacity"
                                />
                            </div>
                            <span className="opacity-bar__val">{Math.round(opacity * 100)}%</span>
                        </div>
                    )}

                    {onToggleClickThrough && (
                        <button
                            type="button"
                            className={`click-through-btn no-drag ${clickThrough ? 'active' : ''}`}
                            onPointerEnter={() => {
                                ;(window as any).__isInteractingWithOverlay = true
                                window.api?.setIgnoreMouseEvents(false)
                            }}
                            onPointerLeave={() => {
                                ;(window as any).__isInteractingWithOverlay = false
                            }}
                            onPointerDown={(e) => {
                                e.stopPropagation()
                                ;(window as any).__isInteractingWithOverlay = true
                                window.api?.setIgnoreMouseEvents(false)
                            }}
                            onPointerUp={() => {
                                setTimeout(() => {
                                    ;(window as any).__isInteractingWithOverlay = false
                                }, 150)
                            }}
                            onClick={(e) => {
                                e.stopPropagation()
                                onToggleClickThrough()
                            }}
                            title={
                                clickThrough
                                    ? 'Click-Through: ON (Overlay in focus - buttons active)'
                                    : 'Click-Through: OFF (Background focus - clicks pass through to background)'
                            }
                            aria-label="Toggle click-through mode"
                            aria-pressed={clickThrough}
                        >
                            <span className="click-through-btn__icon" aria-hidden="true">
                                <IconClickThrough />
                            </span>
                            <span className="click-through-btn__lbl">Click-thru</span>
                            <span className={`click-through-btn__dot ${clickThrough ? 'on' : ''}`} />
                        </button>
                    )}
                </div>

                <div className="acts">
                    <button
                        type="button"
                        className="mini no-drag"
                        onClick={onPrev}
                        disabled={!canPrev}
                    >
                        <IconChevronLeft />
                        Prev
                    </button>
                    <button
                        type="button"
                        className="mini no-drag"
                        onClick={onNext}
                        disabled={!canNext}
                    >
                        Next
                        <IconChevronRight />
                    </button>
                </div>
            </div>

            <div className="feed__scroll" ref={scrollRef}>
                {children}
            </div>

            <button
                type="button"
                className={`newpill no-drag ${showNewPill ? 'show' : ''}`}
                onClick={onJumpNewest}
            >
                <IconArrowDown />
                New answer
            </button>

            {composer}

            <div className={`banner banner--warn ${warnMsg ? 'show' : ''}`}>
                <IconClock />
                <span>{warnMsg}</span>
                <button type="button" className="x no-drag" onClick={onDismissWarn}>
                    ×
                </button>
            </div>
            <div className={`banner banner--bad ${errorMsg ? 'show' : ''}`}>
                <IconAlert />
                <span>{errorMsg}</span>
                <button type="button" className="x no-drag" onClick={onDismissError}>
                    ×
                </button>
            </div>
        </main>
    )
}

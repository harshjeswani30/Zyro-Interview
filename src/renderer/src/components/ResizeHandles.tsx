import React from 'react'
import { useResize } from '../hooks/useResize'

const Handle: React.FC<{ dir: string }> = ({ dir }) => {
    const { onPointerDown } = useResize(dir)
    const cursor = dir === 'nw' || dir === 'se' ? 'nwse-resize' : 'nesw-resize'

    return (
        <div
            onPointerDown={onPointerDown}
            onPointerEnter={() => {
                ;(window as any).__isInteractingWithOverlay = true
                window.api?.setIgnoreMouseEvents(false)
            }}
            onPointerLeave={() => {
                if (!(window as any).__isResizingOverlay) {
                    ;(window as any).__isInteractingWithOverlay = false
                }
            }}
            style={{ cursor }}
            className={`resize-handle-adv handle-${dir} no-drag`}
        >
            <span className="resize-handle-indicator" style={{ cursor }} />
        </div>
    )
}

export const TopResizeHandles: React.FC = () => (
    <>
        <Handle dir="ne" />
        <Handle dir="nw" />
    </>
)

export const BottomResizeHandles: React.FC = () => (
    <>
        <Handle dir="se" />
        <Handle dir="sw" />
    </>
)

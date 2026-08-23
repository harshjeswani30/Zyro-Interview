import React from 'react'
import { useResize } from '../hooks/useResize'

const Handle: React.FC<{ dir: string }> = ({ dir }) => {
    const { onPointerDown } = useResize(dir)

    return (
        <div
            onPointerDown={onPointerDown}
            className={`resize-handle-adv handle-${dir} no-drag`}
        >
            <span className="resize-handle-indicator" />
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

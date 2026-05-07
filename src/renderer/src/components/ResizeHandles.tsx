import React from 'react'
import { useResize } from '../hooks/useResize'

const HANDLES = ['ne', 'nw', 'se', 'sw'] as const

const cursorMap: Record<string, string> = {
    n: 'n-resize',
    s: 's-resize',
    e: 'e-resize',
    w: 'w-resize',
    ne: 'ne-resize',
    nw: 'nw-resize',
    se: 'se-resize',
    sw: 'sw-resize'
}

const Handle: React.FC<{ dir: string }> = ({ dir }) => {
    const { onPointerDown } = useResize(dir)

    // Determine indicator style based on direction
    const getIndicatorStyle = (): React.CSSProperties => {
        const style: React.CSSProperties = {}
        const thickness = 4
        const size = 20
        const color = '#ff3333' // Bright Red

        if (dir === 'ne') {
            style.top = 0
            style.right = 0
            style.width = size
            style.height = size
            style.borderTop = `${thickness}px solid ${color}`
            style.borderRight = `${thickness}px solid ${color}`
            style.borderTopRightRadius = '100% 100%' // Smooth curve
        }
        if (dir === 'nw') {
            style.top = 0
            style.left = 0
            style.width = size
            style.height = size
            style.borderTop = `${thickness}px solid ${color}`
            style.borderLeft = `${thickness}px solid ${color}`
            style.borderTopLeftRadius = '100% 100%'
        }
        if (dir === 'se') {
            style.bottom = 0
            style.right = 0
            style.width = size
            style.height = size
            style.borderBottom = `${thickness}px solid ${color}`
            style.borderRight = `${thickness}px solid ${color}`
            style.borderBottomRightRadius = '100% 100%'
        }
        if (dir === 'sw') {
            style.bottom = 0
            style.left = 0
            style.width = size
            style.height = size
            style.borderBottom = `${thickness}px solid ${color}`
            style.borderLeft = `${thickness}px solid ${color}`
            style.borderBottomLeftRadius = '100% 100%'
        }

        return style
    }

    return (
        <div
            onPointerDown={onPointerDown}
            className={`resize-handle-adv handle-${dir} no-drag`}
            style={{
                position: 'absolute',
                cursor: cursorMap[dir],
                zIndex: 2147483647,
                pointerEvents: 'auto',
                backgroundColor: 'transparent',
                ...(dir === 'ne' && { top: 2, right: 2, width: 20, height: 20 }),
                ...(dir === 'nw' && { top: 2, left: 2, width: 20, height: 20 }),
                ...(dir === 'se' && { bottom: 2, right: 2, width: 20, height: 20 }),
                ...(dir === 'sw' && { bottom: 2, left: 2, width: 20, height: 20 })
            }}
        >
            <span className="resize-handle-indicator" style={getIndicatorStyle()} />
        </div>
    )
}

export const ResizeHandles: React.FC = () => (
    <>
        {HANDLES.map((dir) => (
            <Handle key={dir} dir={dir} />
        ))}
    </>
)

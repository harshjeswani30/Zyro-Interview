import React from 'react'

/*
 * Inline icon set for the redesigned overlay.
 *
 * Every glyph draws on the same 24x24 grid and carries the shared `.i` class,
 * so the stylesheet owns stroke width, line caps and sizing -- nothing here
 * sets those inline.
 */

function Glyph({ children }: { children: React.ReactNode }): React.ReactElement {
    return (
        <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
            {children}
        </svg>
    )
}

export function IconAuto(): React.ReactElement {
    return (
        <Glyph>
            <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
        </Glyph>
    )
}

export function IconManual(): React.ReactElement {
    return (
        <Glyph>
            <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 6a1.5 1.5 0 0 1 3 0v6M14 7.5a1.5 1.5 0 0 1 3 0V13M17 10a1.5 1.5 0 0 1 3 0v4a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.4L3.6 14a1.6 1.6 0 0 1 2.6-1.8L8 14" />
        </Glyph>
    )
}

export function IconMic(): React.ReactElement {
    return (
        <Glyph>
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
        </Glyph>
    )
}

export function IconCamera(): React.ReactElement {
    return (
        <Glyph>
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
            <circle cx="12" cy="13" r="3.5" />
        </Glyph>
    )
}

export function IconShield(): React.ReactElement {
    return (
        <Glyph>
            <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z" />
            <path d="M9.5 12l2 2 3.5-4" />
        </Glyph>
    )
}

export function IconMinimize(): React.ReactElement {
    return (
        <Glyph>
            <path d="M4 9h16M4 15h16" />
        </Glyph>
    )
}

export function IconExpand(): React.ReactElement {
    return (
        <Glyph>
            <path d="M9 9L4 4m0 5V4h5" />
            <path d="M15 9l5-5m-5 0h5v5" />
            <path d="M9 15l-5 5m0-5v5h5" />
            <path d="M15 15l5 5m-5 0h5v-5" />
        </Glyph>
    )
}

export function IconPower(): React.ReactElement {
    return (
        <Glyph>
            <path d="M12 3v9M18.4 6.6a8 8 0 1 1-12.8 0" />
        </Glyph>
    )
}

export function IconCopy(): React.ReactElement {
    return (
        <Glyph>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a1 1 0 0 1 1-1h10" />
        </Glyph>
    )
}

export function IconCheck(): React.ReactElement {
    return (
        <Glyph>
            <path d="M20 6L9 17l-5-5" />
        </Glyph>
    )
}

export function IconTrash(): React.ReactElement {
    return (
        <Glyph>
            <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
        </Glyph>
    )
}

export function IconArrowDown(): React.ReactElement {
    return (
        <Glyph>
            <path d="M12 5v14M6 13l6 6 6-6" />
        </Glyph>
    )
}

export function IconSend(): React.ReactElement {
    return (
        <Glyph>
            <path d="M5 12h13M13 6l6 6-6 6" />
        </Glyph>
    )
}

export function IconSparkle(): React.ReactElement {
    return (
        <Glyph>
            <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" />
        </Glyph>
    )
}

export function IconEqualizer(): React.ReactElement {
    return (
        <Glyph>
            <path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 12h2" />
        </Glyph>
    )
}

export function IconClock(): React.ReactElement {
    return (
        <Glyph>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
        </Glyph>
    )
}

export function IconAlert(): React.ReactElement {
    return (
        <Glyph>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16h.01" />
        </Glyph>
    )
}

export function IconChevronLeft(): React.ReactElement {
    return (
        <Glyph>
            <path d="M15 6l-6 6 6 6" />
        </Glyph>
    )
}

export function IconChevronRight(): React.ReactElement {
    return (
        <Glyph>
            <path d="M9 6l6 6-6 6" />
        </Glyph>
    )
}

export function IconClickThrough(): React.ReactElement {
    return (
        <Glyph>
            <path d="M4 4l7 16 2.8-6.2L20 11z" />
            <path d="M15 15l5 5" strokeDasharray="2 2" />
        </Glyph>
    )
}

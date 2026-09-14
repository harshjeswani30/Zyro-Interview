import React from 'react'
import {
    IconAuto,
    IconCamera,
    IconExpand,
    IconManual,
    IconMic,
    IconMinimize,
    IconPower,
    IconShield
} from './icons'

export interface OverlayDockProps {
    /** Short status line under the brand, e.g. "Listening" / "Composing". */
    statusText: string
    /** Animates the equalizer bars while audio is flowing. */
    speaking: boolean
    autoMode: boolean
    listening: boolean
    listenDisabled: boolean
    captureDisabled: boolean
    capturing?: boolean
    stealthOn: boolean
    minimized: boolean
    onModeChange: (auto: boolean) => void
    onToggleListen: () => void
    onCapture: () => void
    onToggleStealth: () => void
    onToggleMinimize: () => void
    onEnd: () => void
    onPointerDown?: (e: React.PointerEvent) => void
}

/** Top control dock: brand + status, mode switch, transport keys, window keys. */
export function OverlayDock({
    statusText,
    speaking,
    autoMode,
    listening,
    listenDisabled,
    captureDisabled,
    capturing = false,
    stealthOn,
    minimized,
    onModeChange,
    onToggleListen,
    onCapture,
    onToggleStealth,
    onToggleMinimize,
    onEnd,
    onPointerDown
}: OverlayDockProps): React.ReactElement {
    const isTranscribing =
        statusText.toLowerCase().includes('transcrib') ||
        statusText.toLowerCase().includes('processing manual')

    return (
        <header className={`dock glass ${isTranscribing ? 'is-transcribing' : ''}`} onPointerDown={onPointerDown}>
            <div className="brand">
                <span
                    className={`wave ${speaking || isTranscribing ? 'is-speaking' : ''} ${isTranscribing ? 'is-transcribing' : ''}`}
                    aria-label={isTranscribing ? 'Transcribing audio' : speaking ? 'Audio active' : 'Audio idle'}
                >
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                </span>
                <div className="status">
                    <span className="status__label">Zyro Live</span>
                    <div className="status__row">
                        <span className="status__value">{statusText}</span>
                        <span className="tag" role="img" aria-label="Screen protection on">◈</span>
                    </div>
                </div>
            </div>

            <div className="tray">
                <div className="key mode no-drag">
                    <span className="mlbl">Mode</span>
                    <div className="mtrack">
                        <span className="mthumb" />
                        <button
                            type="button"
                            className={`no-drag ${autoMode ? 'on' : ''}`}
                            onClick={() => onModeChange(true)}
                        >
                            <IconAuto />
                            <span>Auto</span>
                        </button>
                        <button
                            type="button"
                            className={`no-drag ${!autoMode ? 'on' : ''}`}
                            onClick={() => onModeChange(false)}
                        >
                            <IconManual />
                            <span>Manual</span>
                        </button>
                    </div>
                </div>

                <button
                    type="button"
                    className={`key no-drag ${listening ? 'on-ok' : ''}`}
                    onClick={onToggleListen}
                    disabled={listenDisabled}
                >
                    <span className="ico">
                        <IconMic />
                    </span>
                    <span className="txt">
                        <span className="lbl">{listening ? 'Stop' : 'Listen'}</span>
                        <span className="sc">Ctrl + Space</span>
                    </span>
                    <span className="led" />
                </button>

                <button
                    type="button"
                    className={`key no-drag ${capturing ? 'on-ok' : ''}`}
                    onClick={onCapture}
                    disabled={captureDisabled}
                >
                    <span className="ico">
                        <IconCamera />
                    </span>
                    <span className="txt">
                        <span className="lbl">Capture</span>
                        <span className="sc">Ctrl + S</span>
                    </span>
                    <span className="led" />
                </button>

                <button
                    type="button"
                    className={`key no-drag ${stealthOn ? 'on' : ''}`}
                    onClick={onToggleStealth}
                >
                    <span className="ico">
                        <IconShield />
                    </span>
                    <span className="txt">
                        <span className="lbl">Stealth</span>
                        <span className="sc">Ctrl + N</span>
                    </span>
                    <span className="led" />
                </button>
            </div>

            <div className="tray">
                <button
                    type="button"
                    className="key icon-only minimize-btn no-drag"
                    onClick={onToggleMinimize}
                    title={minimized ? 'Expand (Ctrl+M)' : 'Minimize (Ctrl+M)'}
                >
                    <span className="ico">{minimized ? <IconExpand /> : <IconMinimize />}</span>
                </button>
                <button
                    type="button"
                    className="key icon-only danger no-drag"
                    onClick={onEnd}
                    title="End session"
                >
                    <span className="ico">
                        <IconPower />
                    </span>
                </button>
            </div>
        </header>
    )
}


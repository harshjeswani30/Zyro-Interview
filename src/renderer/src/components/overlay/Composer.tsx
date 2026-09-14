import React from 'react'
import { IconSend, IconSparkle } from './icons'

export interface ComposerProps {
    value: string
    disabled: boolean
    onChange: (v: string) => void
    onSubmit: () => void
    inputRef?: React.Ref<HTMLInputElement>
}

/** Manual-mode question input pinned to the bottom of the feed. */
export function Composer({
    value,
    disabled,
    onChange,
    onSubmit,
    inputRef
}: ComposerProps): React.ReactElement {
    const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
        e.preventDefault()
        onSubmit()
    }

    return (
        <form className="composer no-drag" onSubmit={handleSubmit}>
            <div className="field">
                <span className="cprefix">
                    <IconSparkle />
                </span>
                <input
                    ref={inputRef}
                    type="text"
                    className="cinput no-drag"
                    placeholder="Ask Zyro anything…  (Manual mode)"
                    autoComplete="off"
                    value={value}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value)}
                />
                <button
                    type="submit"
                    className="send no-drag"
                    disabled={disabled || !value.trim()}
                >
                    <IconSend />
                </button>
            </div>
        </form>
    )
}


import { describe, expect, it } from 'vitest'
import {
  createInitialUpdaterState,
  onDownloadProgressState,
  onUpdateAvailableState,
  onUpdateDownloadedState,
  onUpdateErrorState
} from './updaterState'

describe('updaterState', () => {
  it('progresses cleanly idle -> available -> downloading -> ready', () => {
    let state = createInitialUpdaterState()
    expect(state.status).toBe('idle')

    const avail = onUpdateAvailableState(state, { version: '1.0.1' })
    expect(avail.shouldEmitAvailable).toBe(true)
    expect(avail.shouldEmitReadyInstead).toBe(false)
    state = avail.state
    expect(state.status).toBe('available')

    state = onDownloadProgressState(state, 42.9)
    expect(state.status).toBe('downloading')
    expect(state.progress).toBe(42)

    state = onUpdateDownloadedState({ version: '1.0.1' })
    expect(state.status).toBe('ready')
    expect(state.progress).toBe(100)
    expect(state.error).toBeNull()
  })

  it('ignores out-of-order progress ticks once ready', () => {
    const ready = onUpdateDownloadedState({ version: '1.0.1' })
    const next = onDownloadProgressState(ready, 15)
    expect(next).toEqual(ready)
  })

  it('emits ready instead of downgrading if update-available fires again for already-downloaded version', () => {
    const ready = onUpdateDownloadedState({ version: '1.0.1' })
    const res = onUpdateAvailableState(ready, { version: '1.0.1' })
    expect(res.state.status).toBe('ready')
    expect(res.shouldEmitReadyInstead).toBe(true)
    expect(res.shouldEmitAvailable).toBe(false)
  })

  it('ignores duplicate update-available while downloading same version', () => {
    const available = onUpdateAvailableState(createInitialUpdaterState(), { version: '1.0.1' }).state
    const downloading = onDownloadProgressState(available, 55)
    const res = onUpdateAvailableState(downloading, { version: '1.0.1' })
    expect(res.state.status).toBe('downloading')
    expect(res.state.progress).toBe(55)
    expect(res.shouldEmitAvailable).toBe(false)
  })

  it('falls back to available (not idle) on download error so user can retry', () => {
    const available = onUpdateAvailableState(createInitialUpdaterState(), { version: '1.0.1' }).state
    const downloading = onDownloadProgressState(available, 80)
    const failed = onUpdateErrorState(downloading, 'Checksum mismatch')
    expect(failed.status).toBe('available')
    expect(failed.info?.version).toBe('1.0.1')
    expect(failed.progress).toBe(0)
    expect(failed.error).toBe('Checksum mismatch')
  })

  it('stays idle when error occurs before any update info is found', () => {
    const failed = onUpdateErrorState(createInitialUpdaterState(), 'Network timeout')
    expect(failed.status).toBe('idle')
    expect(failed.info).toBeNull()
    expect(failed.error).toBe('Network timeout')
  })
})


export type UpdateStatus = 'idle' | 'available' | 'downloading' | 'ready'

export interface UpdateVersionInfo {
  version: string
  [key: string]: unknown
}

export interface AppUpdateState {
  status: UpdateStatus
  info: UpdateVersionInfo | null
  progress: number
  error: string | null
}

export function createInitialUpdaterState(): AppUpdateState {
  return {
    status: 'idle',
    info: null,
    progress: 0,
    error: null
  }
}

export function onUpdateAvailableState(
  prev: AppUpdateState,
  info: UpdateVersionInfo
): { state: AppUpdateState; shouldEmitReadyInstead: boolean; shouldEmitAvailable: boolean } {
  if (prev.status === 'ready' && prev.info?.version === info.version) {
    return { state: prev, shouldEmitReadyInstead: true, shouldEmitAvailable: false }
  }
  if (prev.status === 'downloading' && prev.info?.version === info.version) {
    return { state: prev, shouldEmitReadyInstead: false, shouldEmitAvailable: false }
  }
  return {
    state: { status: 'available', info, progress: 0, error: null },
    shouldEmitReadyInstead: false,
    shouldEmitAvailable: true
  }
}

export function onDownloadProgressState(prev: AppUpdateState, percent: number): AppUpdateState {
  // Never regress a completed download back to 'downloading' from stale/out-of-order ticks.
  if (prev.status === 'ready') return prev
  const clamped = Math.max(0, Math.min(100, Math.floor(Number.isFinite(percent) ? percent : 0)))
  return {
    ...prev,
    status: 'downloading',
    progress: clamped,
    error: null
  }
}

export function onUpdateDownloadedState(info: UpdateVersionInfo): AppUpdateState {
  return {
    status: 'ready',
    info,
    progress: 100,
    error: null
  }
}

export function onUpdateErrorState(prev: AppUpdateState, errorMessage: string): AppUpdateState {
  if (prev.status === 'ready' && prev.info) {
    return { ...prev, error: errorMessage }
  }
  if (prev.info) {
    return {
      ...prev,
      status: 'available',
      progress: 0,
      error: errorMessage
    }
  }
  return {
    status: 'idle',
    info: null,
    progress: 0,
    error: errorMessage
  }
}


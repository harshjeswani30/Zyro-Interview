const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Config Store
    getConfig: (key) => ipcRenderer.invoke('get-config', key),
    setConfig: (key, value) => ipcRenderer.invoke('set-config', key, value),
    getAllConfig: () => ipcRenderer.invoke('get-all-config'),
    
    // Transcription & AI
    transcribeChunk: (data) => ipcRenderer.invoke('transcribe-chunk', data),
    generateFinalResponse: (data) => ipcRenderer.invoke('generate-final-response', data),
    analyzeScreen: () => ipcRenderer.invoke('analyze-screen'),
    pickResume: () => ipcRenderer.invoke('pick-resume'),
    parsePdf: (data) => ipcRenderer.invoke('parse-pdf', data),
    clearMemory: () => ipcRenderer.invoke('clear-memory'),
    
    // Listeners
    onStatusChange: (callback) => ipcRenderer.on('status-change', (_event, value) => callback(value)),
    onLog: (callback) => ipcRenderer.on('log', (_event, value) => callback(value)),
    quitApp: () => ipcRenderer.send('app-quit'),
    toggleCompactMode: (isCompact) => ipcRenderer.invoke('toggle-compact-mode', isCompact),
    flashFrame: (shouldFlash) => ipcRenderer.send('flash-frame', shouldFlash),
    showNotification: (payload) => ipcRenderer.send('show-notification', payload),
    onNavToAgentChat: (callback) => ipcRenderer.on('nav-to-agent-chat', () => callback())
});

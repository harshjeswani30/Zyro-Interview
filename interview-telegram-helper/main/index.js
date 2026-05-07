const { app, BrowserWindow, ipcMain, screen, desktopCapturer, session, Notification: ElectronNotification, dialog: electronDialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('../store/configStore');
const { transcribeOnly, generateAIResponse, clearMemory, analyzeScreenProcess } = require('../services/aiPipeline');

// Move PDF require inside the handler to avoid startup collisions
let PDFParser; 

let mainWindow;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        frame: false,
        transparent: true,
        resizable: true, // Changed from false to true to ensure setSize works reliably
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
            autoplayPolicy: 'no-user-gesture-required'
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    const alwaysOnTop = store.get('alwaysOnTop');
    mainWindow.setAlwaysOnTop(alwaysOnTop);

    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
            if (sources.length > 0) {
                callback({ video: sources[0], audio: 'loopback' });
            }
        });
    });
}

app.whenReady().then(() => {
    // Set App User Model ID for Windows Toast Notifications
    if (process.platform === 'win32') {
        app.setAppUserModelId('com.zyro.interview.helper');
    }

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers
ipcMain.handle('get-config', (event, key) => store.get(key));
ipcMain.handle('set-config', (event, key, value) => {
    store.set(key, value);
    if (key === 'alwaysOnTop' && mainWindow) {
        mainWindow.setAlwaysOnTop(value);
    }
});

ipcMain.handle('toggle-compact-mode', (event, isCompact) => {
    if (!mainWindow) return;
    
    // Ensure window is in a state that allows resizing
    mainWindow.setResizable(true);
    
    if (isCompact) {
        mainWindow.setSize(380, 320); 
        mainWindow.setAlwaysOnTop(true);
        mainWindow.setResizable(false); // Lock it in compact mode
    } else {
        mainWindow.setSize(800, 600);
        mainWindow.setAlwaysOnTop(store.get('alwaysOnTop') || false);
        mainWindow.center();
        // Keep it resizable in full mode or lock it?
        // Let's keep it resizable: true for full mode as well for better stability
    }
});

// Native Notification Handler
ipcMain.on('show-notification', (event, { title, body }) => {
    const notif = new ElectronNotification({
        title,
        body,
        silent: true // We handle sound in the renderer
    });
    notif.show();
    notif.on('click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('nav-to-agent-chat');
        }
    });
});

ipcMain.on('flash-frame', (event, shouldFlash) => {
    if (mainWindow) mainWindow.flashFrame(shouldFlash);
});
ipcMain.handle('get-all-config', () => store.store);

ipcMain.on('app-quit', () => {
    app.quit();
});

// Handler for REAL-TIME transcription 
ipcMain.handle('transcribe-chunk', async (event, { base64Audio }) => {
    try {
        const tempPath = path.join(app.getPath('userData'), `chunk_${Date.now()}.webm`);
        fs.writeFileSync(tempPath, Buffer.from(base64Audio, 'base64'));

        const text = await transcribeOnly(tempPath);
        
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        
        return text;
    } catch (err) {
        console.error('Transcription chunk error:', err);
        return '';
    }
});

// Handler for FINAL AI response on stop
ipcMain.handle('generate-final-response', async (event, { fullText }) => {
    try {
        if (mainWindow) mainWindow.webContents.send('log', 'Reviewing transcript & filtering fillers...');
        const result = await generateAIResponse(fullText);
        return result;
    } catch (err) {
        if (mainWindow) mainWindow.webContents.send('log', `AI Error: ${err.message}`);
        throw err;
    }
});

// Handler for clearing AI memory
ipcMain.handle('clear-memory', () => {
    clearMemory();
    console.log('[Main] Conversation memory cleared.');
});

// Handler for Analyzing Screen (Screenshot -> LLaMA Vision -> Telegram)
ipcMain.handle('analyze-screen', async (event) => {
    try {
        if (mainWindow) {
            mainWindow.webContents.send('log', 'Capturing screen for analysis...');
            // Temporary hide to capture background only
            mainWindow.setOpacity(0);
            await sleep(200); // Wait for OS to register window as transparent
        }
        
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: screen.getPrimaryDisplay().size
        });
        
        if (mainWindow) mainWindow.setOpacity(1); // Restore opacity
        
        const primarySource = sources[0];
        if (!primarySource) throw new Error('No screen source found');

        const base64Image = primarySource.thumbnail.toDataURL();
        
        if (mainWindow) mainWindow.webContents.send('log', 'Analyzing image with AI Vision...');
        const result = await analyzeScreenProcess(base64Image);
        
        if (mainWindow) mainWindow.webContents.send('log', 'Screen analysis sent to Telegram.', 'success');
        return result;
    } catch (err) {
        if (mainWindow) mainWindow.webContents.send('log', `Screen Analysis Error: ${err.message}`, 'error');
        throw err;
    }
});

// Handler for Resume Selection
ipcMain.handle('pick-resume', async () => {
    const { canceled, filePaths } = await electronDialog.showOpenDialog({
        title: 'Select your Resume',
        filters: [{ name: 'Resume', extensions: ['pdf', 'txt', 'doc', 'docx'] }],
        properties: ['openFile']
    });
    
    if (canceled || filePaths.length === 0) return null;
    
    try {
        const buffer = fs.readFileSync(filePaths[0]);
        return {
            path: filePaths[0],
            data: buffer.toString('base64'),
            name: filePaths[0].split(/[\\/]/).pop()
        };
    } catch (err) {
        console.error('File pick error:', err);
        return null;
    }
});

// Handler for PDF Parsing (v2 API Support)
ipcMain.handle('parse-pdf', async (event, base64Data) => {

    try {
        const buffer = Buffer.from(base64Data, 'base64');
        
        // 1. Text Bypass
        if (!buffer.toString('utf-8', 0, 4).startsWith('%PDF')) {
            return buffer.toString('utf-8');
        }

        // 2. V2 Standard Parsing
        console.log('[Main] Processing PDF with v2 api...');
        const { PDFParse } = require('pdf-parse');
        
        if (!PDFParse) {
            throw new Error('PDFParse class not found in pdf-parse package.');
        }

        // Initialize parser with the new v2 signature
        const parser = new PDFParse({ data: buffer });
        
        try {
            const result = await parser.getText();
            return result.text || '';
        } finally {
            // Always free memory
            try { await parser.destroy(); } catch (e) { }
        }
    } catch (err) {
        console.error('Final PDF processing error:', err);
        throw err;
    }
});




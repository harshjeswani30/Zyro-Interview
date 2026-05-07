// UI Elements - Navigation
const navHome = document.getElementById('nav-home');
const navSettings = document.getElementById('nav-settings');
const navProfile = document.getElementById('nav-profile');
const viewHome = document.getElementById('view-home');
const viewSettings = document.getElementById('view-settings');
const viewProfile = document.getElementById('view-profile');
const pageTitle = document.getElementById('page-title');
const pageDesc = document.getElementById('page-desc');

// UI Elements - Settings Form
const tgTokenInput = document.getElementById('tg-token');
const tgChatIdInput = document.getElementById('tg-chat-id');
const groqKeyInput = document.getElementById('groq-key');
const audioDeviceSelect = document.getElementById('audio-device');
const toggleTopmost = document.getElementById('toggle-topmost');
const saveSettingsBtn = document.getElementById('save-settings');
const settingsStatus = document.getElementById('settings-status');

// UI Elements - Profile Wizard
const candidateNameInput = document.getElementById('candidate-name');
const targetRoleInput = document.getElementById('target-role');
const targetCompanyInput = document.getElementById('target-company');
const inviteLanguageSelect = document.getElementById('interview-language');
const codingLanguageSelect = document.getElementById('coding-language');

const uploadBtn = document.getElementById('upload-btn');
const dropArea = document.getElementById('drop-area');
const dzScanning = document.getElementById('dz-scanning');
const fileCard = document.getElementById('file-card');
const displayFilename = document.getElementById('display-filename');
const removeResumeBtn = document.getElementById('remove-resume-btn');
const resumeTextInput = document.getElementById('resume-text');

const experienceLevelSelect = document.getElementById('experience-level');
const expFields = document.getElementById('exp-fields');
const experienceDurationInput = document.getElementById('experience-duration');
const workHistoryInput = document.getElementById('work-history');
const saveAllProfileBtn = document.getElementById('save-all-profile');
const profileStatus = document.getElementById('profile-status');

const analyzeScreenBtn = document.getElementById('analyze-screen-btn');

// Wizard Navigation
const tabs = document.querySelectorAll('.wizard-tab');
const contents = document.querySelectorAll('.wizard-content');
const nextBtns = document.querySelectorAll('.next-step');
const prevBtns = document.querySelectorAll('.prev-step');
const quitAppBtn = document.getElementById('quit-app-btn');
const toggleCompactBtn = document.getElementById('toggle-compact-btn');

toggleCompactBtn.addEventListener('click', async () => {
    // Determine target state based on current class presence to stay in sync
    const targetCompact = !document.body.classList.contains('compact-mode');
    isCompact = targetCompact;
    
    document.body.classList.toggle('compact-mode', targetCompact);
    await window.api.toggleCompactMode(targetCompact);
});

quitAppBtn.addEventListener('click', () => {
    window.api.quitApp();
});

// UI Elements - Recording
const recordBtn = document.getElementById('record-btn');
const logPanel = document.getElementById('log-panel');
const statusLabel = document.getElementById('status-label');

let isRecording = false;
let isCompact = false;
let mediaRecorder = null;
let audioStream = null;
let fullTranscript = '';
let isFinalizing = false;
let currentRecordingPromise = null;
let currentRecorder = null;
let activeTranscriptLog = null; // Holds the active continuous transcription paragraph

// ─── Navigation ───────────────────────────────────────────────────
function showView(viewName) {
    [viewHome, viewSettings, viewProfile].forEach(v => v && v.classList.remove('active'));
    [navHome, navSettings, navProfile].forEach(n => n && n.classList.remove('active'));

    if (viewName === 'home') {
        navHome.classList.add('active');
        viewHome.classList.add('active');
        pageTitle.innerText = 'Interview';
        pageDesc.innerText = 'Real-time session capture.';
    } else if (viewName === 'settings') {
        navSettings.classList.add('active');
        viewSettings.classList.add('active');
        pageTitle.innerText = 'System Configuration';
        pageDesc.innerText = 'API Keys and Audio Routing';
        loadSettings();
    } else if (viewName === 'profile') {
        navProfile.classList.add('active');
        viewProfile.classList.add('active');
        pageTitle.innerText = 'Setup';
        pageDesc.innerText = 'Configure your profile and resume.';
        loadProfile();
    }
}

navHome.addEventListener('click', () => showView('home'));
navSettings.addEventListener('click', () => showView('settings'));
navProfile.addEventListener('click', () => showView('profile'));

// ─── Wizard Logic ──────────────────────────────────────────────────
function showStep(step) {
    tabs.forEach(t => t.classList.toggle('active', parseInt(t.dataset.step) === step));
    contents.forEach((c, idx) => c.classList.toggle('active', (idx + 1) === step));
}

nextBtns.forEach(btn => {
    btn.addEventListener('click', () => showStep(parseInt(btn.dataset.next)));
});

prevBtns.forEach(btn => {
    btn.addEventListener('click', () => showStep(parseInt(btn.dataset.prev)));
});

tabs.forEach(tab => {
    tab.addEventListener('click', () => showStep(parseInt(tab.dataset.step)));
});

// ─── Logging ──────────────────────────────────────────────────────
function addLog(msg, type = 'system') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerText = msg; // Removed timestamp for cleaner compact look
    
    logPanel.appendChild(entry);
    
    // Auto-pruning for compact look
    const maxEntries = isCompact ? 5 : 50;
    while (logPanel.children.length > maxEntries) {
        logPanel.removeChild(logPanel.firstChild);
    }
    
    logPanel.scrollTop = logPanel.scrollHeight;
    activeTranscriptLog = null;
}

window.api.onLog((msg) => addLog(msg, 'system'));

// ─── Settings Logic ──────────────────────────────────────────────
async function loadSettings() {
    const config = await window.api.getAllConfig();
    tgTokenInput.value = config.telegramBotToken || '';
    tgChatIdInput.value = config.telegramChatId || '';
    groqKeyInput.value = config.groqApiKey || '';
    audioDeviceSelect.value = config.audioDevice || '__system__';
    
    if (config.alwaysOnTop) toggleTopmost.classList.add('active');
}

toggleTopmost.addEventListener('click', async () => {
    const isActive = toggleTopmost.classList.toggle('active');
    await window.api.setConfig('alwaysOnTop', isActive);
});

saveSettingsBtn.addEventListener('click', async () => {
    await window.api.setConfig('telegramBotToken', tgTokenInput.value.trim());
    await window.api.setConfig('telegramChatId', tgChatIdInput.value.trim());
    await window.api.setConfig('groqApiKey', groqKeyInput.value.trim());
    await window.api.setConfig('audioDevice', audioDeviceSelect.value);
    await window.api.setConfig('alwaysOnTop', toggleTopmost.classList.contains('active'));
    
    settingsStatus.innerText = 'Saved for system.';
    setTimeout(() => settingsStatus.innerText = '', 3000);
});

// ─── Profile Logic ────────────────────────────────────────────────
async function loadProfile() {
    const config = await window.api.getAllConfig();
    candidateNameInput.value = config.candidateName || '';
    targetRoleInput.value = config.targetRole || '';
    targetCompanyInput.value = config.targetCompany || '';
    inviteLanguageSelect.value = config.interviewLanguage || 'en-US';
    codingLanguageSelect.value = config.codingLanguage || 'Python';
    
    resumeTextInput.value = config.resumeText || '';
    if (config.resumeFileName) {
        displayFilename.innerText = config.resumeFileName;
        dropArea.classList.add('hidden');
        fileCard.classList.remove('hidden');
    } else {
        dropArea.classList.remove('hidden');
        fileCard.classList.add('hidden');
    }
    
    experienceLevelSelect.value = config.experienceLevel || 'fresher';
    experienceDurationInput.value = config.experienceDuration || '';
    workHistoryInput.value = config.workHistory || '';
    expFields.style.display = (experienceLevelSelect.value === 'experienced') ? 'block' : 'none';
    showStep(config.setupStep || 1);
}

experienceLevelSelect.addEventListener('change', () => {
    expFields.style.display = (experienceLevelSelect.value === 'experienced') ? 'block' : 'none';
});

const handleResumeUpload = async (file) => {
    if (!file) return;
    
    // Show Scanning State
    dzScanning.classList.remove('hidden');
    
    try {
        const text = await window.api.parsePdf(file.data);
        resumeTextInput.value = text;
        displayFilename.innerText = file.name;
        
        await window.api.setConfig('resumeFileName', file.name);
        await window.api.setConfig('resumeText', text);
        
        // Success Transition
        dropArea.classList.add('hidden');
        fileCard.classList.remove('hidden');
    } catch (err) {
        console.error('Upload error:', err);
        alert('Resume Parse Failed. Please try a different format.');
    } finally {
        dzScanning.classList.add('hidden');
    }
};

uploadBtn.addEventListener('click', async (e) => {
    e.stopPropagation(); // Prevent droparea click
    const file = await window.api.pickResume();
    handleResumeUpload(file);
});

dropArea.addEventListener('click', async () => {
    const file = await window.api.pickResume();
    handleResumeUpload(file);
});

// Drag & Drop
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
    }, false);
});

dropArea.addEventListener('drop', async (e) => {
    const file = e.dataTransfer.files[0];
    if (file && (file.type === 'application/pdf' || file.name.endsWith('.txt'))) {
        // We need to read the file into base64 because Electron's handle expects it
        const reader = new FileReader();
        reader.onload = async () => {
            const base64Data = reader.result.split(',')[1];
            handleResumeUpload({
                name: file.name,
                data: base64Data
            });
        };
        reader.readAsDataURL(file);
    }
});

removeResumeBtn.addEventListener('click', async () => {
    await window.api.setConfig('resumeFileName', '');
    await window.api.setConfig('resumeText', '');
    resumeTextInput.value = '';
    
    fileCard.classList.add('hidden');
    dropArea.classList.remove('hidden');
});

saveAllProfileBtn.addEventListener('click', async () => {
    await window.api.setConfig('candidateName', candidateNameInput.value.trim());
    await window.api.setConfig('targetRole', targetRoleInput.value.trim());
    await window.api.setConfig('targetCompany', targetCompanyInput.value.trim());
    await window.api.setConfig('interviewLanguage', inviteLanguageSelect.value);
    await window.api.setConfig('codingLanguage', codingLanguageSelect.value);
    await window.api.setConfig('experienceLevel', experienceLevelSelect.value);
    await window.api.setConfig('experienceDuration', experienceDurationInput.value.trim());
    await window.api.setConfig('workHistory', workHistoryInput.value.trim());
    await window.api.setConfig('autoAnswer', true);
    await window.api.setConfig('setupStep', 3);
    
    profileStatus.innerText = 'Profile synchronized successfully!';
    setTimeout(() => profileStatus.innerText = '', 3000);
});

// ─── Recording Logic (Circular & Stealth + VAD) ─────────────────
async function captureAndTranscribeChunk(audioCtx, analyser, dataArray) {
    if (!isRecording || isFinalizing) return;

    currentRecordingPromise = new Promise((resolve) => {
        // VAD: Ensure audio is above threshold before recording
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        
        // Match original threshold (15 for frequency bin avg)
        if (avg < 15) {
            setTimeout(resolve, 500); // Check again soon
            return;
        }

        const mimeType = 'audio/webm;codecs=opus';
        currentRecorder = new MediaRecorder(audioStream, { mimeType, audioBitsPerSecond: 128000 });
        const chunks = [];

        currentRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        currentRecorder.onstop = async () => {
            currentRecorder = null;
            if (chunks.length === 0) { resolve(); return; }
            const blob = new Blob(chunks, { type: mimeType });
            const reader = new FileReader();
            reader.onloadend = async () => {
                const base64Audio = reader.result.split(',')[1];
                try {
                    const text = await window.api.transcribeChunk({ base64Audio });
                    if (text && text.trim().length > 1) {
                        const cleaned = text.trim();
                        fullTranscript += ' ' + cleaned;
                        
                        if (!activeTranscriptLog) {
                            activeTranscriptLog = document.createElement('div');
                            activeTranscriptLog.className = 'log-entry success';
                            logPanel.appendChild(activeTranscriptLog);
                        }
                        
                        const words = (activeTranscriptLog.innerText + ' ' + cleaned).split(' ');
                        // Keep only last ~25 words to ensure it stays in view and "pushes up"
                        if (words.length > 25) {
                            activeTranscriptLog.innerText = '... ' + words.slice(-25).join(' ');
                        } else {
                            activeTranscriptLog.innerText = words.join(' ').trim();
                        }
                        
                        // Prune other log entries to focus on transcript
                        while (logPanel.children.length > 5) {
                            if (logPanel.firstChild === activeTranscriptLog) break; 
                            logPanel.removeChild(logPanel.firstChild);
                        }
                        
                        logPanel.scrollTop = logPanel.scrollHeight;
                    }
                } catch (err) {}
                resolve();
            };
            reader.readAsDataURL(blob);
        };

        currentRecorder.start();
        setTimeout(() => { if (currentRecorder && currentRecorder.state === 'recording') currentRecorder.stop(); }, 4000);
    });

    return currentRecordingPromise;
}

async function startSession() {
    try {
        const device = audioDeviceSelect.value;
        fullTranscript = '';
        isFinalizing = false;
        
        // Clear log panel for fresh conversation
        logPanel.innerHTML = '';
        activeTranscriptLog = null;

        // Optionally clear memory on new session
        if (window.api.clearMemory) window.api.clearMemory();

        if (device === '__system__') {
            audioStream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: 1, height: 1 },
                audio: { 
                    echoCancellation: false, 
                    sampleRate: 16000,
                    suppressLocalAudioPlayback: false
                }
            });
            audioStream.getVideoTracks().forEach(t => t.stop());
        } else {
            audioStream = await navigator.mediaDevices.getUserMedia({ 
                audio: { deviceId: device === 'default' ? undefined : { exact: device }, sampleRate: 16000 }
            });
        }
        
        // Setup Audio Analyser for VAD
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(audioStream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        isRecording = true;
        updateBtnState('listening');
        addLog('Capture Active (Production Mode)', 'system');

        const runLoop = async () => {
            while (isRecording && !isFinalizing) await captureAndTranscribeChunk(audioCtx, analyser, dataArray);
        };
        runLoop();

    } catch (err) {
        addLog(`Capture Error: ${err.message}`, 'error');
        updateBtnState('idle');
    }
}

async function stopSession() {
    if (isFinalizing) return;
    isFinalizing = true;
    updateBtnState('processing');
    addLog('Analyzing session...', 'system');

    // Force stop the active recorder to trigger immediate Whisper transcription for the final chunk
    if (currentRecorder && currentRecorder.state === 'recording') {
        currentRecorder.stop();
    }

    // Wait for the final active chunk to be transcribed and appended
    if (currentRecordingPromise) {
        await currentRecordingPromise;
    }

    try {
        if (fullTranscript.trim().length > 5) {
            await window.api.generateFinalResponse({ fullText: fullTranscript.trim() });
            addLog('Expert response delivered to Telegram.', 'success');
        } else {
            addLog('No conversation detected.', 'error');
        }
    } catch (err) {
        addLog(`Expert AI Error: ${err.message}`, 'error');
    } finally {
        isRecording = false;
        isFinalizing = false;
        activeTranscriptLog = null;
        updateBtnState('idle');
        if (audioStream) audioStream.getTracks().forEach(t => t.stop());
    }
}

recordBtn.addEventListener('click', async () => {
    if (isRecording) await stopSession();
    else await startSession();
});

analyzeScreenBtn.addEventListener('click', async () => {
    try {
        if (isRecording || isFinalizing) return;
        
        analyzeScreenBtn.disabled = true;
        analyzeScreenBtn.classList.add('loading');
        const textLabel = analyzeScreenBtn.querySelector('.btn-text');
        const originalText = textLabel.innerText;
        textLabel.innerText = 'Scanning...';
        
        await window.api.analyzeScreen();
        
        textLabel.innerText = originalText;
        analyzeScreenBtn.classList.remove('loading');
        analyzeScreenBtn.disabled = false;
    } catch (err) {
        addLog(`Analyze Error: ${err.message}`, 'error');
        analyzeScreenBtn.disabled = false;
        analyzeScreenBtn.classList.remove('loading');
        analyzeScreenBtn.querySelector('.btn-text').innerText = 'Analyze';
    }
});

function updateBtnState(state) {
    recordBtn.classList.remove('recording', 'loading');
    const textLabel = recordBtn.querySelector('.btn-text');
    
    if (state === 'listening') {
        recordBtn.classList.add('recording');
        textLabel.innerText = 'Stop';
        statusLabel.innerText = 'Listening...';
        recordBtn.disabled = false;
    } else if (state === 'processing') {
        recordBtn.classList.add('loading');
        textLabel.innerText = '...';
        statusLabel.innerText = 'Finalizing...';
        recordBtn.disabled = true;
    } else {
        textLabel.innerText = 'Listen';
        statusLabel.innerText = 'Ready';
        recordBtn.disabled = false;
    }
}

// Initial Load
loadSettings();
loadProfile();
addLog('System Online.');

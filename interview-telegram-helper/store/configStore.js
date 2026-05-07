const Store = require('electron-store');

const schema = {
    // API Keys
    telegramBotToken: { type: 'string', default: '' },
    telegramChatId: { type: 'string', default: '' },
    groqApiKey: { type: 'string', default: '' },
    
    // Application Settings
    alwaysOnTop: { type: 'boolean', default: true },
    audioDevice: { type: 'string', default: '__system__' },
    autoAnswer: { type: 'boolean', default: true },

    // Candidate Profile (Step 1)
    candidateName: { type: 'string', default: '' },
    targetRole: { type: 'string', default: '' },
    targetCompany: { type: 'string', default: '' },
    interviewLanguage: { type: 'string', default: 'en-US' },
    codingLanguage: { type: 'string', default: 'Python' },

    // Resume Data (Step 2)
    resumeText: { type: 'string', default: '' },
    resumeFileName: { type: 'string', default: '' },

    // Experience Details (Step 3)
    experienceLevel: { type: 'string', default: 'fresher' }, // 'fresher' | 'experienced'
    experienceDuration: { type: 'string', default: '' },
    workHistory: { type: 'string', default: '' },
    
    // Session State
    setupStep: { type: 'number', default: 1 }
};

const store = new Store({ schema });

module.exports = store;

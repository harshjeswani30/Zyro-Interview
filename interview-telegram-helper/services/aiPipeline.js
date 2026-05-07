const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const store = require('../store/configStore');

// ─── Transcription & Filler Filter ────────────────────────────────
function cleanTranscript(text) {
    if (!text) return '';
    
    // Aggressive Filler Blacklist (Mirrored from user request)
    const blacklist = [
        'hello', 'hi', 'hey', 'thank you', 'thanks', 'thanku', 
        'subscribe', 'bye', 'good morning', 'good evening', 
        'good afternoon', 'how are you', 'how r u', 'thanks for watching',
        'uh', 'um', 'ah', 'please subscribe', 'subtitle by'
    ];
    
    let cleaned = text;
    
    // 1. Remove specific standalone hallucination phrases
    blacklist.forEach(phrase => {
        const regex = new RegExp(`\\b${phrase}\\b[.,!?;:]?`, 'gi');
        cleaned = cleaned.replace(regex, '');
    });
    
    // 2. Clean up double spaces or trailing punctuation
    cleaned = cleaned.replace(/\s+/g, ' ').replace(/^\s*[,.!?;:]\s*/, '').trim();
    
    return cleaned;
}

async function transcribeOnly(filePath) {
    const groqKey = store.get('groqApiKey');
    if (!groqKey) throw new Error('Missing Groq API Key.');

    const openai = new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' });

    try {
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: 'whisper-large-v3',
            prompt: 'This is a technical interview. Do not include greetings or fillers.'
        });
        return cleanTranscript(transcription.text || '');
    } catch (error) {
        console.error('[STT Error]:', error.message);
        return '';
    }
}

// ─── AI Response Helpers ──────────────────────────────────────────

let conversationHistory = [];

async function getGroqClient() {
    const groqKey = store.get('groqApiKey');
    if (!groqKey) throw new Error('Missing Groq API Key.');
    return {
        openai: new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' })
    };
}

function extractProfileContext(config) {
    return {
        name: config.candidateName || 'Candidate',
        role: config.targetRole || 'Software Engineer',
        company: config.targetCompany || '',
        expLevel: config.experienceLevel || 'fresher',
        expDuration: config.experienceDuration || '',
        workHistory: config.workHistory || '',
        codingLang: config.interviewLanguage || 'Python',
        resume: config.resumeText || ''
    };
}

function getExperienceContext(name, role, company, experienceLevel, experienceDuration, workHistory) {
    const targetCompany = company ? `"${company}"` : 'the company';
  
    if (experienceLevel === 'fresher') {
      return `
⚠️ EXPERIENCE LEVEL — FRESHER:
- You are a FRESHER with NO prior full-time paid work experience.
- "${targetCompany}" is the company you are CURRENTLY interviewing for.
- Highlight project achievements as primary evidence of skill.
`;
    }
  
    return `
⚠️ EXPERIENCE LEVEL — EXPERIENCED:
- You have ${experienceDuration} of experience.
- PAST WORK HISTORY: ${workHistory || 'As per resume'}.
- NEVER claim more than ${experienceDuration} of experience.
`;
}

function getIntroTemplate(name, role, company, experienceLevel, experienceDuration, workHistory) {
    if (experienceLevel === 'fresher') {
        return `I am ${name}, a ${role}${company ? ` applying for ${company}` : ''}. I recently completed my studies and built projects demonstrating skills in tech stack mentioned in resume.`;
    }
    return `I am ${name}, a ${role} with ${experienceDuration} of experience focusing on ${workHistory}.`;
}

function buildSystemPrompt(name, role, company, expLevel, expDuration, workHistory, codingLang, resume) {
    const expContext = getExperienceContext(name, role, company, expLevel, expDuration, workHistory);
    const introTemplate = getIntroTemplate(name, role, company, expLevel, expDuration, workHistory);

    return `
You are the brain of "Interview Pro", an elite AI interview assistant.
CANDIDATE: ${name}
ROLE: ${role}
COMPANY: ${company}
LANGUAGE: ${codingLang}

${expContext}

### IDENTITY & TONE:
- You ARE ${name}. Use first person ("I", "Me").
- BE CONCISE BUT COMPLETE. Provide enough detail to sound like a solid answer, but no rambling.
- TONE & LANGUAGE: Use very simple "10th class Indian English". Do not use heavy vocabulary or complex sentences. Speak naturally and casually so it's easy to dictate quickly.
- NO greetings/filler ("Hello", "Certainly", "Great question", "Sure"). Start your answer immediately.

### CORE CONSTRAINTS:
1. MAX LENGTH: Around 5 to 7 simple lines/sentences MAX for any answer.
2. TECHNICAL: Give the main core concept in simple terms along with a tiny detail or example.
3. PROJECTS: Explain your work and tech stack in about 3 lines max.
4. MCQs: If the interviewer asks an MCQ (giving options like A, B, C, D), FIRST output the raw direct correct answer on line 1. Underneath it, give a short 2-3 line simple explanation of why it is correct.
5. INTRODUCTIONS: **ONLY IF** the interviewer explicitly asks "Tell me about yourself" or "Introduce yourself", use this base: ${introTemplate}. **OTHERWISE, DO NOT introduce yourself or say your name.** Answer ONLY what is specifically asked in the question.
6. FOLLOW-UPS: If the question is short or a follow-up (like "Why?", "Can you explain more?", "What about the other?"), look at the RECENT CONVERSATION to understand the context and answer smartly.
7. CODE: Always use ${codingLang}.
8. HISTORY: Only use details from the RESUME below.

### RESUME SOURCE OF TRUTH:
${resume.substring(0, 4000)}
`;
}

function updateHistory(role, content) {
    conversationHistory.push({ role, content });
    if (conversationHistory.length > 10) conversationHistory.shift();
}

function getHistoryContext() {
    if (conversationHistory.length === 0) return '';
    return `\n### RECENT CONVERSATION:\n${conversationHistory.map(h => `${h.role === 'user' ? 'Interviewer' : 'Me'}: ${h.content}`).join('\n')}\n`;
}

// ─── Main AI Pipelines ───────────────────────────────────────────

async function generateAIResponse(fullText) {
    const finalTranscript = cleanTranscript(fullText);
    if (!finalTranscript || finalTranscript.length < 5) throw new Error('Empty transcript.');

    const config = store.get();
    const telegramToken = config.telegramBotToken;
    const telegramChatId = config.telegramChatId;
    
    const { name, role, company, expLevel, expDuration, workHistory, codingLang, resume } = extractProfileContext(config);
    const systemPrompt = buildSystemPrompt(name, role, company, expLevel, expDuration, workHistory, codingLang, resume);
    const historyContext = getHistoryContext();

    const { openai } = await getGroqClient();

    try {
        const completion = await openai.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${historyContext}Interviewer: ${finalTranscript}` }
            ],
            temperature: 0.7
        });

        const answer = completion.choices[0].message.content;
        updateHistory('user', finalTranscript);
        updateHistory('assistant', answer);

        if (telegramToken && telegramChatId) {
            await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: telegramChatId, text: `🎤 *Audio Question:* \n${finalTranscript}\n\n💡 *Answer:* \n${answer}`, parse_mode: 'Markdown' })
            });
        }

        return { transcript: finalTranscript, answer };
    } catch (error) {
        throw error;
    }
}

async function analyzeScreenProcess(base64Image) {
    const config = store.get();
    const telegramToken = config.telegramBotToken;
    const telegramChatId = config.telegramChatId;

    if (!telegramToken || !telegramChatId) throw new Error("Telegram credentials missing.");

    const { openai } = await getGroqClient();
    const { name, role, company, expLevel, expDuration, workHistory, codingLang, resume } = extractProfileContext(config);
    const systemPrompt = buildSystemPrompt(name, role, company, expLevel, expDuration, workHistory, codingLang, resume);

    const completion = await openai.chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Analyze this screen. Answer any interview question found.' },
                    { type: 'image_url', image_url: { url: base64Image } }
                ]
            }
        ],
        temperature: 0.7,
        max_tokens: 1024
    });

    const answer = completion.choices[0].message.content;

    await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramChatId, text: `📸 *Screen Analyzed* \n\n💡 *Answer:* \n${answer}`, parse_mode: 'Markdown' })
    });

    return answer;
}

function clearMemory() {
    conversationHistory = [];
}

module.exports = { transcribeOnly, generateAIResponse, clearMemory, analyzeScreenProcess };

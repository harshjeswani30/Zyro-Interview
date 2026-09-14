# Zyro Setup UI - Content Reference for Redesign

This document contains all the text, labels, placeholders, buttons, tooltips, and structural content from the `SetupPage.tsx` wizard. It is intended to be used by the Fabel team for a complete UI redesign of the Setup App.

---

## 1. Global / Shell Elements

### Sidebar (Left Navigation)
- **Menu Items (Steps)**:
  - Step 1: Tell us about you
  - Step 2: Resume Library
  - Step 3: Interview Content
  - Step 4: Final Check
  - Scheduled Sessions
- **Bottom Stats**:
  - **Sessions**: [Value]
  - **Free Trial**: [Formatted Time]

### Header Actions
- **Tooltips/Buttons**:
  - "Real-time Cloud Sync Active"
  - "Minimize"
  - "Close App"

### Footer Navigation
- **Buttons**:
  - **Back** (Available on steps 2, 3, and Final Check)
  - **Next** (Available on steps 1, 2, and 3)
  - **Start Interview** (Available on Final Check)

---

## 2. Main Setup Steps

### Step 1: Tell us about you
**Header:** 
- Title: `Tell us about you`
- Subtitle (Teleprompter): `Configure your profile, target role, and interview preferences.`

**Fields & Content:**
- **Auto-Answer Mode (Toggle Card)**
  - Title: `Auto-Answer Mode`
  - Badge: `BETA`
  - Description: `AI operates continuously, automatically answering every 5 seconds.`
- **Your Full Name \***
  - Placeholder: `e.g. Rahul Sharma`
- **Applying for Role \***
  - Placeholder: `e.g. Software Engineer`
- **Company (Interviewing For)**
  - Placeholder: `e.g. Google`
- **Answer Language(s) \***
  - Sub-label tags: `Dual mode` / `Single mode`
  - Description: `Reply in {Selected Language(s)}. Any other spoken language falls back to English. (Pick up to 2.)`
  - Dropdown Options: English, Hindi, Spanish, French, German, Italian, Japanese, Dutch, Portuguese, Russian
- **Preferred Coding Language \***
  - Sub-label tag: `DSA & Code Output`
  - Dropdown Options: Python, JavaScript, TypeScript, Java, C++, SQL, C#, Go, Rust, Kotlin, Swift, PHP, Ruby
- **Experience Level \***
  - Buttons: `🎓 Fresher` | `💼 Experienced`
  - *If Experienced is selected:*
    - Duration Placeholder: `How long? e.g. 6 months, 1 year, 2.5 years`
    - History Placeholder: `(Optional) Past work details — e.g. Worked at TechCorp as a React developer for 1 year, built an e-commerce platform.`
    - Sub-description: `If left blank, AI will only mention your experience duration without any past work details.`

---

### Step 2: Resume Library
**Header:** 
- Title: `Resume Library`
- Subtitle (Teleprompter): `Upload, manage, and select your target resume for this session.`

**Input Modes (Toggle):** `Upload PDF Document` | `Paste Plain Text`

**Mode A: Upload PDF Document**
- Upload Button Title: `Select PDF Resume`
- Upload Button Subtitle: `Click to browse your documents (.pdf format)`
- Parsing State Button: `Parse & Save` (Changes to `Parsing...` when active)
- Cancel Button: `Cancel`

**Mode B: Paste Plain Text**
- **Resume Version / Profile Title \***
  - Placeholder: `e.g. Senior Frontend Resume (React & TS)`
- **Resume Details / Experience Text \***
  - Info: `{count} chars`
  - Placeholder: `Paste your resume content, summary, skills, past experience, projects, or education here...`
- Action Buttons: `Clear`, `Save & Add to Library` (Changes to `Refining...` when active)

**Saved Resumes List:**
- Title: `Saved Resumes ({count})`
- Description: `Select active resume for AI prompt context`
- List Item Info: `ID: {id} • {count} chars`
- Badge for selected item: `ACTIVE`
- Action Tooltip: `Delete Resume`
- Empty State Message: `No resumes added yet. Upload a PDF or paste text above.`

---

### Step 3: Interview Content (Knowledge Base)
**Header:** 
- Title: `Interview Content`
- Subtitle (Teleprompter): `Upload company documents, preparation notes, and cheat sheets.`

**Add Material Form (When Active):**
- Form Title: `Add Preparation Material`
- Form Subtitle: `Notes, cheat sheets & QA docs for live AI matching`
- Button: `Cancel`
- **Title / Topic Name \***
  - Placeholder: `e.g. Google System Design, Behavioral QA, Cheat Sheet`
- **Content (Paste Plain Text or Q&A) \***
  - Info: `{count} characters`
  - Placeholder: `Paste interview questions and answers, documentation, cheat sheets, or technical notes here. The AI will search this material instantly when asked a relevant question.`

**Knowledge Base Grid View:**
- **General AI Mode (Default Card)**
  - Title: `General AI Mode`
  - Badge: `Active` / `Default`
  - Description: `Standard interview assistant mode using general knowledge & candidate resume.`
  - Footer Meta: `Full AI Capability`
- **Custom Saved Material (Dynamic Cards)**
  - Badge: `Active` / `Ready`
  - Description: `On-device vector indexed material for real-time interview lookup.`
  - Footer Meta: `Local Vector Storage`
  - Action Tooltip: `Delete Material`
- **Empty State (Add Button):**
  - Title: `Add Material`
  - Description: `Cheat sheets, notes & QA docs`

---

### Step 4: Final Check
**Header:** 
- Title: `Final Check`
- Subtitle (Teleprompter): `Verify your interview configuration before launching the assistant.`

**Summary Grid (4 Cards):**
1. **Profile**
   - Content: `{Name}`
   - Sub-content: `{Role} @ {Company}` or `Profile configured`
2. **Resume**
   - Content: `{Selected Resume Name}`
   - Sub-content: `✓ Attached & Indexed` or `No Resume Selected`
3. **Coding Syntax**
   - Content: `{Selected Language}`
   - Sub-content: `DSA & Solution Architecture`
4. **AI Mode**
   - Content: `⚡ Auto-Answer Active` or `🎯 Manual Trigger`
   - Sub-content: `Instant automatic responses` or `Press hotkey for answers`

**Global Hotkeys Control Panel:**
- Header: `⚡ Overlay Shortcuts & Controls`
- Sub-header: `Active During Live Interview`
- Cards:
  - **Disappear Mode** (`Ctrl+B`): `Instant stealth toggle — hides overlay window from screen immediately during live camera checks & screen sharing`
  - **Stealth Protection** (`Ctrl+N`): `Hardware-level screen protection shield — prevents Zoom, Teams, and Google Meet from recording or capturing this window`
  - **Speech Audio** (`Ctrl+Space`): `Real-time dual audio capture — listens to interviewer questions from system audio or microphone and automatically transcribes`
  - **Screen OCR Scan** (`Ctrl+S`): `AI vision screen grabber — instantly analyzes coding challenges, diagrams, and technical interview questions from your screen`
  - **Auto-Answer Mode** (`Ctrl+A`): `Hands-free intelligent AI engine — automatically detects completed questions and generates context-aware answers without manual keypresses`
  - **Scroll & Zoom** (`↑↓` / `Ctrl±`): `Quick reading navigation — use up/down arrow keys to scroll through AI answers and Ctrl +/- to adjust font scale dynamically`

---

### Step: Scheduled Sessions
**Header:** 
- Title: `Scheduled Sessions`
- Subtitle (Teleprompter): `Schedule your upcoming interviews. Overlay auto-launches at the set time — credits pre-verified.`

**Schedule Creator Card:**
- Title: `Schedule an Interview`
- Subtitle: `Set up your target role, date & time, and attached resume`
- **Session Label / Title \***
  - Placeholder: `e.g. Google L5 Frontend Round 1`
- **Target Date \***
  - Placeholder: `Select target date...`
- **Target Time \***
  - Placeholder: `Select target time...`
- **Applying for Role \***
  - Placeholder: `e.g. Senior Frontend Developer`
- **Company (Optional)**
  - Placeholder: `e.g. Google, Amazon, Meta`
- **Target Resume \***
  - Tags: `✓ Attached` / `{count} available`
  - Dropdown Empty State: `No resumes found. Please upload one in the Resume Library tab.`
  - Placeholder: `Select target resume for this interview...`
- **Live Preview Pill:**
  - Status Messages: `Starts in {time}`, `⚠️ Time already passed`
- **Notice Alert:**
  - `1 Credit Pre-Verification: 1 credit is temporarily held at scheduling. Actual credit deduction happens dynamically at the end of the session based on exact minutes used (1 credit = 1 hour).`

**Scheduled Sessions List:**
- **Empty State:**
  - Title: `No upcoming sessions scheduled`
  - Description: `Pick a date and time above to schedule an interview. The overlay will automatically launch when the time arrives.`
- **Item Meta:**
  - Badges for: Role, Company (`@{company}`)
  - Sub-labels: Date/Time, Selected Resume Name
  - Status Chip: `Starts in {time}` or `Starting momentarily...`
- **Action Buttons:**
  - `Launch Now` (Tooltip: `Start interview immediately with this session's configuration`)
  - `Cancel` (Tooltip: `Cancel this scheduled session and release hold`)

---

## 3. Paywall / Alerts overlay

**Paywall Modal:**
- Pill Badge: `0 Sessions Left`
- Title: `Refill Sessions`
- Subtitle: `Get more sessions to start live AI interviews.`
- Feature Highlights:
  - `⚡ Real-time AI`
  - `🔒 100% Stealth`
  - `📁 Local RAG`
  - `🗣️ Hindi & English`
- Buttons:
  - `Get Sessions`
  - `Dismiss`

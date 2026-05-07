# Interview Telegram Helper 🎧

A production-level cross-platform desktop application built with Electron to provide real-time interview support. It captures system audio, transcribes it via Groq's Whisper API, processes it with LLMs (Llama 3/Mixtral), and sends the response directly to a Telegram channel.

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: Latest stable version.
- **FFmpeg**: Must be installed and added to your system's PATH.
- **VB-Audio Virtual Cable**: Required to route "system output" as an "audio input".

### 2. FFmpeg Installation
- **Windows**: Download from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), extract, and add the `bin` folder to your System Environment Variables (PATH).
- **Verify**: Open terminal and type `ffmpeg -version`.

### 3. Audio Routing (VB-Cable)
1. Install [VB-Cable](https://vb-audio.com/Cable/).
2. Set your System Output device to **CABLE Input (VB-Audio Virtual Cable)**.
3. In this app's **Settings**, select **CABLE Output (VB-Audio Virtual Cable)** as the Audio Input Device.

### 4. Installation
```bash
# Clone the project and navigate to directory
cd interview-telegram-helper

# Install dependencies
pnpm install
```

### 5. Running the App
```bash
pnpm start
```

### 6. Building the Executable (.exe)
```bash
pnpm build
```

## 🛠 Features
- **Clean Modern UI**: Dark theme with glassmorphism, mirroring the original Zyro AI design.
- **Real-time Pipeline**: Start recording with one click, and get results in Telegram seconds later.
- **Secure Persistence**: API keys and model preferences are saved locally via `electron-store`.
- **Always-on-top**: Keep the controller visible while interviewing.

## ⚙️ Configuration
Enter the following in the **Settings** tab:
- **Telegram Bot Token**: From @BotFather.
- **Telegram Chat ID**: Use @userinfobot to find your ID or channel ID.
- **Groq API Key**: From [Groq Console](https://console.groq.com/keys).
- **Model Selection**: Choose between Llama 3.3 70B (High Quality) or Llama 3.1 8B (Fast).

---
*Created by Zyro AI*

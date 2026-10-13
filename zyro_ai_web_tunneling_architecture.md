# Zyro AI: Web Tunneling & Session Hijacking Architecture

This document outlines the complete logic, mechanism, and architecture for implementing a "Bring Your Own Subscription" (BYOS) feature in the Zyro AI app. This allows users to connect their personal ChatGPT Plus or Claude Pro accounts, enabling Zyro AI to use their web sessions for answering interview questions without paying for standard API costs.

---

## 1. High-Level Architecture

The system operates by tricking the AI provider's backend (ChatGPT/Claude) into thinking that the API requests are coming directly from the user's browser. 

**The flow is as follows:**
1. **User Auth:** User logs into ChatGPT/Claude inside a hidden/embedded WebView in the Zyro AI app.
2. **Extraction:** Zyro AI extracts the session cookies (`sessionKey`, `__Secure-next-auth.session-token`).
3. **Execution:** When an interview question is asked, Zyro AI's backend (or local proxy) uses a **TLS-impersonated HTTP client** to send the prompt to the provider's undocumented web API using the extracted cookies.
4. **Streaming:** The provider responds with Server-Sent Events (SSE). Zyro AI parses this stream, removes web-specific artifacts, and streams it word-by-word to the Interview Overlay.

---

## 2. Core Components

### A. The Authenticator (WebView & Token Extractor)
A dedicated UI component where the target provider's login page is loaded.
* **Target URLs:** 
  * Claude: `https://claude.ai/login`
  * ChatGPT: `https://chatgpt.com/auth/login`
* **Mechanism:** A script polls the WebView's cookie store every 1 second. Once the user successfully logs in and the target session cookie appears, the token is extracted and saved securely, and the WebView is closed.

### B. TLS Impersonation Layer (The "Stealth" Client)
Standard HTTP clients (like Node.js `fetch` or Python `requests`) leave fingerprints that Cloudflare's WAF immediately blocks (Error 403). 
* **Mechanism:** You must use an HTTP client that mimics the TLS fingerprint (Cipher suites, ALPN, JA3) of a real browser (e.g., Chrome). 
* **Recommended Tools:** `curl-impersonate`, Golang's `utls`, or Python's `tls_client`.

### C. Turnstile / CAPTCHA Solver (The Fallback)
Sometimes, even with perfect TLS impersonation, Cloudflare throws a CAPTCHA challenge.
* **Mechanism:** A background headless browser (Playwright/Puppeteer) is briefly spun up to load the URL, execute the JavaScript challenge, solve the Turnstile CAPTCHA, and return the clearance cookies (`cf_clearance`).

### D. The Translator & Streamer
The undocumented web APIs do not return standard JSON responses like the official OpenAI API. They return complex NDJSON (Newline Delimited JSON) or custom SSE streams.
* **Mechanism:** A parser that reads the stream chunk-by-chunk, extracts only the assistant's generated text, and forwards it to the Zyro AI overlay via WebSockets or SSE.

---

## 3. Implementation Steps

### Step 1: Cookie Extraction Logic
Write a polling mechanism that watches for specific cookies after navigation.

**What to extract:**
* **Claude:** Domain: `.claude.ai`, Cookie Name: `sessionKey`
* **ChatGPT:** Domain: `.chatgpt.com`, Cookie Name: `__Secure-next-auth.session-token` (and occasionally `accessToken` from LocalStorage).

### Step 2: Reverse-Engineering the Web Endpoints
You need to inspect network traffic on the actual websites to see where the prompt is sent.
* **Claude Web Endpoint:** `POST https://claude.ai/api/organizations/{org_id}/chat_conversations/{chat_id}/completion`
* **ChatGPT Web Endpoint:** `POST https://chatgpt.com/backend-api/conversation`

*Note: You will also need to scrape metadata, such as Claude's `org_id` which can be fetched by making a `GET` request to `https://claude.ai/api/organizations` first.*

### Step 3: Injecting Headers
When sending requests to the above endpoints, you must perfectly replicate browser headers.
**Mandatory Headers:**
* `Cookie`: (Your extracted cookies + Cloudflare clearance cookies)
* `User-Agent`: (Must match exactly the browser version used for TLS impersonation)
* `Accept`, `Accept-Language`, `Sec-Fetch-Dest`, `Sec-Fetch-Mode`, `Sec-Fetch-Site`

### Step 4: Keep-Alive & Pre-warming (Crucial for Interviews)
Latency is critical in an interview. If Zyro AI sends a request and gets hit with a CAPTCHA, it will add a 5-10 second delay.
**Solution:**
* Send a silent "ping" request (e.g., `GET /api/organizations` or fetching chat history) when the interview starts and every 5 minutes in the background.
* This keeps the Cloudflare session active and ensures the token hasn't expired. If it hits a CAPTCHA, solve it in the background *before* the interviewer asks a question.

---

## 4. OmniRoute Codebase References for Analysis
If you want to study how this is perfectly executed, analyze these files in the OmniRoute project:

1. **Token Extraction Logic:**
   * `open-sse/services/tokenExtractionConfig.ts` - Maps out login URLs and exactly which cookies to extract for every provider.
2. **TLS Impersonation:**
   * `open-sse/services/claudeTlsClient.ts` - Shows how they securely impersonate a browser to bypass Cloudflare for Claude.
3. **Turnstile / CAPTCHA Bypass:**
   * `open-sse/services/claudeTurnstileSolver.ts` - Logic for spinning up a headless browser to solve CAPTCHAs.
4. **Web Endpoint Execution & Translation:**
   * `open-sse/executors/claude-web/browserTransport.ts` - Handles the raw HTTP connection to Claude's internal APIs.
   * `open-sse/executors/claude-web/stream.ts` - Parses the complex web stream back into clean text.
   * `open-sse/vendor/codex-chatgpt-web/` - The entire directory handles the ChatGPT reverse engineering logic.

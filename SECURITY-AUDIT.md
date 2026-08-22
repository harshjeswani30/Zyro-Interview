# Security & Code Audit — Zyro AI

**Project:** `D:\Projects\Ai Assistant` — zyro-ai v1.0.1
**Date:** 10 August 2026
**Scope:** Electron main & preload, renderer services, `ai-gateway` Cloudflare Worker, admin panel, Supabase edge function, build & CI config, compiled output in `out/` and `dist/`
**Method:** Manual source review. Key claims verified against the compiled bundle and git history — not inferred from source alone.
**Changes made:** None. Analysis only; no source files were modified.

> Live secret values are truncated in this document (Gemini key, admin password, JWT bodies). Full values are at the cited file and line.

---

## Headline

**The Supabase `service_role` key is compiled into the shipped desktop application.**

Confirmed by decoding the JWTs embedded in `out/main/index.js`: one is `anon`, one is `service_role`. Anyone who downloads the installer can extract it and read or write the entire database, bypassing all Row Level Security. Everything else in this report is secondary to fixing that.

**Good news:** `git log --all -- .env .env.local` is empty, and a history search for the service-role JWT returned nothing. The Supabase keys are **not** in git history — they leak through the built binary, not the repository. No history rewrite is needed for them; rotation alone is enough. The Gemini key (C4) is the one exception — that one *is* committed.

---

## Summary of findings

| ID | Severity | Finding |
|----|----------|---------|
| C1 | CRITICAL | `service_role` key hardcoded in the desktop main process |
| C2 | CRITICAL | Admin panel hands `service_role` to its renderer, which has an XSS sink |
| C3 | CRITICAL | Admin password hardcoded in renderer source, checked client-side |
| C4 | CRITICAL | Gemini API key committed to git |
| C5 | CRITICAL | AI gateway has no authentication whatsoever |
| H1 | HIGH | Any user can grant themselves unlimited free usage |
| H2 | HIGH | Horizontal privilege escalation — read/write any user's row |
| H3 | HIGH | Session-credit double-spend (race condition) |
| H4 | HIGH | `shell.openExternal` with unvalidated input |
| H5 | HIGH | Deep-link auth callback accepts any token, from anyone |
| H6 | HIGH | Any authenticated user can email your entire user base |
| H7 | HIGH | Live payment secrets in a `.env` the admin panel ships |
| M1 | MEDIUM | Gateway failover and load balancing do not work |
| M2 | MEDIUM | Knowledge Base is non-functional (three separate bugs) |
| M3 | MEDIUM | Unencrypted resume and interview content on disk |
| M4 | MEDIUM | Two different Supabase projects referenced |
| M5 | MEDIUM | Unsigned builds published to a public repo |
| M6 | MEDIUM | Blanket permission grant |
| M7 | MEDIUM | Crash and error-handling gaps |
| M8 | MEDIUM | Repository hygiene |

**Suggested order of work.** Rotate the exposed credentials first (Supabase `service_role` and `anon`, Gemini, Stripe, Razorpay) — that is the only step that invalidates what has already leaked. Then C1 and C5, since they are remotely reachable by anyone holding an installer. Then H1–H3, which cost you revenue the moment anyone notices. The rest can follow at normal pace.

---

# CRITICAL

## C1. `service_role` key hardcoded in the desktop main process

**Location:** `src/main/index.ts:213–214` — used at `:614`, `:884`, `:926`, `:954`, `:1018`

```ts
const SUPABASE_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...service_role...'
```

`service_role` bypasses all Row Level Security. It is a full-database admin credential. Extracting it from a shipped installer takes about 30 seconds:

```bash
7z x AppService-Setup-3.3.5.exe
npx asar extract app.asar out
grep -o 'eyJhbGciOi[A-Za-z0-9_.-]*' out/out/main/index.js
```

I decoded the token payload: `iat` 1772972949, `exp` 2088548949 — valid for roughly ten years. Every copy of the installer you have distributed contains it. Anyone holding it can read every user's profile, email and phone number; set any balance to any value; and drop tables.

### How to fix

**1. Rotate first, before anything else.** Supabase Dashboard → Settings → API → Legacy API keys → roll `service_role`. Also roll `anon` — it is in the same bundle, and while `anon` is designed to be public you should assume both are burned. Rolling breaks anything using the old key, so do it in a window where you can redeploy.

**2. Delete the constant from the client entirely.** No `service_role` key in any code that ships to a user's machine — not in main, not in preload, not behind an env var, not obfuscated. Anything on the user's disk is public.

**3. Move every privileged operation to a Supabase Edge Function.** Each of the five handlers becomes a function that receives the *user's* JWT and derives identity server-side:

```ts
// supabase/functions/get-profile/index.ts
const authHeader = req.headers.get('Authorization')
if (!authHeader?.startsWith('Bearer ')) {
  return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
}
const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!   // server-side only
)
const { data: { user }, error } = await admin.auth.getUser(authHeader.slice(7))
if (error || !user) {
  return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
}
// user.id is now cryptographically established — never taken from the request body
```

The main process then calls the function with `apikey: ANON_KEY` and `Authorization: Bearer <userAccessToken>` — the pattern you **already use correctly** in `supabase-create-razorpay-order` (`:982`) and `supabase-log-session` (`:1043`). Copy that shape onto the other five handlers.

**4. Turn on RLS** for `profiles`, `session_logs`, `transactions` and `coupons`. The presence of `dist/unpacked/supabase_fix_rls.sql` suggests this has been patched reactively before. Verify, then apply policies:

```sql
select tablename, rowsecurity from pg_tables where schemaname = 'public';

alter table profiles enable row level security;

create policy "own profile read" on profiles
  for select using (auth.uid() = id);

-- deliberately NO user-facing update policy on balance columns;
-- writes go only through edge functions using service_role
```

**5. Ship a forced update.** Old installers keep working with the old key until you rotate — rotation is what actually kills them. Publish the fixed version first and rotate immediately after, or add a minimum-version gate.

---

## C2. Admin panel hands `service_role` to its renderer, and that renderer has an XSS sink

**Location:** `admin-panel/src/preload/index.ts:4–9` · `admin-panel/src/renderer/src/lib/supabase.ts:5` · `admin-panel/src/renderer/src/components/BroadcastSection.tsx:371`

```ts
contextBridge.exposeInMainWorld('adminEnv', {
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'zyro-admin-2025'
})
```

The renderer builds a Supabase client with the service-role key, so all admin database access happens in web-page context. In the same renderer:

```tsx
dangerouslySetInnerHTML={{ __html: htmlContent }}
```

If `htmlContent` ever contains content you did not author — a broadcast draft loaded from the database, pasted marketing HTML, a support ticket body — that is script execution in a context holding a full-database admin key.

Note the comment two lines below in the same preload: *"secret key stays in main process, never exposed to renderer."* That is true for Stripe and false for Supabase.

Also `admin-panel/src/renderer/index.html:7` sets no `object-src` or `frame-src`, and whitelists `http://localhost:5174` — a dev origin permitted in production builds.

### How to fix

- Remove `supabaseServiceKey` and `adminPassword` from the `contextBridge` surface. A preload should expose *functions*, never credentials.
- Follow the pattern already used for coupons: renderer calls `ipcRenderer.invoke(...)`, main holds the key and performs the query. `admin-panel/src/main/index.ts` already does this correctly for `stripe:*`. Extend it to every table the admin renderer touches.
- Replace `dangerouslySetInnerHTML` with sanitized rendering. For an HTML email composer you genuinely need HTML, so sanitize rather than escape:

```tsx
import DOMPurify from 'dompurify'

<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(htmlContent, {
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick']
}) }} />
```

Better still, render the preview inside an `<iframe sandbox="allow-same-origin">` so even a sanitizer bypass cannot reach `window.adminEnv`.

- Tighten the admin CSP and drop the localhost entries from production output:
  `default-src 'self'; script-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'`

---

## C3. Admin password hardcoded in renderer source, checked client-side

**Location:** `admin-panel/src/renderer/src/components/LoginPage.tsx:21`

```tsx
if (password === 'Peey……00..') {   // redacted here — full value at the cited line
  onLogin(password)
}
```

Two problems. The string is a live credential sitting in source — and in the built JS bundle at `dist/unpacked/admin-panel/out/renderer/`. And the comparison runs in the renderer, so it is not an authentication boundary at all: DevTools, or editing the unpacked asar, walks straight past it. The fallback `'zyro-admin-2025'` in the preload is the same class of problem.

### How to fix

1. Treat the hardcoded admin password as compromised and stop using it anywhere.
2. Make admin identity a property of the database, not a string in the client:

```sql
alter table profiles add column is_admin boolean not null default false;
update profiles set is_admin = true where email = 'you@zyro-ai.in';
```

3. Log the admin in through real Supabase auth (`signInWithPassword`), then have every privileged edge function verify `is_admin` on the authenticated user before doing anything. The client-side check becomes a UX nicety with no security weight — which is the only role a client-side check can honestly hold.
4. Enable MFA on that admin account in Supabase.

---

## C4. Gemini API key committed to git

**Location:** `ai-gateway/src/index.ts:449` — also present in `ai-gateway/.wrangler/tmp/dev-7j7PFw/index.js`

```ts
const GEMINI_API_KEY = 'AIzaSyBSy8……VARGA'   // redacted here — full value at the cited line
```

Unlike the Supabase keys, this one *is* in your git history, and it is duplicated in a tracked build artifact. If that repository is public — or ever becomes public — the key is harvested within minutes; GitHub secret scanners and third-party crawlers both watch for the `AIzaSy` prefix.

### How to fix

1. Revoke the key in Google AI Studio now. Billing abuse on a leaked Gemini key is immediate and metered.
2. Move it to a Worker secret and read it from the binding, matching how the Groq keys are already handled:

```bash
npx wrangler secret put GEMINI_API_KEY
```

```ts
interface Env {
  GROQ_WHISPER_KEY_1: string
  // ...
  GEMINI_API_KEY: string
}

// in the handler:
const GEMINI_API_KEY = c.env.GEMINI_API_KEY
if (!GEMINI_API_KEY) return c.json({ error: 'Vision unavailable' }, 503)
```

3. Purge the history for this file, since it was committed:

```bash
pipx install git-filter-repo
git filter-repo --path ai-gateway/src/index.ts \
                --path ai-gateway/.wrangler --invert-paths --force
```

That rewrites history and requires a force push plus re-clones for collaborators. Rotating the key is what actually protects you; the purge is hygiene. Do the rotation regardless.

4. Add `.wrangler/` to `.gitignore` — you are currently tracking build artifacts under `ai-gateway/.wrangler/tmp/`, which is how the key got duplicated.

---

## C5. The AI gateway has no authentication

**Location:** `ai-gateway/src/index.ts` — `/gateway/llm` `:379` · `/gateway/stt` `:353` · `/gateway/vision` `:419` · `/gateway/embeddings` `:328` · `/gateway/analyze` `:708`

Every route is open to the internet. No API key check, no JWT verification, no rate limit, no per-user quota. The URL `https://ai-gateway.harshjeswani30.workers.dev` is a plaintext constant at `src/main/index.ts:204`, so it ships in your installer and is trivially discovered. Anyone can run:

```bash
curl -X POST https://ai-gateway.harshjeswani30.workers.dev/gateway/llm \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

and burn your Groq and Gemini quota indefinitely. The CORS config at `:36` does not help — **CORS is a browser policy**, and `curl`, Postman and any server-side script ignore it completely.

Right now this endpoint is a free LLM proxy for anyone who finds it, and it is also the cheapest way to bypass your paywall: a modified client can skip your billing entirely and still get answers.

### How to fix

Verify the Supabase JWT inside the Worker, tying gateway usage to a real, paying account:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose'

const JWKS = createRemoteJWKSet(
  new URL('https://weqwxoihdfsvjwwcgtat.supabase.co/auth/v1/.well-known/jwks.json')
)

const requireUser = async (c, next) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401)
  try {
    const { payload } = await jwtVerify(auth.slice(7), JWKS, {
      issuer: 'https://weqwxoihdfsvjwwcgtat.supabase.co/auth/v1',
    })
    c.set('userId', payload.sub)
    await next()
  } catch {
    return c.json({ error: 'unauthorized' }, 401)
  }
}

app.use('/gateway/*', requireUser)
```

If your project still issues legacy HS256 tokens rather than the newer asymmetric ones, verify with the shared secret instead — `jwtVerify(token, new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET))` — and store that secret with `wrangler secret put`.

Then add rate limiting keyed on `userId`, using Cloudflare's Rate Limiting binding or a Durable Object. Roughly 60 LLM calls and 200 STT calls per user per hour will stop abuse without affecting legitimate interview sessions. Update `src/main/index.ts` so `gatewayHeaders()` attaches the user's access token — the plumbing already exists via `get-supabase-token`.

> **Separately:** `forwardRequest` at `:170` forwards a caller-supplied `x-user-api-key` straight into the `Authorization` header sent to Groq/Deepgram. Keep that only if BYO-key is a deliberate feature; otherwise delete it, because it is an unauthenticated way to make your Worker issue requests with arbitrary credentials.

---

# HIGH

## H1. Any user can grant themselves unlimited free usage

**Location:** `src/main/index.ts:1012–1031`

```ts
ipcMain.handle('supabase-update-trial', async (_e, seconds) => {
  await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${supabaseUserId}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, ... },
    body: JSON.stringify({ trial_seconds_used: seconds })
  })
})
```

`seconds` comes from the renderer and is written verbatim with admin privileges. No clamping, no monotonicity check, no type validation. The renderer runs on the user's machine, so it is attacker-controlled by definition:

```js
window.api.supabaseUpdateTrial(0)   // trial reset, forever
```

Your enforcement lives at `OverlayPage.tsx:222` and `SetupPage.tsx:113`, both client-side. `start-interview` (`:612`) does check the balance server-side, which is the right instinct — but it reads the same column the client can freely rewrite, so the check has nothing solid to stand on.

### How to fix

Move the clock to the server and never accept a duration from the client. Track sessions as rows with timestamps and derive usage:

```sql
create table interview_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id),
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  heartbeat_at timestamptz not null default now()
);

create or replace function trial_seconds_used(uid uuid)
returns integer language sql stable as $$
  select coalesce(sum(
    extract(epoch from (coalesce(ended_at, heartbeat_at) - started_at))
  )::int, 0)
  from interview_sessions where user_id = uid;
$$;
```

The client sends a heartbeat with no payload; an edge function stamps `heartbeat_at = now()`. Trial consumption is then derived, not asserted.

For a smaller change now, at minimum make the value monotonic and bounded server-side so it can only increase and never exceed the cap:

```sql
create or replace function bump_trial(delta integer)
returns integer language plpgsql security definer as $$
declare new_val integer;
begin
  if delta < 0 or delta > 60 then
    raise exception 'invalid delta';
  end if;
  update profiles
     set trial_seconds_used = least(600, trial_seconds_used + delta)
   where id = auth.uid()
  returning trial_seconds_used into new_val;
  return new_val;
end $$;
```

Call it with the *user's* token, send only a small elapsed delta, and let the database enforce the ceiling.

---

## H2. Horizontal privilege escalation — write to any user's row

**Location:** `src/main/index.ts:857–863`

```ts
ipcMain.on('supabase-manual-sync', (_e, { accessToken, refreshToken, userId }) => {
  supabaseAccessToken  = accessToken
  supabaseRefreshToken = refreshToken || null
  supabaseUserId       = userId          // ← attacker-supplied, never verified
  storeSecureSession({ accessToken, refreshToken, userId })
})
```

`supabaseUserId` is taken directly from the renderer and never checked against the token. Every service-role handler then interpolates it into the URL — `/rest/v1/profiles?id=eq.${supabaseUserId}` — and because those requests authenticate with `service_role`, RLS does not apply. So:

```js
window.api.supabaseManualSync('anything', 'anything', '<other-user-uuid>')
await window.api.supabaseGetProfile()    // read their email, phone, balance
await window.api.supabaseUpdateTrial(0)  // write to their row
```

Combined with C1 this is remote, since the key is extractable from the installer and these endpoints can be hit directly with `curl` — the Electron client is not even required. The guards at `:880`, `:925` and `:1014` check `if (!supabaseUserId || !supabaseAccessToken)`, which only tests that the strings are non-empty. They do not verify the token belongs to that user, or that it is valid at all.

### How to fix

Never accept `userId` from the renderer. Derive it from the token, in main:

```ts
async function resolveUserId(token: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
  })
  if (!res.ok) return null
  const user = await res.json()
  return user?.id ?? null
}

ipcMain.on('supabase-manual-sync', async (_e, { accessToken, refreshToken }) => {
  const verifiedId = await resolveUserId(accessToken)
  if (!verifiedId) {
    console.warn('[Supabase] Rejected manual-sync: invalid token')
    return
  }
  supabaseAccessToken  = accessToken
  supabaseRefreshToken = refreshToken ?? null
  supabaseUserId       = verifiedId
  storeSecureSession({ accessToken, refreshToken, userId: verifiedId })
})
```

`handleProtocolUrl` already does exactly this at `:326` — reuse that logic rather than trusting the renderer. Once C1 is done and identity is derived from the JWT inside edge functions, this class of bug disappears structurally: there is no `userId` in the request for an attacker to change.

Also interpolate nothing user-controlled into PostgREST URLs. `?id=eq.${x}` with an unvalidated `x` lets a caller inject extra query operators. Validate the UUID shape (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) or `encodeURIComponent` it.

---

## H3. Session-credit double-spend (race condition)

**Location:** `src/main/index.ts:924–950` and `:952–978`

```ts
const current = rows?.[0]?.sessions_balance ?? 0
if (current <= 0) throw new Error('No sessions remaining')
const newBalance = current - 1
await fetch(..., { method: 'PATCH',
  body: JSON.stringify({ sessions_balance: newBalance }) })
```

Read-then-write with no atomicity and no optimistic-concurrency guard. Two concurrent invocations both read `5`, both write `4`, and one session is consumed for free. With a scripted client, firing twenty in parallel against a balance of one is a reliable way to get twenty sessions.

### How to fix

Do the decrement in a single atomic statement inside the database:

```sql
create or replace function consume_session()
returns integer language plpgsql security definer as $$
declare new_balance integer;
begin
  update profiles
     set sessions_balance = sessions_balance - 1
   where id = auth.uid()
     and sessions_balance > 0
  returning sessions_balance into new_balance;

  if new_balance is null then
    raise exception 'no_sessions_remaining';
  end if;
  return new_balance;
end $$;
```

The `and sessions_balance > 0` in the `WHERE` clause is what makes it safe — Postgres takes a row lock, so concurrent callers serialize and the second matches zero rows. Call `rpc('consume_session')` with the user's token instead of doing the read/write pair in main. Apply the same treatment to `phone_sessions_balance`, and add `check (sessions_balance >= 0)` as a backstop.

---

## H4. `shell.openExternal` with unvalidated input

**Location:** `src/main/index.ts:1539–1541`, `:446–449` · `admin-panel/src/main/index.ts:212–214`

```ts
ipcMain.on('open-external', (_, url) => {
  shell.openExternal(url)
})
```

No scheme allowlist. On Windows `shell.openExternal` hands the string to the shell, so `file:///C:/Windows/System32/calc.exe` launches a program, and UNC paths like `\\attacker\share\payload.exe` reach out over SMB — which also leaks NetNTLM hashes. `setWindowOpenHandler` at `:446` has the same gap for any `window.open`.

This needs a foothold in the renderer to trigger, so it is an escalation primitive rather than a standalone hole. But your renderer displays LLM output through `react-markdown`, your CSP includes `'unsafe-eval'` (`src/renderer/index.html:10`), and both windows run `sandbox: false` — so a renderer compromise turns directly into code execution.

### How to fix

```ts
const ALLOWED_HOSTS = new Set([
  'zyro-ai.in', 'www.zyro-ai.in',
  'accounts.google.com',
  'weqwxoihdfsvjwwcgtat.supabase.co',
  'checkout.razorpay.com'
])

function openExternalSafely(raw: unknown): void {
  if (typeof raw !== 'string' || raw.length > 2048) return
  let u: URL
  try { u = new URL(raw) } catch { return }
  if (u.protocol !== 'https:') return        // blocks file:, smb:, javascript:
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    console.warn('[Security] Blocked openExternal:', u.hostname)
    return
  }
  shell.openExternal(u.toString())
}

ipcMain.on('open-external', (_e, url) => openExternalSafely(url))

mainWindow.webContents.setWindowOpenHandler((details) => {
  openExternalSafely(details.url)
  return { action: 'deny' }
})
```

Apply the same helper in the admin panel. While you are there:

- Set `sandbox: true` on both windows (`:393`, `:465`). You use `contextIsolation: true` already, which is good; `sandbox: false` undoes much of the benefit. Your preload only calls `ipcRenderer`, so it should work under the sandbox — test the `koffi` and PDF paths, which live in main and are unaffected.
- Drop `'unsafe-eval'` from `script-src`. It is usually a dev-mode artifact; check whether your production Vite build actually needs it.
- Add a `will-navigate` guard so the renderer cannot be steered off `file://`:

```ts
win.webContents.on('will-navigate', (e, url) => {
  if (!url.startsWith('file://') && url !== process.env['ELECTRON_RENDERER_URL']) {
    e.preventDefault()
  }
})
```

---

## H5. Deep-link auth callback accepts any token, from anyone

**Location:** `src/main/index.ts:298–362`, trigger at `:279–289`

```ts
app.on('second-instance', (_event, commandLine) => {
  const url = commandLine.pop()
  if (url?.startsWith('zyroapp://')) handleProtocolUrl(url)
})
```

You registered `zyroapp://` as a system protocol handler, so **any web page** can invoke it. There is no OAuth `state` parameter and no PKCE verifier, so `handleProtocolUrl` cannot distinguish a token from a login your app initiated from a token an attacker supplied. A page that navigates to `zyroapp://auth-callback?access_token=<attacker_token>` silently signs your user into the attacker's account — classic session fixation. From there, resume uploads and interview content flow into a session the attacker controls.

*Secondary bug:* `commandLine.pop()` assumes the URL is the final argv element. Windows appends flags in various situations, so the deep link is silently dropped when it is not last — a likely source of intermittent "Google login does nothing" reports.

### How to fix

1. Generate a `state` nonce before opening the browser, and reject callbacks that do not echo it:

```ts
import { randomBytes, timingSafeEqual } from 'crypto'

let pendingOAuthState: string | null = null

ipcMain.handle('supabase-login-google', async () => {
  pendingOAuthState = randomBytes(32).toString('hex')
  const redirectUri =
    `https://www.zyro-ai.in/auth/callback?is_desktop=true&state=${pendingOAuthState}`
  const authUrl =
    `${SUPABASE_URL}/auth/v1/authorize?provider=google` +
    `&redirect_to=${encodeURIComponent(redirectUri)}`
  openExternalSafely(authUrl)
})
```

In `handleProtocolUrl`, compare with `timingSafeEqual` on equal-length buffers, then clear `pendingOAuthState` so each nonce is single-use. Drop the callback if there is no pending state — that alone blocks the unsolicited-token attack.

2. Scan all of argv rather than popping the last element:
   `const url = commandLine.find((a) => a.startsWith('zyroapp://'))`
3. Keep the existing `/auth/v1/user` verification at `:326` and treat a failed lookup as fatal. Today the `else` branch at `:341` stores the token anyway — remove that fallback, along with the one in the `catch` at `:348`.
4. Prefer PKCE via `supabase-js` `signInWithOAuth({ flowType: 'pkce' })` if you would rather not hand-roll the nonce; same protection, less code to get wrong.

---

## H6. Any authenticated user can email your entire user base

**Location:** `supabase/functions/send-broadcast/index.ts:20–45`

```ts
const { data: { user }, error: authError } =
  await supabaseClient.auth.getUser(authHeader.replace('Bearer ', ''))
if (authError || !user) throw new Error('Unauthorized')
// ...
const { data: profiles } = await supabaseClient.from('profiles').select('email')
```

This verifies the caller is *logged in*, never that they are an **admin**. Any user who signs up — free trial included — can call the function and have it enumerate every email in `profiles` and blast arbitrary HTML through your Resend account, from `hello@zyro-ai.in`. That is a mass-phishing capability wearing your domain, plus a full customer-list disclosure via the `details` array in the response. It will also torch your sender reputation and probably your Resend account.

Three more issues in the same file: `Access-Control-Allow-Origin: '*'` (`:5`) lets any origin call it from a browser with the victim's credentials; `req.headers.get('Authorization')!` (`:21`) throws a `TypeError` on a missing header, producing a 500 instead of a clean 401; and the sequential per-recipient loop (`:54`) will exceed the Edge Function CPU limit once you have a few hundred users, leaving broadcasts half-sent with no idempotency.

### How to fix

```ts
const authHeader = req.headers.get('Authorization')
if (!authHeader?.startsWith('Bearer ')) {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

const { data: { user }, error: authError } =
  await supabaseClient.auth.getUser(authHeader.slice(7))
if (authError || !user) {
  return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
}

const { data: profile } = await supabaseClient
  .from('profiles').select('is_admin').eq('id', user.id).single()
if (!profile?.is_admin) {
  return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
}
```

Also: replace `'*'` with an explicit origin allowlist; move to Resend's batch endpoint (`/emails/batch`, 100 per call) or enqueue recipients and drain via a scheduled function; and stop returning per-recipient results to the caller — log them server-side and return only aggregate counts, so the endpoint cannot be used to dump your list. Sanitize the `html` field server-side too, since the same string is what `BroadcastSection.tsx` renders through `dangerouslySetInnerHTML` (C2).

> Your untracked `supabase/functions/send-ticket-reply/` almost certainly needs the same admin check. I did not review it, since it is not committed yet.

---

## H7. Real payment secrets in a root `.env` that the admin panel ships

**Location:** `.env` (gitignored, correctly) — read by `admin-panel/src/main/index.ts:10`

```
SUPABASE_SERVICE_ROLE_KEY=...
STRIPE_SECRET_KEY=...
RAZORPAY_KEY_SECRET=...
```

`.env` is properly gitignored and never committed — good. The problem is the load path:

```ts
const envPath = is.dev ? resolve(__dirname, '../../.env')
                       : resolve(process.resourcesPath, '.env')
```

In production the admin panel expects a `.env` file **inside the packaged app's resources directory**. If you ever ship that build to anyone, or it lands on a machine you do not control, your live Stripe and Razorpay secret keys go with it. A Razorpay key secret allows arbitrary refunds and payment capture; a Stripe secret key is effectively full account access.

### How to fix

- Treat the admin panel as an internal tool that must never be distributed, and say so in its README. Better: rebuild it as a web app behind Supabase auth with the `is_admin` check, so secrets stay on a server you control. An Electron app is a poor container for a payment secret because there is no trust boundary between the app and its user.
- Never place payment secrets in a packaged app under any circumstances. Payment operations belong in edge functions with secrets in Supabase's secret store (`supabase secrets set STRIPE_SECRET_KEY=...`).
- Since these keys have sat in a working tree alongside a 149 MB untracked installer and several untracked vendor directories, rotate all three as a precaution: Supabase `service_role`, the Stripe secret key, and the Razorpay key secret.

> **Worth checking directly:** verify the payment webhook validates signatures. I found no `razorpay-create-order` or webhook function in the repo — they are deployed but not committed. If the webhook does not check `X-Razorpay-Signature` with HMAC-SHA256 over the raw body, anyone can forge a payment-success callback and mint session credits for free. Given how much else here routes through client-trusted balance updates, this deserves a look.

---

# MEDIUM

## M1. Gateway failover and load balancing do not work

**Location:** `ai-gateway/src/index.ts:88–141` — called at `:315`, `:354`, `:380`, `:709`

```ts
function initializeProviders(env: Env) {
  // Always refresh provider definitions ...
  providers = [ /* fresh objects, activeRequests: 0, status: 'healthy' */ ]
}
```

Every route calls `initializeProviders()` on entry, which **reassigns** the module-level array. So `activeRequests` resets to `0` and `status` resets to `'healthy'` on every single request. The cooldown logic at `:283–285` and `:370` writes to objects the next request discards.

Net effect: a rate-limited or dead provider is retried immediately and forever, and `getBestProvider`'s sort by `activeRequests` (`:160`) always compares zeros — you get the first matching provider every time. Key 2 is never used while key 1 exists.

The comment at `:82–85` acknowledges Workers are stateless per request, but module globals *do* survive within an isolate — the unconditional reassignment is what throws that away.

### How to fix

```ts
let initialized = false

function initializeProviders(env: Env) {
  if (initialized) return
  providers = [ /* ... */ ]
  initialized = true
}
```

Isolates recycle regularly, so this is still best-effort. For cooldowns that hold across isolates, use a Durable Object or write provider health to Workers KV with a short TTL. Given this is a cost-control and reliability mechanism rather than a security boundary, the one-line guard is a reasonable first step.

---

## M2. Knowledge Base is non-functional (three separate bugs)

**Location:** `src/main/index.ts:562–583`

```ts
ipcMain.handle('kb-list', async () => {
  return { data: [], error: null }                    // always empty
})

ipcMain.handle('kb-save', async (_event, args) => {
  localVectorDb.indexContent('kb_' + args.title, args.content)
  return { data: { id: `kb_${Date.now()}`, ... } }    // id ≠ source
})

ipcMain.handle('kb-delete', async (_event, kbId) => {
  localVectorDb.clearSource(kbId)                     // kbId is `kb_<timestamp>`
})
```

`kb-list` is a stub returning `[]`, so saved entries never appear. `kb-save` indexes under source `kb_<title>` but returns id `kb_<timestamp>`, and `kb-delete` passes that id to `clearSource`, which filters on `source`. The two never match, so deletion silently no-ops — the entry stays in the vector store and keeps influencing answers after the user believes it is gone. Users will read that as "the app ignores my notes."

### How to fix

Give `LocalVectorDb` a real entry index and use one stable identifier throughout:

```ts
public listSources(): { id: string; title: string; created_at: string }[] {
  const seen = new Map<string, string>()
  for (const c of this.data.chunks) {
    if (!seen.has(c.source)) seen.set(c.source, c.id)
  }
  return [...seen.keys()].map((s) => ({
    id: s,
    title: s.replace(/^kb_/, ''),
    created_at: new Date().toISOString()
  }))
}
```

Then have `kb-save` return `{ id: 'kb_' + args.title }` so `kb-delete` receives a value `clearSource` can match, and wire `kb-list` to `listSources()`. Also handle title collisions — `indexContent` filters by source first (`localVectorDb.ts:75`), so saving two entries with the same title silently replaces the first.

---

## M3. Unencrypted resume and interview content on disk

**Location:** `src/main/localVectorDb.ts:43` — plus `zyro_local_vectors.json` in the repo root

```ts
fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
```

Resume text, cheat-sheet notes and interview content are written as plaintext JSON to `userData`. The 13 KB `zyro_local_vectors.json` sitting in your project root holds verbatim chunks in cleartext. Any other process running as the user, any backup tool and any sync client can read it. You already built the right primitive in `secureStorage.ts` (`safeStorage`, DPAPI/Keychain) and use it for tokens; resume data does not get the same treatment.

Related: `load()` (`:29`) parses the entire file synchronously in the constructor, which runs at import time — before `app.whenReady()`. There is no size cap and no chunk-count cap, so the store grows without bound and startup slows as it does. A corrupt file resets the store silently (`:35–38`), so users lose notes with no message.

### How to fix

```ts
private save(): void {
  const json = JSON.stringify(this.data)
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf-8')
  fs.writeFileSync(this.filePath, buf)
}
```

- Mirror that in `load()` with a plaintext fallback for existing files, exactly as `loadSecureSession` does at `secureStorage.ts:37–48`.
- Cap the store (say 5,000 chunks) and evict oldest-first in `indexContent`.
- Move `load()` out of the constructor into an explicit `init()` called from `whenReady`. Note the fallback to `process.cwd()` at `:24` — that is how the JSON ended up in your repo root instead of `userData`.
- Delete `zyro_local_vectors.json` from the repo and gitignore it, so real user data cannot be committed.
- Purge vectors on logout. `clearSecureSession` wipes the token but the indexed resume survives, so on a shared machine the next user inherits the previous user's resume content in their AI context.

---

## M4. Two different Supabase projects referenced

**Location:** `src/main/index.ts:210` → `weqwxoihdfsvjwwcgtat` · `admin-panel/src/preload/index.ts:5` → `wzazigashanttpqbrfod`

The desktop app and the admin panel's fallback URL point at different projects. One is stale. If the admin panel ever falls back to its default (i.e. `SUPABASE_URL` is unset), it manages coupons in a project the desktop app never reads — coupons that appear created but never apply, with no error anywhere.

### How to fix

Pick the live project, remove the hardcoded fallbacks entirely, and fail loudly when the env var is missing rather than silently defaulting to a wrong URL. `getSupabase()` at `admin-panel/src/main/index.ts:15` already throws on missing config — extend that discipline to the preload.

---

## M5. Unsigned builds published to a public repo

**Location:** `electron-builder.yml:52–57` · `.github/workflows/build.yml`

No `certificateFile` for Windows and `notarize: false` for macOS, so releases are unsigned. `electron-updater` fetches over HTTPS and checks the `sha512` in `latest.yml`, so this is not trivially MITM-able — but with no code signature there is no publisher identity binding the installer to you. Practical consequences: SmartScreen warnings that depress install rates, macOS Gatekeeper refusing to launch, and no tamper-evidence if a release asset is ever swapped by someone with repo write access.

### How to fix

Get an Authenticode certificate (EV gets instant SmartScreen reputation) and an Apple Developer ID, store them as GitHub secrets, and wire them in via `CSC_LINK`/`CSC_KEY_PASSWORD`. Enable macOS notarization once you have the Developer ID. Until then, publish SHA-256 checksums on your download page so users can verify manually.

---

## M6. Blanket permission grant

**Location:** `src/main/index.ts:519–522`

```ts
session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
  const allowed = ['media', 'microphone', 'camera', 'display-capture', 'audioCapture']
  callback(allowed.includes(permission))
})
```

The requesting origin is ignored. Since you load from `file://` this is low-risk today, but combined with H4's navigation gap it means any content reaching the renderer gets mic, camera and screen capture with no prompt.

### How to fix

```ts
session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
  const url = wc.getURL()
  const trusted = url.startsWith('file://') ||
                  url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? '\0')
  const allowed = ['media', 'microphone', 'camera', 'display-capture', 'audioCapture']
  callback(trusted && allowed.includes(permission))
})
```

Also add `setPermissionCheckHandler` — the request handler alone does not cover synchronous permission checks.

---

## M7. Crash and error-handling gaps

**Location:** `src/main/index.ts` — various

- **`:1150`** — `resumeText.substring(0, 3000)` throws `TypeError` if `resumeText` is undefined, taking down the whole transcribe-and-answer flow mid-interview. Use `(resumeText ?? '').substring(...)`. `systemPrompt` on the line above is unvalidated too.
- **`:623`, `:935`, `:963`, `:1029`** — `await res.json()` with no `res.ok` check. When PostgREST returns an error object, `rows?.[0]` is `undefined` and the balance silently reads as `0`, so a paying user is told they have no sessions. Check `res.ok` and distinguish "couldn't reach the server" from "you're out of credits."
- **`:172–174`** — `withRetry` throws bare object literals (`throw { status, message, body }`) rather than `Error` instances, so there is no stack trace and `instanceof Error` checks downstream fail. Use a small `class GatewayError extends Error`.
- **`:1003–1004`** — two empty `catch (e) {}` blocks swallow errors while building a message. Log at debug level at minimum.
- **`admin-panel/src/main/index.ts:234–236`** — `process.on('unhandledRejection')` exists in the admin panel but not in the desktop main process. Right now an unhandled rejection in an IPC handler can leave the app half-initialized with no diagnostic.
- No global `uncaughtException` handler and no crash reporting anywhere. For a stealth overlay users cannot easily observe failing, consider Sentry or `crashReporter` so you learn about mid-interview crashes without waiting for reports.

---

## M8. Repository hygiene

**Location:** working tree

`git status` shows several things that should not be near this tree:

- `ghostly-3.3.5-setup.exe` — a 149 MB untracked binary. One `git add -A` puts it in your history permanently.
- `gaze-correction-cam-master/`, `natively-cluely-ai-assistant-main/`, `zyro-support-client/` — untracked third-party source drops. The second contains its own AI-provider settings code; if it holds credentials or gets committed, it is a fresh leak surface. Vet or remove.
- `scratch/`, `supabase/.temp/`, `zyro_local_vectors.json` — scratch state and user data in the working tree.
- `admin-panel/electron.vite.config.1776004987049.mjs` and `...1776523519755.mjs` — timestamped generated configs, both tracked.
- `ai-gateway/.wrangler/tmp/dev-7j7PFw/index.js` — tracked build artifact, and the second location where the Gemini key leaked.

### How to fix

Extend `.gitignore` with `*.exe`, `*.dmg`, `*.AppImage`, `.wrangler/`, `scratch/`, `supabase/.temp/`, `zyro_local_vectors.json` and `**/electron.vite.config.*.mjs`; then `git rm --cached` the tracked artifacts. Add a pre-commit secret scan so this class of thing cannot recur:

```bash
pipx install detect-secrets
detect-secrets scan --baseline .secrets.baseline
```

Enable GitHub push protection and secret scanning on the repo — free for public repos, and it would have caught C4.

---

# One thing outside the security list

## Deliberate impersonation of a Windows system process

**Location:** `electron-builder.yml:1–2` · `src/renderer/index.html:6` · `src/main/index.ts:403`, `:1548`, `:29`, `:1294`

Several details line up in a way worth naming plainly:

- `appId: com.security.hp` and `productName: AppService`
- Window title *"Host Process for Windows Services"*
- `setAppUserModelId('com.security.hp')`
- `WDA_EXCLUDEFROMCAPTURE` to hide the overlay from Zoom, Teams, Meet, OBS and proctoring software
- A "Ghostly Micro-Blink Stealth Screenshot Protocol" that blanks the overlay during capture

Together, the application is built to impersonate a Windows system process and evade screen capture during interviews. That is a product and legal question rather than a vulnerability, so it sits outside the findings above — but it is worth stating explicitly, because it materially changes your risk profile in three ways:

- **Anti-malware.** Naming an unsigned binary after a system process is a documented malware heuristic. Combined with M5 (unsigned builds), expect Defender and SmartScreen detections — some of which will be hard to appeal precisely *because* of the naming.
- **Distribution.** Interview-evasion tooling violates the terms of most proctoring platforms and several app stores, and payment processors have terminated accounts over it. Your Stripe and Razorpay integrations are exposed to that risk.
- **Disclosure.** The security findings above involve real user PII — emails, phone numbers, resumes. If C1 or H2 is exploited, breach-notification duties apply regardless of what the product does.

None of this changes the technical remediation. It does mean the C-series fixes are worth doing quickly and independently of any product decisions, since the data at risk belongs to your users rather than to you.

---

*No files in the project were modified in the course of this review.*

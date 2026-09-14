# Security Audit — 2026-09-10 (rev. 2026-09-13)

**Scope:** Full-stack audit of the Zyro monorepo — desktop app (`src/`), admin panel (`admin-panel/`), support client (`zyro-support-client/`), website (`website/`), AI gateway (`ai-gateway/`), Supabase Edge Functions, database/RLS surface, secrets, packaging, and CI.

**Method:** Every finding was verified by reading the actual code (line-referenced). Leads were cross-checked by multiple independent audit passes; a separate adversarial pass attempted to refute each finding before it was kept.

**2026-09-13 revision:** every item below was re-verified against the working tree **and the live database** (`weqwxoihdfsvjwwcgtat`) via direct probes. Fixed items are removed from the open list and archived in §7 with their verification evidence. Line numbers are as of this tree. This revision supersedes the 2026-09-10 text in place.

**Secrets policy:** this file contains **locations** of secrets, never the secret values themselves.

---

## 1. Open findings summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 6 |
| Medium | 6 |
| Low | 5 |

Biggest open risks in one line each:

- **C6** The code-signing certificate password is still in the public repo.

---

## 2. CRITICAL (open)

### C2. ~~`service_role` key never rotated — old installers still ship it~~ **RESOLVED 2026-09-14 — see §7.**
- **Files:** shipped installers built before 2026-09-10 (both admin apps) bundled `.env` with the live `service_role` JWT. The builder files are fixed now (`extraResources: []`, verified), but **the key itself was never re-issued**: on 2026-09-13 all local copies (root `.env`, `dist/unpacked/.env`, `admin-panel/.env`, `zyro-support-client/.env`) were compared and carry the **same** JWT.
- **Impact:** anyone holding an old installer (staff machine, shared download link, GitHub release) has a working database master key. RLS is meaningless to them.
- **Fix (corrected 2026-09-13 after checking live docs — there is no reset button for the legacy `service_role` JWT; the earlier "Reset service key" guidance was outdated):** Settings → API Keys → create a new **secret key** (`sb_secret_…`, carries `service_role` privileges) → replace the legacy key in every legit consumer **before** deactivation — Edge Functions must stop reading `SUPABASE_SERVICE_ROLE_KEY` (it dies when legacy keys are deactivated) and switch to `JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS'))['default']`, then redeploy; `admin-panel`/`zyro-support-client` mains: swap the `.env` value for the new key (upgrade supabase-js so non-JWT keys are sent via `apikey` header) → then **deactivate the legacy `service_role` key** on the same page (reversible; legacy `anon` toggles independently and can stay enabled). Deactivation is what kills every already-shipped installer's copy of the old key — no rebuild of old installers needed.

### C5. ~~Inbound email webhook has no signature verification~~ **RESOLVED 2026-09-13 — see §7.**

### C6. Signing-certificate password committed — **re-verified live 2026-09-14, next up for remediation**
- **Files:** `electron-builder.yml:21` (`cscKeyPassword` in plaintext, public repo — HTTP 200 verified; value redacted from this doc per policy). `build/codesign.pfx` exists locally (4290 bytes) but is **not git-tracked** — only the password is exposed.
- **Full exposure map (verified 2026-09-14 by live grep):** the burned value currently sits in **18 tree locations** — `electron-builder.yml`; `admin-panel/.env:11-12` + `zyro-support-client/.env` **as `ADMIN_PASSWORD`/`MAIN_VITE_ADMIN_PASSWORD` (i.e. it is still the live admin-app login password)**; `scratch/export_cer.ps1`; bundled build outputs (`admin-panel/out/`, `release/win-unpacked/resources/.env` **and `app.asar`** — meaning every distributed installer carries it), `dist/unpacked` mirrors, and android assets. Git history: 2 commits (`4526c5aa` first commit, `086032f1`).
- **Impact:** (a) anyone with an old installer extracts the asar → working admin-app password; (b) if the PFX ever leaks alongside, an attacker signs malware as this publisher and it passes the update channel's signature checks (with H7, that is RCE); (c) all previously signed installers' trust is suspect.
- **Correction (2026-09-14):** the earlier claim that commit `086032f1` put a **real Groq key** into history was wrong — live `git grep` found only the `gsk_your_groq_api_key_here` placeholder in `.env.example` and prefix-check logic (`startsWith('gsk_')`) in `ai-gateway/src/index.ts`. **No Groq rotation needed.** Live gateway keys are properly in Worker secrets (verified via `wrangler secret list`).
- **Fix plan (agreed with owner 2026-09-14 — owner will drive it "kal"/next session):**
  - **A (code):** remove `cscKeyPassword` from `electron-builder.yml` → use env `CSC_KEY_PASSWORD`; delete the dead `ADMIN_PASSWORD`/`MAIN_VITE_ADMIN_PASSWORD` lines from both `.env`s; scrub `scratch/export_cer.ps1`; clean build artifacts.
  - **B (history):** `git filter-repo` purge of the password blobs + force-push — **needs owner's explicit go (history rewrite)**; GitHub may retain cached commits/forks until support purges them, which is why C is the real fix.
  - **C (cert — owner's action, blocks closure):** revoke and reissue the certificate with a fresh password; new PFX stays in `build/` untracked; password via env var only.
  - **D:** withdraw old installers; rebuild + re-release both admin apps (already pending for the key migration anyway — old builds carry the dead legacy Supabase keys too).

### C7. ~~Gateway STT is still exempt from auth~~ **RESOLVED 2026-09-13 — see §7.**

### ~~C2 (duplicate entry)~~ **merged into the resolved entry above — closed 2026-09-14.**

---

## 3. HIGH (open)

### H1. Deep-link session injection
- **Files:** `src/main/index.ts:435-501` (`handleProtocolUrl` accepts any `zyroapp://auth-callback?access_token=...&refresh_token=...`; token parsing at `:441-455`; refresh flow `:355-385`), `:133/136` (protocol registration); website side passes tokens through the protocol URL.
- **Exploit:** one crafted link logs the victim into the attacker's account; victim data lands in the attacker's account. No `state`/nonce exists yet.
- **Fix:** OAuth PKCE with per-login `state` validated in the callback; reject tokens not tied to an in-flight login; never log the URL.

### H2. `shell.openExternal` on arbitrary URLs
- **Files:** `src/main/index.ts:610-611` (`setWindowOpenHandler` passes `details.url` through), `:2261-2263` (`open-external` IPC, zero validation — verified 2026-09-13).
- **Exploit:** `file://`, `smb://`, `search-ms:` handlers → OS handler abuse, NTLM leak.
- **Fix:** allowlist `https://` + fixed hosts before every `openExternal`; deny non-https in the open handler.

### H4. Main process hands long-lived secrets to the renderer
- **Files:** `src/main/index.ts:704` (`get-deepgram-key`), `:720` (`get-supabase-session-data` returns access **and refresh** tokens), auth-callback success push (~`:490`).
- **Fix:** no third-party keys or refresh tokens in the renderer; do the work in main behind scoped IPC (e.g. `transcribe-audio`).

### H5. `supabase-manual-sync` trusts renderer-supplied tokens
- **File:** `src/main/index.ts:1107` (verified still present).
- **Fix:** only main may establish sessions; validate tokens against `/auth/v1/user`; require user confirmation before replacing a stored session.

### H6. Admin-panel IPC surface is unauthenticated inside the app
- **Files:** `admin-panel/src/main/index.ts:47-173` — every `admin:*` handler (list/update/delete profiles, staff permissions, tickets, balances, notifications) runs with no session check (verified 2026-09-13).
- **Impact:** any XSS/injected script in the admin renderer drives the service-role client directly.
- **Fix:** verify an admin session in main (held from login) before every `admin:*` handler; validate argument shapes.

### H7. Update pipeline: renderer-triggerable, prerelease channel, notarize off
- **Files:** `src/main/index.ts:2212,2219` (`install-update`, `download-update` IPC), `electron-builder.yml:48` (`notarize: false`), `:65` (`releaseType: prerelease`).
- **Impact:** combined with C6's leaked cert password, a forged update passes signature checks → RCE via the update channel.
- **Fix:** explicit user confirmation for install; notarization on; drop the prerelease channel; rotate the certificate (C6).

---

## 4. MEDIUM (open)

### M1. Renderer sandbox disabled; no navigation guards
- **Files:** `src/main/index.ts:569,649` (`sandbox:false`); no `will-navigate` handlers. **Fix:** `sandbox:true` + deny-list navigation guards.

### M2. Blanket media permission grants
- **File:** `src/main/index.ts:688-689` (grants media/mic/camera/display-capture to any webContents). **Fix:** gate on the app's own origin and per-session consent.

### M3. Plaintext session fallback
- **File:** `src/main/secureStorage.ts:16,42-48` — downgrades to cleartext when DPAPI is unavailable. **Fix:** refuse to persist instead of downgrading.

### M5. Gateway CORS reflects any origin with `credentials:true`; errors leak internals
- **Files:** `ai-gateway/src/index.ts:263` (origin reflection), `:257` (`credentials: true`), `:331,476,504` (`err.message` returned to clients). **Fix:** static origin allowlist; drop credentials; generic 500 body.

### M6. KV revocation skipped for STT paths
- **File:** `ai-gateway/src/index.ts:302-304` (deliberate, latency rationale). With C7's exemption still open this extends the hole: revoked users keep STT until token expiry. **Fix:** include STT once C7 lands (hot KV read is cheap).

### M7. Gateway resume routes: stale auth comment; in-memory rate limit
- **Files:** `ai-gateway/src/resume/routes.ts:10` (comment claims "no authentication" — stale, the middleware now applies to these routes), `:89-103` (per-IP window is per-isolate, bypassable). **Fix:** correct the comment; move the limiter to KV/Durable Object.

---

## 5. LOW (open)

- **L1.** CSP allows `unsafe-eval` — `src/renderer/index.html:10`. Remove; apply via `onHeadersReceived`.
- **L2.** System-wide bare-key shortcuts + silent protection toggles — `src/main/index.ts:866+` (`Up`, `Down`, numpad keys hijacked in every app). Window-scoped accelerators; visible UI state for toggles.
- **L3.** Vision route spreads client body (`...rest`) into the provider payload — `ai-gateway/src/index.ts:1126-1140`. Explicit field allowlist.
- **L4.** Unbounded local vector store — `src/main/localVectorDb.ts` (no chunk/source caps; whole-file JSON rewrite per save; no IPC rate limit).
- **L5.** CI actions pinned by tag — `.github/workflows/build.yml:22,30` (`actions/checkout@v4` etc.). Pin to commit SHAs; add `permissions: contents: read`.

---

## 6. Attack chains (updated 2026-09-13)

1. **Free Whisper STT, no account — STILL LIVE:** curl `POST /gateway/stt` with no auth (C7 exemption) → burn Groq Whisper keys.
2. ~~₹299 "unlimited"~~ **CLOSED** — plan-switch (C1) and self-balance (C8) are fixed and live-verified.
3. ~~**Old-installer DB takeover**~~ **CLOSED 2026-09-14** — the bundled `service_role` JWT is dead (401, probe-verified); every old installer's key is inert.
4. **Session injection:** branded-phishing half is closed (C4 fixed), but the receiving end still accepts injected tokens (H1) and the inbound webhook can still forge thread content (C5).
5. **Update-channel RCE — still open:** leaked cert password (C6) + public prerelease repo + renderer-triggerable install (H7).

---

## 7. Resolved (removed from the open list — verification evidence)

| Item | What closed it | Verified |
|---|---|---|
| **C1** Razorpay plan-switch + replay race + coupon stacking | `razorpay-verify` reads order from Razorpay API (plan/amount/user server-side); `fulfill_razorpay_order` RPC + unique index (migration `20260912000000_payment_privilege_hardening.sql`) | Code + deployed (2026-09-12 deploy, entrypoint = fixed source); RPC probed live |
| **C2 (code half)** `.env` bundled into installers | `extraResources: []` in both builders; prod loads `userData/.env` | Builder files read 2026-09-13 — rotation half stays open as C2 |
| *(C2 follow-on)* All consumers migrated to new API keys | Root functions (11): `SUPABASE_SECRET_KEYS` via `serviceRoleKey()` helper, pinned supabase-js@2.98.0; website functions (7 + `_shared/drive.ts`, `_shared/serviceKey.ts`, `_shared/publishableKey.ts`): same helpers; `generate-gateway-token`/`cos-sts` anon → `SUPABASE_PUBLISHABLE_KEYS`; desktop `src/main/index.ts` + admin-panel + support-client `.env`s + renderer fallback: anon JWT → `sb_publishable_`; admin panels supabase-js 2.49.4 → 2.98.0; all 19 functions deployed with live `verify_jwt` flags preserved | Deployed 2026-09-14; live-tested: `generate-gateway-token` (user JWT), `check-balance`, `get-profile`, `update-trial` (validation), `razorpay-create-order` (real order created), `deduct-credit-hours`, `release-hold`, `hold-credit` (402 = balance logic, auth fine), `clear-history`; secret+publishable key REST/auth probes OK; test user + profile created & deleted same day |
| **C2 — LEGACY KEYS DEACTIVATED (final closure)** | All `.env` files (root, both admin apps, `dist/unpacked`) swapped to `sb_secret_`/`sb_publishable_`; website repo pushed to GitHub (commit `39b6014`) → Vercel auto-deploy → user updated the `VITE_SUPABASE_ANON_KEY` env var → redeploy verified (`index-Dr7_h4B-.js` bundles `sb_publishable_`); Management API `PUT /api-keys/legacy?enabled=false` executed — both legacy keys (anon + service_role) disabled | **Probed live 2026-09-14:** old `service_role` JWT → **401** (REST + auth); old `anon` JWT → **401**; new `sb_secret_` REST + auth-admin → **OK**; login via `sb_publishable_` → **OK**; all 7 function probes post-deactivation → **200**; test user+profile cleaned up. Old installers' bundled keys are now inert |
| **C3** Support client renderer service key | Preload exposes URL+anon only; privileged ops via main-process `staff:*` IPC | Code re-read 2026-09-13 |
| **C4** Email functions "any token >20 chars" | Real JWT (`auth.getUser`) + `staff_permissions` check + HTML escaping; support client forwards staff JWT via direct fetch | Live probes 2026-09-13: random token → `Unauthorized`; non-staff JWT → `staff only`; anon can no longer read profiles |
| **C8** Profiles privilege columns writable by users | Column REVOKEs + durable trigger (migration §3) | Live probes: `PATCH sessions_balance`/`is_admin` → 403 trigger; legit self-update → 204; signup path intact |
| **C9** Anon can read profiles | Policy dropped + SELECT revoked (migration §4) | Live probe: anon → `42501 permission denied for table` |
| **C10** Staff self-signup | Sign Up tab removed; `staff_permissions` writes revoked from anon/authenticated (migration §2) | Code + migration live |
| **H3** Hardcoded admin fallback | Both branches removed from `LoginPage.tsx`; dead `ADMIN_PASSWORD` type dropped; support client's dead `LoginPage.tsx` (same hardcoded value, no auth at all) deleted | Source grep clean 2026-09-13; owner account provisioned server-side (single `is_admin=true` row, verified) |
| **H8** Broadcast raw HTML | Admin panel sanitizes via DOMPurify + script-strip; support client sink removed | Code read 2026-09-13 |
| **M4** Billing RPCs directly callable; negative amounts | Negative-amount guard + `REVOKE EXECUTE ON ALL FUNCTIONS` from PUBLIC/anon/authenticated + `ALTER DEFAULT PRIVILEGES` (migration §2); `transactions`/`coupons`/`staff_permissions` write revokes | Live probes: negative → `invalid_credits_amount`; anon RPC → `42501` |
| **M8** `update-trial` dead first update | Removed; `bump_trial_seconds` RPC with server-side LEAST clamp | Code read 2026-09-13 |
| *(follow-on)* `generate-gateway-token` dead `subscription_status` read | Removed (column never existed on the live DB) | Live schema introspected 2026-09-12 |
| *(found 2026-09-14)* `consume-session` calls a dead RPC | `consume_session_balance(uuid,text)` was dropped by migration `20240825_fractional_credits.sql` (replaced by `deduct_credit_hours`); the function 500s; renderer has no caller (preload exposes it, nothing invokes it) — pre-existing, not migration-related | Live probe 2026-09-14: 500 `function public.consume_session_balance(p_column, p_user_id) does not exist`; `grep` clean for renderer callers. **Open:** delete the function + its two dead IPC handlers, or repoint at `deduct_credit_hours` |
| **C7** Gateway STT exempt + website AI calls tokenless | Gateway middleware: STT exemption removed, KV revocation on every route, `?token=` fallback (WS/`<audio>` can't set headers); website `lib/ai.ts`: full token flow (prefetch on camera-check screen, 1-min refresh, logout reset, TTS via `?token=`); desktop: STT fetches tokened, WS `?token=` plumbing | Deployed 2026-09-13 (website `edc67be` → Vercel, gateway `f164d3fe` → workers.dev); live probes: STT/LLM/TTS no-token → **401**, valid user token → auth passes (header + query param), deployed bundle contains `generate-gateway-token`/`x-gateway-token`. Desktop code ready — new app build/release pending |
| **C5** Inbound email webhook unsigned | svix verification (raw-body HMAC, 5-min replay window, constant-time compare, fail-closed); `RESEND_WEBHOOK_SECRET` set on the project; webhook re-registered in Resend on `email.received` only | Deployed 2026-09-13; live probes: no headers → 401, wrong signature → 401, stale timestamp → 401 |
| *(follow-on)* `subscription_status` in migration | Live schema verified before final migration run; migration applied cleanly 2026-09-12 | All four sections probe-verified |

---

## 8. Remediation plan (updated 2026-09-13)

### Immediate (this week)
1. ~~**Retire the `service_role` key** (C2)~~ **DONE 2026-09-14** — full migration + legacy deactivation executed and probe-verified (see §7).
2. **Close C7:** website `generate-gateway-token` flow → remove the STT exemption → KV check for STT → rate limit. (Until then, the website's analyze/LLM features 401 — decide whether they're live user features first.)
3. ~~**C5:** svix signature check on the inbound webhook.~~ **DONE 2026-09-13.**
4. **C6 — NEXT UP (agreed with owner 2026-09-14, scheduled next session):** step A (code cleanup — env var for cert password, dead admin-password lines, artifact scrub) + step B (`git filter-repo` purge + force-push, owner's explicit go needed) + step C (cert revoke/reissue — owner's action, blocks closure; **no Groq rotation needed** — the earlier claim was corrected 2026-09-14).

### Short-term
5. H1 deep-link state/nonce; H2 `openExternal` allowlist; H4/H5 stop handing keys/tokens to the renderer; H6 gate `admin:*` IPC on a verified session; H7 update-channel hardening.
6. Rebuild + redistribute both admin apps (they still run the pre-fix builds locally until replaced).

### Hardening
7. M1–M3, M5–M7; L1–L5.
8. Commit out-of-band DB objects to migrations so the repo keeps matching the live DB (the 2026-09-12 migration proved why: an inferred column did not exist).

---

## 9. Method notes & limitations

- Open items were re-verified against the tree at commit `6a9de4d7`+ (uncommitted fixes present 2026-09-13) **and** against the live project via probes (REST, RPC, function invokes, deploy metadata).
- Live probes used throwaway test accounts (created and deleted same day; no data residue).
- Razorpay signature behaviour could not be fully exercised from here (local `.env` holds the test key pair; deployed functions hold the live pair) — C1's closure rests on the deployed entrypoint/source match plus the RPC probes, both verified.
- Items still needing a live check by the owner: whether the code-signing certificate has been reissued (C6), and whether the old installers have been withdrawn from wherever they were distributed (C2's other half).

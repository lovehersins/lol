# App Starter

Electron desktop app with **Discord OAuth2 login**, backed by a minimal
serverless auth backend (Cloudflare Worker, no database). Discord is the
identity provider — this app never sees or stores a Discord password, and
never handles Discord's own OAuth tokens.

## How auth works

1. You click **Sign in with Discord**. The app opens Discord's login page
   in your system browser (not an embedded webview).
2. After you approve, Discord redirects to the backend, which exchanges
   the code for a Discord token **server-side**, looks up your Discord
   profile, then immediately discards Discord's token.
3. The backend mints its own short-lived session (an access token good for
   15 minutes, plus a rotating refresh token good for 30 days) and hands
   it to the desktop app over a one-time local handoff — never through a
   URL that leaves your machine.
4. The app stores only the refresh token, encrypted at rest via your OS
   keychain (Electron `safeStorage`). The access token lives in memory
   only and is never exposed to the UI layer.
5. When the access token expires, the app silently trades the refresh
   token for a new one. If the refresh token itself is expired or
   revoked, you're asked to sign in again.
6. **Sign out** revokes the refresh token on the backend and clears local
   state.

The renderer (UI) never touches a raw token — it only gets your public
Discord username/avatar and a signed-in/out boolean over IPC.

## Project layout

```
src/
  main.js            Electron main process: OAuth flow, token storage/refresh, IPC
  preload.js          Safe bridge between renderer and main (no raw tokens exposed)
  renderer/            UI (HTML/CSS/JS) — sign-in button, profile, console
backend/
  src/worker.js        Cloudflare Worker: Discord OAuth2 exchange, session issuing
  wrangler.toml        Worker + KV config
.github/workflows/     CI build for the .exe
```

## 1. Set up the Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create a new application.
2. Under **OAuth2 → General**, copy the **Client ID** and **Client Secret**.
3. Under **OAuth2 → Redirects**, add exactly one redirect URI:
   `https://<your-worker-subdomain>.workers.dev/auth/discord/callback`
   (must match `DISCORD_REDIRECT_URI` in `backend/wrangler.toml` exactly).
   Do **not** add any `http://127.0.0.1/...` redirect here — Discord only
   ever redirects to the backend; the backend then relays to your app's
   local loopback listener.
4. Scopes used: `identify` only (username, avatar, id — no email, no
   guilds, nothing else).

## 2. Deploy the backend (Cloudflare Workers, free tier)

```bash
cd backend
npm install
npx wrangler login

# One-time: create the KV namespace and paste the returned id into wrangler.toml
npx wrangler kv namespace create AUTH_KV

# Set secrets (never stored in the repo)
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put SESSION_JWT_SECRET   # any long random string

npm run deploy
```

Update `DISCORD_REDIRECT_URI` in `backend/wrangler.toml` to your actual
`*.workers.dev` URL (or custom domain) before deploying, and make sure it
matches the Discord Developer Portal redirect URI exactly.

For local backend development: copy `backend/.dev.vars.example` to
`backend/.dev.vars`, fill it in, then `npm run dev` (runs on
`http://localhost:8787`).

## 3. Run the desktop app locally

```bash
npm install
npm start
```

By default the app points at the `BACKEND_URL` hardcoded in `src/main.js`
— update that constant to your deployed Worker URL. To override for local
dev instead, copy `.env.example` to `.env` and set `BACKEND_URL` (e.g. to
your local `wrangler dev` URL). `.env` is git-ignored and is **not**
bundled into the built `.exe`.

## 4. Build the Windows .exe

Locally (on Windows, or via Wine on Linux/macOS):

```bash
npm run dist
```

The installer lands in `dist/`.

### Or let GitHub build it for you

`.github/workflows/build.yml` builds the exe on every push to `main` on a
Windows GitHub Actions runner. After a push, go to
**Actions → Build Windows exe → latest run → Artifacts** and download
`app-starter-windows`.

## Environment variables / secrets summary

| Where | Name | Secret? | Notes |
|---|---|---|---|
| Backend (Worker) | `DISCORD_CLIENT_ID` | No | Set via `wrangler secret put` anyway for convenience |
| Backend (Worker) | `DISCORD_CLIENT_SECRET` | **Yes** | Never leaves the Worker |
| Backend (Worker) | `SESSION_JWT_SECRET` | **Yes** | HMAC key signing session access tokens |
| Backend (Worker) | `DISCORD_REDIRECT_URI` | No | Public, in `wrangler.toml` |
| Desktop app | `BACKEND_URL` | No | Public Worker URL; hardcode or override via `.env` for dev only |

No database, no username/password table, and no long-lived credential is
ever bundled into the built app.

## Data storage

No database. Cloudflare KV holds only short-lived, ephemeral records:

| Key prefix | Contents | TTL |
|---|---|---|
| `state:*` | OAuth `state` + PKCE verifier + loopback redirect | 5 min, single use |
| `handoff:*` | One-time code → real tokens | 60 sec, single use |
| `refresh:*` | SHA-256 hash of refresh token → Discord profile | 30 days, rotated on use |

## Remaining security considerations

- Access tokens are stateless JWTs, so they can't be individually revoked
  before their 15-minute expiry — logout revokes the refresh token, which
  stops renewal, but an already-issued access token remains valid for up
  to 15 more minutes. Shorten `ACCESS_TOKEN_TTL_SECONDS` in
  `backend/src/worker.js` if you need a tighter window.
- If your OS doesn't support `safeStorage` encryption (rare, e.g. some
  minimal Linux setups without a keyring), the app currently declines to
  persist the refresh token at all rather than falling back to plaintext
  — you'll be prompted to sign in each launch on such systems.
- Rate limiting isn't implemented on the Worker endpoints; consider
  Cloudflare's built-in rate limiting rules if this is exposed publicly
  at scale.
- Rotate `SESSION_JWT_SECRET` periodically; doing so invalidates all
  outstanding access tokens (refresh tokens are unaffected since they're
  looked up in KV, not signed).

## Files changed / created

**Modified:**
- `src/main.js` — replaced static API-key config/proxy with the full
  Discord OAuth2 login flow, token storage/refresh, and IPC handlers.
- `src/preload.js` — replaced config/callApi bridge with
  auth/login/logout/whoami bridge (no raw tokens exposed).
- `src/renderer/index.html`, `src/renderer/renderer.js`,
  `src/renderer/styles.css` — replaced the Base URL/Endpoint/API key form
  with a Discord sign-in panel and profile display.
- `package.json` — updated description.
- `.env.example` — now documents `BACKEND_URL` only (no secrets).
- `.gitignore` — added backend dev-secret files.
- `README.md` — this file.

**Created:**
- `backend/src/worker.js` — the Cloudflare Worker implementing the OAuth2
  exchange, session issuance/refresh/revocation, and `/me`.
- `backend/wrangler.toml` — Worker + KV configuration.
- `backend/package.json` — Worker dev dependencies/scripts.
- `backend/.dev.vars.example` — template for local Worker secrets.

**Unchanged:**
- `.github/workflows/build.yml` — still just builds the Windows `.exe`;
  no change needed since `BACKEND_URL` is non-secret and hardcoded.

/**
 * Discord OAuth2 auth backend for the desktop app.
 *
 * Design notes (see repo root README for the full write-up):
 * - No user database. Discord is the identity provider; the only
 *   server-side state is short-lived OAuth "state"/PKCE data, one-time
 *   handoff codes, and refresh-token hashes, all in Workers KV with TTLs.
 * - Discord's own OAuth tokens are used once (to call /users/@me) and then
 *   discarded. They are never returned to the client and never stored.
 * - The client only ever receives: a short-lived signed session JWT
 *   ("access token", 15 min) and an opaque refresh token (30 days).
 */

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const OAUTH_STATE_TTL_SECONDS = 5 * 60; // 5 minutes
const HANDOFF_TTL_SECONDS = 60; // 1 minute, single use

const DISCORD_API = 'https://discord.com/api/v10';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/auth/discord/start' && request.method === 'GET') {
        return await handleStart(url, env);
      }
      if (url.pathname === '/auth/discord/callback' && request.method === 'GET') {
        return await handleCallback(url, env);
      }
      if (url.pathname === '/auth/token/exchange' && request.method === 'POST') {
        return await handleTokenExchange(request, env);
      }
      if (url.pathname === '/auth/refresh' && request.method === 'POST') {
        return await handleRefresh(request, env);
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        return await handleLogout(request, env);
      }
      if (url.pathname === '/me' && request.method === 'GET') {
        return await handleMe(request, env);
      }
      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'internal_error' }, 500);
    }
  },
};

// ---- /auth/discord/start ----------------------------------------------

async function handleStart(url, env) {
  const redirectUri = url.searchParams.get('redirect_uri') || '';

  // Only ever allow redirecting back to a loopback address the desktop
  // app just spun up. This is the anti-open-redirect check: without it,
  // an attacker could ask us to hand a real handoff code to any URL.
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/callback$/.test(redirectUri)) {
    return json({ error: 'invalid_redirect_uri' }, 400);
  }

  const state = randomToken(32);
  const codeVerifier = randomToken(48);
  const codeChallenge = base64url(await sha256(codeVerifier));

  await env.AUTH_KV.put(
    `state:${state}`,
    JSON.stringify({ codeVerifier, redirectUri }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS }
  );

  const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', env.DISCORD_REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'identify');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  return json({ authorize_url: authorizeUrl.toString() });
}

// ---- /auth/discord/callback --------------------------------------------

async function handleCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return htmlPage('Sign-in was cancelled. You can close this window and try again.');
  }
  if (!code || !state) {
    return htmlPage('Missing code or state. You can close this window and try again.');
  }

  const stateKey = `state:${state}`;
  const stateRaw = await env.AUTH_KV.get(stateKey);
  // One-time use: delete immediately, regardless of outcome, so a replayed
  // or forged `state` can never succeed. This is the CSRF protection.
  if (stateRaw) await env.AUTH_KV.delete(stateKey);

  if (!stateRaw) {
    return htmlPage('This sign-in link expired or was already used. Please try signing in again from the app.');
  }
  const { codeVerifier, redirectUri } = JSON.parse(stateRaw);

  // Exchange the code server-side. The client secret never leaves the Worker.
  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.DISCORD_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    return htmlPage('Discord rejected the sign-in request. You can close this window and try again.');
  }
  const discordTokens = await tokenRes.json();

  const profileRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${discordTokens.access_token}` },
  });
  if (!profileRes.ok) {
    return htmlPage('Could not read your Discord profile. You can close this window and try again.');
  }
  const profile = await profileRes.json();
  // discordTokens is intentionally dropped here — we never store or return
  // Discord's own OAuth tokens.

  const user = {
    id: profile.id,
    username: profile.global_name || profile.username,
    avatar: profile.avatar
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
      : null,
  };

  const accessToken = await signSessionJwt(user, env.SESSION_JWT_SECRET);
  const refreshToken = randomToken(48);
  await storeRefreshToken(env, refreshToken, user);

  const handoffCode = randomToken(24);
  await env.AUTH_KV.put(
    `handoff:${handoffCode}`,
    JSON.stringify({ accessToken, refreshToken, user }),
    { expirationTtl: HANDOFF_TTL_SECONDS }
  );

  // Redirect the system browser back to the app's local loopback server.
  // Only a one-time opaque code travels in this URL — never the real tokens.
  const dest = new URL(redirectUri);
  dest.searchParams.set('handoff', handoffCode);
  return Response.redirect(dest.toString(), 302);
}

// ---- /auth/token/exchange ------------------------------------------------

async function handleTokenExchange(request, env) {
  const body = await safeJson(request);
  const handoffCode = body?.handoff_code;
  if (!handoffCode) return json({ error: 'missing_handoff_code' }, 400);

  const key = `handoff:${handoffCode}`;
  const raw = await env.AUTH_KV.get(key);
  if (!raw) return json({ error: 'invalid_or_expired_handoff_code' }, 400);
  await env.AUTH_KV.delete(key); // single use

  const { accessToken, refreshToken, user } = JSON.parse(raw);
  return json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    user,
  });
}

// ---- /auth/refresh ---------------------------------------------------

async function handleRefresh(request, env) {
  const body = await safeJson(request);
  const refreshToken = body?.refresh_token;
  if (!refreshToken) return json({ error: 'missing_refresh_token' }, 400);

  const hash = base64url(await sha256(refreshToken));
  const key = `refresh:${hash}`;
  const raw = await env.AUTH_KV.get(key);
  if (!raw) {
    // Expired, revoked, or unknown — caller must do a full Discord login again.
    return json({ error: 'invalid_or_expired_refresh_token' }, 401);
  }
  const { user } = JSON.parse(raw);

  // Rotate: delete the old refresh token, issue a new one.
  await env.AUTH_KV.delete(key);
  const newRefreshToken = randomToken(48);
  await storeRefreshToken(env, newRefreshToken, user);

  const accessToken = await signSessionJwt(user, env.SESSION_JWT_SECRET);
  return json({
    access_token: accessToken,
    refresh_token: newRefreshToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    user,
  });
}

// ---- /auth/logout ------------------------------------------------------

async function handleLogout(request, env) {
  const body = await safeJson(request);
  const refreshToken = body?.refresh_token;
  if (refreshToken) {
    const hash = base64url(await sha256(refreshToken));
    await env.AUTH_KV.delete(`refresh:${hash}`);
  }
  return json({ ok: true });
}

// ---- /me -----------------------------------------------------------------

async function handleMe(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json({ error: 'missing_bearer_token' }, 401);

  const payload = await verifySessionJwt(token, env.SESSION_JWT_SECRET);
  if (!payload) return json({ error: 'invalid_or_expired_access_token' }, 401);

  return json({ user: { id: payload.sub, username: payload.username, avatar: payload.avatar } });
}

// ---- helpers ---------------------------------------------------------

async function storeRefreshToken(env, refreshToken, user) {
  const hash = base64url(await sha256(refreshToken));
  await env.AUTH_KV.put(`refresh:${hash}`, JSON.stringify({ user }), {
    expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
  });
}

async function signSessionJwt(user, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.id,
    username: user.username,
    avatar: user.avatar,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
  };
  const encHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const sig = base64url(await hmacSign(signingInput, secret));
  return `${signingInput}.${sig}`;
}

async function verifySessionJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, sig] = parts;
  const expectedSig = base64url(await hmacSign(`${encHeader}.${encPayload}`, secret));
  if (!timingSafeEqual(sig, expectedSig)) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(encPayload)));
  } catch (_) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function sha256(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

function randomToken(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64url(bytes);
}

function base64url(bytes) {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlPage(message) {
  return new Response(
    `<!doctype html><html><body style="font-family:sans-serif;background:#12151b;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><p>${message}</p></body></html>`,
    { headers: { 'Content-Type': 'text/html' } }
  );
}

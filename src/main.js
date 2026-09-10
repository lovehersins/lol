const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Public URL of the deployed auth backend.
const BACKEND_URL =
  process.env.BACKEND_URL || 'https://app-starter-auth.testingappauth.workers.dev';

const SESSION_PATH = path.join(app.getPath('userData'), 'session.bin');

// In-memory only -- never written to disk, never sent to the renderer.
let session = { accessToken: null, accessTokenExpiresAt: 0, user: null };

// ---- persisted refresh token (encrypted at rest via OS keychain) ---------

function loadRefreshToken() {
  try {
    const encrypted = fs.readFileSync(SESSION_PATH);
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(encrypted);
  } catch (_) {
    return null;
  }
}

function saveRefreshToken(refreshToken) {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(
      'OS secure storage unavailable; refresh token will not persist across restarts.'
    );
    return;
  }

  fs.writeFileSync(
    SESSION_PATH,
    safeStorage.encryptString(refreshToken)
  );
}

function clearRefreshToken() {
  try {
    fs.unlinkSync(SESSION_PATH);
  } catch (_) {
    // Nothing to remove.
  }
}

// ---- session helpers -----------------------------------------------------

function publicUser() {
  return session.user ? { ...session.user } : null;
}

function applyTokens({ access_token, refresh_token, expires_in, user }) {
  session.accessToken = access_token;
  session.accessTokenExpiresAt =
    Date.now() + expires_in * 1000 - 30_000;
  session.user = user;

  saveRefreshToken(refresh_token);
}

function clearSession() {
  session = {
    accessToken: null,
    accessTokenExpiresAt: 0,
    user: null,
  };

  clearRefreshToken();
}

/**
 * Returns a valid access token, refreshing it first if it's expired/missing.
 */
async function getValidAccessToken() {
  if (
    session.accessToken &&
    Date.now() < session.accessTokenExpiresAt
  ) {
    return session.accessToken;
  }

  const refreshToken = loadRefreshToken();

  if (!refreshToken) {
    return null;
  }

  const res = await fetch(`${BACKEND_URL}/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    clearSession();
    return null;
  }

  const data = await res.json();

  applyTokens(data);

  return session.accessToken;
}

/**
 * Attempts to restore a session at app startup
 * using the saved refresh token.
 */
async function tryRestoreSession() {
  const token = await getValidAccessToken();

  return token ? publicUser() : null;
}

// ---- Discord OAuth2 login flow -------------------------------------------

async function loginWithDiscord() {
  let resolveHandoff;
  let rejectHandoff;

  const handoffPromise = new Promise((resolve, reject) => {
    resolveHandoff = resolve;
    rejectHandoff = reject;
  });

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');

    if (reqUrl.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const handoffCode = reqUrl.searchParams.get('handoff');

    res.writeHead(200, {
      'Content-Type': 'text/html',
    });

    res.end(
      '<html><body style="font-family:sans-serif;background:#12151b;color:#eee;' +
        'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">' +
        '<p>Signed in. You can close this window and return to the app.</p>' +
        '</body></html>'
    );

    server.close();

    if (handoffCode) {
      resolveHandoff(handoffCode);
    } else {
      rejectHandoff(
        new Error('No handoff code received.')
      );
    }
  });

  // Start a local listener on 127.0.0.1 using an OS-assigned port.
  await new Promise((resolve, reject) => {
    server.on('error', reject);

    server.listen(
      0,
      '127.0.0.1',
      resolve
    );
  });

  const port = server.address().port;
  const redirectUri =
    `http://127.0.0.1:${port}/callback`;

  // Give up after 5 minutes.
  const timeout = setTimeout(() => {
    server.close();

    rejectHandoff(
      new Error(
        'Sign-in timed out. Please try again.'
      )
    );
  }, 5 * 60 * 1000);

  try {
    // Ask the backend for the Discord authorize URL.
    const startRes = await fetch(
      `${BACKEND_URL}/auth/discord/start?redirect_uri=${encodeURIComponent(
        redirectUri
      )}`
    );

    if (!startRes.ok) {
      throw new Error(
        'Could not start Discord sign-in. Is the backend reachable?'
      );
    }

    const { authorize_url } =
      await startRes.json();

    // Open Discord in the system browser.
    await shell.openExternal(authorize_url);

    // Wait for the loopback callback.
    const handoffCode =
      await handoffPromise;

    // Exchange the one-time handoff code.
    const exchangeRes = await fetch(
      `${BACKEND_URL}/auth/token/exchange`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          handoff_code: handoffCode,
        }),
      }
    );

    if (!exchangeRes.ok) {
      throw new Error(
        'Could not complete sign-in with the backend.'
      );
    }

    const data =
      await exchangeRes.json();

    applyTokens(data);

    return publicUser();
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

// ---- logout --------------------------------------------------------------

async function logout() {
  const refreshToken =
    loadRefreshToken();

  if (refreshToken) {
    try {
      await fetch(
        `${BACKEND_URL}/auth/logout`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            refresh_token: refreshToken,
          }),
        }
      );
    } catch (_) {
      // Best-effort revoke.
    }
  }

  clearSession();
}

// ---- window --------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 640,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#12151b',

    webPreferences: {
      preload: path.join(
        __dirname,
        'preload.js'
      ),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);

  win.loadFile(
    path.join(
      __dirname,
      'renderer',
      'index.html'
    )
  );
}

// ---- IPC -----------------------------------------------------------------

ipcMain.handle(
  'auth:getStatus',
  async () => {
    const user =
      await tryRestoreSession();

    return {
      loggedIn: !!user,
      user,
    };
  }
);

ipcMain.handle(
  'auth:login',
  async () => {
    try {
      const user =
        await loginWithDiscord();

      return {
        ok: true,
        user,
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message,
      };
    }
  }
);

ipcMain.handle(
  'auth:logout',
  async () => {
    await logout();

    return {
      ok: true,
    };
  }
);

// Authenticated test call.
ipcMain.handle(
  'api:whoami',
  async () => {
    const token =
      await getValidAccessToken();

    if (!token) {
      return {
        ok: false,
        error:
          'Not signed in. Please sign in with Discord first.',
      };
    }

    try {
      const res = await fetch(
        `${BACKEND_URL}/me`,
        {
          headers: {
            Authorization:
              `Bearer ${token}`,
          },
        }
      );

      const body =
        await res.json();

      if (!res.ok) {
        return {
          ok: false,
          error:
            `Request failed (${res.status})`,
          body,
        };
      }

      return {
        ok: true,
        body,
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message,
      };
    }
  }
);

// ---- app lifecycle -------------------------------------------------------

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (
      BrowserWindow.getAllWindows()
        .length === 0
    ) {
      createWindow();
    }
  });
});

app.on(
  'window-all-closed',
  () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  }
);
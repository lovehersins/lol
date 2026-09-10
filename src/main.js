const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (_) {
    // No saved config yet — that's fine.
  }
  return {
    baseUrl: fileConfig.baseUrl || process.env.API_BASE_URL || '',
    apiKey: fileConfig.apiKey || process.env.API_KEY || '',
    endpoint: fileConfig.endpoint || process.env.API_ENDPOINT || '',
  };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 640,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#12151b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', (_event, config) => saveConfig(config));

ipcMain.handle('api:call', async (_event, { prompt }) => {
  const config = loadConfig();

  if (!config.baseUrl || !config.apiKey) {
    return {
      ok: false,
      error: 'Add a base URL and API key in Settings before sending a request.',
    };
  }

  const url = config.endpoint
    ? new URL(config.endpoint, config.baseUrl).toString()
    : config.baseUrl;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ prompt }),
    });

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = text;
    }

    if (!response.ok) {
      return { ok: false, error: `Request failed (${response.status})`, body };
    }

    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const baseUrlInput = document.getElementById('baseUrl');
const endpointInput = document.getElementById('endpoint');
const apiKeyInput = document.getElementById('apiKey');
const configForm = document.getElementById('config-form');
const saveStatus = document.getElementById('save-status');
const statusPill = document.getElementById('status-pill');

const log = document.getElementById('log');
const promptForm = document.getElementById('prompt-form');
const promptInput = document.getElementById('prompt');
const sendBtn = document.getElementById('send-btn');

function setPill(state) {
  statusPill.classList.remove('pill-idle', 'pill-ok', 'pill-error');
  if (state === 'ok') {
    statusPill.textContent = 'ready';
    statusPill.classList.add('pill-ok');
  } else if (state === 'error') {
    statusPill.textContent = 'last call failed';
    statusPill.classList.add('pill-error');
  } else {
    statusPill.textContent = 'not connected';
    statusPill.classList.add('pill-idle');
  }
}

async function loadConfig() {
  const config = await window.bridge.getConfig();
  baseUrlInput.value = config.baseUrl || '';
  endpointInput.value = config.endpoint || '';
  apiKeyInput.value = config.apiKey || '';
  setPill(config.baseUrl && config.apiKey ? 'ok' : 'idle');
}

configForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const config = {
    baseUrl: baseUrlInput.value.trim(),
    endpoint: endpointInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
  };
  await window.bridge.setConfig(config);
  saveStatus.textContent = 'Saved.';
  setPill(config.baseUrl && config.apiKey ? 'ok' : 'idle');
  setTimeout(() => (saveStatus.textContent = ''), 2000);
});

function appendEntry(promptText, result) {
  const empty = log.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'entry';

  const promptEl = document.createElement('div');
  promptEl.className = 'entry-prompt';
  promptEl.textContent = promptText;
  entry.appendChild(promptEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'entry-body' + (result.ok ? '' : ' error');
  bodyEl.textContent = result.ok
    ? JSON.stringify(result.body, null, 2)
    : `${result.error}${result.body ? '\n' + JSON.stringify(result.body, null, 2) : ''}`;
  entry.appendChild(bodyEl);

  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

promptForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = promptInput.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  promptInput.value = '';

  const result = await window.bridge.callApi(text);
  appendEntry(text, result);
  setPill(result.ok ? 'ok' : 'error');
  sendBtn.disabled = false;
  promptInput.focus();
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    promptForm.requestSubmit();
  }
});

loadConfig();

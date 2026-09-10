const signedOutView = document.getElementById('signed-out-view');
const signedInView = document.getElementById('signed-in-view');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const loginStatus = document.getElementById('login-status');
const avatarEl = document.getElementById('avatar');
const usernameEl = document.getElementById('username');
const statusPill = document.getElementById('status-pill');

const log = document.getElementById('log');
const promptForm = document.getElementById('prompt-form');
const promptInput = document.getElementById('prompt');
const sendBtn = document.getElementById('send-btn');

function setPill(state) {
  statusPill.classList.remove('pill-idle', 'pill-ok', 'pill-error');
  if (state === 'ok') {
    statusPill.textContent = 'signed in';
    statusPill.classList.add('pill-ok');
  } else if (state === 'error') {
    statusPill.textContent = 'last call failed';
    statusPill.classList.add('pill-error');
  } else {
    statusPill.textContent = 'not signed in';
    statusPill.classList.add('pill-idle');
  }
}

function renderUser(user) {
  if (user) {
    signedOutView.classList.add('hidden');
    signedInView.classList.remove('hidden');
    usernameEl.textContent = user.username;
    avatarEl.src = user.avatar || '';
    avatarEl.style.visibility = user.avatar ? 'visible' : 'hidden';
    setPill('ok');
  } else {
    signedOutView.classList.remove('hidden');
    signedInView.classList.add('hidden');
    setPill('idle');
  }
}

async function refreshStatus() {
  const { loggedIn, user } = await window.bridge.getAuthStatus();
  renderUser(loggedIn ? user : null);
}

loginBtn.addEventListener('click', async () => {
  loginBtn.disabled = true;
  loginStatus.textContent = 'Opening Discord in your browser…';
  const result = await window.bridge.login();
  loginBtn.disabled = false;
  if (result.ok) {
    loginStatus.textContent = '';
    renderUser(result.user);
  } else {
    loginStatus.textContent = result.error || 'Sign-in failed.';
  }
});

logoutBtn.addEventListener('click', async () => {
  await window.bridge.logout();
  renderUser(null);
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

  // This starter's "console" now demonstrates an authenticated call: it
  // asks the backend which Discord account is signed in (GET /me), rather
  // than proxying an arbitrary prompt to a manually-pasted API key.
  const result = await window.bridge.whoami();
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

refreshStatus();

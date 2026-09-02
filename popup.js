const PR_FIELDS = ['prGroupingEnabled', 'prAutoClose', 'prNotifyOnMerge', 'reviewWatchEnabled', 'reviewAutoOpen'];
const BOOLEAN_FIELDS = ['groupingEnabled', 'collapseNewGroups', 'staleEnabled', ...PR_FIELDS];
const NUMBER_FIELDS = ['minTabsPerGroup', 'staleHours', 'staleMinCount'];

const el = (id) => document.getElementById(id);

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

function readSettings() {
  const settings = {};
  for (const field of BOOLEAN_FIELDS) settings[field] = el(field).checked;
  for (const field of NUMBER_FIELDS) {
    const input = el(field);
    const value = Number(input.value);
    const min = Number(input.min);
    const max = Number(input.max);
    settings[field] = Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;
    input.value = settings[field];
  }
  return settings;
}

async function save() {
  await send({ type: 'saveSettings', settings: readSettings() });
  await refreshCount();
}

async function refreshCount() {
  const { stale } = await send({ type: 'getState' });
  const badge = el('staleCount');
  badge.hidden = stale.length === 0;
  badge.textContent = `${stale.length} stale`;
}

/* ---------------- GitHub ---------------- */

let pollTimer;

function showGithub(view) {
  el('ghDisconnected').hidden = view !== 'disconnected';
  el('ghPending').hidden = view !== 'pending';
  el('ghConnected').hidden = view !== 'connected';
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

// The popup polls while it's open for a responsive code screen; the background
// alarm keeps polling if the popup closes mid-flow.
function schedulePoll(seconds) {
  stopPolling();
  pollTimer = setTimeout(poll, Math.max(2, seconds) * 1000);
}

async function poll() {
  const result = await send({ type: 'pollGithub' });
  switch (result.status) {
    case 'pending':
      el('ghStatus').textContent = 'Waiting for authorisation…';
      schedulePoll(result.interval || 5);
      return;
    case 'connected':
      stopPolling();
      await refreshGithub();
      return;
    case 'denied':
      stopPolling();
      el('ghStatus').textContent = 'Request declined on GitHub.';
      setTimeout(() => showGithub('disconnected'), 2500);
      return;
    case 'expired':
      stopPolling();
      el('ghStatus').textContent = 'Code expired — try again.';
      setTimeout(() => showGithub('disconnected'), 2500);
      return;
    default:
      stopPolling();
      el('ghStatus').textContent = result.message || 'Something went wrong.';
  }
}

function renderDevice(device) {
  const code = device.userCode || '';
  el('ghCode').textContent = code;
  el('ghStatus').textContent = 'Waiting for authorisation…';
  showGithub('pending');
  schedulePoll(device.interval || 5);
}

async function refreshGithub() {
  const { github, settings } = await send({ type: 'getState' });
  if (github.connected) {
    stopPolling();
    el('ghLogin').textContent = `@${github.login}`;
    for (const field of PR_FIELDS) el(field).checked = settings[field];
    showGithub('connected');
    return;
  }
  // The popup is destroyed every time it closes — including when Copy opens the
  // GitHub tab — so a connect already in flight has to be picked back up here,
  // or it looks like nothing happened and the user presses Connect again.
  if (github.pendingDevice) {
    renderDevice(github.pendingDevice);
    return;
  }
  showGithub('disconnected');
}

function wireGithub() {
  el('ghConnect').addEventListener('click', async (event) => {
    event.target.disabled = true;
    const result = await send({ type: 'connectGithub' });
    event.target.disabled = false;
    if (result.error) {
      el('ghStatus').textContent = result.error;
      showGithub('pending');
      return;
    }
    renderDevice(result.device);
  });

  el('ghCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(el('ghCode').textContent);
    el('ghCopy').textContent = 'Copied';
    setTimeout(() => (el('ghCopy').textContent = 'Copy'), 1500);
    await chrome.tabs.create({ url: 'https://github.com/login/device' });
  });

  el('ghCancel').addEventListener('click', async () => {
    stopPolling();
    await send({ type: 'cancelGithubConnect' });
    showGithub('disconnected');
  });

  el('ghDisconnect').addEventListener('click', async () => {
    await send({ type: 'disconnectGithub' });
    showGithub('disconnected');
  });

  el('prReview').addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('review.html#prs') });
    window.close();
  });

  el('prSync').addEventListener('click', async (event) => {
    event.target.disabled = true;
    event.target.textContent = 'Syncing…';
    await send({ type: 'syncPrs' });
    event.target.textContent = 'Sync now';
    event.target.disabled = false;
    await refreshCount();
  });
}

async function init() {
  const { settings, stale } = await send({ type: 'getState' });
  for (const field of BOOLEAN_FIELDS) el(field).checked = settings[field];
  for (const field of NUMBER_FIELDS) el(field).value = settings[field];

  const badge = el('staleCount');
  badge.hidden = stale.length === 0;
  badge.textContent = `${stale.length} stale`;

  for (const field of [...BOOLEAN_FIELDS, ...NUMBER_FIELDS]) {
    el(field).addEventListener('change', save);
  }

  el('regroupNow').addEventListener('click', async (event) => {
    event.target.disabled = true;
    await send({ type: 'regroupNow' });
    event.target.disabled = false;
  });

  el('ungroupAll').addEventListener('click', async (event) => {
    event.target.disabled = true;
    await send({ type: 'ungroupAll' });
    event.target.disabled = false;
  });

  el('review').addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
    window.close();
  });

  for (const button of document.querySelectorAll('.stepper button')) {
    button.addEventListener('click', async () => {
      const input = el(button.dataset.target);
      const next = Number(input.value) + Number(button.dataset.step);
      input.value = Math.min(Math.max(next, Number(input.min)), Number(input.max));
      await save();
    });
  }

  wireGithub();
  await refreshGithub();
}

init();

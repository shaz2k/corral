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
    const via = github.kind === 'pat' ? 'token' : 'GitHub sign-in';
    el('ghLogin').textContent = `@${github.login} · via ${via}`;
    el('ghNoSearch').hidden = github.canSearch !== false;

    // Surface a live sync failure here too — the popup is where people look
    // when PR groups aren't appearing.
    const problem = el('ghProblem');
    problem.textContent = '';
    const { error } = await send({ type: 'getPrState' });
    problem.hidden = !error;
    if (error) {
      problem.append(error.message);
      if (error.url) {
        const link = document.createElement('a');
        link.href = error.url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.className = 'banner-link';
        link.textContent = 'Authorise this token →';
        problem.append(link);
      }
    }
    // Discovery needs search; hide the toggles that cannot work rather than
    // leaving switches that silently do nothing.
    const searchable = github.canSearch !== false;
    el('reviewWatchEnabled').closest('.row').hidden = !searchable;
    el('reviewAutoOpen').closest('.row').hidden = !searchable;
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
  const patError = (text) => {
    const box = el('ghPatError');
    box.textContent = text || '';
    box.hidden = !text;
  };

  const savePat = async () => {
    const token = el('ghPat').value;
    if (!token.trim()) return patError('Paste a token first.');
    patError('');
    el('ghPatSave').disabled = true;
    el('ghPatSave').textContent = 'Checking…';
    const result = await send({ type: 'connectPat', token });
    el('ghPatSave').disabled = false;
    el('ghPatSave').textContent = 'Connect';
    if (result.error) return patError(result.error);
    el('ghPat').value = '';
    await refreshGithub();
  };

  el('ghPatSave').addEventListener('click', savePat);
  el('ghPat').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') savePat();
  });

  el('ghPatCreate').addEventListener('click', () => {
    // Pre-fills scope and description so the token works first time.
    chrome.tabs.create({
      url: 'https://github.com/settings/tokens/new?scopes=repo&description=Corral%20tab%20groups',
    });
  });

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
    const note = el('prSyncResult');
    event.target.disabled = true;
    event.target.textContent = 'Syncing…';

    // Refresh what is already open first, so any PR that just landed is flagged
    // before we pull in more, then open tabs for anything still missing one.
    await send({ type: 'syncPrs' });
    const result = await send({ type: 'openMissingPrs' });

    event.target.textContent = 'Sync now';
    event.target.disabled = false;

    note.hidden = false;
    if (result.error) note.textContent = result.error;
    else if (result.opened) note.textContent = `Up to date · opened ${result.opened} new tab${result.opened === 1 ? '' : 's'}.`;
    else if (result.total) note.textContent = `Up to date · all ${result.total} of your PRs already have a tab.`;
    else note.textContent = 'Up to date · you have no open pull requests.';
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

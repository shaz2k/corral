const el = (id) => document.getElementById(id);

function formatIdle(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 60) return `${minutes}m idle`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h idle`;
  return `${Math.round(hours / 24)}d idle`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

function selectedIds() {
  return [...document.querySelectorAll('#list input[type=checkbox]:checked')].map((box) =>
    Number(box.dataset.tabId)
  );
}

function syncButtons() {
  const count = selectedIds().length;
  el('close').disabled = count === 0;
  el('discard').disabled = count === 0;
  el('close').textContent = count ? `Close ${count}` : 'Close';
  el('discard').textContent = count ? `Unload ${count}` : 'Unload';
  for (const item of document.querySelectorAll('#list li')) {
    item.classList.toggle('selected', item.querySelector('input').checked);
  }
}

let toastTimer;

function showToast(text, undoTabs) {
  clearTimeout(toastTimer);
  el('toastText').textContent = text;
  const undo = el('toastUndo');
  undo.hidden = !undoTabs?.length;
  undo.onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'reopenTabs', tabs: undoTabs });
    el('toast').classList.remove('show');
    await load();
  };
  el('toast').classList.add('show');
  toastTimer = setTimeout(() => el('toast').classList.remove('show'), 7000);
}

function faviconNode(tab) {
  const wrap = document.createElement('span');
  wrap.className = 'favicon';
  if (tab.favIconUrl && /^https?:/.test(tab.favIconUrl)) {
    const img = document.createElement('img');
    img.src = tab.favIconUrl;
    img.alt = '';
    // Fall back to the first letter of the host if the icon fails to load.
    img.addEventListener('error', () => {
      img.remove();
      wrap.textContent = hostOf(tab.url).charAt(0).toUpperCase();
    });
    wrap.append(img);
  } else {
    wrap.textContent = hostOf(tab.url).charAt(0).toUpperCase();
  }
  return wrap;
}

function render(stale, settings) {
  const list = el('list');
  list.textContent = '';

  el('summary').textContent = stale.length
    ? `${stale.length} ${stale.length === 1 ? 'tab' : 'tabs'} untouched for over ${settings.staleHours}h`
    : '';
  el('empty').hidden = stale.length > 0;

  for (const tab of stale) {
    const item = document.createElement('li');

    const boxWrap = document.createElement('span');
    boxWrap.className = 'checkbox';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.tabId = String(tab.id);
    box.addEventListener('change', syncButtons);
    boxWrap.append(box);

    const info = document.createElement('div');
    info.className = 'tab-info';
    info.title = tab.url;

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url;

    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = hostOf(tab.url);
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '·';
    const idle = document.createElement('span');
    idle.textContent = formatIdle(tab.lastActive);
    meta.append(host, sep, idle);
    if (tab.discarded) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'unloaded';
      meta.append(tag);
    }

    info.append(title, meta);
    info.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'focusTab', tabId: tab.id }));

    item.append(boxWrap, faviconNode(tab), info);
    list.append(item);
  }

  syncButtons();
}

async function load() {
  const { stale, settings } = await chrome.runtime.sendMessage({ type: 'getState' });
  render(stale, settings);
}

/* ---------------- pull requests ---------------- */

const STATE_LABELS = {
  merged: 'Merged',
  closed: 'Closed',
  open: 'Open',
  draft: 'Draft',
  unknown: 'Checking…',
};

function isDone(state) {
  return state === 'merged' || state === 'closed';
}

function badge(state) {
  const tag = document.createElement('span');
  tag.className = `state state-${state}`;
  tag.textContent = STATE_LABELS[state] || state;
  return tag;
}

function prRow(pr, { checkbox = false, checked = false } = {}) {
  const item = document.createElement('li');
  if (checkbox) {
    const boxWrap = document.createElement('span');
    boxWrap.className = 'checkbox';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.dataset.prKey = pr.key;
    box.addEventListener('change', syncPrButtons);
    boxWrap.append(box);
    item.append(boxWrap);
  }

  const info = document.createElement('div');
  info.className = 'tab-info';
  info.title = pr.url;

  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = pr.title || pr.key;

  const meta = document.createElement('div');
  meta.className = 'tab-meta';
  const repo = document.createElement('span');
  repo.className = 'host';
  repo.textContent = `${pr.repo} #${pr.number}`;
  meta.append(repo);
  if (pr.state) meta.append(badge(pr.state));
  if (pr.relation === 'review') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'your review';
    meta.append(tag);
  }

  info.append(title, meta);
  item.append(info);
  return { item, info };
}

function selectedPrKeys() {
  return [...document.querySelectorAll('#prList input[type=checkbox]:checked')].map((box) => box.dataset.prKey);
}

function syncPrButtons() {
  const count = selectedPrKeys().length;
  const button = el('prCloseDone');
  button.disabled = count === 0;
  button.textContent = count ? `Close ${count}` : 'Close done';
  for (const item of document.querySelectorAll('#prList li')) {
    const box = item.querySelector('input');
    if (box) item.classList.toggle('selected', box.checked);
  }
}

function renderPrTabs(prTabs) {
  const list = el('prList');
  list.textContent = '';
  el('prEmpty').hidden = prTabs.length > 0;

  // Finished PRs first — those are the actionable ones.
  const sorted = [...prTabs].sort((a, b) => Number(isDone(b.state)) - Number(isDone(a.state)));
  for (const pr of sorted) {
    const done = isDone(pr.state);
    const { item, info } = prRow(pr, { checkbox: true, checked: done });
    if (done) {
      const hint = document.createElement('span');
      hint.className = 'tag safe';
      hint.textContent = 'safe to close';
      item.querySelector('.tab-meta').append(hint);
    }
    if (pr.pinned) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'pinned';
      item.querySelector('.tab-meta').append(tag);
    }
    info.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'focusTab', tabId: pr.id }));
    item.dataset.tabId = String(pr.id);
    list.append(item);
  }
  syncPrButtons();
}

function renderPrUndo(undo) {
  el('prUndoBlock').hidden = undo.length === 0;
  const list = el('prUndoList');
  list.textContent = '';
  for (const entry of undo) {
    const { item } = prRow({ ...entry, state: 'merged' });
    const reopen = document.createElement('button');
    reopen.textContent = 'Reopen';
    reopen.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'undoPrClose', keys: [entry.key] });
      await loadPrs();
    });
    item.append(reopen);
    list.append(item);
  }
}

function renderAvailable(prs) {
  const list = el('prAvailable');
  list.textContent = '';
  const missing = prs.filter((pr) => !pr.hasTab);
  el('prOpenMissing').disabled = missing.length === 0;
  el('prOpenMissing').textContent = missing.length
    ? `Open ${missing.length} without a tab`
    : 'All of them already have a tab';

  for (const pr of prs) {
    const { item, info } = prRow({ ...pr, state: pr.draft ? 'draft' : 'open' });
    if (pr.hasTab) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'tab open';
      item.querySelector('.tab-meta').append(tag);
    } else {
      const open = document.createElement('button');
      open.textContent = 'Open';
      open.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'openPrTabs', urls: [pr.url] });
        await loadPrs();
      });
      item.append(open);
    }
    info.addEventListener('click', () => chrome.tabs.create({ url: pr.url }));
    list.append(item);
  }
}

async function loadPrs() {
  const state = await chrome.runtime.sendMessage({ type: 'getPrState' });
  el('prDisconnected').hidden = state.connected;
  el('prBody').hidden = !state.connected;
  if (!state.connected) {
    el('summary').textContent = '';
    return;
  }

  const banner = el('prBanner');
  banner.hidden = !state.error;
  if (state.error) banner.textContent = state.error.message;

  renderPrTabs(state.prTabs);
  renderPrUndo(state.undo);

  const done = state.prTabs.filter((pr) => isDone(pr.state)).length;
  el('summary').textContent = state.prTabs.length
    ? `${state.prTabs.length} PR ${state.prTabs.length === 1 ? 'tab' : 'tabs'}` +
      (done ? ` · ${done} finished` : '')
    : 'No pull request tabs open';

  const available = await chrome.runtime.sendMessage({ type: 'getOpenPrs' });
  if (available.connected) renderAvailable(available.prs);
}

/* ---------------- view switching ---------------- */

function showView(view) {
  const prs = view === 'prs';
  el('staleView').hidden = prs;
  el('prView').hidden = !prs;
  el('staleActions').hidden = prs;
  el('prActions').hidden = !prs;
  el('viewTitle').textContent = prs ? 'Pull requests' : 'Stale tabs';
  el('navStale').classList.toggle('is-active', !prs);
  el('navPrs').classList.toggle('is-active', prs);
  location.hash = prs ? '#prs' : '';
  if (prs) loadPrs();
  else load();
}

el('navStale').addEventListener('click', () => showView('stale'));
el('navPrs').addEventListener('click', () => showView('prs'));

el('prRefresh').addEventListener('click', async (event) => {
  event.target.disabled = true;
  event.target.textContent = 'Refreshing…';
  await chrome.runtime.sendMessage({ type: 'syncPrs' });
  await loadPrs();
  event.target.textContent = 'Refresh';
  event.target.disabled = false;
});

el('prCloseDone').addEventListener('click', async () => {
  const tabIds = [...document.querySelectorAll('#prList li')]
    .filter((item) => item.querySelector('input')?.checked)
    .map((item) => Number(item.dataset.tabId));
  if (!tabIds.length) return;
  const { closed } = await chrome.runtime.sendMessage({ type: 'closeTabs', tabIds });
  await loadPrs();
  showToast(`Closed ${tabIds.length} PR ${tabIds.length === 1 ? 'tab' : 'tabs'}`, closed);
});

el('prOpenMissing').addEventListener('click', async (event) => {
  const urls = [...document.querySelectorAll('#prAvailable li')]
    .map((item) => item.querySelector('.tab-info')?.title)
    .filter(Boolean);
  const state = await chrome.runtime.sendMessage({ type: 'getPrState' });
  const open = new Set(state.prTabs?.map((pr) => pr.url) || []);
  const missing = urls.filter((url) => !open.has(url));
  if (!missing.length) return;
  event.target.disabled = true;
  await chrome.runtime.sendMessage({ type: 'openPrTabs', urls: missing });
  await loadPrs();
  event.target.disabled = false;
});

el('selectAll').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('#list input[type=checkbox]')];
  const turnOn = boxes.some((box) => !box.checked);
  for (const box of boxes) box.checked = turnOn;
  el('selectAll').textContent = turnOn ? 'Clear selection' : 'Select all';
  syncButtons();
});

el('close').addEventListener('click', async () => {
  const tabIds = selectedIds();
  if (!tabIds.length) return;
  const { closed } = await chrome.runtime.sendMessage({ type: 'closeTabs', tabIds });
  await load();
  showToast(`Closed ${tabIds.length} ${tabIds.length === 1 ? 'tab' : 'tabs'}`, closed);
});

el('discard').addEventListener('click', async () => {
  const tabIds = selectedIds();
  if (!tabIds.length) return;
  await chrome.runtime.sendMessage({ type: 'discardTabs', tabIds });
  await load();
  showToast(`Unloaded ${tabIds.length} ${tabIds.length === 1 ? 'tab' : 'tabs'} — they'll reload when clicked`);
});

showView(location.hash === '#prs' ? 'prs' : 'stale');

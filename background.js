import { groupKeyForUrl, labelForKey, colorForKey, isPrKey, PR_KEY, REVIEW_KEY, MINE_KEY } from './domain.js';
import {
  AuthError,
  RateLimitError,
  GITHUB_ORIGINS,
  clearToken,
  fetchMyOpenPrs,
  fetchPrState,
  fetchReviewRequests,
  getPendingDeviceFlow,
  getToken,
  pollDeviceFlow,
  prRefForUrl,
  startDeviceFlow,
} from './github.js';

const DEFAULTS = {
  groupingEnabled: true,
  minTabsPerGroup: 2,
  collapseNewGroups: false,
  staleEnabled: true,
  staleHours: 24,
  staleMinCount: 5,
  notifyIntervalMinutes: 180,
  prGroupingEnabled: true,
  prAutoClose: false,
  prNotifyOnMerge: true,
  reviewWatchEnabled: true,
  reviewAutoOpen: true,
};

const ACTIVITY_KEY = 'activity';
const MANAGED_KEY = 'managedGroups';
const LAST_NOTIFY_KEY = 'lastNotifyAt';
const PR_STATES_KEY = 'prStates';
const PR_UNDO_KEY = 'prUndo';
const PR_ERROR_KEY = 'prLastError';
// PRs we have already auto-opened a tab for. Without this, closing an
// auto-opened tab would just make it reappear on the next poll.
const SEEN_REVIEWS_KEY = 'seenReviewRequests';
const STALE_ALARM = 'tab-tidy-stale-scan';
const PR_ALARM = 'corral-pr-sync';
const DEVICE_ALARM = 'corral-device-poll';
const PR_UNDO_TTL_MS = 7 * 24 * 3600 * 1000;
const NO_GROUP = chrome.tabGroups ? chrome.tabGroups.TAB_GROUP_ID_NONE : -1;

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function getManaged() {
  const { [MANAGED_KEY]: managed } = await chrome.storage.local.get(MANAGED_KEY);
  return managed || {};
}

async function setManaged(managed) {
  await chrome.storage.local.set({ [MANAGED_KEY]: managed });
}

async function getActivity() {
  const { [ACTIVITY_KEY]: activity } = await chrome.storage.local.get(ACTIVITY_KEY);
  return activity || {};
}

/* ---------------- activity tracking ---------------- */

async function touchTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const activity = await getActivity();
  activity[tabId] = { ts: Date.now(), url: tab.url || '', title: tab.title || '' };
  await chrome.storage.local.set({ [ACTIVITY_KEY]: activity });
}

async function seedActivity() {
  const tabs = await chrome.tabs.query({});
  const activity = await getActivity();
  const now = Date.now();
  const live = {};
  for (const tab of tabs) {
    // Chrome recycles tab ids across restarts, so a stored record only belongs
    // to this tab if the URL still matches — otherwise start the clock fresh.
    const prev = activity[tab.id];
    const carriesOver = prev && prev.url && prev.url === tab.url;
    live[tab.id] = {
      ts: carriesOver ? prev.ts : now,
      url: tab.url || '',
      title: tab.title || '',
    };
  }
  await chrome.storage.local.set({ [ACTIVITY_KEY]: live });
}

/* ---------------- grouping ---------------- */

// PR tabs divert into their own buckets, but only while GitHub is actually
// connected — otherwise we can't tell merged from open and the group is just a
// worse-labelled github.com group.
//
// Which bucket depends on what the PR wants from you. `states` is the cached
// PR data; until a PR has been fetched we can't classify it, so it waits in the
// neutral group rather than guessing wrong and having the tab jump groups.
function keyForTab(tab, prGrouping, states) {
  const url = tab.url || tab.pendingUrl;
  if (!prGrouping) return groupKeyForUrl(url);
  const ref = prRefForUrl(url);
  if (!ref) return groupKeyForUrl(url);

  const known = states?.[ref.key];
  if (!known) return PR_KEY;
  // Reviews stay in Review even after you submit, so the tab doesn't hop
  // groups the instant you approve. reviewedByViewer is our own sticky flag.
  if (known.awaitingViewer || known.reviewedByViewer) return REVIEW_KEY;
  if (known.isMine) return MINE_KEY;
  return PR_KEY;
}

const pending = new Map();

function scheduleRegroup(windowId) {
  if (windowId === undefined || windowId === chrome.windows.WINDOW_ID_NONE) return;
  clearTimeout(pending.get(windowId));
  pending.set(
    windowId,
    setTimeout(() => {
      pending.delete(windowId);
      regroupWindow(windowId).catch(() => {});
    }, 600)
  );
}

let regroupChain = Promise.resolve();

function regroupWindow(windowId) {
  regroupChain = regroupChain.then(() => doRegroupWindow(windowId)).catch(() => {});
  return regroupChain;
}

async function doRegroupWindow(windowId) {
  const settings = await getSettings();
  if (!settings.groupingEnabled) return;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch {
    return;
  }
  if (!tabs.length) return;

  const managed = await getManaged();
  const startingCount = Object.keys(managed).length;
  const prGrouping = settings.prGroupingEnabled && Boolean(await getToken());
  const prStates = prGrouping ? await getPrStates() : null;

  // Existing managed groups in this window, by key. Drop records for groups
  // that no longer exist.
  const existingByKey = new Map();
  for (const [groupIdStr, key] of Object.entries(managed)) {
    const groupId = Number(groupIdStr);
    try {
      const group = await chrome.tabGroups.get(groupId);
      if (group.windowId === windowId) existingByKey.set(key, groupId);
    } catch {
      delete managed[groupIdStr];
    }
  }

  // Adopt groups we didn't create whose title already matches a domain label —
  // e.g. a "Github" group made by hand, or one from before this was installed.
  // Without this, new tabs can't join the group the user already thinks of as theirs.
  const keysInWindow = new Set();
  for (const tab of tabs) {
    const key = keyForTab(tab, prGrouping, prStates);
    if (key) keysInWindow.add(key);
  }
  const labelToKey = new Map([...keysInWindow].map((key) => [labelForKey(key).toLowerCase(), key]));
  const adoptedKeys = new Set();
  try {
    for (const group of await chrome.tabGroups.query({ windowId })) {
      if (managed[group.id] !== undefined) continue;
      const key = labelToKey.get((group.title || '').trim().toLowerCase());
      if (key === undefined || existingByKey.has(key)) continue;
      managed[group.id] = key;
      existingByKey.set(key, group.id);
      adoptedKeys.add(key);
    }
  } catch {}

  const managedIds = new Set(Object.keys(managed).map(Number));

  // key -> tabs eligible for (re)grouping
  const buckets = new Map();
  for (const tab of tabs) {
    if (tab.pinned) continue;
    const key = keyForTab(tab, prGrouping, prStates);
    if (!key) continue;
    // Leave groups the user made by hand alone.
    if (tab.groupId !== NO_GROUP && !managedIds.has(tab.groupId)) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(tab);
  }

  let managedDirty = Object.keys(managed).length !== startingCount;

  for (const [key, bucketTabs] of buckets) {
    const existingGroupId = existingByKey.get(key);

    // The PR groups are semantic, not a pile of same-domain tabs — one open PR
    // is already worth its own group, so the domain threshold doesn't apply.
    const threshold = isPrKey(key) ? 1 : settings.minTabsPerGroup;
    if (bucketTabs.length < threshold) {
      // Not enough tabs to justify a group we created. Release any we still hold —
      // but never dissolve a group the user made themselves.
      if (adoptedKeys.has(key)) continue;
      const strays = bucketTabs.filter((t) => t.groupId !== NO_GROUP);
      if (strays.length) {
        try {
          await chrome.tabs.ungroup(strays.map((t) => t.id));
        } catch {}
      }
      continue;
    }

    const needsGrouping = bucketTabs.filter((t) => t.groupId !== existingGroupId);
    if (!needsGrouping.length) continue;

    const tabIds = needsGrouping.map((t) => t.id);
    try {
      if (existingGroupId !== undefined) {
        await chrome.tabs.group({ groupId: existingGroupId, tabIds });
      } else {
        const groupId = await chrome.tabs.group({ createProperties: { windowId }, tabIds });
        await chrome.tabGroups.update(groupId, {
          title: labelForKey(key),
          color: colorForKey(key),
          collapsed: settings.collapseNewGroups,
        });
        managed[groupId] = key;
        existingByKey.set(key, groupId);
        managedDirty = true;
      }
    } catch {
      // Tab moved or closed mid-flight; the next event will retry.
    }
  }

  if (managedDirty) await setManaged(managed);
}

async function regroupAllWindows() {
  const windows = await chrome.windows.getAll();
  for (const win of windows) await regroupWindow(win.id);
}

/* ---------------- pull requests ---------------- */

async function getPrStates() {
  const { [PR_STATES_KEY]: states } = await chrome.storage.local.get(PR_STATES_KEY);
  return states || {};
}

async function getPrUndo() {
  const { [PR_UNDO_KEY]: entries } = await chrome.storage.local.get(PR_UNDO_KEY);
  const cutoff = Date.now() - PR_UNDO_TTL_MS;
  return (entries || []).filter((entry) => entry.closedAt > cutoff);
}

async function setPrError(error) {
  if (!error) {
    await chrome.storage.local.remove(PR_ERROR_KEY);
    return;
  }
  await chrome.storage.local.set({ [PR_ERROR_KEY]: error });
}

async function getPrError() {
  const { [PR_ERROR_KEY]: error } = await chrome.storage.local.get(PR_ERROR_KEY);
  return error || null;
}

// Every open tab that points at a pull request, with whatever state we know.
async function findPrTabs() {
  const tabs = await chrome.tabs.query({});
  const states = await getPrStates();
  const result = [];
  for (const tab of tabs) {
    const ref = prRefForUrl(tab.url || tab.pendingUrl);
    if (!ref) continue;
    const known = states[ref.key];
    const forReview = Boolean(known?.awaitingViewer || known?.reviewedByViewer);
    result.push({
      id: tab.id,
      windowId: tab.windowId,
      key: ref.key,
      repo: `${ref.owner}/${ref.repo}`,
      number: ref.number,
      url: tab.url || ref.key,
      title: known?.title || tab.title || ref.key,
      favIconUrl: tab.favIconUrl || '',
      pinned: tab.pinned,
      active: tab.active,
      state: known?.state || 'unknown',
      checkedAt: known?.checkedAt || 0,
      isMine: Boolean(known?.isMine),
      awaitingViewer: Boolean(known?.awaitingViewer),
      forReview,
      bucket: forReview ? 'review' : known?.isMine ? 'mine' : 'other',
    });
  }
  return result;
}

let prSyncChain = Promise.resolve();

function queuePrSync() {
  prSyncChain = prSyncChain
    .then(() => syncPullRequests())
    .then(async (result) => {
      const review = await checkReviewRequests().catch(() => null);
      return { ...result, reviewFound: review?.found || 0, reviewOpened: review?.opened || 0 };
    })
    .catch(() => {});
  return prSyncChain;
}

// Status-only refresh, for events where discovering new review requests would be
// surprising (e.g. the user merely navigated a tab to a PR).
function queueStatusSync() {
  prSyncChain = prSyncChain.then(() => syncPullRequests()).catch(() => {});
  return prSyncChain;
}

// Refresh the state of every PR we have a tab for, then act on the merged ones.
async function syncPullRequests() {
  const token = await getToken();
  if (!token) return { synced: 0 };

  const settings = await getSettings();
  const prTabs = await findPrTabs();
  if (!prTabs.length) {
    await setPrError(null);
    return { synced: 0 };
  }

  const states = await getPrStates();
  const now = Date.now();
  // Dedupe: the same PR open in three tabs is one API call.
  const refsByKey = new Map(prTabs.map((tab) => [tab.key, tab]));
  const newlyResolved = [];

  for (const [key, tab] of refsByKey) {
    const ref = prRefForUrl(tab.url);
    if (!ref) continue;
    try {
      const state = await fetchPrState(ref, token.accessToken, token.login);
      const prev = states[key];
      const previous = prev?.state;
      // Once a PR has been in your review queue it stays flagged, so submitting
      // a review (which clears requested_reviewers) doesn't move the tab.
      const reviewedByViewer = Boolean(prev?.reviewedByViewer || prev?.awaitingViewer);
      states[key] = { ...state, reviewedByViewer, checkedAt: now };
      // Only fire on the transition, so a tab left open for days doesn't get
      // re-notified (or re-closed after the user chose to reopen it).
      const resolved = state.state === 'merged' || state.state === 'closed';
      if (resolved && previous && previous !== 'merged' && previous !== 'closed') {
        newlyResolved.push({ key, state: state.state, title: state.title, repo: state.repo, number: state.number });
      }
    } catch (error) {
      if (error instanceof AuthError) {
        await clearToken();
        await setPrError({ kind: 'auth', message: 'GitHub disconnected — reconnect to keep tracking PRs.' });
        await regroupAllWindows();
        return { synced: 0, error: 'auth' };
      }
      if (error instanceof RateLimitError) {
        await chrome.storage.local.set({ [PR_STATES_KEY]: states });
        await setPrError({ kind: 'rate', message: 'GitHub rate limit reached. Retrying later.', resetAt: error.resetAt });
        return { synced: 0, error: 'rate' };
      }
      // A 404 usually means the repo is private to someone else or was deleted.
      // Leave the last known state alone and move on.
    }
  }

  await chrome.storage.local.set({ [PR_STATES_KEY]: states });
  await setPrError(null);

  if (newlyResolved.length) {
    if (settings.prAutoClose) await autoCloseResolved(newlyResolved);
    else if (settings.prNotifyOnMerge) notifyResolved(newlyResolved);
  }

  await updateBadgeFromScan();
  return { synced: refsByKey.size, resolved: newlyResolved.length };
}

/* ---------------- review request watcher ---------------- */

async function getSeenReviews() {
  const { [SEEN_REVIEWS_KEY]: seen } = await chrome.storage.local.get(SEEN_REVIEWS_KEY);
  return seen || {};
}

// Finds review requests that are new since the last check and opens a tab for
// each. Runs on the same alarm as the status sync.
async function checkReviewRequests() {
  const token = await getToken();
  if (!token) return { found: 0 };

  const settings = await getSettings();
  if (!settings.reviewWatchEnabled) return { found: 0 };

  let requests;
  try {
    requests = await fetchReviewRequests(token.accessToken);
  } catch (error) {
    if (error instanceof AuthError) {
      await clearToken();
      await setPrError({ kind: 'auth', message: 'GitHub disconnected — reconnect to keep tracking PRs.' });
      return { found: 0, error: 'auth' };
    }
    if (error instanceof RateLimitError) {
      await setPrError({ kind: 'rate', message: 'GitHub rate limit reached. Retrying later.', resetAt: error.resetAt });
      return { found: 0, error: 'rate' };
    }
    return { found: 0, error: String(error.message || error) };
  }

  const seen = await getSeenReviews();
  const openTabs = await findPrTabs();
  const openKeys = new Set(openTabs.map((tab) => tab.key));
  const now = Date.now();

  // Anything we have never acted on before. Keyed on our own record rather than
  // on open tabs, so closing an auto-opened tab doesn't make it come back.
  const fresh = requests.filter((pr) => !seen[pr.key]);
  for (const pr of requests) {
    if (!seen[pr.key]) seen[pr.key] = { firstSeenAt: now, opened: false };
  }

  // Record the state of these PRs so grouping can classify them immediately,
  // rather than leaving a freshly opened tab in the neutral group for a cycle.
  if (fresh.length) {
    const states = await getPrStates();
    for (const pr of fresh) {
      states[pr.key] = {
        ...(states[pr.key] || {}),
        state: pr.draft ? 'draft' : 'open',
        title: pr.title,
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        updatedAt: pr.updatedAt,
        isMine: false,
        awaitingViewer: true,
        reviewedByViewer: true,
        checkedAt: now,
      };
    }
    await chrome.storage.local.set({ [PR_STATES_KEY]: states });
  }

  const toOpen = settings.reviewAutoOpen ? fresh.filter((pr) => !openKeys.has(pr.key)) : [];
  for (const pr of toOpen) {
    try {
      await chrome.tabs.create({ url: pr.url, active: false });
      seen[pr.key].opened = true;
    } catch {}
  }

  await chrome.storage.local.set({ [SEEN_REVIEWS_KEY]: seen });

  if (fresh.length) {
    if (toOpen.length) await regroupAllWindows();
    notifyReviewRequests(fresh, toOpen.length);
  }

  await updateBadgeFromScan();
  return { found: fresh.length, opened: toOpen.length };
}

function notifyReviewRequests(fresh, openedCount) {
  const first = fresh[0];
  const many = fresh.length > 1;
  chrome.notifications.create('corral-review-requested', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: many ? `${fresh.length} PRs need your review` : 'A PR needs your review',
    message: openedCount
      ? `${first.repo} #${first.number}${many ? ' and others' : ''} — opened in your Review group.`
      : `${first.repo} #${first.number}${many ? ' and others' : ''} — open the review page to see them.`,
    buttons: [{ title: 'Show me' }, { title: 'Dismiss' }],
    requireInteraction: false,
  });
}

async function autoCloseResolved(resolved) {
  const keys = new Set(resolved.map((entry) => entry.key));
  const prTabs = await findPrTabs();
  const undo = await getPrUndo();
  const closedIds = [];

  for (const tab of prTabs) {
    if (!keys.has(tab.key)) continue;
    // Never yank a tab out from under someone who is looking at it, and never
    // touch a pinned tab — pinning is an explicit "keep this" signal.
    if (tab.active || tab.pinned) continue;
    undo.push({
      key: tab.key,
      url: tab.url,
      title: tab.title,
      repo: tab.repo,
      number: tab.number,
      windowId: tab.windowId,
      closedAt: Date.now(),
    });
    closedIds.push(tab.id);
  }

  if (!closedIds.length) return;
  try {
    await chrome.tabs.remove(closedIds);
  } catch {}
  await chrome.storage.local.set({ [PR_UNDO_KEY]: undo });

  const first = resolved[0];
  chrome.notifications.create(`corral-pr-closed-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: closedIds.length === 1 ? 'Closed a merged PR tab' : `Closed ${closedIds.length} merged PR tabs`,
    message:
      closedIds.length === 1
        ? `${first.repo} #${first.number} — undo from the PR review page for 7 days.`
        : `Starting with ${first.repo} #${first.number}. Undo from the PR review page for 7 days.`,
    buttons: [{ title: 'Undo' }, { title: 'Dismiss' }],
    requireInteraction: false,
  });
}

function notifyResolved(resolved) {
  const first = resolved[0];
  const verb = first.state === 'merged' ? 'merged' : 'closed';
  chrome.notifications.create('corral-pr-resolved', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: resolved.length === 1 ? `A PR was ${verb}` : `${resolved.length} PRs are done`,
    message:
      resolved.length === 1
        ? `${first.repo} #${first.number} was ${verb}. Its tab is safe to close.`
        : `Starting with ${first.repo} #${first.number}. Their tabs are safe to close.`,
    buttons: [{ title: 'Review PR tabs' }, { title: 'Dismiss' }],
    requireInteraction: false,
  });
}

async function reopenPrTabs(keys) {
  const undo = await getPrUndo();
  const wanted = keys?.length ? new Set(keys) : null;
  const remaining = [];

  for (const entry of undo) {
    if (wanted && !wanted.has(entry.key)) {
      remaining.push(entry);
      continue;
    }
    try {
      await chrome.tabs.create({ url: entry.url, windowId: entry.windowId, active: false });
    } catch {
      await chrome.tabs.create({ url: entry.url, active: false });
    }
  }

  await chrome.storage.local.set({ [PR_UNDO_KEY]: remaining });
  await regroupAllWindows();
}

/* ---------------- stale tab detection ---------------- */

async function findStaleTabs() {
  const settings = await getSettings();
  const activity = await getActivity();
  const tabs = await chrome.tabs.query({});
  const cutoff = Date.now() - settings.staleHours * 3600 * 1000;

  const stale = [];
  for (const tab of tabs) {
    if (tab.pinned || tab.active || tab.audible) continue;
    const record = activity[tab.id];
    const ts = record?.ts;
    if (ts === undefined || ts > cutoff) continue;
    stale.push({
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || record.title || tab.url,
      url: tab.url || record.url,
      favIconUrl: tab.favIconUrl || '',
      lastActive: ts,
      discarded: tab.discarded,
    });
  }
  stale.sort((a, b) => a.lastActive - b.lastActive);
  return { stale, settings };
}

// Badge priority: PRs waiting on your review (orange) beat finished PR tabs
// (green), which beat stale tabs (amber). Most actionable signal wins.
async function updateBadge(staleCount, resolvedPrCount = 0, awaitingReview = 0) {
  if (awaitingReview > 0) {
    await chrome.action.setBadgeText({ text: String(awaitingReview) });
    await chrome.action.setBadgeBackgroundColor({ color: '#bc4c00' });
    return;
  }
  if (resolvedPrCount > 0) {
    await chrome.action.setBadgeText({ text: String(resolvedPrCount) });
    await chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' });
    return;
  }
  await chrome.action.setBadgeText({ text: staleCount > 0 ? String(staleCount) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
}

async function countResolvedPrTabs() {
  if (!(await getToken())) return 0;
  const prTabs = await findPrTabs();
  return prTabs.filter((tab) => tab.state === 'merged' || tab.state === 'closed').length;
}

async function countAwaitingReview() {
  if (!(await getToken())) return 0;
  const prTabs = await findPrTabs();
  return prTabs.filter((tab) => tab.awaitingViewer && tab.state !== 'merged' && tab.state !== 'closed').length;
}

async function scanStale() {
  const { stale, settings } = await findStaleTabs();
  await updateBadge(stale.length, await countResolvedPrTabs(), await countAwaitingReview());
  if (!settings.staleEnabled || stale.length < settings.staleMinCount) return;

  const { [LAST_NOTIFY_KEY]: lastNotifyAt } = await chrome.storage.local.get(LAST_NOTIFY_KEY);
  const quietUntil = (lastNotifyAt || 0) + settings.notifyIntervalMinutes * 60 * 1000;
  if (Date.now() < quietUntil) return;

  await chrome.storage.local.set({ [LAST_NOTIFY_KEY]: Date.now() });
  chrome.notifications.create('tab-tidy-stale', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${stale.length} tabs are collecting dust`,
    message: `Untouched for over ${settings.staleHours}h. Open Corral to review and close the ones you don't need.`,
    buttons: [{ title: 'Review tabs' }, { title: 'Dismiss' }],
    requireInteraction: false,
  });
}

function openReview(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`review.html${hash}`) });
}

/* ---------------- events ---------------- */

async function installAlarms() {
  await chrome.alarms.create(STALE_ALARM, { periodInMinutes: 15, delayInMinutes: 1 });
  // 5 minutes is the floor Chrome enforces for extension alarms.
  if (await getToken()) await chrome.alarms.create(PR_ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.sync.set(await getSettings());
  await seedActivity();
  await installAlarms();
  await regroupAllWindows();
  await scanStale();
  await queuePrSync();
});

chrome.runtime.onStartup.addListener(async () => {
  await seedActivity();
  await installAlarms();
  await regroupAllWindows();
  await scanStale();
  await queuePrSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STALE_ALARM) scanStale().catch((error) => console.error('Corral scan failed', error));
  if (alarm.name === PR_ALARM) queuePrSync().catch((error) => console.error('Corral PR sync failed', error));
  if (alarm.name === DEVICE_ALARM) advanceDeviceFlow().catch(() => {});
});

// Device flow polling has to survive the service worker being torn down between
// polls, so it runs on an alarm rather than a setInterval in the popup.
async function advanceDeviceFlow() {
  const device = await getPendingDeviceFlow();
  if (!device) {
    await chrome.alarms.clear(DEVICE_ALARM);
    return;
  }
  const result = await pollDeviceFlow();
  if (result.status === 'pending') return;

  await chrome.alarms.clear(DEVICE_ALARM);
  if (result.status === 'connected') {
    await installAlarms();
    await queuePrSync();
    await regroupAllWindows();
    chrome.notifications.create('corral-github-connected', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'GitHub connected',
      message: `Signed in as ${result.login}. Corral will keep your PR tabs in one group.`,
    });
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  touchTab(tab.id).catch(() => {});
  scheduleRegroup(tab.windowId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    touchTab(tabId).catch(() => {});
    scheduleRegroup(tab.windowId);
    // A tab that just became a PR needs its state fetched before the group
    // badge or review page can say anything useful about it.
    if (prRefForUrl(changeInfo.url)) queueStatusSync().catch(() => {});
  } else if (changeInfo.title) {
    touchTab(tabId).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  touchTab(tabId).catch(() => {});
  updateBadgeFromScan();
});

chrome.tabs.onRemoved.addListener(async (tabId, { windowId, isWindowClosing }) => {
  const activity = await getActivity();
  if (activity[tabId]) {
    delete activity[tabId];
    await chrome.storage.local.set({ [ACTIVITY_KEY]: activity });
  }
  if (!isWindowClosing) scheduleRegroup(windowId);
});

chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => scheduleRegroup(newWindowId));
chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => scheduleRegroup(oldWindowId));

chrome.tabGroups.onRemoved.addListener(async (group) => {
  const managed = await getManaged();
  if (managed[group.id] !== undefined) {
    delete managed[group.id];
    await setManaged(managed);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await touchTab(tab.id);
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  chrome.notifications.clear(notificationId);
  if (notificationId === 'tab-tidy-stale') {
    if (buttonIndex === 0) openReview();
  } else if (notificationId === 'corral-pr-resolved') {
    if (buttonIndex === 0) openReview('#prs');
  } else if (notificationId.startsWith('corral-pr-closed-')) {
    if (buttonIndex === 0) reopenPrTabs().catch(() => {});
  } else if (notificationId === 'corral-review-requested') {
    if (buttonIndex === 0) openReview('#prs');
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);
  if (notificationId === 'tab-tidy-stale') openReview();
  else if (
    notificationId === 'corral-pr-resolved' ||
    notificationId === 'corral-review-requested' ||
    notificationId.startsWith('corral-pr-closed-')
  ) {
    openReview('#prs');
  }
});

async function updateBadgeFromScan() {
  const { stale } = await findStaleTabs();
  await updateBadge(stale.length, await countResolvedPrTabs(), await countAwaitingReview());
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'getState': {
        const { stale, settings } = await findStaleTabs();
        const token = await getToken();
        if (token) return { stale, settings, github: { connected: true, login: token.login } };
        // Hand back any in-flight device flow so a reopened popup can resume it
        // instead of showing Connect again.
        const pendingDevice = await getPendingDeviceFlow();
        return { stale, settings, github: { connected: false, pendingDevice } };
      }
      case 'saveSettings': {
        await chrome.storage.sync.set(message.settings);
        await regroupAllWindows();
        await updateBadgeFromScan();
        return { ok: true };
      }
      case 'getPrState': {
        const token = await getToken();
        if (!token) return { connected: false, prTabs: [], undo: [], openPrs: [] };
        const [prTabs, undo, error, settings] = await Promise.all([
          findPrTabs(),
          getPrUndo(),
          getPrError(),
          getSettings(),
        ]);
        return { connected: true, login: token.login, prTabs, undo, error, settings };
      }
      case 'getOpenPrs': {
        const token = await getToken();
        if (!token) return { connected: false, prs: [] };
        try {
          const prs = await fetchMyOpenPrs(token.accessToken);
          const openTabs = await findPrTabs();
          const openKeys = new Set(openTabs.map((tab) => tab.key));
          return { connected: true, prs: prs.map((pr) => ({ ...pr, hasTab: openKeys.has(pr.key) })) };
        } catch (error) {
          if (error instanceof AuthError) {
            await clearToken();
            return { connected: false, prs: [], error: 'auth' };
          }
          return { connected: true, prs: [], error: String(error.message || error) };
        }
      }
      case 'syncPrs':
        return queuePrSync();
      case 'openPrTabs': {
        for (const url of message.urls) {
          try {
            await chrome.tabs.create({ url, active: false });
          } catch {}
        }
        await queueStatusSync();
        await regroupAllWindows();
        return { ok: true };
      }
      case 'undoPrClose': {
        await reopenPrTabs(message.keys);
        await updateBadgeFromScan();
        return { ok: true };
      }
      case 'dismissPrUndo': {
        await chrome.storage.local.set({ [PR_UNDO_KEY]: [] });
        return { ok: true };
      }
      case 'connectGithub': {
        // The GitHub hosts are optional_host_permissions, so ask at the moment
        // the user opts in rather than up-front at install.
        const granted = await chrome.permissions.request({ origins: GITHUB_ORIGINS });
        if (!granted) return { error: 'Permission to reach github.com was declined.' };
        try {
          const device = await startDeviceFlow();
          await chrome.alarms.create(DEVICE_ALARM, { periodInMinutes: Math.max(0.5, device.interval / 60) });
          return { ok: true, device };
        } catch (error) {
          return { error: String(error.message || error) };
        }
      }
      case 'pollGithub': {
        const device = await getPendingDeviceFlow();
        if (!device) {
          const token = await getToken();
          return token ? { status: 'connected', login: token.login } : { status: 'expired' };
        }
        const result = await pollDeviceFlow();
        if (result.status === 'connected') {
          await chrome.alarms.clear(DEVICE_ALARM);
          await installAlarms();
          await queuePrSync();
          await regroupAllWindows();
        }
        return result;
      }
      case 'cancelGithubConnect': {
        await chrome.alarms.clear(DEVICE_ALARM);
        await chrome.storage.local.remove('githubDevice');
        return { ok: true };
      }
      case 'disconnectGithub': {
        await clearToken();
        await chrome.alarms.clear(PR_ALARM);
        await chrome.alarms.clear(DEVICE_ALARM);
        await chrome.storage.local.remove([PR_STATES_KEY, PR_UNDO_KEY, PR_ERROR_KEY, SEEN_REVIEWS_KEY]);
        await regroupAllWindows();
        await updateBadgeFromScan();
        return { ok: true };
      }
      case 'regroupNow': {
        await regroupAllWindows();
        return { ok: true };
      }
      case 'ungroupAll': {
        const managed = await getManaged();
        for (const groupIdStr of Object.keys(managed)) {
          try {
            const tabs = await chrome.tabs.query({ groupId: Number(groupIdStr) });
            if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id));
          } catch {}
        }
        await setManaged({});
        return { ok: true };
      }
      case 'closeTabs': {
        // Capture URLs first so the review page can offer an undo.
        const closed = [];
        for (const tabId of message.tabIds) {
          try {
            const tab = await chrome.tabs.get(tabId);
            closed.push({ url: tab.url, windowId: tab.windowId, index: tab.index });
          } catch {}
        }
        await chrome.tabs.remove(message.tabIds);
        await updateBadgeFromScan();
        return { ok: true, closed };
      }
      case 'reopenTabs': {
        for (const entry of message.tabs) {
          try {
            await chrome.tabs.create({ url: entry.url, windowId: entry.windowId, active: false });
          } catch {
            await chrome.tabs.create({ url: entry.url, active: false });
          }
        }
        await updateBadgeFromScan();
        return { ok: true };
      }
      case 'discardTabs': {
        for (const tabId of message.tabIds) {
          try {
            await chrome.tabs.discard(tabId);
          } catch {}
        }
        return { ok: true };
      }
      case 'focusTab': {
        const tab = await chrome.tabs.get(message.tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(message.tabId, { active: true });
        return { ok: true };
      }
      default:
        return { error: 'unknown message' };
    }
  })().then(sendResponse, (error) => sendResponse({ error: String(error) }));
  return true;
});

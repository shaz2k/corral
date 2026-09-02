// GitHub OAuth device flow + pull request lookups.
//
// SETUP: register an OAuth App at https://github.com/settings/applications/new,
// tick "Enable Device Flow", and paste its client ID below. Device flow uses no
// client secret, so this value is safe to ship — it is public by design.
export const CLIENT_ID = 'Ov23liS3qDh8FkVn5bXS';

// Classic OAuth scopes are all device flow supports (no fine-grained tokens).
// `repo` is the narrowest scope that can still read pull requests in the private
// repos most people actually work in; `public_repo` alone would silently miss them.
const SCOPE = 'repo';

export const GITHUB_ORIGINS = ['https://api.github.com/*', 'https://github.com/*'];

const TOKEN_KEY = 'githubToken';
const DEVICE_KEY = 'githubDevice';

export class AuthError extends Error {}
export class RateLimitError extends Error {
  constructor(resetAt) {
    super('GitHub rate limit reached');
    this.resetAt = resetAt;
  }
}

/* ---------------- token storage ---------------- */

// storage.local, never storage.sync — a sync'd token would be replicated to
// every machine on the Google account, including ones the user never authorised.
export async function getToken() {
  const { [TOKEN_KEY]: token } = await chrome.storage.local.get(TOKEN_KEY);
  return token || null;
}

async function setToken(token) {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearToken() {
  await chrome.storage.local.remove([TOKEN_KEY, DEVICE_KEY]);
}

/* ---------------- device flow ---------------- */

async function postForm(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 400) throw new Error(`GitHub returned ${res.status}`);
  return res.json();
}

export async function startDeviceFlow() {
  if (!CLIENT_ID) throw new Error('No GitHub client ID is configured in github.js');
  const data = await postForm('https://github.com/login/device/code', {
    client_id: CLIENT_ID,
    scope: SCOPE,
  });
  if (data.error) throw new Error(data.error_description || data.error);

  const device = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: Math.max(5, data.interval || 5),
    expiresAt: Date.now() + (data.expires_in || 900) * 1000,
  };
  await chrome.storage.local.set({ [DEVICE_KEY]: device });
  return device;
}

export async function getPendingDeviceFlow() {
  const { [DEVICE_KEY]: device } = await chrome.storage.local.get(DEVICE_KEY);
  if (!device) return null;
  if (device.expiresAt <= Date.now()) {
    await chrome.storage.local.remove(DEVICE_KEY);
    return null;
  }
  return device;
}

// One poll attempt. GitHub expects the client to keep asking until the user
// finishes at verification_uri, so `pending` is the normal case, not an error.
export async function pollDeviceFlow() {
  const device = await getPendingDeviceFlow();
  if (!device) return { status: 'expired' };

  const data = await postForm('https://github.com/login/oauth/access_token', {
    client_id: CLIENT_ID,
    device_code: device.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  if (data.access_token) {
    const user = await fetchViewer(data.access_token);
    await setToken({
      accessToken: data.access_token,
      scope: data.scope || SCOPE,
      login: user.login,
      connectedAt: Date.now(),
    });
    await chrome.storage.local.remove(DEVICE_KEY);
    return { status: 'connected', login: user.login };
  }

  switch (data.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      // GitHub asks us to back off; it supplies the new floor.
      device.interval = Math.max(device.interval + 5, data.interval || 0);
      await chrome.storage.local.set({ [DEVICE_KEY]: device });
      return { status: 'pending', interval: device.interval };
    case 'expired_token':
    case 'access_denied':
      await chrome.storage.local.remove(DEVICE_KEY);
      return { status: data.error === 'access_denied' ? 'denied' : 'expired' };
    default:
      await chrome.storage.local.remove(DEVICE_KEY);
      return { status: 'error', message: data.error_description || data.error || 'Unknown error' };
  }
}

/* ---------------- API ---------------- */

async function api(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (res.status === 401) throw new AuthError('GitHub rejected the stored token');
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      throw new RateLimitError(Number(res.headers.get('x-ratelimit-reset') || 0) * 1000);
    }
    throw new Error(`GitHub returned ${res.status}`);
  }
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  return res.json();
}

async function fetchViewer(token) {
  return api('/user', token);
}

/* ---------------- PR URL parsing ---------------- */

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/;

// A github.com pull request URL -> {owner, repo, number, key}, else null.
// Deliberately github.com only: the REST calls go to api.github.com, so an
// Enterprise host would parse fine here and then fail every lookup.
export function prRefForUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname.replace(/^www\./, '').toLowerCase() !== 'github.com') return null;

  const match = PR_PATH.exec(parsed.pathname);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return { owner, repo, number: Number(number), key: `${owner}/${repo}#${number}` };
}

export function prUrlForKey(key) {
  const match = /^(.+)\/(.+)#(\d+)$/.exec(key);
  return match ? `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` : null;
}

/* ---------------- PR state ---------------- */

function normaliseState(pr) {
  if (pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  return pr.draft ? 'draft' : 'open';
}

export async function fetchPrState(ref, token, viewerLogin) {
  const pr = await api(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token);
  const author = pr.user?.login || '';
  // requested_reviewers empties out the moment you submit a review, so it can
  // only ever mean "still waiting on you" — never "was assigned to you".
  const awaitingViewer = viewerLogin
    ? (pr.requested_reviewers || []).some((r) => r.login === viewerLogin)
    : false;
  return {
    state: normaliseState(pr),
    title: pr.title || '',
    repo: `${ref.owner}/${ref.repo}`,
    number: ref.number,
    url: pr.html_url || prUrlForKey(ref.key),
    updatedAt: Date.parse(pr.updated_at || '') || 0,
    author,
    isMine: Boolean(viewerLogin) && author === viewerLogin,
    awaitingViewer,
  };
}

// Open PRs the user cares about: theirs, plus ones waiting on their review.
export async function fetchMyOpenPrs(token) {
  const queries = [
    { relation: 'author', q: 'is:open is:pr archived:false author:@me' },
    { relation: 'review', q: 'is:open is:pr archived:false review-requested:@me' },
  ];

  const byKey = new Map();
  for (const { relation, q } of queries) {
    const data = await api(`/search/issues?per_page=50&q=${encodeURIComponent(q)}`, token);
    for (const item of data.items || []) {
      const ref = prRefForUrl(item.html_url);
      if (!ref || byKey.has(ref.key)) continue;
      byKey.set(ref.key, {
        key: ref.key,
        repo: `${ref.owner}/${ref.repo}`,
        number: ref.number,
        title: item.title || '',
        url: item.html_url,
        relation,
        draft: Boolean(item.draft),
        updatedAt: Date.parse(item.updated_at || '') || 0,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Just the PRs waiting on your review, for the background discovery poll.
export async function fetchReviewRequests(token) {
  const q = 'is:open is:pr archived:false review-requested:@me';
  const data = await api(`/search/issues?per_page=50&q=${encodeURIComponent(q)}`, token);
  const out = [];
  for (const item of data.items || []) {
    const ref = prRefForUrl(item.html_url);
    if (!ref) continue;
    out.push({
      key: ref.key,
      repo: `${ref.owner}/${ref.repo}`,
      number: ref.number,
      title: item.title || '',
      url: item.html_url,
      draft: Boolean(item.draft),
      updatedAt: Date.parse(item.updated_at || '') || 0,
    });
  }
  return out;
}

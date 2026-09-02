// Second-level suffixes where the registrable domain needs three labels
// (e.g. bbc.co.uk). Not a full Public Suffix List — covers the common cases
// without shipping a 200KB table.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'lg.jp',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'firm.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec',
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
  'com.sg', 'com.hk', 'com.tw', 'com.tr', 'com.my', 'com.ph', 'com.vn',
  'com.sa', 'com.eg', 'com.ng', 'com.pk', 'com.bd', 'com.kw', 'com.qa',
  'co.il', 'org.il', 'ac.il', 'gov.il',
  'co.th', 'or.th', 'ac.th', 'go.th',
  'co.id', 'or.id', 'ac.id', 'go.id',
  'com.pl', 'com.ua', 'com.ru', 'com.es', 'com.pt', 'com.gr', 'com.cy',
  'co.ke', 'co.tz', 'co.ug', 'com.gh',
  'gov.us', 'k12.us',
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'herokuapp.com',
  'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com',
]);

const IP_LIKE = /^\d{1,3}(\.\d{1,3}){3}$/;

// Returns a stable grouping key for a URL, or null if the tab shouldn't be grouped.
export function groupKeyForUrl(url) {
  if (!url) return null;
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!host) return null;
  if (IP_LIKE.test(host) || host.startsWith('[') || !host.includes('.')) return host;

  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const take = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

// Pull requests get their own group rather than joining the generic github.com
// one. Not a hostname, so it can never collide with a real grouping key.
export const PR_KEY = '__pull_requests__';

// "github.com" -> "Github", "localhost" -> "Localhost", "10.0.0.5" -> "10.0.0.5"
export function labelForKey(key) {
  if (key === PR_KEY) return 'Pull requests';
  if (IP_LIKE.test(key)) return key;
  const first = key.split('.')[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const COLORS = ['blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'grey'];

export function colorForKey(key) {
  if (key === PR_KEY) return 'purple';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 100000;
  return COLORS[hash % COLORS.length];
}

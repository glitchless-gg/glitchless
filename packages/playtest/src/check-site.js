// Where a game check finds the game behind the address someone posted, and whether the site lets a bot play it.
// An itch.io page plays its HTML5 game in a frame on html-classic.itch.zone (an address that changes with every
// upload), so the check reads the page for that frame and plays it at the page's own size. Any other address is
// played as it is. Before playing, the check reads the site's robots.txt and stops where it asks bots to stay out;
// while loading, it stops on a refusal (401, 403, 429) or a page that checks for a human (a challenge or CAPTCHA),
// which it never tries to get past.

// How the check names itself to sites: in the User-Agent after the browser's own, and as the robots.txt agent.
export const CHECK_AGENT = 'GlitchlessCheck';
export const CHECK_UA_SUFFIX = `${CHECK_AGENT}/1.0 (+https://www.glitchless.gg)`;

const decode = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\\\//g, '/');

// An itch.io game page's address: https://<maker>.itch.io/<game> (a draft's ?secret= kept). → URL or null.
export function itchPage(url) {
  try {
    const u = new URL(url);
    return /^[a-z0-9-]+\.itch\.io$/i.test(u.hostname) && /^\/[^/]+\/?$/.test(u.pathname) ? u : null;
  } catch {
    return null;
  }
}

// The game in an itch.io page's HTML → { frame_url, width, height, title } or { error } in words for a person.
// The frame is an <iframe> in the page, or for a game behind a "Run game" button, the one in its data-iframe, or for
// one that opens in its own window, the address in the page's script.
export function itchFrame(html, pageUrl) {
  const title = decode(html.match(/<h1[^>]*class="[^"]*game_title[^"]*"[^>]*>([^<]+)</)?.[1] || html.match(/<title>([^<]+?)(?: by [^<]+)?<\/title>/)?.[1] || '').trim() || null;
  if (/class="[^"]*password_form|This page is password protected/i.test(html)) return { error: `the itch.io page ${pageUrl} is password-protected, so a bot can't open it`, title };
  const frameRe = /(?:https?:)?\/\/html(?:-classic)?\.itch\.zone\/html\/\d+\/[^"'\s<>\\]+/;
  const iframe = html.match(/<iframe[^>]+src="((?:https?:)?\/\/html(?:-classic)?\.itch\.zone\/[^"]+)"/)?.[1];
  const placeholder = html.match(/data-iframe="([^"]+)"/)?.[1];
  const inScript = decode(html).match(frameRe)?.[0];
  let src = iframe || (placeholder && decode(placeholder).match(frameRe)?.[0]) || inScript;
  if (!src) return { error: `the itch.io page ${pageUrl} has nothing that plays in a browser (its game is a download)`, title };
  src = decode(src);
  if (src.startsWith('//')) src = `https:${src}`;
  const frame = html.match(/<div[^>]*class="[^"]*game_frame[^"]*"[^>]*>/)?.[0] || '';
  const num = (k) => Number(frame.match(new RegExp(`data-${k}="(\\d+)"`))?.[1] || html.match(new RegExp(`"${k}":\\s*(\\d+)`))?.[1]) || null;
  return { frame_url: src, width: num('width'), height: num('height'), title };
}

// robots.txt → whether `agent` may fetch `path`: the group for the agent by name, else `*`; the longest matching
// rule wins, and Allow wins a tie (RFC 9309). `*` and a final `$` work as they do for search engines.
export function robotsAllow(text, agent, path) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [key, value] = [m[1].toLowerCase(), m[2].trim()];
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === 'allow', path: value });
    } else lastWasAgent = false;
  }
  const name = agent.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && name.includes(a)));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let best = null;
  for (const r of rules) {
    const anchored = r.path.endsWith('$');
    const re = new RegExp(`^${(anchored ? r.path.slice(0, -1) : r.path).split('*').map(esc).join('.*')}${anchored ? '$' : ''}`);
    if (!re.test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// A response that says the site doesn't want bots: → the reason in words, or null.
export function refusal({ status, headers = {}, title = '', body = '' }) {
  const h = (k) => headers[k] ?? headers[k.toLowerCase()];
  if (status === 401 || status === 403) return `the site answered ${status} (it refuses this visit)`;
  if (status === 429) return 'the site answered 429 (too many requests): it is limiting bots';
  if (h('cf-mitigated') === 'challenge') return 'the site checks for a human first (a Cloudflare challenge)';
  const words = `${title} ${String(body).slice(0, 4000)}`;
  if (/just a moment\.\.\.|attention required|verify you are (a )?human|are you a robot|captcha|checking your browser/i.test(words)) return 'the site checks for a human first (a challenge or CAPTCHA)';
  return null;
}

// robots.txt of a page's site, asked once per host: → { allowed, rules_url }. A site without one (404) allows.
export async function robotsCheck(url, { fetch = globalThis.fetch, ua, cache = new Map() } = {}) {
  const u = new URL(url);
  const at = `${u.origin}/robots.txt`;
  if (!cache.has(at)) {
    const text = await fetch(at, { headers: { 'user-agent': ua }, redirect: 'follow', signal: AbortSignal.timeout(10_000) })
      .then(async (r) => (r.ok && /text\/plain/.test(r.headers.get('content-type') || 'text/plain') ? r.text() : ''))
      .catch(() => '');
    cache.set(at, text);
  }
  return { allowed: robotsAllow(cache.get(at), CHECK_AGENT, `${u.pathname}${u.search}`), rules_url: at };
}

// The address someone posted → what the check plays: { page_url, play_url, title, size: {width, height} | null,
// site, referer }. An itch.io page is fetched once for its frame; anything else is played as it is.
export async function resolveGame(url, { fetch = globalThis.fetch, ua, log = () => {}, robots = new Map() } = {}) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    throw new Error(`"${url}" is not a web address: give the game's page, such as https://someone.itch.io/their-game`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`only http and https addresses can be checked, not ${u.protocol}`);
  const page = u.toString();
  const robotsPage = await robotsCheck(page, { fetch, ua, cache: robots });
  if (!robotsPage.allowed) throw new Error(`${robotsPage.rules_url} asks bots not to visit ${u.pathname}, so the check stops here`);
  const itch = itchPage(page);
  if (!itch) return { page_url: page, play_url: page, title: null, size: null, site: siteOf(u.hostname), referer: null };

  log(`reading the itch.io page ${page}`);
  const res = await fetch(page, { headers: { 'user-agent': ua }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  const html = await res.text();
  const refused = refusal({ status: res.status, headers: Object.fromEntries(res.headers), body: html, title: html.match(/<title>([^<]*)/)?.[1] });
  if (refused) throw new Error(`${page}: ${refused}, so the check stops here`);
  if (res.status === 404) throw new Error(`there is no itch.io page at ${page} (404): is it public, or a draft that needs its secret link?`);
  if (!res.ok) throw new Error(`${page} answered HTTP ${res.status}`);
  const found = itchFrame(html, page);
  if (found.error) throw new Error(found.error);
  const robotsFrame = await robotsCheck(found.frame_url, { fetch, ua, cache: robots });
  if (!robotsFrame.allowed) throw new Error(`${robotsFrame.rules_url} asks bots not to load the game's frame, so the check stops here`);
  return { page_url: page, play_url: found.frame_url, title: found.title, size: found.width && found.height ? { width: found.width, height: found.height } : null, site: 'itch.io', referer: page };
}

// The kind of place a game was posted, in the words a report uses.
export function siteOf(host) {
  const h = String(host).toLowerCase();
  const sites = [
    ['itch.zone', 'itch.io'],
    ['itch.io', 'itch.io'],
    ['github.io', 'GitHub Pages'],
    ['vercel.app', 'Vercel'],
    ['netlify.app', 'Netlify'],
    ['pages.dev', 'Cloudflare Pages'],
    ['web.app', 'Firebase Hosting'],
    ['firebaseapp.com', 'Firebase Hosting'],
    ['glitch.me', 'Glitch'],
    ['replit.app', 'Replit'],
    ['surge.sh', 'Surge'],
    ['newgrounds.com', 'Newgrounds'],
    ['crazygames.com', 'CrazyGames'],
  ];
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost')) return 'this computer';
  return sites.find(([suffix]) => h === suffix || h.endsWith(`.${suffix}`))?.[1] ?? h.replace(/^www\./, '');
}

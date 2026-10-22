import { useEffect, useMemo, useState } from 'react';
import { Icon } from './components.jsx';
import { useQuery, onMeta } from './api.js';
import { Filters } from './filters.js';
import { Performance } from './pages/Performance.jsx';
import { Errors } from './pages/Errors.jsx';
import { Players } from './pages/Players.jsx';
import { Board } from './pages/Board.jsx';
import { Events } from './pages/Events.jsx';
import { Heatmaps } from './pages/Heatmaps.jsx';
import { Sessions, SessionDetail } from './pages/Sessions.jsx';
import { Versions } from './pages/Versions.jsx';
import { LiveTail } from './pages/Live.jsx';
import { Agents } from './pages/Agents.jsx';
import { Setup } from './pages/Setup.jsx';
import { Pages } from './pages/Pages.jsx';
import { VIEWS, EMPTY_PAGES } from './dashboard.js';
import { Shell, DEFAULT_SHELL } from './shell.js';

const RANGES = [
  { key: '15m', label: 'Past 15 Minutes', ms: 15 * 60e3 },
  { key: '1h', label: 'Past 1 Hour', ms: 3600e3 },
  { key: '4h', label: 'Past 4 Hours', ms: 4 * 3600e3 },
  { key: '1d', label: 'Past 1 Day', ms: 86400e3 },
  { key: '2d', label: 'Past 2 Days', ms: 2 * 86400e3 },
  { key: '7d', label: 'Past 7 Days', ms: 7 * 86400e3 },
  { key: '14d', label: 'Past 14 Days', ms: 14 * 86400e3 },
  { key: '30d', label: 'Past 30 Days', ms: 30 * 86400e3 },
  // Past 31 days the server answers by day; it says how far back a reader can go (max_range_days).
  { key: '90d', label: 'Past 90 Days', ms: 90 * 86400e3 },
  { key: '1y', label: 'Past 1 Year', ms: 365 * 86400e3 },
];
const DAILY_AFTER = 31 * 86400e3;

// The game's own pages come first (its dashboard, server/src/board.js); these follow them.
export const NAV = [
  { section: 'AI' },
  { path: 'agents', label: 'Agents & MCP', icon: 'agents', title: 'Agents & MCP' },
  { path: 'setup', label: 'Install SDK', icon: 'setup', title: 'Install Glitchless' },
];

// The page component of each built-in view.
const VIEW_PAGES = { events: Events, performance: Performance, errors: Errors, players: Players, heatmaps: Heatmaps, sessions: Sessions, versions: Versions, live: LiveTail };
const DAY = 86400e3;

export function useHashRoute() {
  const parse = () => {
    const h = window.location.hash.replace(/^#\/?/, '');
    const [path, query] = h.split('?');
    const [page, ...rest] = path.split('/');
    return { page, arg: rest.join('/') || null, query: new URLSearchParams(query || '') };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function load(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

// `shell` (optional) is how a host wraps the dashboard; see shell.js. Beyond the context values it takes:
//   nav(items) → items   change the navigation (each item may carry its own `page` component)
//   sidebarTop, footer   elements for the top and the bottom of the side navigation
export function App({ shell: custom = {} }) {
  const shell = { ...DEFAULT_SHELL, ...custom, brand: { ...DEFAULT_SHELL.brand, ...custom.brand } };
  const route = useHashRoute();
  const [rangeKey, setRangeKey] = useState(() => load('glitchless.range', '1d'));
  const [service, setService] = useState(() => load('glitchless.service', ''));
  const [env, setEnv] = useState('');
  const [version, setVersion] = useState('');
  const [type, setType] = useState('all');
  const [live, setLive] = useState(() => load('glitchless.live', '1') === '1');
  const [tick, setTick] = useState(0);
  const services = useQuery('services', {}, { refreshMs: 15000 });
  const list = services.data?.services || [];
  // Ranges up to what the server keeps for this reader (the plan's retention on Glitchless Cloud).
  const maxDays = services.data?.max_range_days ?? null;
  const ranges = RANGES.filter((r) => maxDays == null || r.ms <= maxDays * DAY);
  // What the answers said about the picked range: estimated parts and notes, per query.
  const [answered, setAnswered] = useState({});
  useEffect(
    () =>
      onMeta((name, meta) =>
        setAnswered((a) => {
          const v = JSON.stringify([meta.approximate || [], meta.note || null]);
          return a[name] === v ? a : { ...a, [name]: v };
        }),
      ),
    [],
  );

  useEffect(() => {
    // A game with no data yet has no services: forget one remembered from another game.
    if (!list.length) {
      if (services.data && service) setService('');
      return;
    }
    if (!service || !list.find((s) => s.service === service)) setService([...list].sort((a, b) => b.last_seen - a.last_seen)[0].service);
  }, [list, service]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      localStorage.setItem('glitchless.range', rangeKey);
      localStorage.setItem('glitchless.live', live ? '1' : '0');
      if (service) localStorage.setItem('glitchless.service', service);
    } catch {}
  }, [rangeKey, live, service]);
  // Relative time ranges slide forward while Live is on.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((x) => x + 1), 10000);
    return () => clearInterval(t);
  }, [live]);

  // A range past the server's limit (a plan that keeps less) falls back to the longest one it has.
  const range = ranges.find((r) => r.key === rangeKey) || (RANGES.some((r) => r.key === rangeKey) ? ranges.at(-1) : RANGES[3]);
  useEffect(() => setAnswered({}), [range.key, service, env, version, type]);
  const estimated = [...new Set(Object.values(answered).flatMap((v) => JSON.parse(v)[0]))];
  const notes = [...new Set(Object.values(answered).map((v) => JSON.parse(v)[1]).filter(Boolean))];
  const now = useMemo(() => Math.floor(Date.now() / 5000) * 5000, [tick, rangeKey, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = list.find((s) => s.service === service);
  // The game's pages. An automatic dashboard depends on what the game sent, so it is read over a week (moving
  // every 5 minutes), not the picked range: pages don't come and go with the time picker.
  const week = Math.floor(now / 300e3) * 300e3;
  const dash = useQuery('dashboard', { service, from: week - 7 * DAY, to: week }, { enabled: !!service, refreshMs: 60000 });
  const dashboard = dash.data?.dashboard;
  const pages = dashboard?.pages || (service ? [] : EMPTY_PAGES);
  const filters = {
    service,
    env,
    version,
    from: now - range.ms,
    to: now,
    rangeKey,
    live,
    params: { service, env, version, type, from: now - range.ms, to: now },
    go: (path) => (window.location.hash = `#/${path}`),
    versions: current?.versions || [],
    dashboard: { spec: dashboard?.spec ?? null, source: dashboard?.source, updated_at: dashboard?.updated_at, updated_by: dashboard?.updated_by, reload: dash.reload },
  };

  const game = [
    { section: 'Dashboard' },
    ...pages.map((p) => ({ path: p.id, label: p.title, icon: p.icon, title: p.title, dash: p })),
    ...(service ? [{ path: 'pages', label: 'Edit pages', icon: 'edit', title: 'Dashboard pages', page: Pages, quiet: true }] : []),
  ];
  const items = shell.nav ? shell.nav([...game, ...NAV]) : [...game, ...NAV];
  const statics = { agents: Agents, setup: Setup };
  // A page of the game's dashboard; else another item; else a built-in view the dashboard leaves out (links
  // such as #/errors/<issue> or #/sessions/<id> still open it); else the first page.
  const resolve = (id) => {
    const item = items.find((n) => n.path && n.path === id);
    const p = item?.dash;
    if (p) return p.view ? { Page: VIEW_PAGES[p.view], title: p.title, page: p } : { Page: Board, title: p.title, page: p };
    if (item) return { Page: item.page || statics[item.path], title: item.title };
    if (VIEW_PAGES[id]) return { Page: VIEW_PAGES[id], title: VIEWS[id].title, page: { id, view: id } };
    return null;
  };
  const first = items.find((n) => n.path);
  // A link to a page this list doesn't have yet (an agent just added it): read the pages again.
  const unknown = !!route.page && !!dashboard && !resolve(route.page);
  useEffect(() => {
    if (unknown) dash.reload();
  }, [unknown, route.page]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = resolve(route.page) || (first ? resolve(first.path) : null);
  const active = view?.page?.id ?? (items.some((n) => n.path === route.page) ? route.page : first?.path);
  const Page = view?.page?.view === 'sessions' && route.arg ? SessionDetail : view?.Page;
  const loading = (services.loading && !services.data) || (service && !dashboard && dash.loading);

  return (
    <Shell.Provider value={shell}>
      <Filters.Provider value={filters}>
        <div className={`app ${shell.className}`.trim()}>
          <nav className="sidenav">
            <div className="brand">
              <img src={shell.brand.logo} alt={shell.brand.name} />
              <div>
                <div className="name">{shell.brand.name}</div>
                <div className="tagline">{shell.brand.tagline}</div>
              </div>
            </div>
            {shell.sidebarTop}
            {/* Self-hosted, this picks the game. Hosted, a game is picked above and almost always has one service. */}
            {(!shell.sidebarTop || list.length > 1) && (
            <div className="svc-pick">
              {shell.servicesLabel && <div className="svc-label">{shell.servicesLabel}</div>}
              <select value={service} onChange={(e) => setService(e.target.value)} title="Game service">
                {!list.length && <option value="">{shell.servicesEmpty}</option>}
                {list.map((s) => (
                  <option key={s.service} value={s.service}>
                    {s.service}
                  </option>
                ))}
              </select>
            </div>
            )}
            {items.map((n, i) =>
              n.section ? (
                <div key={i} className="navsec">
                  {n.section}
                </div>
              ) : (
                <a key={n.path} className={`navitem ${active === n.path ? 'active' : ''} ${n.quiet ? 'quiet' : ''}`.trim()} href={`#/${n.path}`}>
                  <Icon name={n.icon} />
                  {n.label}
                </a>
              ),
            )}
            {shell.footer ?? null}
          </nav>
          <main>
            <header className="topbar">
              <div className="crumbs">
                <span className="root">{service || shell.brand.name} /</span>
                <h1>{Page === SessionDetail ? 'Session Replay' : view?.title}</h1>
              </div>
              <div className="spacer" />
              <div className="tvars">
                <label className="tvar">
                  <span>$env</span>
                  <select value={env} onChange={(e) => setEnv(e.target.value)}>
                    <option value="">*</option>
                    {(current?.envs || []).map((e) => (
                      <option key={e}>{e}</option>
                    ))}
                  </select>
                </label>
                <label className="tvar">
                  <span>$session_type</span>
                  <select value={type} onChange={(e) => setType(e.target.value)}>
                    <option value="all">*</option>
                    <option value="user">user</option>
                    <option value="synthetic">synthetic (bots)</option>
                    <option value="simulated">simulated</option>
                  </select>
                </label>
                <label className="tvar">
                  <span>$version</span>
                  <select value={version} onChange={(e) => setVersion(e.target.value)}>
                    <option value="">*</option>
                    {(current?.versions || []).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="timepick">
                <Icon name="clock" size={14} />
                <select value={range.key} onChange={(e) => setRangeKey(e.target.value)}>
                  {ranges.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              {range.ms > DAILY_AFTER && (
                <span
                  className="daily-note"
                  title={[
                    'Over 31 days the numbers are daily: a session counts on the day it started.',
                    estimated.length ? `Estimated from sketches or samples: ${estimated.map((x) => x.replace(/_/g, ' ')).join(', ')}.` : '',
                    ...notes,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  By day{estimated.length ? ' · some estimated' : ''}
                </span>
              )}
              <button className={`btn live ${live ? 'on' : ''}`} onClick={() => setLive(!live)} title="Auto-refresh every 10s">
                <span className={`dot ${live ? 'on' : ''}`} /> {live ? 'Live' : 'Paused'}
              </button>
            </header>
            <div className="page">
              {loading || !Page ? <div className="loading-bar" /> : <Page key={view.page?.id || route.page} route={route} page={view.page} />}
            </div>
          </main>
        </div>
      </Filters.Provider>
    </Shell.Provider>
  );
}

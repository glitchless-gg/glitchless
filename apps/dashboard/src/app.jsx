import { useEffect, useMemo, useState } from 'react';
import { Icon } from './components.jsx';
import { useQuery } from './api.js';
import { Filters } from './filters.js';
import { Overview } from './pages/Overview.jsx';
import { Performance } from './pages/Performance.jsx';
import { Errors } from './pages/Errors.jsx';
import { Players } from './pages/Players.jsx';
import { Heatmaps } from './pages/Heatmaps.jsx';
import { Sessions, SessionDetail } from './pages/Sessions.jsx';
import { Versions } from './pages/Versions.jsx';
import { LiveTail } from './pages/Live.jsx';
import { Agents } from './pages/Agents.jsx';
import { Setup } from './pages/Setup.jsx';
import { Shell, DEFAULT_SHELL } from './shell.js';

const RANGES = [
  { key: '15m', label: 'Past 15 Minutes', ms: 15 * 60e3 },
  { key: '1h', label: 'Past 1 Hour', ms: 3600e3 },
  { key: '4h', label: 'Past 4 Hours', ms: 4 * 3600e3 },
  { key: '1d', label: 'Past 1 Day', ms: 86400e3 },
  { key: '2d', label: 'Past 2 Days', ms: 2 * 86400e3 },
  { key: '7d', label: 'Past 7 Days', ms: 7 * 86400e3 },
];

export const NAV = [
  { section: 'Game' },
  { path: 'overview', label: 'Overview', icon: 'overview', title: 'Service Overview' },
  { path: 'performance', label: 'Performance', icon: 'perf', title: 'Frame Performance' },
  { path: 'errors', label: 'Error Tracking', icon: 'errors', title: 'Error Tracking' },
  { section: 'Players' },
  { path: 'players', label: 'Player Analytics', icon: 'players', title: 'Player Analytics' },
  { path: 'heatmaps', label: 'Heatmaps', icon: 'heatmap', title: 'Level Heatmaps' },
  { path: 'sessions', label: 'Sessions & Replay', icon: 'sessions', title: 'Sessions' },
  { section: 'Delivery' },
  { path: 'versions', label: 'Versions', icon: 'versions', title: 'Version Tracking' },
  { path: 'live', label: 'Live Tail', icon: 'live', title: 'Live Tail' },
  { section: 'AI' },
  { path: 'agents', label: 'Agents & MCP', icon: 'agents', title: 'Agents & MCP' },
  { path: 'setup', label: 'Install SDK', icon: 'setup', title: 'Install Glitchless' },
];

export function useHashRoute() {
  const parse = () => {
    const h = window.location.hash.replace(/^#\/?/, '') || 'overview';
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

  useEffect(() => {
    if (!list.length) return;
    if (!service || !list.find((s) => s.service === service)) setService([...list].sort((a, b) => b.last_seen - a.last_seen)[0].service);
  }, [list, service]);
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

  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[3];
  const now = useMemo(() => Math.floor(Date.now() / 5000) * 5000, [tick, rangeKey, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = list.find((s) => s.service === service);
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
  };

  const items = shell.nav ? shell.nav(NAV) : NAV;
  const nav = items.find((n) => n.path === route.page) || items.find((n) => n.path);
  const pages = { overview: Overview, performance: Performance, errors: Errors, players: Players, heatmaps: Heatmaps, sessions: route.arg ? SessionDetail : Sessions, versions: Versions, live: LiveTail, agents: Agents, setup: Setup };
  for (const n of items) if (n.page) pages[n.path] = n.page;
  const Page = (items.some((n) => n.path === route.page) && pages[route.page]) || Overview;

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
            <div className="svc-pick">
              {shell.servicesLabel && <div className="svc-label">{shell.servicesLabel}</div>}
              <select value={service} onChange={(e) => setService(e.target.value)} title="Game service">
                {!list.length && <option value="">{shell.servicesEmpty}</option>}
                {list.map((s) => (
                  <option key={s.service} value={s.service}>
                    🎮 {s.service}
                  </option>
                ))}
              </select>
            </div>
            {items.map((n, i) =>
              n.section ? (
                <div key={i} className="navsec">
                  {n.section}
                </div>
              ) : (
                <a key={n.path} className={`navitem ${route.page === n.path ? 'active' : ''}`} href={`#/${n.path}`}>
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
                <h1>{route.page === 'sessions' && route.arg ? 'Session Replay' : nav.title}</h1>
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
                <select value={rangeKey} onChange={(e) => setRangeKey(e.target.value)}>
                  {RANGES.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className={`btn live ${live ? 'on' : ''}`} onClick={() => setLive(!live)} title="Auto-refresh every 10s">
                <span className={`dot ${live ? 'on' : ''}`} /> {live ? 'Live' : 'Paused'}
              </button>
            </header>
            <div className="page">
              {services.loading && !services.data ? <div className="loading-bar" /> : <Page route={route} />}
            </div>
          </main>
        </div>
      </Filters.Provider>
    </Shell.Provider>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Floating } from './components.jsx';
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
import { Reports } from './pages/Reports.jsx';
import { Agents } from './pages/Agents.jsx';
import { Setup } from './pages/Setup.jsx';
import { Pages } from './pages/Pages.jsx';
import { Servers } from './pages/Servers.jsx';
import { Matches } from './pages/Matches.jsx';
import { VIEWS, EMPTY_PAGES } from './dashboard.js';
import { Shell, DEFAULT_SHELL } from './shell.js';
import { THEMES, applyTheme, useThemePref, useTheme } from './theme.js';
import { useBrand, brandStyle, BrandLogo } from './brand.jsx';

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
const VIEW_PAGES = { events: Events, performance: Performance, errors: Errors, players: Players, heatmaps: Heatmaps, sessions: Sessions, versions: Versions, live: LiveTail, reports: Reports, servers: Servers, matches: Matches };
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

// The property filter (A6): ?prop.rank=diamond,gold before the hash, so it stays as the pages change and a copied
// link keeps it. { rank: ['diamond', 'gold'] }.
function readProps() {
  const out = {};
  for (const [k, v] of new URLSearchParams(window.location.search)) if (k.startsWith('prop.') && v) out[k.slice(5)] = v.split(',').filter(Boolean);
  return out;
}

function writeProps(props) {
  const q = new URLSearchParams([...new URLSearchParams(window.location.search)].filter(([k]) => !k.startsWith('prop.')));
  for (const [k, v] of Object.entries(props)) if (v.length) q.set(`prop.${k}`, v.join(','));
  window.history.replaceState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}${window.location.hash}`);
}

function load(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

// The services picked in this browser, most recent first ([] when there's nothing or it can't be read).
// Whether a media query matches, following it as the window changes.
function useMedia(query) {
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const m = matchMedia(query);
    const change = () => setOn(m.matches);
    change();
    m.addEventListener('change', change);
    return () => m.removeEventListener('change', change);
  }, [query]);
  return on;
}

function loadPicked() {
  try {
    const list = JSON.parse(load('glitchless.services', '[]'));
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
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
  // The services picked in this browser, most recent first: a game opens on the last one picked in it, even after
  // another game in between (a game can have several, such as a site's and its app's).
  const picked = useRef(loadPicked());
  const [env, setEnv] = useState('');
  const [version, setVersion] = useState('');
  const [type, setType] = useState('all');
  const [props, setPropsState] = useState(readProps);
  const setProps = (next) => (writeProps(next), setPropsState(next));
  const [live, setLive] = useState(() => load('glitchless.live', '1') === '1');
  // The side navigation folds to a rail of icons, remembered in this browser. On a phone it's a drawer instead: the
  // menu button at the start of the top bar slides it out over the page, and choosing a page, the backdrop or Escape
  // puts it away. The rail is the desktop's, so a phone's drawer always shows the game picker and the names.
  const [folded, setFolded] = useState(() => load('glitchless.nav', 'open') === 'folded');
  const phone = useMedia('(max-width: 760px)');
  const rail = folded && !phone;
  const [drawer, setDrawer] = useState(false);
  const menuBtn = useRef(null);
  const navRef = useRef(null);
  const [navTip, setNavTip] = useState(null); // a folded rail's name for the icon pointed at or focused
  const navRest = useRef(null);
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
    if (!service || !list.find((s) => s.service === service)) setService(picked.current.find((p) => list.some((s) => s.service === p)) ?? [...list].sort((a, b) => b.last_seen - a.last_seen)[0].service);
  }, [list, service]); // eslint-disable-line react-hooks/exhaustive-deps
  // Another game has other properties: its filter goes when the game changes (not when the remembered one loads).
  const lastService = useRef(service);
  useEffect(() => {
    if (lastService.current && service && lastService.current !== service && Object.keys(props).length) setProps({});
    if (service) lastService.current = service;
  }, [service]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      localStorage.setItem('glitchless.range', rangeKey);
      localStorage.setItem('glitchless.live', live ? '1' : '0');
      localStorage.setItem('glitchless.nav', folded ? 'folded' : 'open');
      if (service) {
        localStorage.setItem('glitchless.service', service);
        picked.current = [service, ...picked.current.filter((p) => p !== service)].slice(0, 20);
        localStorage.setItem('glitchless.services', JSON.stringify(picked.current));
      }
    } catch {}
  }, [rangeKey, live, service, folded]);
  // Relative time ranges slide forward while Live is on.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((x) => x + 1), 10000);
    return () => clearInterval(t);
  }, [live]);

  // A range past the server's limit (a plan that keeps less) falls back to the longest one it has.
  const range = ranges.find((r) => r.key === rangeKey) || (RANGES.some((r) => r.key === rangeKey) ? ranges.at(-1) : RANGES[3]);
  const propParams = Object.fromEntries(Object.entries(props).map(([k, v]) => [`prop.${k}`, v.join(',')]));
  const propKey = JSON.stringify(propParams);
  useEffect(() => setAnswered({}), [range.key, service, env, version, type, propKey]);
  const estimated = [...new Set(Object.values(answered).flatMap((v) => JSON.parse(v)[0]))];
  const notes = [...new Set(Object.values(answered).map((v) => JSON.parse(v)[1]).filter(Boolean))];
  const now = useMemo(() => Math.floor(Date.now() / 5000) * 5000, [tick, rangeKey, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = list.find((s) => s.service === service);
  // The game's pages. An automatic dashboard depends on what the game sent, so it is read over a week (moving
  // every 5 minutes), not the picked range: pages don't come and go with the time picker.
  const week = Math.floor(now / 300e3) * 300e3;
  const dash = useQuery('dashboard', { service, from: week - 7 * DAY, to: week }, { enabled: !!service, refreshMs: 60000 });
  const dashboard = dash.data?.dashboard;
  // The game's session properties over the same week (A6), for the property filter and the splits by one.
  const known = useQuery('events', { service, from: week - 7 * DAY, to: week }, { enabled: !!service, refreshMs: 300000 });
  const properties = (known.data?.properties || []).filter((p) => !p.identifier_like);
  const pages = dashboard?.pages || (service ? [] : EMPTY_PAGES);
  const filters = {
    service,
    env,
    version,
    from: now - range.ms,
    to: now,
    rangeKey,
    live,
    props,
    setProps,
    properties,
    params: { service, env, version, type, from: now - range.ms, to: now, ...propParams },
    go: (path) => (window.location.hash = `#/${path}`),
    // The page that shows a built-in view (a board may have the view's own id, such as "servers").
    pageOf: (view) => pathOf(pages.find((p) => p.view === view)?.id ?? view),
    versions: current?.versions || [],
    dashboard: { spec: dashboard?.spec ?? null, source: dashboard?.source, updated_at: dashboard?.updated_at, updated_by: dashboard?.updated_by, reload: dash.reload },
  };

  const game = [
    { section: 'Dashboard' },
    ...pages.map((p) => ({ path: p.id, label: p.title, icon: p.icon, title: p.title, dash: p })),
    ...(service ? [{ path: 'pages', label: 'Edit pages', icon: 'edit', title: 'Dashboard pages', page: Pages, quiet: true }] : []),
  ];
  const listed = shell.nav ? shell.nav([...game, ...NAV]) : [...game, ...NAV];
  // A page of the game whose id is one of the dashboard's own addresses (a board called "agents" next to Agents & MCP)
  // gets an address of its own, so both stay in the sidebar and each link opens its own page.
  const own = new Set(listed.filter((n) => n.path && !n.dash).map((n) => n.path));
  const items = listed.map((n) => (n.dash && own.has(n.path) ? { ...n, path: `${n.path}-page` } : n));
  const pathOf = (id) => items.find((n) => n.dash?.id === id)?.path ?? id;
  const statics = { agents: Agents, setup: Setup };
  // A page of the game's dashboard; else another item; else a built-in view the dashboard leaves out (links
  // such as #/errors/<issue> or #/sessions/<id> still open it); else the first page.
  const builtIn = (id) => ({ Page: VIEW_PAGES[id], title: VIEWS[id].title, page: { id, view: id } });
  const resolve = (id) => {
    const item = items.find((n) => n.path && n.path === id);
    const p = item?.dash;
    if (p) return p.view ? { Page: VIEW_PAGES[p.view], title: p.title, page: p, path: item.path } : { Page: Board, title: p.title, page: p, path: item.path };
    if (item) return { Page: item.page || statics[item.path], title: item.title, path: item.path };
    if (VIEW_PAGES[id]) return builtIn(id);
    return null;
  };
  const first = items.find((n) => n.path);
  // A link to a page this list doesn't have yet (an agent just added it): read the pages again.
  const unknown = !!route.page && !!dashboard && !resolve(route.page);
  useEffect(() => {
    if (unknown) dash.reload();
  }, [unknown, route.page]); // eslint-disable-line react-hooks/exhaustive-deps
  // A link into a built-in view (#/matches/<id>, #/sessions/<id>, #/errors/<issue>) opens that view even when a board
  // of the game has the same id, under the page that shows the view when there is one.
  const deep = !!route.arg && !!VIEW_PAGES[route.page] && resolve(route.page)?.page?.view !== route.page;
  const shows = deep && pages.find((p) => p.view === route.page);
  const view = (deep ? (shows ? resolve(shows.id) : builtIn(route.page)) : resolve(route.page)) || (first ? resolve(first.path) : null);
  const active = view?.path ?? (view?.page ? pathOf(view.page.id) : null) ?? (items.some((n) => n.path === route.page) ? route.page : first?.path);
  const Page = view?.page?.view === 'sessions' && route.arg ? SessionDetail : view?.Page;
  const loading = (services.loading && !services.data) || (service && !dashboard && dash.loading);
  // The drawer goes away when a page is chosen or the window grows past a phone's width.
  useEffect(() => setDrawer(false), [route.page, route.arg, phone]);
  useEffect(() => {
    if (!drawer) return undefined;
    // The first control a phone shows (the desktop's fold button is hidden there).
    [...(navRef.current?.querySelectorAll('button, select, a') ?? [])].find((el) => el.offsetParent)?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setDrawer(false);
      menuBtn.current?.focus();
    };
    document.documentElement.classList.add('drawer-open'); // the page under it doesn't scroll
    window.addEventListener('keydown', onKey);
    return () => {
      document.documentElement.classList.remove('drawer-open');
      window.removeEventListener('keydown', onKey);
    };
  }, [drawer]);
  // On the folded rail each icon names itself beside it: once the mouse rests on it, and at once on keyboard focus.
  const named = (label) =>
    rail
      ? {
          'aria-label': label,
          onPointerEnter: (e) => {
            const el = e.currentTarget;
            if (e.pointerType === 'mouse') navRest.current = setTimeout(() => setNavTip({ el, label }), 350);
          },
          onPointerLeave: () => (clearTimeout(navRest.current), setNavTip(null)),
          onFocus: (e) => e.currentTarget.matches(':focus-visible') && setNavTip({ el: e.currentTarget, label }),
          onBlur: () => setNavTip(null),
        }
      : {};
  const fold = folded ? 'Expand the sidebar' : 'Collapse the sidebar';
  // The game's own accent and logo (brand.jsx), on every page of its dashboard.
  const theme = useTheme();
  const brand = useBrand(service);
  const branded = brandStyle(brand, theme);

  return (
    <Shell.Provider value={shell}>
      <Filters.Provider value={filters}>
        <div className={`app ${shell.className} ${rail ? 'nav-collapsed' : ''} ${drawer ? 'nav-open' : ''} ${branded.className}`.replace(/\s+/g, ' ').trim()} style={branded.style}>
          <nav className="sidenav" id="sidenav" aria-label="Pages" ref={navRef}>
            <div className="brand">
              <img src={shell.brand.logo} alt={shell.brand.name} />
              <div>
                <div className="name">{shell.brand.name}</div>
                <div className="tagline">{shell.brand.tagline}</div>
              </div>
              <button type="button" className="nav-toggle" aria-expanded={!folded} title={folded ? undefined : fold} {...named(fold)} aria-label={fold} onClick={() => (setFolded(!folded), setNavTip(null))}>
                <Icon name={folded ? 'expand' : 'collapse'} size={18} />
              </button>
              <button type="button" className="nav-close" aria-label="Close the menu" onClick={() => (setDrawer(false), menuBtn.current?.focus())}>
                <Icon name="x" size={18} />
              </button>
            </div>
            {!rail && shell.sidebarTop}
            {/* Self-hosted, this picks the game. Hosted, a game is picked above and almost always has one service. */}
            {!rail && (!shell.sidebarTop || list.length > 1) && (
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
                <a key={n.path} className={`navitem ${active === n.path ? 'active' : ''} ${n.quiet ? 'quiet' : ''}`.trim()} href={`#/${n.path}`} aria-current={active === n.path ? 'page' : undefined} {...named(n.label)}>
                  <Icon name={n.icon} />
                  <span className="nl">{n.label}</span>
                </a>
              ),
            )}
            <div className="nav-end">
              <ThemePick folded={rail} named={named} onPick={() => setNavTip(null)} />
              {!rail && (shell.footer ?? null)}
            </div>
          </nav>
          {drawer && <div className="nav-scrim" aria-hidden="true" onClick={() => setDrawer(false)} />}
          {rail && navTip && (
            <Floating anchor={navTip.el} place="right" className="navtip">
              {navTip.label}
            </Floating>
          )}
          <main>
            <header className="topbar">
              <button type="button" className="menu-btn" ref={menuBtn} aria-label="Menu: games and pages" aria-expanded={drawer} aria-controls="sidenav" onClick={() => setDrawer(!drawer)}>
                <Icon name="menu" size={20} />
              </button>
              <div className="crumbs">
                <BrandLogo brand={brand} />
                <span className="root">{service || shell.brand.name} /</span>
                <h1>{Page === SessionDetail ? 'Session Replay' : view?.page?.view === 'matches' && route.arg ? 'Match' : view?.title}</h1>
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
                    <option value="tester">tester (TestFlight)</option>
                    <option value="synthetic">synthetic (bots)</option>
                    <option value="simulated">simulated</option>
                  </select>
                </label>
                <PropFilter list={properties} props={props} onChange={setProps} />
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

// Only sessions with a property's value (A6): a key, then one of its values, from what the game sent over the
// week. A game that sends no properties shows nothing here.
function PropFilter({ list, props, onChange }) {
  const [picked, setPicked] = useState(null);
  // A key picked without a value yet holds only while this game has it.
  const key = Object.keys(props)[0] ?? (list.some((p) => p.key === picked) ? picked : null);
  if (!list.length && !key) return null;
  const values = list.find((p) => p.key === key)?.values || [];
  const now = props[key]?.join(',') ?? '';
  const pickKey = (k) => (setPicked(k || null), onChange({}));
  return (
    <>
      <label className="tvar" title="Only sessions with this property">
        <span>$property</span>
        <select value={key ?? ''} onChange={(e) => pickKey(e.target.value)}>
          <option value="">*</option>
          {list.map((p) => (
            <option key={p.key}>{p.key}</option>
          ))}
          {key && !list.some((p) => p.key === key) && <option>{key}</option>}
        </select>
      </label>
      {key && (
        <label className="tvar">
          <span>${key}</span>
          <select value={now} onChange={(e) => onChange(e.target.value ? { [key]: e.target.value.split(',') } : {})}>
            <option value="">*</option>
            {values.map((v) => (
              <option key={v.value} value={v.value}>
                {v.value}
              </option>
            ))}
            {now && !values.some((v) => v.value === now) && <option value={now}>{now.replace(/,/g, ', ')}</option>}
          </select>
        </label>
      )}
    </>
  );
}

const THEME_NAMES = { system: 'System', light: 'Light', dark: 'Dark' };

// Light, dark, or whatever the system says, kept in this browser (theme.js). Folded, one icon that steps through them.
function ThemePick({ folded, named, onPick }) {
  const pref = useThemePref();
  const pick = (t) => (applyTheme(t, { remember: true }), onPick());
  if (folded) {
    const next = THEMES[(THEMES.indexOf(pref) + 1) % THEMES.length];
    const label = `Theme: ${THEME_NAMES[pref]}. Switch to ${THEME_NAMES[next]}`;
    return (
      <button type="button" className="nav-toggle theme-step" {...named(label)} onClick={() => pick(next)}>
        <Icon name={pref} size={16} />
      </button>
    );
  }
  return (
    <div className="theme-pick" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t} type="button" aria-pressed={pref === t} className={pref === t ? 'on' : undefined} onClick={() => pick(t)}>
          <Icon name={t} size={13} />
          {THEME_NAMES[t]}
        </button>
      ))}
    </div>
  );
}

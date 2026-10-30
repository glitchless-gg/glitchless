// A board: one page of a game's dashboard, panels in the game's own words (server/src/board.js). The coding
// agent designs the dashboard over MCP (glitchless_set_dashboard); people can edit it here. A game without a
// saved dashboard gets one made from the data it sends. With `readOnly` in the filters (a shared board) it
// has no editor and no links into the rest of the dashboard.
// Each panel shows its title, its number or chart, and at most one short line; what the numbers mean, caveats and the
// agent's note sit behind the info icon next to the title (panelLine, panelInfo). BoardGrid packs the panels so a short
// one doesn't stretch to the tallest beside it.
import { useLayoutEffect, useRef, useState } from 'react';
import { useFilters } from '../filters.js';
import { useShell } from '../shell.js';
import { useQuery } from '../api.js';
import { saveDashboard, withPage } from '../dashboard.js';
import { Widget, QueryValue, TimeSeries, BarList, Status, Findings } from '../components.jsx';
import { fmtNum, fmtPct, fmtDuration, fmtTime, fmtMoney, fmtSum, timeAgo, colorFor, causeColor } from '../format.js';
import { CsvButton, panelCsv, liveCsv, columnHeader } from '../csv.jsx';
import { NoGame } from './Overview.jsx';
import { StorePanelBody, STORE_TYPES, REVENUE_STATS, revenueStat, storeLine, storeInfo } from '../stores.jsx';
import { SessionsTable } from './Sessions.jsx';
import { LiveFeed, useLiveEvents, line as liveLine } from './Live.jsx';
import { ReportList } from './Reports.jsx';
import { RetentionTable, RetentionOff } from './Players.jsx';
import { PositionsMap } from '../heatmap.jsx';
import { useBrand, BoardHero, BrandLogo } from '../brand.jsx';
import { NetBody, netLine, netInfo, ServersBody, serversLine, serversInfo, RetentionBy, byWords } from '../genre.jsx';

const SPAN = { s: 3, m: 6, l: 12 };

export function Board({ page }) {
  const f = useFilters();
  const { boardActions: Extra } = useShell();
  const { data, error, reload } = useQuery('board', { ...f.params, page: page?.id }, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  const [editing, setEditing] = useState(false);
  const brand = useBrand(f.service);
  if (!f.service) return <NoGame />;
  if (!data) return error ? <div className="empty">{error.message}</div> : <div className="loading-bar" />;
  const board = data.board;
  if (!board) return <div className="empty">{data.error}</div>;
  if (f.readOnly)
    return (
      <div className="board">
        {brand?.banner ? (
          <BoardHero brand={brand} game={f.service} title={board.title} />
        ) : (
          <div className="board-head">
            <h2>
              <BrandLogo brand={brand} className="board-logo" />
              {board.title}
            </h2>
          </div>
        )}
        <PageWhere where={page?.where} />
        <BoardGrid panels={board.panels} />
      </div>
    );
  return (
    <div className="board">
      <BoardHero brand={brand} game={f.service} title={board.title} />
      <div className="board-head">
        <span className="muted">
          {board.source === 'saved'
            ? `Saved${board.updated_by ? ` by ${board.updated_by === 'dashboard' ? 'you' : board.updated_by}` : ''} ${timeAgo(board.updated_at)}`
            : "Made from what this game sends. Ask your coding agent to design this game's dashboard (glitchless_set_dashboard), or change it here."}
        </span>
        <div className="board-actions">
          {Extra && <Extra board={board} />}
          <button className="btn" onClick={() => setEditing(!editing)}>
            {editing ? 'Close editor' : 'Edit panels'}
          </button>
          <a className="btn" href="#/pages">
            Pages and look
          </a>
        </div>
      </div>
      <PageWhere where={page?.where} />
      {editing && <BoardEditor board={board} onSaved={() => (setEditing(false), reload())} />}
      <BoardGrid panels={board.panels} />
    </div>
  );
}

// A page that shows only some sessions (its `where`, SPEC §3b): which, in words, under its title.
function PageWhere({ where }) {
  const parts = Object.entries(where || {}).map(([k, v]) => `${k.replace(/^\$/, '')} ${(Array.isArray(v) ? v : [v]).join(', ')}`);
  if (!parts.length) return null;
  return <div className="page-where muted">Only sessions with {parts.join('; and ')}</div>;
}

const GAP = 12;
// How many of the 12 columns a panel takes at the board's width: a quarter, half or all of it (`s`, `m`, `l`); on a
// narrower board stats go two to a row and the rest full width; on a phone everything is full width. The .board-grid
// rules in styles.css say the same for the first layout, before the panels are measured.
function spanAt(size, width) {
  const span = SPAN[size] || 6;
  if (width < 520) return 12;
  if (width < 840) return span === 3 ? 6 : 12;
  return span;
}

// Where each panel goes, given its columns and height: in the agent's order, each at the highest place it fits that
// isn't above the panel before it, and never to its left at about the same height, so the board still reads in order
// while the next panels fill in under a short one. Panels side by side whose heights are close become the same height,
// so a row of stats stays even.
function pack(items, cols = 12) {
  const SNAP = 24;
  const top = new Array(cols).fill(0);
  const out = [];
  let band = [];
  let cy = 0;
  let cx = 0;
  const fit = (w) => {
    const all = [];
    for (let x = 0; x + w <= cols; x++) {
      const y = Math.max(cy, ...top.slice(x, x + w));
      if (x < cx && y - cy <= SNAP) continue;
      all.push({ x, y });
    }
    // Nowhere to the right and nothing far enough down: a new row under everything.
    if (!all.length) return { x: 0, y: Math.max(...top) };
    const low = Math.min(...all.map((c) => c.y));
    return all.find((c) => c.y - low <= SNAP);
  };
  // Tallest first, each panel of a row grows to the lowest bottom beside it that is close to its own: two short panels
  // next to a tall one match each other, not the tall one.
  const even = () => {
    const done = [];
    for (const i of [...band].sort((a, b) => out[b].y + out[b].h - (out[a].y + out[a].h))) {
      const o = out[i];
      const own = o.y + o.h;
      const bottom = Math.max(own, ...done.filter((b) => b - own <= Math.max(36, (b - o.y) * 0.2)));
      if (bottom > own) {
        o.h = bottom - o.y;
        o.even = true;
      }
      done.push(bottom);
      for (let x = o.x; x < o.x + o.w; x++) top[x] = o.y + o.h + GAP;
    }
    band = [];
  };
  items.forEach(({ w, h }, i) => {
    w = Math.min(w, cols);
    let at = fit(w);
    const last = out[band.at(-1)];
    if (band.length && !(at.y === last.y && at.x === last.x + last.w)) {
      even();
      at = fit(w);
    }
    out[i] = { x: at.x, y: at.y, w, h };
    for (let x = at.x; x < at.x + w; x++) top[x] = at.y + h + GAP;
    band.push(i);
    cy = at.y;
    cx = at.x + w;
  });
  if (band.length) even();
  return { cells: out, height: Math.max(0, ...out.map((o) => o.y + o.h)) };
}

const col = (n, gaps) => `calc((100% - ${11 * GAP}px) / 12 * ${n} + ${gaps * GAP}px)`;

// The board's panels: a 12-column grid until they are measured, then each placed by pack() at its own height, and
// placed again whenever the board's width or a panel's height changes (a chart drawn, the map loaded, new data).
function BoardGrid({ panels }) {
  const box = useRef(null);
  const [layout, setLayout] = useState(null);
  const ids = panels.map((p) => `${p.id}:${p.size}`).join(' ');
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const width = el.clientWidth;
      const cells = [...el.children];
      if (!width || cells.length !== panels.length) return;
      // A panel's own height: without the height it was given to match its neighbours.
      const given = cells.map((c) => c.style.minHeight);
      cells.forEach((c) => (c.style.minHeight = ''));
      const heights = cells.map((c) => Math.ceil(c.getBoundingClientRect().height));
      cells.forEach((c, i) => (c.style.minHeight = given[i]));
      const next = pack(panels.map((p, i) => ({ w: spanAt(p.size, width), h: heights[i] })));
      setLayout((old) => (old && JSON.stringify(old) === JSON.stringify(next) ? old : next));
    };
    const soon = () => (frame ||= requestAnimationFrame(measure));
    measure();
    const seen = new ResizeObserver(soon);
    seen.observe(el);
    for (const c of el.children) seen.observe(c);
    return () => {
      seen.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const cells = layout?.cells.length === panels.length ? layout.cells : null;
  return (
    <div ref={box} className={`board-grid${cells ? ' packed' : ''}`} style={cells ? { height: layout.height } : undefined}>
      {panels.map((p, i) => {
        const c = cells?.[i];
        return (
          <div key={p.id} className={`cell size-${SPAN[p.size] ? p.size : 'm'}`} style={c ? { left: col(c.x, c.x), width: col(c.w, c.w - 1), top: c.y, minHeight: c.even ? c.h : undefined } : undefined}>
            <Panel p={p} />
          </div>
        );
      })}
    </div>
  );
}

function BoardEditor({ board, onSaved }) {
  const f = useFilters();
  const [text, setText] = useState(JSON.stringify(board.spec.panels, null, 2));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let panels;
      try {
        panels = JSON.parse(text);
      } catch {
        throw new Error('That is not valid JSON.');
      }
      await saveDashboard(f, withPage(f.dashboard.spec, board.page, { panels }));
      onSaved();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };
  return (
    <Widget span={12} title={`Panels of ${board.title}`} sub="stat, series, breakdown, distribution, funnel, levels, frame_time, errors, deaths, events, findings, sessions, versions, live, reports, retention, positions, net, servers, table">
      <textarea className="board-editor" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      {error && <div className="err">{error}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy} onClick={save}>
          Save panels
        </button>
      </div>
    </Widget>
  );
}

// What a versions panel compares: versions, or Steam branches or builds (its `by`, SPEC §4c).
function byLabel(by) {
  return { steam_branch: 'Steam branch', steam_build: 'Steam build' }[by] || 'Version';
}

// The built-in view each panel's More opens.
const MORE_VIEW = { findings: 'findings', sessions: 'sessions', versions: 'versions', live: 'live', errors: 'errors', events: 'events', reports: 'reports', retention: 'players', servers: 'servers' };

function Panel({ p }) {
  const f = useFilters();
  const span = SPAN[p.size] || 6;
  // Every panel with something on it downloads it as CSV (csv.jsx); a live panel its feed.
  const csv = !p.empty && p.type !== 'live' && <CsvButton name={p.title} rows={() => panelCsv(p)} />;
  const [why, whyMore] = p.empty ? splitWhy(p.why) : [null, null];
  const info = [...panelInfo(p), whyMore];
  const warn = !!(p.mismatch?.length || p.sandbox);
  if (p.type === 'stat') return <QueryValue span={span} label={p.title} value={p.empty ? null : statValue(p)} sub={p.empty ? why : statSub(p)} info={info} warn={warn || !!p.off} actions={csv} />;
  if (p.type === 'store_revenue' && REVENUE_STATS.has(p.measure)) {
    const s = p.empty ? null : revenueStat(p);
    return <QueryValue span={span} label={p.title} value={s?.value ?? null} sub={p.empty ? why : s.sub} info={[...(s?.info ?? info)]} actions={csv} />;
  }
  if (p.type === 'live' && !p.empty) return <LivePanel p={p} span={span} />;
  // The view a panel's More opens, on the game's page that shows it (a board may have the view's own id).
  const pageOf = f.pageOf ?? ((v) => v);
  const more =
    p.type === 'positions'
      ? `${pageOf('heatmaps')}?level=${encodeURIComponent(p.level)}`
      : p.type === 'net'
        ? `${pageOf('performance')}?section=network`
        : p.type === 'table'
          ? `${pageOf('events')}?name=${encodeURIComponent(p.event.split(/[:=]/)[0])}`
          : MORE_VIEW[p.type] && pageOf(MORE_VIEW[p.type]);
  return (
    <Widget
      span={span}
      title={p.title}
      sub={p.empty ? null : panelLine(p)}
      info={info}
      warn={warn}
      flush={['sessions', 'versions', 'reports', 'retention', 'table'].includes(p.type) && !p.empty && !p.split?.rows}
      actions={
        (csv || (more && !f.readOnly)) && (
          <>
            {csv}
            {more && !f.readOnly && <a href={`#/${more}`}>More →</a>}
          </>
        )
      }
    >
      {p.anonymous ? <RetentionOff /> : p.empty ? <div className="why">{why}</div> : <PanelBody p={p} />}
    </Widget>
  );
}

// An empty panel says why in its first sentence; the rest of a long reason goes behind the info icon.
function splitWhy(why) {
  const text = String(why ?? '');
  const at = text.search(/\. [A-Z]/);
  return at > 0 && text.length > 110 ? [text.slice(0, at + 1), text.slice(at + 2)] : [text, null];
}

const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

// A panel's one short line under its title: how much is on it, in plain words. Most charts and tables need none.
function panelLine(p) {
  if (STORE_TYPES.has(p.type)) return storeLine(p);
  const more = p.more > 0 ? ` · ${p.more} more` : '';
  if (p.type === 'breakdown') {
    // Rates and averages: the overall number every row is read against.
    if (p.rate) return `All: ${fmtRate(p.overall)} of ${plural(p.events, 'event')}${more}`;
    if (p.avg) return `All: ${fmtUnit(p.overall)} on average, ${plural(p.events, 'event')}${more}`;
    if (p.per === '$hours') return `${p.sum ? fmtSum(p.total, p.currency) : fmtNum(p.total)} in ${fmtNum(p.hours, 1)} hours played${more}`;
    if (p.sum) return `${fmtSum(p.total, p.currency)} from ${plural(p.count, 'event')}${more}`;
    if (p.counts === 'sessions') return `${plural(p.total, 'session')}${p.players != null ? ` from ${plural(p.players, 'player')}` : ''}${more}`;
    return `${p.sessions == null ? `${fmtNum(p.total)} in all` : `${fmtNum(p.total)} in ${plural(p.sessions, 'session')}`}${more}`;
  }
  if (p.type === 'frame_time') return p.kpis.avg_fps != null ? `${fmtNum(p.kpis.avg_fps)} fps on average` : null;
  if (p.type === 'net') return netLine(p);
  if (p.type === 'servers') return serversLine(p);
  // Levels split by an attempt's attribute, a property or a split, or counting runs (SPEC §3b levels).
  if (p.type === 'levels' && (p.by || p.count)) return [p.by && `by ${byWords(p.by)}`, p.count === 'runs' && 'each run counted once at each level it reached'].filter(Boolean).join(' · ');
  if (p.type === 'distribution') return `Half under ${fmtUnit(p.p50, p.unit)}, 1 in 10 over ${fmtUnit(p.p90, p.unit)} (${plural(p.count, 'event')})`;
  if (p.type === 'table') return `${fullCount(p.events, 'event')} from ${fullCount(p.sessions, 'session')}${p.group_by ? ` in ${fullCount(p.groups.length + p.more_groups, 'group')}` : ''}`;
  return null;
}

// A rate: two decimals under 1% (a gacha's 0.41%), else `d`.
function fmtRate(v, d = 1) {
  return fmtPct(v, v != null && v < 1 ? 2 : d);
}

// A number in a panel's unit: seconds as minutes or hours when large, a percentage, or the game's own word after it.
function fmtUnit(v, unit = null) {
  if (v == null) return '–';
  if (unit === 's') return fmtDuration(v);
  if (unit === '%') return fmtPct(v);
  const n = fmtNum(v, Math.abs(v) < 10 && !Number.isInteger(v) ? 2 : Number.isInteger(v) ? 0 : 1);
  return unit ? `${n} ${unit}` : n;
}

// Everything else about a panel, for its info icon: the agent's note, what the numbers are and how they were counted,
// and what was left out. Agents read all of it from the board query; the CSV has the numbers.
function panelInfo(p) {
  const out = [p.note];
  if (STORE_TYPES.has(p.type)) return [...out, ...storeInfo(p)];
  if (p.empty) return out;
  if (p.type === 'breakdown') {
    if (p.counts === 'sessions' && p.players == null) out.push('The game sends no player IDs, so these are sessions: players are not counted.');
    if (p.rate) {
      out.push(`Each bar is the share of ${p.event} events with ${p.rate.replace('=', ' = ')}, and its whisker the range it likely sits in (95%). The line is ${p.expect != null ? `the ${fmtPct(p.expect)} the game expects` : 'every row together'}: a row whose range misses it is drawn in colour. A wide whisker means wait for more events.`);
    } else if (typeof p.avg === 'string') out.push(`Each bar is the average ${p.avg} of the row's ${p.event} events; the line is the average of all of them.`);
    else if (p.avg != null) out.push(`On average ${fmtNum(p.avg, 1)} per session.`);
    if (p.list) out.push(`"${p.by}" is a list: each ${p.event} counts once under each value it has, so the rows add up to more than the events.`);
    if (p.small?.rows) out.push(`${plural(p.small.rows, 'row')} with fewer than ${fmtNum(p.small.min)} events (${plural(p.small.events, 'event')} in all) ${p.small.rows === 1 ? "isn't" : "aren't"} shown.`);
    if (p.per === '$hours') out.push(p.by?.startsWith('$') ? 'Each row is per hour played in it.' : 'Each row is per hour played in all, so they add up.');
    if (p.estimated) out.push(`Estimated in part: ${plural(p.estimated, 'session')} sent more of these events than Glitchless keeps the attributes of (16 each).`);
    if (p.more > 0) out.push(`${plural(p.more, 'more value')} ${p.more === 1 ? "isn't" : "aren't"} shown.`);
  }
  if (p.type === 'distribution') {
    out.push(`Half of the ${p.event} events have ${p.of} under ${fmtUnit(p.p50, p.unit)}, 9 in 10 under ${fmtUnit(p.p90, p.unit)} and 99 in 100 under ${fmtUnit(p.p99, p.unit)}; from ${fmtUnit(p.min, p.unit)} to ${fmtUnit(p.max, p.unit)}, ${fmtUnit(p.mean, p.unit)} on average.`);
    if (p.under || p.over) out.push(`The bars run from the 1st to the 99th percentile: ${[p.under && `${plural(p.under, 'event')} below`, p.over && `${plural(p.over, 'event')} above`].filter(Boolean).join(' and ')} are left off the chart.`);
    if (p.partial) out.push('This event sends more numbers than a minute keeps (32), so some values are not counted.');
    if (p.estimated) out.push(`Estimated in part: ${plural(p.estimated, 'session')} sent more of these events than Glitchless keeps the numbers of (16 each).`);
  }
  if (p.type === 'stat' && p.unit === '%' && p.low != null) out.push(`From ${plural(p.events, 'event')}: it likely sits between ${fmtRate(p.low)} and ${fmtRate(p.high)} (95%).${p.expect != null ? ` The game expects ${fmtRate(p.expect)}.` : ''}`);
  if (p.type === 'series' && p.per === '$hours') out.push('Each point is per hour played in that stretch of time; stretches with under 6 minutes played have none.');
  if (p.type === 'series') {
    if (p.counts === 'sessions') out.push(`Sessions playing at the time, by their ${p.split}.`);
    if (p.spread > 0) out.push(`${fmtNum(p.spread)} of these events came from sessions that sent more than 16: Glitchless keeps when the first 16 were sent, and spreads the rest over the minutes those sessions played.`);
  }
  if (p.type === 'frame_time') out.push(`Half the frames took under ${fmtNum(p.kpis.p50, 1)} ms (p50) and 95% under ${fmtNum(p.kpis.p95, 1)} ms (p95). The green line is the frame budget, ${fmtNum(p.budget_ms, 1)} ms.`);
  if (p.type === 'net') out.push(...netInfo(p));
  if (p.type === 'servers') out.push(...serversInfo(p));
  if ((p.type === 'levels' || p.type === 'deaths') && typeof p.by === 'string') {
    out.push(p.by.startsWith('$') ? `Each attempt counts under its session's ${byWords(p.by)}.` : `Each attempt counts under the ${p.by} it started with (levelStart's attributes); a list counts once under each of its values, and an attempt without it is (none).`);
  }
  if (p.type === 'levels' && p.rows?.some((r) => r.disconnects)) out.push('Disconnects: attempts that ended because the connection dropped. They count as abandons, never as fails or rage quits.');
  if (p.type === 'levels' && p.count === 'runs') out.push('Runs: each run (setGroup("run")) counted once at each level it reached, however many sessions it took.');
  if (p.type === 'table') out.push(...tableInfo(p));
  if (p.type === 'positions') out.push(`${p.axis === 'xy' ? 'Side view' : 'Seen from above'}, ${p.bin} ${p.bin === 1 ? 'unit' : 'units'} a bin${p.path && p.path.bin !== p.bin ? ` (paths ${p.path.bin})` : ''}.${p.truncated ? ` Deaths: the ${fmtNum(p.deaths.length)} places with the most.` : ''}`);
  return [...out, ...leftOut(p)];
}

// Under a stat: what it is out of (conversion, per player, per hour played, the events a rate or percentile is of).
function statSub(p) {
  const of = { $players: 'players', $sessions: 'sessions' }[p.per];
  // The game's servers (A9) and its network (A8): what the number is out of.
  if (p.metric === 'servers_now') return p.players != null ? `${plural(p.players, 'player')} connected to them` : 'sent anything in the last two minutes';
  if (p.metric === 'server_tick_p95') return p.budget_ms ? `budget ${fmtNum(p.budget_ms, 1)} ms · ${plural(p.servers, 'server run')}` : plural(p.servers, 'server run');
  if (p.metric === 'server_crash_free_pct' || p.metric === 'players_per_server') return `over ${plural(p.servers, 'server run')}`;
  if (p.metric === 'disconnect_pct' || p.metric === 'disconnects_per_hour') return p.count != null ? plural(p.count, 'disconnect') : null;
  if (p.unit === 'per hour') return `${p.total != null ? fmtSum(p.total, p.currency) : fmtNum(p.count)} in ${fmtNum(p.hours, 1)} hours played`;
  if (p.rate && p.events != null) return `of ${plural(p.events, 'event')}${p.expect != null ? ` · expected ${fmtPct(p.expect)}` : ''}`;
  if ((p.avg || p.of) && (p.events ?? p.count) != null) return `${p.of ? (p.quantile === 50 ? 'median' : `${p.quantile}th percentile`) : 'average'} of ${plural(p.events ?? p.count, 'event')}`;
  if (p.sum && p.base != null) return `${fmtSum(p.total, p.currency)} over ${fmtNum(p.base)} ${of}`;
  if (p.base != null) return `${fmtNum(p.count)} of ${fmtNum(p.base)}${of ? ` ${of}` : ''}`;
  return null;
}

function statValue(p) {
  if (p.currency) return fmtMoney(p.value, p.currency) + (p.unit === 'per hour' ? ' / h' : '');
  if (p.metric === 'servers_now') return plural(p.value, 'server');
  if (p.metric === 'players_per_server') return fmtNum(p.value, 1);
  if (p.unit === 'per hour') return `${fmtNum(p.value, p.value < 10 ? 2 : p.value < 100 ? 1 : 0)} / h`;
  if (p.unit === 'h') return `${fmtNum(p.value, p.value < 100 ? 1 : 0)} h`;
  if (p.sum) return fmtNum(p.value, 2);
  if (p.unit === 's') return fmtDuration(p.value);
  if (p.unit === '%') return fmtPct(p.value, p.value < 1 ? 2 : 1);
  if (p.unit === 'ms') return `${fmtNum(p.value, 1)} ms`;
  if (p.of && p.unit) return fmtUnit(p.value, p.unit);
  return fmtNum(p.value, Number.isInteger(p.value) ? 0 : 2);
}

// A live panel keeps its own feed, so it builds its own widget: the CSV is the events it shows.
function LivePanel({ p, span }) {
  const f = useFilters();
  const names = p.events;
  const { events } = useLiveEvents(f.service, names);
  const shown = events.slice(0, 60);
  return (
    <Widget
      span={span}
      title={p.title}
      info={p.note}
      flush
      actions={
        <>
          {shown.length > 0 && <CsvButton name={p.title} rows={() => liveCsv(shown, liveLine)} />}
          {!f.readOnly && <a href="#/live">More →</a>}
        </>
      }
    >
      <LiveFeed events={shown} maxHeight={320} waiting={names?.length ? `Waiting for ${names.join(', ')}…` : undefined} />
    </Widget>
  );
}

// Money left out of a panel's sums, for its info icon (which turns amber): amounts sent in another currency than the
// game's, and sandbox purchases (TestFlight and other test installs, which nobody paid for).
function leftOut({ mismatch, sandbox }) {
  const parts = [...(mismatch || []).map((m) => `${fmtNum(m.events)} in ${m.currency} (${fmtMoney(m.sum, m.currency)})`), ...(sandbox ? [plural(sandbox, 'sandbox purchase')] : [])];
  if (!parts.length) return [];
  return [`Left out: ${parts.join(', ')}.`, mismatch?.length && 'One currency per game: amounts in another currency are not added in.', sandbox && 'Purchases from TestFlight and other test installs are free sandbox purchases, not revenue.'];
}

function PanelBody({ p }) {
  const f = useFilters();
  if (STORE_TYPES.has(p.type)) return <StorePanelBody p={p} />;
  switch (p.type) {
    case 'series': {
      const perHour = p.unit === 'per hour' ? ' / h' : '';
      const format = p.currency ? (v) => fmtMoney(v, p.currency, true) + perHour : p.unit === '%' ? (v) => fmtPct(v, v < 1 ? 2 : 0) : perHour ? (v) => `${fmtNum(v, v < 10 ? 1 : 0)}${perHour}` : undefined;
      return (
        <>
          <TimeSeries ts={p.ts} height={160} bars={p.series.length === 1 && !p.rate && !p.avg} format={format} series={p.series.map((s, i) => ({ ...s, color: colorFor(s.label, i) }))} />
        </>
      );
    }
    case 'distribution':
      return <DistributionBody p={p} />;
    case 'breakdown':
      if (p.rate || typeof p.avg === 'string') return <RateBars p={p} />;
      // Per hour played: each row's count or sum over its hours.
      if (p.per === '$hours') return <BarList rows={p.rows.map((r, i) => ({ label: r.value, value: r.per_hour ?? 0, color: colorFor(r.value, i), display: r.per_hour == null ? '–' : `${p.currency ? fmtMoney(r.per_hour, p.currency) : fmtNum(r.per_hour, r.per_hour < 10 ? 2 : 1)} / h`, title: `${r.value}: ${p.sum ? fmtSum(r.sum, p.currency) : fmtNum(p.counts === 'sessions' ? r.sessions : r.count)} in ${fmtNum(r.hours, 1)} hours played${r.why ? ` (${r.why})` : ''}` }))} />;
      // Each bar says its number; its sessions and players are in its tooltip (and the CSV).
      if (p.sum) return <BarList rows={p.rows.map((r, i) => ({ label: r.value, value: r.sum, color: colorFor(r.value, i), display: fmtSum(r.sum, p.currency), title: `${r.value}: ${fmtSum(r.sum, p.currency)} from ${plural(r.count, 'event')}` }))} />;
      // By $platform, $browser or $device_tier without an event: the sessions in each, and their players when the game
      // sends player IDs.
      if (p.counts === 'sessions') return <BarList rows={p.rows.map((r, i) => ({ label: r.value, value: r.sessions, color: colorFor(r.value, i), display: r.players != null ? `${fmtNum(r.sessions)} · ${plural(r.players, 'player')}` : plural(r.sessions, 'session') }))} />;
      // A list (a deck): each row also says the share of the events that have it.
      return <BarList rows={p.rows.map((r, i) => ({ label: r.value, value: r.count, color: colorFor(r.value, i), display: r.share != null ? `${fmtNum(r.count)} · ${fmtPct(r.share, 0)}` : fmtNum(r.count), title: r.sessions == null ? undefined : `${r.value}: ${fmtNum(r.count)} in ${plural(r.sessions, 'session')}${r.players != null ? ` from ${plural(r.players, 'player')}` : ''}` }))} />;
    case 'funnel':
      return <FunnelTable steps={p.steps} />;
    case 'levels':
      return <LevelsTable rows={p.rows} has={p.has} label={p.label || 'Level'} by={p.by} />;
    case 'net':
      return <NetBody p={p} />;
    case 'servers':
      return <ServersBody p={p} />;
    case 'frame_time':
      return (
        <>
          <TimeSeries ts={p.ts} height={160} unit="ms" series={[{ label: 'p50', values: p.p50, color: '#3d8cf5' }, { label: 'p95', values: p.p95, color: '#ff6b57' }]} thresholds={[{ value: p.budget_ms, color: '#1fae84', label: 'budget' }]} />
        </>
      );
    case 'errors':
      return (
        <div className="tablewrap">
          <table className="dt">
            <tbody>
              {p.issues.map((i) => (
                <tr key={i.fingerprint} className={f.readOnly ? undefined : 'click'} onClick={f.readOnly ? undefined : () => f.go(`errors/${i.fingerprint}`)}>
                  <td>
                    {i.message}
                    {i.location && (
                      <div className="muted mono" style={{ fontSize: 11.5, marginTop: 2 }}>
                        {i.location}
                      </div>
                    )}
                  </td>
                  <td className="num">{fmtNum(i.count)}</td>
                  <td className="num muted">{fmtNum(i.sessions)} sessions</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'deaths': {
      const causes = [...new Set(p.rows.flatMap((r) => Object.keys(r.causes)))];
      // Split by an attempt's attribute or a property: a row per level and value.
      return <BarList rows={p.rows.map((r) => ({ label: r.value != null ? `${r.level} · ${r.value}` : r.level, segments: causes.map((c) => ({ label: c, value: r.causes[c] || 0, color: causeColor(c) })) }))} />;
    }
    case 'findings':
      return <Findings findings={p.findings} compact onOpen={f.readOnly ? undefined : (link) => f.go(findingRoute(link, f.pageOf))} />;
    case 'sessions':
      return <SessionsTable rows={p.sessions} maxHeight={380} />;
    case 'versions': {
      // A shared board leaves out sum columns unless its link shows sums (`hidden`).
      const cols = p.columns.map((c, i) => ({ ...c, i })).filter((c) => !c.hidden);
      return (
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{byLabel(p.by)}</th>
                <th>First seen</th>
                <th className="num">Sessions</th>
                {cols.map((c) => (
                  <th className="num" key={c.title} title={columnHeader(c)}>
                    {c.title}
                    {c.unit?.startsWith('per ') && !c.per && <span className="muted"> / {c.unit.slice(4)}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.rows.map((v) => (
                <tr key={v.version}>
                  <td>
                    <span className="tag">{v.version}</span>
                  </td>
                  <td className="muted">{fmtTime(v.first_seen_ever ?? v.first_seen, true)}</td>
                  <td className="num">{fmtNum(v.sessions)}</td>
                  {cols.map((c) => (
                    <td className="num" key={c.title}>
                      {v.values[c.i] == null ? '–' : statValue({ value: v.values[c.i], unit: c.unit, sum: c.sum, currency: c.currency, of: c.of })}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'reports':
      return <ReportList reports={p.reports} compact />;
    case 'table':
      return <TableBody p={p} />;
    case 'positions':
      return (
        <>
          <PositionsMap p={p} />
          <div className="legend" style={{ marginTop: 8 }}>
            {p.deaths && (
              <span title={p.truncated ? `The ${fmtNum(p.deaths.length)} places with the most deaths` : undefined}>
                <i style={{ background: '#ff6b57', height: 8, width: 8, borderRadius: 4 }} />
                {fmtNum(p.total)} deaths{p.truncated ? `, the ${fmtNum(p.deaths.length)} busiest places` : ''}
              </span>
            )}
            {p.path && (
              <span>
                <i style={{ background: 'linear-gradient(90deg,#5b2ca6,#e0437a,#ffc440)', width: 30 }} />
                where players went ({fmtNum(p.path.samples)} positions)
              </span>
            )}
          </div>
        </>
      );
    case 'retention':
      // By a property (A6): each value's D1, D7 and D30 above the cohorts. The answer's `split` holds the rows.
      return (
        <>
          {p.split?.rows && <RetentionBy r={p} />}
          <RetentionTable r={p} compact />
        </>
      );
    case 'events':
      return (
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Event</th>
                <th className="num">Count</th>
                <th className="num">Sessions</th>
                <th className="num">Per session</th>
                <th>Attributes</th>
              </tr>
            </thead>
            <tbody>
              {p.events.map((e) => (
                <tr key={e.name} className={f.readOnly ? undefined : 'click'} onClick={f.readOnly ? undefined : () => f.go(`events?name=${encodeURIComponent(e.name)}`)}>
                  <td>
                    <b>{e.name}</b>
                  </td>
                  <td className="num">{fmtNum(e.count)}</td>
                  <td className="num">
                    {fmtNum(e.sessions)} <span className="muted">· {fmtPct(e.sessions_pct, 0)}</span>
                  </td>
                  <td className="num">{fmtNum(e.per_session, 1)}</td>
                  <td>
                    {e.attrs.map((a) => (
                      <span className="tag" key={a}>
                        {a}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
  return null;
}

// A table panel (SPEC §3b Tables): one table, a row per event in each group's sort order, under a row per group that says
// its events, its sessions and the lowest, average and highest of its `of`. Numbers are written in full (171,230), times
// with their date, and a session opens its replay; on a share link sessions are numbered instead (#1, #2), never named.
function TableBody({ p }) {
  const cols = p.columns.map((c, i) => ({ ...c, i })).filter((c) => !c.hidden);
  const numeric = new Set(cols.filter((c) => !c.key.startsWith('$') && p.groups.some((g) => g.rows.some((r) => typeof r[c.i] === 'number'))).map((c) => c.i));
  const of = p.of && p.columns.find((c) => c.key === p.of);
  // An average of whole scores reads as one (98,380), a small one keeps its decimals (2.35).
  const avg = (v) => tableNum(Math.abs(v) >= 100 ? Math.round(v) : v, of?.unit);
  const head = (g) => [`${fullCount(g.events, 'event')} from ${fullCount(g.sessions, 'session')}`, p.of && g.min != null && `${p.of}: lowest ${tableNum(g.min, of?.unit)}, average ${avg(g.avg)}, highest ${tableNum(g.max, of?.unit)}`].filter(Boolean).join(' · ');
  return (
    <div className="tablewrap" style={{ maxHeight: 640 }}>
      <table className="dt evtable">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={numeric.has(c.i) ? 'num' : undefined}>
                {c.label}
                {c.unit && <span className="muted"> ({c.unit})</span>}
              </th>
            ))}
          </tr>
        </thead>
        {p.groups.map((g, k) => (
          <tbody key={`${k}:${g.value}`}>
            {(p.group_by || p.groups.length > 1 || (p.of && g.min != null)) && (
              <tr className="tgroup">
                <td colSpan={cols.length}>
                  <div className="tg">
                    {p.group_by && <b>{g.value}</b>}
                    <span className="muted">{head(g)}</span>
                  </div>
                </td>
              </tr>
            )}
            {g.rows.map((r, j) => (
              <tr key={j}>
                {cols.map((c) => (
                  <td key={c.key} className={numeric.has(c.i) ? 'num' : undefined}>
                    <TableCell c={c} v={r[c.i]} />
                  </td>
                ))}
              </tr>
            ))}
            {g.more > 0 && (
              <tr className="tmore">
                <td colSpan={cols.length}>
                  <div className="tg">{`${fmtFull(g.more)} more`}</div>
                </td>
              </tr>
            )}
          </tbody>
        ))}
        {p.more_groups > 0 && (
          <tbody>
            <tr className="tmore">
              <td colSpan={cols.length}>
                <div className="tg">{fullCount(p.more_groups, 'more group')}</div>
              </td>
            </tr>
          </tbody>
        )}
      </table>
    </div>
  );
}

function TableCell({ c, v }) {
  if (v == null || v === '') return <span className="muted">–</span>;
  if (c.key === '$time') return fmtTime(v, true);
  if (c.key === '$version') return <span className="tag">{v}</span>;
  if (c.key === '$session') return c.numbered ? `#${v}` : <a href={`#/sessions/${encodeURIComponent(v)}`} title={v}>{String(v).slice(0, 8)}</a>;
  // A word unit ("pts") is in the column's heading; seconds and percentages read as such in each cell.
  if (typeof v === 'number') return tableNum(v, c.unit === 's' || c.unit === '%' ? c.unit : null);
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

// A number in full with thousands separators (171,230), in its column's unit: seconds as minutes or hours when large.
function tableNum(v, unit = null) {
  if (v == null) return '–';
  if (unit === 's') return fmtDuration(v);
  const n = fmtFull(v);
  return unit === '%' ? `${n}%` : unit ? `${n} ${unit}` : n;
}

function fmtFull(v) {
  return v == null ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const fullCount = (n, one) => `${fmtFull(n)} ${n === 1 ? one : `${one}s`}`;

// What a table's rows are, and what it leaves out, for its info icon.
function tableInfo(p) {
  const out = [`Each row is one ${p.event} event${p.group_by ? `, under its ${p.group_by.replace(/^\$/, '')}` : ''}; ${p.sort ? `sorted by ${p.sort.replace(/^-/, '').replace(/^\$/, '')}${p.sort.startsWith('-') ? ', highest first' : ''}` : 'the newest first'}.${p.group_by ? ' The newest group is on top.' : ''}`];
  if (p.columns.some((c) => c.numbered)) out.push('Sessions are numbered in the order they first appear here, so you can tell which rows came from the same session; a shared board never shows their IDs.');
  else if (p.columns.some((c) => c.key === '$session')) out.push('A session is one launch of the game, not a player.');
  if (p.columns.some((c) => c.hidden)) out.push('Amounts are not shown on this shared board.');
  if (p.groups.some((g) => g.more > 0)) out.push(`At most ${fmtFull(p.limit ?? 20)} rows a group (the panel's limit, up to 100); the rest are counted as "more".`);
  if (p.unlisted?.events) out.push(`${plural(p.unlisted.events, 'event')} not listed: ${plural(p.unlisted.sessions, 'session')} sent more than ${p.unlisted.keep}, and Glitchless keeps the first ${p.unlisted.keep} of each event a session sends.`);
  if (p.counted) out.push(`${plural(p.counted, 'event')} sent with count() ${p.counted === 1 ? "isn't" : "aren't"} listed: count() sends totals, not each event.`);
  return out;
}

// A breakdown's rates (or averages): each row a bar, its whisker the range the rate likely sits in, and a line for
// every row together (or the rate the game expects) across all of them. Rows whose range misses the line are in colour.
function RateBars({ p }) {
  const rate = !!p.rate;
  const line = rate ? p.line : p.overall;
  const value = (r) => (rate ? r.rate : r.avg);
  const max = Math.max(...p.rows.map((r) => (rate ? r.high : r.avg) ?? 0), line ?? 0) * 1.08 || 1;
  const scale = rate ? Math.min(100, max) : max;
  const x = (v) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  if (!p.rows.length) return <div className="why">{`No row has ${fmtNum(p.small?.min)} events yet: ${plural(p.small?.rows ?? 0, 'row')} with fewer.`}</div>;
  return (
    <div className="bars ratebars">
      {p.rows.map((r) => (
        <div className="barrow" key={r.value} title={rate ? `${r.value}: ${fmtRate(r.rate)} of ${plural(r.events, 'event')}, likely ${fmtRate(r.low)}–${fmtRate(r.high)}${r.sessions != null ? `, from ${plural(r.sessions, 'session')}` : ''}` : `${r.value}: ${fmtUnit(r.avg)} on average, ${plural(r.events, 'event')}`}>
          <div className="bl">{r.value}</div>
          <div className={`rt${r.off ? ' off' : ''}`}>
            <div className="rf" style={{ width: x(value(r)) }} />
            {rate && <div className="rw" style={{ left: x(r.low), width: `calc(${x(r.high)} - ${x(r.low)})` }} />}
            {line != null && <div className="rl" style={{ left: x(line) }} />}
          </div>
          <div className="bv">
            {rate ? fmtRate(r.rate, 0) : fmtUnit(r.avg)}
            <span className="muted"> · {fmtNum(r.events)}</span>
          </div>
        </div>
      ))}
      <div className="ratekey muted">
        <i className="rl-key" /> {p.expect != null ? `expected: ${fmtRate(p.expect)}` : `all: ${rate ? fmtRate(p.overall) : fmtUnit(p.overall)}`}
        {rate && (
          <>
            <i className="rw-key" /> likely range
          </>
        )}
      </div>
    </div>
  );
}

// A distribution: the histogram of the values from the 1st to the 99th percentile with the median marked, and with
// a split a row per value (half under, 1 in 10 over).
function DistributionBody({ p }) {
  const bins = p.histogram || [];
  const max = Math.max(1, ...bins.map((b) => b.count));
  const lo = bins[0]?.lo ?? 0;
  const hi = bins.at(-1)?.hi ?? 1;
  const at = (v) => ((v - lo) / (hi - lo || 1)) * 100;
  const edge = (v) => fmtUnit(v, p.unit);
  const ticks = bins.length > 6 ? [0, Math.floor(bins.length / 2), bins.length] : bins.map((_, i) => i).concat(bins.length);
  return (
    <>
      <div className="dist">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${p.of}: half under ${edge(p.p50)}`}>
          {bins.map((b, i) => {
            const h = (b.count / max) * 38;
            return (
              <rect key={i} x={(i * 100) / bins.length + 0.25} y={40 - h} width={100 / bins.length - 0.5} height={h} className="db">
                <title>{`${edge(b.lo)} to ${edge(b.hi)}: ${plural(b.count, 'event')}`}</title>
              </rect>
            );
          })}
          {p.p50 != null && p.p50 >= lo && p.p50 <= hi && <line x1={at(p.p50)} x2={at(p.p50)} y1="0" y2="40" className="dm" vectorEffect="non-scaling-stroke" />}
        </svg>
        <div className="dx">
          {ticks.map((i) => (
            <span key={i} style={{ left: `${(i / bins.length) * 100}%` }}>
              {edge(i < bins.length ? bins[i].lo : hi)}
            </span>
          ))}
        </div>
      </div>
      {p.rows && (
        <div className="tablewrap">
          <table className="dt wrap-th">
            <thead>
              <tr>
                <th>{p.by.startsWith('$') ? p.by.slice(1) : p.by}</th>
                <th className="num">Events</th>
                <th className="num">Half under</th>
                <th className="num">1 in 10 over</th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r) => (
                <tr key={r.value}>
                  <td>{r.value}</td>
                  <td className="num">{fmtNum(r.count)}</td>
                  <td className="num">{edge(r.p50)}</td>
                  <td className="num">{edge(r.p90)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function FunnelTable({ steps }) {
  return (
    <div className="tablewrap">
      <table className="dt wrap-th">
        <thead>
          <tr>
            <th>Step</th>
            <th style={{ width: '40%' }}>Reached</th>
            <th className="num">From the step before</th>
            <th className="num">Time from the step before</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => (
            <tr key={s.step + i}>
              <td>
                <b>{s.step}</b>
              </td>
              <td>
                <div className="barrow" style={{ gridTemplateColumns: '1fr 92px' }}>
                  <div className="bt">
                    <div className="bf" style={{ width: `${s.pct_of_first || 0}%`, background: 'var(--ink)' }} />
                  </div>
                  <div className="bv">
                    {fmtNum(s.sessions)} · {fmtPct(s.pct_of_first, 0)}
                  </div>
                </div>
              </td>
              <td className="num">{i ? fmtPct(s.pct_of_previous, 0) : ''}</td>
              <td className="num">{i ? fmtDuration(s.median_s_from_previous) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Where a finding's link goes: an error issue, a match's page (A7), the Servers view (A9), or a view with its level,
// split or section. `pageOf` names the game's page that shows a view (filters.pageOf).
export function findingRoute(link, pageOf = (v) => v) {
  if (link.page === 'matches' && link.match) return `matches/${encodeURIComponent(link.match)}`;
  if (link.page === 'servers') return pageOf('servers');
  if (link.fingerprint) return `errors/${link.fingerprint}`;
  const q = new URLSearchParams({ ...(link.level ? { level: link.level } : {}), ...(link.by_prop ? { by_prop: link.by_prop } : {}), ...(link.section ? { section: link.section } : {}) });
  return `${pageOf(link.page)}${q.size ? `?${q}` : ''}`;
}

function LevelsTable({ rows, has, label, by }) {
  // Clear times: the median completed attempt and the slowest 1 in 10 (servers before them send the average only).
  const clear = rows.some((r) => r.p50_complete_s != null);
  // Split by an attempt's attribute or a property (levels `by`), and runs counted once per level (`count: "runs"`).
  const split = rows.some((r) => r.value != null && r.value !== '');
  const runs = rows.some((r) => r.runs != null);
  return (
    <div className="tablewrap">
      <table className="dt">
        <thead>
          <tr>
            <th>{label}</th>
            {split && <th>{byWords(by) || 'Value'}</th>}
            {runs && <th className="num">Runs</th>}
            <th className="num">Sessions</th>
            <th className="num">Attempts</th>
            {has.completion && <th style={{ width: '24%' }}>Completion</th>}
            {has.fails && <th className="num">Fails</th>}
            {has.deaths && <th className="num">Deaths / session</th>}
            {has.time && <th className="num">{clear ? 'Clear time' : 'Avg time'}</th>}
            {has.disconnects && <th className="num">Disconnects</th>}
            {has.rage_quits && <th className="num">Rage quits</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={`${l.level}\u0001${l.value ?? ''}`}>
              <td>
                <b>{l.level}</b>
              </td>
              {split && <td>{l.value}</td>}
              {runs && <td className="num">{fmtNum(l.runs)}</td>}
              <td className="num">{fmtNum(l.sessions)}</td>
              <td className="num">{fmtNum(l.attempts)}</td>
              {has.completion && (
                <td>
                  <div className="barrow" style={{ gridTemplateColumns: '1fr 48px' }}>
                    <div className="bt">
                      <div className="bf" style={{ width: `${l.completion_pct || 0}%`, background: l.completion_pct < 50 ? '#ff6b57' : 'var(--ink)' }} />
                    </div>
                    <div className="bv">{fmtPct(l.completion_pct, 0)}</div>
                  </div>
                </td>
              )}
              {has.fails && <td className="num">{fmtNum(l.fails)}</td>}
              {has.deaths && <td className="num">{fmtNum(l.deaths_per_session, 1)}</td>}
              {has.time && (
                <td className="num" title={clear && l.p90_complete_s != null ? `Half clear it within ${fmtDuration(l.p50_complete_s)}, 1 in 10 takes over ${fmtDuration(l.p90_complete_s)}; ${fmtDuration(l.avg_complete_s)} on average` : undefined}>
                  {clear ? fmtDuration(l.p50_complete_s) : fmtDuration(l.avg_complete_s)}
                  {clear && l.p90_complete_s != null && <span className="muted"> · 1 in 10 over {fmtDuration(l.p90_complete_s)}</span>}
                </td>
              )}
              {has.disconnects && <td className="num">{fmtNum(l.disconnects)}</td>}
              {has.rage_quits && (
                <td className="num">
                  <Status kind={l.rage_quit_pct > 12 ? 'bad' : l.rage_quit_pct > 5 ? 'warn' : 'neutral'}>{fmtNum(l.rage_quits)}</Status>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

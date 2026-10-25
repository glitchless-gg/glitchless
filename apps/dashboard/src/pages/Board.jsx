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
      {editing && <BoardEditor board={board} onSaved={() => (setEditing(false), reload())} />}
      <BoardGrid panels={board.panels} />
    </div>
  );
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
    <Widget span={12} title={`Panels of ${board.title}`} sub="stat, series, breakdown, funnel, levels, frame_time, errors, deaths, events, findings, sessions, versions, live, reports, retention, positions">
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

function Panel({ p }) {
  const f = useFilters();
  const span = SPAN[p.size] || 6;
  // Every panel with something on it downloads it as CSV (csv.jsx); a live panel its feed.
  const csv = !p.empty && p.type !== 'live' && <CsvButton name={p.title} rows={() => panelCsv(p)} />;
  const [why, whyMore] = p.empty ? splitWhy(p.why) : [null, null];
  const info = [...panelInfo(p), whyMore];
  const warn = !!(p.mismatch?.length || p.sandbox);
  if (p.type === 'stat') return <QueryValue span={span} label={p.title} value={p.empty ? null : statValue(p)} sub={p.empty ? why : statSub(p)} info={info} warn={warn} actions={csv} />;
  if (p.type === 'store_revenue' && REVENUE_STATS.has(p.measure)) {
    const s = p.empty ? null : revenueStat(p);
    return <QueryValue span={span} label={p.title} value={s?.value ?? null} sub={p.empty ? why : s.sub} info={[...(s?.info ?? info)]} actions={csv} />;
  }
  if (p.type === 'live' && !p.empty) return <LivePanel p={p} span={span} />;
  const more = p.type === 'positions' ? `heatmaps?level=${encodeURIComponent(p.level)}` : { findings: 'findings', sessions: 'sessions', versions: 'versions', live: 'live', errors: 'errors', events: 'events', reports: 'reports', retention: 'players' }[p.type];
  return (
    <Widget
      span={span}
      title={p.title}
      sub={p.empty ? null : panelLine(p)}
      info={info}
      warn={warn}
      flush={['sessions', 'versions', 'reports', 'retention'].includes(p.type) && !p.empty}
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
    if (p.sum) return `${fmtSum(p.total, p.currency)} from ${plural(p.count, 'event')}${more}`;
    if (p.counts === 'sessions') return `${plural(p.total, 'session')}${p.players != null ? ` from ${plural(p.players, 'player')}` : ''}${more}`;
    return `${p.sessions == null ? `${fmtNum(p.total)} in all` : `${fmtNum(p.total)} in ${plural(p.sessions, 'session')}`}${more}`;
  }
  if (p.type === 'frame_time') return p.kpis.avg_fps != null ? `${fmtNum(p.kpis.avg_fps)} fps on average` : null;
  return null;
}

// Everything else about a panel, for its info icon: the agent's note, what the numbers are and how they were counted,
// and what was left out. Agents read all of it from the board query; the CSV has the numbers.
function panelInfo(p) {
  const out = [p.note];
  if (STORE_TYPES.has(p.type)) return [...out, ...storeInfo(p)];
  if (p.empty) return out;
  if (p.type === 'breakdown') {
    if (p.counts === 'sessions' && p.players == null) out.push('The game sends no player IDs, so these are sessions: players are not counted.');
    if (p.avg != null) out.push(`On average ${fmtNum(p.avg, 1)} per session.`);
    if (p.more > 0) out.push(`${plural(p.more, 'more value')} ${p.more === 1 ? "isn't" : "aren't"} shown.`);
  }
  if (p.type === 'series') {
    if (p.counts === 'sessions') out.push(`Sessions playing at the time, by their ${p.split}.`);
    if (p.spread > 0) out.push(`${fmtNum(p.spread)} of these events came from sessions that sent more than 16: Glitchless keeps when the first 16 were sent, and spreads the rest over the minutes those sessions played.`);
  }
  if (p.type === 'frame_time') out.push(`Half the frames took under ${fmtNum(p.kpis.p50, 1)} ms (p50) and 95% under ${fmtNum(p.kpis.p95, 1)} ms (p95). The green line is the frame budget, ${fmtNum(p.budget_ms, 1)} ms.`);
  if (p.type === 'positions') out.push(`${p.axis === 'xy' ? 'Side view' : 'Seen from above'}, ${p.bin} ${p.bin === 1 ? 'unit' : 'units'} a bin${p.path && p.path.bin !== p.bin ? ` (paths ${p.path.bin})` : ''}.${p.truncated ? ` Deaths: the ${fmtNum(p.deaths.length)} places with the most.` : ''}`);
  return [...out, ...leftOut(p)];
}

// Under a stat: what it is out of (conversion, per player).
function statSub(p) {
  const of = { $players: 'players', $sessions: 'sessions' }[p.per];
  if (p.sum && p.base != null) return `${fmtSum(p.total, p.currency)} over ${fmtNum(p.base)} ${of}`;
  if (p.base != null) return `${fmtNum(p.count)} of ${fmtNum(p.base)}${of ? ` ${of}` : ''}`;
  return null;
}

function statValue(p) {
  if (p.currency) return fmtMoney(p.value, p.currency);
  if (p.sum) return fmtNum(p.value, 2);
  if (p.unit === 's') return fmtDuration(p.value);
  if (p.unit === '%') return fmtPct(p.value);
  if (p.unit === 'ms') return `${fmtNum(p.value, 1)} ms`;
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
    case 'series':
      return (
        <>
          <TimeSeries ts={p.ts} height={160} bars={p.series.length === 1} format={p.currency ? (v) => fmtMoney(v, p.currency, true) : undefined} series={p.series.map((s, i) => ({ ...s, color: colorFor(s.label, i) }))} />
        </>
      );
    case 'breakdown':
      // Each bar says its number; its sessions and players are in its tooltip (and the CSV).
      if (p.sum) return <BarList rows={p.rows.map((r, i) => ({ label: r.value, value: r.sum, color: colorFor(r.value, i), display: fmtSum(r.sum, p.currency), title: `${r.value}: ${fmtSum(r.sum, p.currency)} from ${plural(r.count, 'event')}` }))} />;
      // By $platform, $browser or $device_tier without an event: the sessions in each, and their players when the game
      // sends player IDs.
      if (p.counts === 'sessions') return <BarList rows={p.rows.map((r, i) => ({ label: r.value, value: r.sessions, color: colorFor(r.value, i), display: r.players != null ? `${fmtNum(r.sessions)} · ${plural(r.players, 'player')}` : plural(r.sessions, 'session') }))} />;
      return <BarList rows={p.rows.map((r, i) => ({ label: r.value, value: r.count, color: colorFor(r.value, i), display: fmtNum(r.count), title: r.sessions == null ? undefined : `${r.value}: ${fmtNum(r.count)} in ${plural(r.sessions, 'session')}${r.players != null ? ` from ${plural(r.players, 'player')}` : ''}` }))} />;
    case 'funnel':
      return <FunnelTable steps={p.steps} />;
    case 'levels':
      return <LevelsTable rows={p.rows} has={p.has} label={p.label || 'Level'} />;
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
      return <BarList rows={p.rows.map((r) => ({ label: r.level, segments: causes.map((c) => ({ label: c, value: r.causes[c] || 0, color: causeColor(c) })) }))} />;
    }
    case 'findings':
      return <Findings findings={p.findings} compact onOpen={f.readOnly ? undefined : (link) => f.go(link.fingerprint ? `errors/${link.fingerprint}` : `${link.page}${link.level ? `?level=${encodeURIComponent(link.level)}` : ''}`)} />;
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
                      {v.values[c.i] == null ? '–' : statValue({ value: v.values[c.i], unit: c.unit, sum: c.sum, currency: c.currency })}
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
      return <RetentionTable r={p} compact />;
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

function LevelsTable({ rows, has, label }) {
  return (
    <div className="tablewrap">
      <table className="dt">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="num">Sessions</th>
            <th className="num">Attempts</th>
            {has.completion && <th style={{ width: '24%' }}>Completion</th>}
            {has.fails && <th className="num">Fails</th>}
            {has.deaths && <th className="num">Deaths / session</th>}
            {has.time && <th className="num">Avg time</th>}
            {has.rage_quits && <th className="num">Rage quits</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.level}>
              <td>
                <b>{l.level}</b>
              </td>
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
              {has.time && <td className="num">{fmtDuration(l.avg_complete_s)}</td>}
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

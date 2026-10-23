// A board: one page of a game's dashboard, panels in the game's own words (server/src/board.js). The coding
// agent designs the dashboard over MCP (glitchless_set_dashboard); people can edit it here. A game without a
// saved dashboard gets one made from the data it sends. With `readOnly` in the filters (a shared board) it
// has no editor and no links into the rest of the dashboard.
import { useState } from 'react';
import { useFilters } from '../filters.js';
import { useShell } from '../shell.js';
import { useQuery } from '../api.js';
import { saveDashboard, withPage } from '../dashboard.js';
import { Widget, QueryValue, TimeSeries, BarList, Status, Findings } from '../components.jsx';
import { fmtNum, fmtPct, fmtDuration, fmtTime, fmtMoney, fmtSum, timeAgo, colorFor, causeColor } from '../format.js';
import { CsvButton, panelCsv, liveCsv, columnHeader } from '../csv.jsx';
import { NoGame } from './Overview.jsx';
import { SessionsTable } from './Sessions.jsx';
import { LiveFeed, useLiveEvents, line as liveLine } from './Live.jsx';
import { ReportList } from './Reports.jsx';
import { RetentionTable, RetentionOff } from './Players.jsx';

const SPAN = { s: 3, m: 6, l: 12 };

export function Board({ page }) {
  const f = useFilters();
  const { boardActions: Extra } = useShell();
  const { data, error, reload } = useQuery('board', { ...f.params, page: page?.id }, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  const [editing, setEditing] = useState(false);
  if (!f.service) return <NoGame />;
  if (!data) return error ? <div className="empty">{error.message}</div> : <div className="loading-bar" />;
  const board = data.board;
  if (!board) return <div className="empty">{data.error}</div>;
  if (f.readOnly)
    return (
      <div className="grid">
        <div className="board-head s12">
          <h2>{board.title}</h2>
        </div>
        {board.panels.map((p) => (
          <Panel key={p.id} p={p} />
        ))}
      </div>
    );
  return (
    <div className="grid">
      <div className="board-head s12">
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
            Pages
          </a>
        </div>
      </div>
      {editing && <BoardEditor board={board} onSaved={() => (setEditing(false), reload())} />}
      {board.panels.map((p) => (
        <Panel key={p.id} p={p} />
      ))}
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
    <Widget span={12} title={`Panels of ${board.title}`} sub="stat, series, breakdown, funnel, levels, frame_time, errors, deaths, events, findings, sessions, versions, live, reports, retention">
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

function Panel({ p }) {
  const f = useFilters();
  const span = SPAN[p.size] || 6;
  // Every panel with something on it downloads it as CSV (csv.jsx); a live panel its feed.
  const csv = !p.empty && p.type !== 'live' && <CsvButton name={p.title} rows={() => panelCsv(p)} />;
  if (p.type === 'stat') return <QueryValue span={span} label={p.title} value={p.empty ? null : statValue(p)} sub={p.empty ? p.why : statSub(p)} title={p.note} actions={csv} />;
  if (p.type === 'live' && !p.empty) return <LivePanel p={p} span={span} />;
  const more = { findings: 'findings', sessions: 'sessions', versions: 'versions', live: 'live', errors: 'errors', events: 'events', reports: 'reports', retention: 'players' }[p.type];
  return (
    <Widget
      span={span}
      title={p.title}
      sub={p.note}
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
      {p.anonymous ? <RetentionOff /> : p.empty ? <div className="why">{p.why}</div> : <PanelBody p={p} />}
    </Widget>
  );
}

// Under a stat: what it is out of (conversion, per player), and money sent in another currency, left out.
function statSub(p) {
  const of = { $players: 'players', $sessions: 'sessions' }[p.per];
  const main = p.sum && p.base != null ? `${fmtSum(p.total, p.currency)} over ${fmtNum(p.base)} ${of}` : p.base != null ? `${fmtNum(p.count)} of ${fmtNum(p.base)}${of ? ` ${of}` : ''}` : p.note;
  if (!p.mismatch?.length) return main;
  return (
    <>
      {main}
      <div className="warn-t" title="One currency per game: amounts in another currency are not added in.">
        Left out: {p.mismatch.map((m) => `${fmtNum(m.events)} in ${m.currency} (${fmtMoney(m.sum, m.currency)})`).join(', ')}
      </div>
    </>
  );
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
      sub={p.note}
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

// Amounts sent in another currency than the game's, left out of a panel's sums.
function LeftOut({ mismatch }) {
  if (!mismatch?.length) return null;
  return (
    <div className="warn-t" style={{ marginTop: 6 }} title="One currency per game: amounts in another currency are not added in.">
      Left out: {mismatch.map((m) => `${fmtNum(m.events)} in ${m.currency} (${fmtMoney(m.sum, m.currency)})`).join(', ')}
    </div>
  );
}

function PanelBody({ p }) {
  const f = useFilters();
  switch (p.type) {
    case 'series':
      return (
        <>
          <TimeSeries ts={p.ts} height={160} bars={p.series.length === 1} format={p.currency ? (v) => fmtMoney(v, p.currency, true) : undefined} series={p.series.map((s, i) => ({ ...s, color: colorFor(s.label, i) }))} />
          <LeftOut mismatch={p.mismatch} />
        </>
      );
    case 'breakdown':
      if (p.sum)
        return (
          <>
            <BarList rows={p.rows.map((r, i) => ({ label: r.value, value: r.sum, color: colorFor(r.value, i), display: `${fmtSum(r.sum, p.currency)} · ${fmtNum(r.count)}` }))} />
            <div className="muted s12" style={{ marginTop: 6 }}>
              {fmtSum(p.total, p.currency)} from {fmtNum(p.count)} events{p.more > 0 ? ` · ${p.more} more values` : ''}
            </div>
            <LeftOut mismatch={p.mismatch} />
          </>
        );
      return (
        <>
          <BarList rows={p.rows.map((r, i) => ({ label: r.value, value: r.count, color: colorFor(r.value, i), display: r.sessions == null ? fmtNum(r.count) : `${fmtNum(r.count)} · ${fmtNum(r.sessions)} sessions` }))} />
          <div className="muted s12" style={{ marginTop: 6 }}>
            {p.sessions == null ? `${fmtNum(p.total)} in all` : `${fmtNum(p.total)} in ${fmtNum(p.sessions)} sessions`}{p.more > 0 ? ` · ${p.more} more values` : ''}
            {p.avg != null ? ` · average ${fmtNum(p.avg, 1)}` : ''}
          </div>
        </>
      );
    case 'funnel':
      return <FunnelTable steps={p.steps} />;
    case 'levels':
      return <LevelsTable rows={p.rows} has={p.has} label={p.label || 'Level'} />;
    case 'frame_time':
      return (
        <>
          <TimeSeries ts={p.ts} height={160} unit="ms" series={[{ label: 'p50', values: p.p50, color: '#3d8cf5' }, { label: 'p95', values: p.p95, color: '#ff6b57' }]} thresholds={[{ value: p.budget_ms, color: '#1fae84', label: 'budget' }]} />
          <div className="muted" style={{ marginTop: 6 }}>
            p50 {fmtNum(p.kpis.p50, 1)} ms · p95 {fmtNum(p.kpis.p95, 1)} ms{p.kpis.avg_fps != null ? ` · ${fmtNum(p.kpis.avg_fps)} fps` : ''}
          </div>
        </>
      );
    case 'errors':
      return (
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
                <th>Version</th>
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
                  <td className="muted">{fmtTime(v.first_seen, true)}</td>
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
    case 'retention':
      return <RetentionTable r={p} compact />;
    case 'events':
      return (
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
      );
  }
  return null;
}

export function FunnelTable({ steps }) {
  return (
    <table className="dt">
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
                  <div className="bf" style={{ width: `${s.pct_of_first || 0}%`, background: '#14213d' }} />
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
                      <div className="bf" style={{ width: `${l.completion_pct || 0}%`, background: l.completion_pct < 50 ? '#ff6b57' : '#14213d' }} />
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

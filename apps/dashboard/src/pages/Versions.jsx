// Versions: did a release make the game better, in the terms this game cares about? First the stats on
// its boards, then its own events per session, then the built-in measures it has data for (frame time only
// for games that send frames, level completion only for games with levels).
import { useEffect, useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, Status, BarList } from '../components.jsx';
import { fmtNum, fmtMs, fmtPct, fmtTime, fmtDuration, fmtMoney, frameStatus, PALETTE } from '../format.js';
import { NoGame } from './Overview.jsx';
import { CsvButton, columnHeader } from '../csv.jsx';

// `needs` names what the game has to report for the measure to mean anything (the query's `has`).
const METRICS = [
  { key: 'frame_p95', label: 'p95 frame time', fmt: (v) => fmtMs(v), lowerIsBetter: true, needs: 'frames' },
  { key: 'frame_p99', label: 'p99 frame time', fmt: (v) => fmtMs(v), lowerIsBetter: true, needs: 'frames' },
  { key: 'hitches_per_min', label: 'Hitches / min', fmt: (v) => fmtNum(v, 2), lowerIsBetter: true, needs: 'frames' },
  { key: 'draw_calls', label: 'Draw calls (avg)', fmt: (v) => fmtNum(v), lowerIsBetter: true, needs: 'frames' },
  { key: 'render_cpu_ms', label: 'Render CPU / frame', fmt: (v) => fmtMs(v, 2), lowerIsBetter: true, needs: 'frames' },
  { key: 'avg_session_s', label: 'Average session', fmt: (v) => fmtDuration(v), lowerIsBetter: null },
  { key: 'error_free_pct', label: 'Error-free sessions', fmt: (v) => fmtPct(v), lowerIsBetter: false },
  { key: 'crash_free_pct', label: 'Crash-free sessions', fmt: (v) => fmtPct(v), lowerIsBetter: false },
  { key: 'errors_per_session', label: 'Errors / session', fmt: (v) => fmtNum(v, 2), lowerIsBetter: true },
  { key: 'level_completion_pct', label: 'Level completion', fmt: (v) => fmtPct(v), lowerIsBetter: false, needs: 'levels' },
  { key: 'rage_quit_pct', label: 'Rage-quit rate', fmt: (v) => fmtPct(v), lowerIsBetter: true, needs: 'rage' },
  { key: 'deaths_per_session', label: 'Deaths / session', fmt: (v) => fmtNum(v, 1), lowerIsBetter: true, needs: 'deaths' },
  { key: 'geometries_growth_per_level_load', label: 'Geometry growth / level load', fmt: (v) => fmtNum(v), lowerIsBetter: true, needs: 'geometry' },
];

function fmtStat(v, unit, currency) {
  if (v == null) return '–';
  if (currency) return fmtMoney(v, currency);
  if (unit === '%') return fmtPct(v);
  if (unit === 'ms') return fmtMs(v);
  if (unit === 's') return fmtDuration(v);
  return fmtNum(v, Number.isInteger(v) ? 0 : 2);
}

export function Versions() {
  const f = useFilters();
  const { data } = useQuery('versions', { ...f.params, version: '' }, { refreshMs: f.live ? 15000 : 0, enabled: !!f.service });
  // (respects $session_type, so bot-vs-bot comparisons stay like-for-like)
  const list = data?.versions || [];
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  useEffect(() => {
    if (list.length >= 2 && !a && !b) {
      setA(list.at(-2).version);
      setB(list.at(-1).version);
    }
  }, [list, a, b]);
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const has = { ...(data.has || {}), rage: data.has?.deaths || data.has?.fails };
  const board = data.board || [];
  const events = Object.keys(list[0]?.events || {});
  const builtins = METRICS.filter((m) => (!m.needs || has[m.needs]) && list.some((v) => v[m.key] != null));
  const va = list.find((v) => v.version === a);
  const vb = list.find((v) => v.version === b);
  const levels = has.frames ? [...new Set(list.flatMap((v) => Object.keys(v.level_p95 || {})))].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })) : [];
  const rows = [
    ...(board.length ? [{ section: "This game's boards" }] : []),
    ...board.map((s, i) => ({ key: `board${i}`, label: s.unit?.startsWith('per ') && !s.per ? `${s.title} (${s.unit})` : s.title, csv: columnHeader(s), get: (v) => v.board?.[i], fmt: (x) => fmtStat(x, s.unit, s.currency), lowerIsBetter: null })),
    ...(events.length ? [{ section: 'Its events, per session' }] : []),
    ...events.map((name) => ({ key: `ev:${name}`, label: name, get: (v) => v.events?.[name], fmt: (x) => fmtNum(x, 2), lowerIsBetter: null })),
    ...(builtins.length ? [{ section: 'Built in' }] : []),
    ...builtins.map((m) => ({ ...m, get: (v) => v[m.key] })),
  ];

  return (
    <div className="grid">
      <Widget
        span={12}
        title="Versions"
        sub="every build that reported in this range"
        flush
        actions={
          <CsvButton
            name="versions"
            rows={() => [
              ['Version', 'First seen', 'Sessions', ...board.slice(0, 4).map(columnHeader), ...(has.frames ? ['p95 frame (ms)'] : []), 'Error-free %', ...(has.levels ? ['Level completion %'] : []), ...(has.rage ? ['Rage quits %'] : [])],
              ...list.map((v) => [v.version, new Date(v.first_seen).toISOString(), v.sessions, ...board.slice(0, 4).map((s, i) => v.board?.[i]), ...(has.frames ? [v.frame_p95] : []), v.error_free_pct, ...(has.levels ? [v.level_completion_pct] : []), ...(has.rage ? [v.rage_quit_pct] : [])]),
            ]}
          />
        }
      >
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Version</th>
                <th>First seen</th>
                <th className="num">Sessions</th>
                {board.slice(0, 4).map((s) => (
                  <th className="num" key={s.title}>
                    {s.title}
                  </th>
                ))}
                {has.frames && <th className="num">p95 frame</th>}
                <th className="num">Error-free</th>
                {has.levels && <th className="num">Level completion</th>}
                {has.rage && <th className="num">Rage quits</th>}
              </tr>
            </thead>
            <tbody>
              {list.map((v) => (
                <tr key={v.version}>
                  <td>
                    <span className="tag" style={{ fontWeight: 700 }}>
                      {v.version}
                    </span>
                  </td>
                  <td className="muted">{fmtTime(v.first_seen, true)}</td>
                  <td className="num">{fmtNum(v.sessions)}</td>
                  {board.slice(0, 4).map((s, i) => (
                    <td className="num" key={s.title}>
                      {fmtStat(v.board?.[i], s.unit, s.currency)}
                    </td>
                  ))}
                  {has.frames && (
                    <td className="num">
                      <Status kind={frameStatus(v.frame_p95)}>{fmtMs(v.frame_p95)}</Status>
                    </td>
                  )}
                  <td className="num">{fmtPct(v.error_free_pct)}</td>
                  {has.levels && <td className="num">{fmtPct(v.level_completion_pct)}</td>}
                  {has.rage && <td className="num">{fmtPct(v.rage_quit_pct)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
      <Widget
        span={levels.length ? 7 : 12}
        title="Compare versions"
        sub="what changed between two builds, in this game's own numbers first"
        actions={
          <>
            {va && vb && (
              <CsvButton
                name={`compare-${a}-${b}`}
                rows={() => [['Measure', a, b, 'Change'], ...rows.filter((m) => !m.section).map((m) => [m.csv ?? m.label, m.get(va), m.get(vb), m.get(va) != null && m.get(vb) != null ? Math.round((m.get(vb) - m.get(va)) * 1000) / 1000 : null])]}
              />
            )}
            <select value={a} onChange={(e) => setA(e.target.value)} className="btn">
              {list.map((v) => (
                <option key={v.version}>{v.version}</option>
              ))}
            </select>
            <span className="muted">→</span>
            <select value={b} onChange={(e) => setB(e.target.value)} className="btn">
              {list.map((v) => (
                <option key={v.version}>{v.version}</option>
              ))}
            </select>
          </>
        }
        flush
      >
        {va && vb ? (
          <table className="dt">
            <thead>
              <tr>
                <th>Measure</th>
                <th className="num">{a}</th>
                <th className="num">{b}</th>
                <th className="num">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                if (m.section)
                  return (
                    <tr key={m.section} className="section">
                      <td colSpan={4}>{m.section}</td>
                    </tr>
                  );
                const x = m.get(va);
                const y = m.get(vb);
                const d = x != null && y != null ? y - x : null;
                const rel = d != null && x ? (d / Math.abs(x)) * 100 : null;
                // The game's own numbers have no "better" direction we can know: the change is shown, not judged.
                const good = d == null || Math.abs(d) < 1e-9 || m.lowerIsBetter == null ? null : m.lowerIsBetter ? d < 0 : d > 0;
                const change = d == null || Math.abs(d) < 1e-9 ? null : `${d > 0 ? '▲' : '▼'} ${rel != null && Math.abs(rel) < 1000 ? `${Math.abs(rel).toFixed(0)}%` : m.fmt(Math.abs(d))}`;
                return (
                  <tr key={m.key}>
                    <td>{m.label}</td>
                    <td className="num">{m.fmt(x)}</td>
                    <td className="num">
                      <b>{m.fmt(y)}</b>
                    </td>
                    <td className="num">{change == null ? <span className="muted">–</span> : good == null ? change : <Status kind={good ? 'ok' : 'alert'}>{change}</Status>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty">Ship a second version to compare. Bump the version you pass to Glitchless.init().</div>
        )}
      </Widget>
      {levels.length > 0 && (
        <Widget span={5} title="p95 frame time by level and version">
          {levels.map((l) => (
            <div key={l} style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>{l}</div>
              <BarList rows={list.map((v, i) => ({ label: v.version, value: v.level_p95?.[l] ?? 0, display: fmtMs(v.level_p95?.[l]), color: PALETTE[i % PALETTE.length] }))} max={Math.max(40, ...list.map((v) => v.level_p95?.[l] || 0))} />
            </div>
          ))}
        </Widget>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, Status, BarList } from '../components.jsx';
import { fmtNum, fmtMs, fmtPct, fmtTime, frameStatus, PALETTE } from '../format.js';
import { NoGame } from './Overview.jsx';

const METRICS = [
  { key: 'frame_p95', label: 'p95 frame time', fmt: (v) => fmtMs(v), lowerIsBetter: true },
  { key: 'frame_p99', label: 'p99 frame time', fmt: (v) => fmtMs(v), lowerIsBetter: true },
  { key: 'hitches_per_min', label: 'Hitches / min', fmt: (v) => fmtNum(v, 2), lowerIsBetter: true },
  { key: 'draw_calls', label: 'Draw calls (avg)', fmt: (v) => fmtNum(v), lowerIsBetter: true },
  { key: 'render_cpu_ms', label: 'Render CPU / frame', fmt: (v) => fmtMs(v, 2), lowerIsBetter: true },
  { key: 'error_free_pct', label: 'Error-free sessions', fmt: (v) => fmtPct(v), lowerIsBetter: false },
  { key: 'crash_free_pct', label: 'Crash-free sessions', fmt: (v) => fmtPct(v), lowerIsBetter: false },
  { key: 'errors_per_session', label: 'Errors / session', fmt: (v) => fmtNum(v, 2), lowerIsBetter: true },
  { key: 'level_completion_pct', label: 'Level completion', fmt: (v) => fmtPct(v), lowerIsBetter: false },
  { key: 'rage_quit_pct', label: 'Rage-quit rate', fmt: (v) => fmtPct(v), lowerIsBetter: true },
  { key: 'deaths_per_session', label: 'Deaths / session', fmt: (v) => fmtNum(v, 1), lowerIsBetter: true },
  { key: 'geometries_growth_per_level_load', label: 'Geometry growth / level load', fmt: (v) => fmtNum(v), lowerIsBetter: true },
];

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
  const va = list.find((v) => v.version === a);
  const vb = list.find((v) => v.version === b);
  const levels = [...new Set(list.flatMap((v) => Object.keys(v.level_p95 || {})))].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));

  return (
    <div className="grid">
      <Widget span={12} title="Versions" sub="every build that reported telemetry in this range" flush>
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Version</th>
                <th>First seen</th>
                <th className="num">Sessions</th>
                <th className="num">p95 frame</th>
                <th className="num">Hitches/min</th>
                <th className="num">Error-free</th>
                <th className="num">Level completion</th>
                <th className="num">Rage quits</th>
                <th className="num">Geo growth / load</th>
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
                  <td className="num">
                    <Status kind={frameStatus(v.frame_p95)}>{fmtMs(v.frame_p95)}</Status>
                  </td>
                  <td className="num">{fmtNum(v.hitches_per_min, 2)}</td>
                  <td className="num">{fmtPct(v.error_free_pct)}</td>
                  <td className="num">{fmtPct(v.level_completion_pct)}</td>
                  <td className="num">{fmtPct(v.rage_quit_pct)}</td>
                  <td className="num">{fmtNum(v.geometries_growth_per_level_load)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
      <Widget
        span={7}
        title="Compare versions"
        actions={
          <>
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
                <th>Metric</th>
                <th className="num">{a}</th>
                <th className="num">{b}</th>
                <th className="num">Change</th>
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => {
                const x = va[m.key];
                const y = vb[m.key];
                const d = x != null && y != null ? y - x : null;
                const rel = d != null && x ? (d / Math.abs(x)) * 100 : null;
                const good = d == null || Math.abs(d) < 1e-9 ? null : m.lowerIsBetter ? d < 0 : d > 0;
                return (
                  <tr key={m.key}>
                    <td>{m.label}</td>
                    <td className="num">{m.fmt(x)}</td>
                    <td className="num">
                      <b>{m.fmt(y)}</b>
                    </td>
                    <td className="num">{good == null ? <span className="muted">–</span> : <Status kind={good ? 'ok' : 'alert'}>{`${d > 0 ? '▲' : '▼'} ${rel != null && Math.abs(rel) < 1000 ? `${Math.abs(rel).toFixed(0)}%` : m.fmt(Math.abs(d))}`}</Status>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty">Ship a second version to compare. Bump the `version` you pass to Glitchless.init().</div>
        )}
      </Widget>
      <Widget span={5} title="p95 frame time by level and version">
        {levels.map((l) => (
          <div key={l} style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>{l}</div>
            <BarList rows={list.map((v, i) => ({ label: v.version, value: v.level_p95?.[l] ?? 0, display: fmtMs(v.level_p95?.[l]), color: PALETTE[i % PALETTE.length] }))} max={Math.max(40, ...list.map((v) => v.level_p95?.[l] || 0))} />
          </div>
        ))}
      </Widget>
    </div>
  );
}

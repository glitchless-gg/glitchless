import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { useShell } from '../shell.js';
import { Widget, QueryValue, TimeSeries, BarList, Findings, Empty, Status, Sparkline, GroupTitle } from '../components.jsx';
import { fmtNum, fmtMs, fmtPct, fmtDuration, frameStatus, pctStatus, timeAgo } from '../format.js';

export function NoGame() {
  const { setupLink } = useShell();
  return (
    <Empty title="No games reporting yet">
      Add the SDK to a Three.js game and play a level. <a href={setupLink.href}>{setupLink.label}</a>
    </Empty>
  );
}

export function Overview() {
  const f = useFilters();
  const { data } = useQuery('overview', f.params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const k = data.kpis || {};
  const s = data.series || {};
  const budget = k.frame_budget_ms || 16.67;
  const markers = (data.deployments || []).map((d) => ({ ts: d.ts, label: `v${d.version}` }));
  const investigate = (link) => f.go(link.fingerprint ? `errors/${link.fingerprint}` : `${link.page}${link.level ? `?level=${encodeURIComponent(link.level)}` : ''}`);

  return (
    <div className="grid">
      <QueryValue label="Sessions" value={fmtNum(k.sessions)} sub={`${fmtNum(k.players)} players${k.synthetic_sessions ? ` · ${k.synthetic_sessions} bots` : ''}${k.simulated_sessions ? ` · ${k.simulated_sessions} simulated` : ''}`} />
      <QueryValue label="Crash-free sessions" value={fmtPct(k.crash_free_pct)} status={pctStatus(k.crash_free_pct, 99.9, 99)} sub={`${fmtPct(k.error_free_pct)} error-free`} />
      <QueryValue label="p95 frame time" value={k.frame_p95 != null ? k.frame_p95.toFixed(1) : null} unit="ms" status={frameStatus(k.frame_p95, budget)} sub={`budget ${budget.toFixed(1)}ms · p99 ${fmtMs(k.frame_p99)}`} />
      <QueryValue label="Frames over budget" value={fmtPct(k.pct_frames_over_budget)} status={pctStatus(k.pct_frames_over_budget, 5, 15, false)} sub={`${fmtNum(k.avg_fps, 1)} avg fps`} />
      <QueryValue label="Hitches / min" value={fmtNum(k.hitches_per_min, 2)} status={pctStatus(k.hitches_per_min, 1, 4, false)} sub="frames > 50ms" />
      <QueryValue label="Rage quits" value={fmtPct(k.rage_quit_pct)} status={pctStatus(k.rage_quit_pct, 5, 12, false)} sub={`${fmtNum(k.rage_quits)} sessions · avg ${fmtDuration(k.avg_session_s)}`} />

      <Widget span={8} title="Frame time" sub="merged across all players · p50 / p95 / p99">
        <TimeSeries
          ts={s.ts}
          height={330}
          unit="ms"
          series={[
            { label: 'p50', values: s.p50, color: '#3d8cf5' },
            { label: 'p95', values: s.p95, color: '#14213d', width: 2 },
            { label: 'p99', values: s.p99, color: '#ff6b57', dash: [4, 3] },
          ]}
          thresholds={[{ value: budget, color: '#1fae84', label: `${Math.round(1000 / budget)}fps budget` }]}
          markers={markers}
        />
      </Widget>
      <Widget
        span={4}
        title={
          <span className="findings-head">Findings</span>
        }
        actions={<a href="#/agents">Ask an agent →</a>}
      >
        <Findings findings={data.findings} compact onOpen={investigate} />
      </Widget>

      <Widget span={4} title="Players & sessions">
        <TimeSeries
          ts={s.ts}
          height={150}
          series={[
            { label: 'active players', values: s.players, color: '#14213d', fill: 'rgba(20,33,61,.08)' },
            { label: 'sessions started', values: s.sessions, color: '#3d8cf5' },
          ]}
          markers={markers}
        />
      </Widget>
      <Widget span={4} title="Errors, hitches & deaths">
        <TimeSeries
          ts={s.ts}
          height={150}
          bars
          series={[
            { label: 'errors', values: s.errors, color: '#ff6b57' },
            { label: 'hitches', values: s.hitches, color: '#f2a93b' },
          ]}
        />
      </Widget>
      <Widget span={4} title="Level funnel" sub="sessions that started vs completed" actions={<a href="#/players">Details →</a>}>
        <BarList
          rows={(data.funnel || []).map((l) => ({
            label: l.level,
            segments: [
              { label: 'completed', value: l.completed, color: '#14213d' },
              { label: 'did not finish', value: Math.max(0, l.sessions - l.completed), color: '#e9e3f6' },
            ],
            display: fmtPct(l.completion_pct, 0),
          }))}
        />
      </Widget>

      <GroupTitle>Stability</GroupTitle>
      <Widget span={12} title="Top issues" actions={<a href="#/errors">Error Tracking →</a>} flush>
        <IssuesTable issues={data.top_errors} onClick={(i) => f.go(`errors/${i.fingerprint}`)} />
      </Widget>
    </div>
  );
}

export function IssuesTable({ issues, onClick, selected }) {
  if (!issues?.length) return <div className="empty">No errors in this time range.</div>;
  return (
    <div className="tablewrap">
      <table className="dt">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Levels</th>
            <th className="num">Count</th>
            <th className="num">Sessions</th>
            <th>Trend</th>
            <th>Versions</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i) => (
            <tr key={i.fingerprint} className={`click ${selected === i.fingerprint ? 'sel' : ''}`} onClick={() => onClick?.(i)}>
              <td style={{ maxWidth: 460 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Status kind={i.fatal ? 'alert' : 'warn'}>{i.kind}</Status>
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.message}</b>
                </div>
                <div className="muted mono" style={{ fontSize: 11.5, marginTop: 2 }}>
                  {i.location}
                </div>
              </td>
              <td>{i.levels.map((l) => <span className="tag" key={l}>{l}</span>)}</td>
              <td className="num">{fmtNum(i.count)}</td>
              <td className="num">
                {fmtNum(i.sessions)} <span className="muted">({fmtPct(i.sessions_pct, 0)})</span>
              </td>
              <td>
                <Sparkline values={i.series} />
              </td>
              <td>{i.versions.map((v) => <span className="tag" key={v}>{v}</span>)}</td>
              <td className="muted">{timeAgo(i.last_seen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

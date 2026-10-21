import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, BarList, Status, GroupTitle } from '../components.jsx';
import { fmtNum, fmtPct, fmtDuration, pctStatus, timeAgo, colorFor } from '../format.js';
import { NoGame } from './Overview.jsx';

export function Players({ route }) {
  const f = useFilters();
  const focus = route.query.get('level');
  const { data } = useQuery('players', f.params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const k = data.kpis;
  const funnel = data.funnel || [];
  const causes = Object.keys(Object.assign({}, ...funnel.map((l) => l.death_causes)));
  return (
    <div className="grid">
      <QueryValue label="Players" value={fmtNum(k.players)} sub={`${fmtNum(k.sessions_per_player, 1)} sessions / player`} />
      <QueryValue label="Returning players" value={fmtPct(k.returning_players_pct)} sub="played on 2+ days" />
      <QueryValue label="Median session" value={fmtDuration(k.median_session_s)} sub={`avg ${fmtDuration(k.avg_session_s)}`} />
      <QueryValue label="Rage quits" value={fmtPct(k.rage_quit_pct)} status={pctStatus(k.rage_quit_pct, 5, 12, false)} sub={`${fmtNum(k.rage_quits)} quit ≤20s after dying`} />
      <QueryValue label="Rage inputs" value={fmtNum(k.rage_inputs)} sub="same key mashed ≥4× in 1s" status={k.rage_inputs > 50 ? 'warn' : 'neutral'} />
      <QueryValue label="Sessions" value={fmtNum(k.sessions)} />

      <Widget span={12} title="Level funnel" sub="per level: who started, who finished, and what stopped them" flush>
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Level</th>
                <th style={{ width: '28%' }}>Completion</th>
                <th className="num">Sessions</th>
                <th className="num">Attempts</th>
                <th className="num">Deaths / session</th>
                <th>Death causes</th>
                <th className="num">Avg clear time</th>
                <th className="num">Rage quits</th>
              </tr>
            </thead>
            <tbody>
              {funnel.map((l) => (
                <tr key={l.level} className={`click ${focus === l.level ? 'sel' : ''}`} onClick={() => f.go(`heatmaps?level=${encodeURIComponent(l.level)}`)}>
                  <td>
                    <b>{l.level}</b>
                  </td>
                  <td>
                    <div className="barrow" style={{ gridTemplateColumns: '1fr 56px' }}>
                      <div className="bt">
                        <div className="bf" style={{ width: `${l.completion_pct || 0}%`, background: l.completion_pct < 50 ? '#ff6b57' : l.completion_pct < 75 ? '#f2a93b' : '#14213d' }} />
                      </div>
                      <div className="bv">{fmtPct(l.completion_pct, 0)}</div>
                    </div>
                  </td>
                  <td className="num">{fmtNum(l.sessions)}</td>
                  <td className="num">{fmtNum(l.attempts)}</td>
                  <td className="num">{fmtNum(l.deaths_per_session, 1)}</td>
                  <td>
                    {Object.entries(l.death_causes)
                      .sort((a, b) => b[1] - a[1])
                      .map(([c, n]) => (
                        <span className="tag" key={c} style={{ borderLeft: `3px solid ${colorFor(c, 0)}` }}>
                          {c} {n}
                        </span>
                      ))}
                  </td>
                  <td className="num">{fmtDuration(l.avg_complete_s)}</td>
                  <td className="num">
                    <Status kind={pctStatus(l.rage_quit_pct, 5, 12, false)}>
                      {fmtNum(l.rage_quits)} · {fmtPct(l.rage_quit_pct, 0)}
                    </Status>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>

      <Widget span={6} title="Deaths by level & cause" actions={<a href="#/heatmaps">Heatmaps →</a>}>
        <BarList rows={funnel.map((l) => ({ label: l.level, segments: causes.map((c, i) => ({ label: c, value: l.death_causes[c] || 0, color: colorFor(c, i) })) }))} />
        <div className="legend" style={{ marginTop: 8 }}>
          {causes.map((c, i) => (
            <span key={c}>
              <i style={{ background: colorFor(c, i) }} />
              {c}
            </span>
          ))}
        </div>
      </Widget>
      <Widget span={6} title="Session length">
        <BarList rows={data.session_length.labels.map((label, i) => ({ label, value: data.session_length.counts[i], color: '#3d8cf5' }))} />
      </Widget>

      <GroupTitle>Rage quits</GroupTitle>
      <Widget span={12} title="Recent rage quits" sub="sessions that ended within 20s of a death, without continuing" flush>
        <div className="tablewrap" style={{ maxHeight: 300 }}>
          <table className="dt">
            <thead>
              <tr>
                <th>When</th>
                <th>Level</th>
                <th>Cause</th>
                <th className="num">Position</th>
                <th>Version</th>
                <th>Session</th>
              </tr>
            </thead>
            <tbody>
              {data.rage_quits.map((r) => (
                <tr key={r.session_id} className="click" onClick={() => f.go(`sessions/${r.session_id}`)}>
                  <td className="muted">{timeAgo(r.ts)}</td>
                  <td>{r.level}</td>
                  <td>
                    <span className="tag">{r.cause}</span>
                  </td>
                  <td className="num mono">{r.x != null ? `x=${r.x.toFixed(1)}` : '–'}</td>
                  <td>
                    <span className="tag">{r.version}</span>
                  </td>
                  <td className="mono muted">{r.session_id.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
    </div>
  );
}

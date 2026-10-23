import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, BarList, Status, GroupTitle } from '../components.jsx';
import { fmtNum, fmtPct, fmtDuration, pctStatus, timeAgo, colorFor, causeColor } from '../format.js';
import { NoGame } from './Overview.jsx';
import { CsvButton, retentionCsv } from '../csv.jsx';

// What a game in anonymous mode sees instead of retention: why it is missing, and the one setting that turns it on.
export function RetentionOff() {
  return (
    <div className="why">
      Nobody can be seen coming back: this game sends no player IDs, so every session counts as a new player. Turn on install mode to see D1, D7 and D30: <code>privacy: 'install'</code> in <code>Glitchless.init</code> (Godot <code>"privacy": "install"</code>, Unity <code>Privacy.Install</code>, Unreal Install). Each device then keeps a random ID, not tied to any account.
    </div>
  );
}

// Cohorts by the day players were first seen, D1, D7 and D30 as the share of the cohort that played that day; a dash
// until that day has ended inside the range.
export function RetentionTable({ r, compact = false }) {
  const days = ['d1', 'd7', 'd30'];
  const cell = (c, d) => {
    const v = c[d];
    if (v == null) return <td className="num muted" key={d} title="that day has not ended in this range">–</td>;
    return (
      <td className="num ret" key={d} style={{ background: `rgba(31, 174, 132, ${Math.min(0.08 + v / 100, 0.9)})` }} title={`${fmtNum(c.returned[d])} of ${fmtNum(c.players)}`}>
        {fmtPct(v, 0)}
      </td>
    );
  };
  const waiting = days.every((d) => r[d] == null);
  return (
    <div className="tablewrap" style={{ maxHeight: compact ? 320 : 420 }}>
      <table className="dt">
        <thead>
          <tr>
            <th>First seen</th>
            <th className="num">New players</th>
            <th className="num">D1</th>
            <th className="num">D7</th>
            <th className="num">D30</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <b>All cohorts</b>
            </td>
            <td className="num">
              <b>{fmtNum(r.new_players)}</b>
            </td>
            {days.map((d) => (
              <td className="num" key={d}>
                <b>{fmtPct(r[d], 1)}</b>
              </td>
            ))}
          </tr>
          {[...r.cohorts].reverse().map((c) => (
            <tr key={c.day}>
              <td className="mono">{c.day}</td>
              <td className="num">{fmtNum(c.players)}</td>
              {days.map((d) => cell(c, d))}
            </tr>
          ))}
        </tbody>
      </table>
      {(waiting || r.id_sessions_pct < 100) && (
        <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
          {waiting ? 'D1 needs a range that covers the day after a cohort; pick 8 days or more for D7 and 31 for D30. ' : ''}
          {r.id_sessions_pct < 100 ? `Counted over the ${fmtPct(r.id_sessions_pct, 0)} of sessions that sent a player ID.` : ''}
        </div>
      )}
    </div>
  );
}

export function Players({ route }) {
  const f = useFilters();
  const focus = route.query.get('level');
  const { data } = useQuery('players', f.params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const k = data.kpis;
  const funnel = data.funnel || [];
  const causes = Object.keys(Object.assign({}, ...funnel.map((l) => l.death_causes)));
  // Sections only for what this game reports: a puzzle or farming game has no deaths, so no death columns
  // or rage quits (quitting right after dying).
  const deaths = funnel.some((l) => l.deaths);
  const rage = deaths || funnel.some((l) => l.fails) || k.rage_quits > 0;
  const times = funnel.some((l) => l.avg_complete_s != null);
  const r = data.retention;
  // Anonymous sessions are each their own player, so "returning" would read 0%: say what it needs instead.
  const anonymous = r?.status === 'anonymous';
  return (
    <div className="grid">
      <QueryValue label="Players" value={fmtNum(k.players)} sub={`${fmtNum(k.sessions_per_player, 1)} sessions / player`} />
      <QueryValue label="Returning players" value={anonymous ? null : fmtPct(k.returning_players_pct)} sub={anonymous ? 'needs install mode' : 'played on 2+ days'} />
      <QueryValue label="Median session" value={fmtDuration(k.median_session_s)} sub={`avg ${fmtDuration(k.avg_session_s)}`} />
      {rage && <QueryValue label="Rage quits" value={fmtPct(k.rage_quit_pct)} status={pctStatus(k.rage_quit_pct, 5, 12, false)} sub={`${fmtNum(k.rage_quits)} quit ≤20s after dying or failing`} />}
      {k.rage_inputs > 0 && <QueryValue label="Rage inputs" value={fmtNum(k.rage_inputs)} sub="same key mashed ≥4× in 1s" status={k.rage_inputs > 50 ? 'warn' : 'neutral'} />}
      <QueryValue label="Sessions" value={fmtNum(k.sessions)} />

      {funnel.length > 0 && (
      <Widget
        span={12}
        title="Level funnel"
        sub="per level: who started, who finished, and what stopped them"
        flush
        actions={
          <CsvButton
            name="level-funnel"
            rows={() => [
              ['Level', 'Completion %', 'Sessions', 'Attempts', ...(deaths ? ['Deaths / session', 'Death causes'] : []), ...(times ? ['Avg clear time (s)'] : []), ...(rage ? ['Rage quits', 'Rage quits %'] : [])],
              ...funnel.map((l) => [
                l.level,
                l.completion_pct,
                l.sessions,
                l.attempts,
                ...(deaths
                  ? [
                      l.deaths_per_session,
                      Object.entries(l.death_causes)
                        .sort((a, b) => b[1] - a[1])
                        .map(([c, n]) => `${c} ${n}`)
                        .join('; '),
                    ]
                  : []),
                ...(times ? [l.avg_complete_s] : []),
                ...(rage ? [l.rage_quits, l.rage_quit_pct] : []),
              ]),
            ]}
          />
        }
      >
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Level</th>
                <th style={{ width: '28%' }}>Completion</th>
                <th className="num">Sessions</th>
                <th className="num">Attempts</th>
                {deaths && <th className="num">Deaths / session</th>}
                {deaths && <th>Death causes</th>}
                {times && <th className="num">Avg clear time</th>}
                {rage && <th className="num">Rage quits</th>}
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
                  {deaths && <td className="num">{fmtNum(l.deaths_per_session, 1)}</td>}
                  {deaths && <td>
                    {Object.entries(l.death_causes)
                      .sort((a, b) => b[1] - a[1])
                      .map(([c, n]) => (
                        <span className="tag" key={c} style={{ borderLeft: `3px solid ${causeColor(c)}` }}>
                          {c} {n}
                        </span>
                      ))}
                  </td>}
                  {times && <td className="num">{fmtDuration(l.avg_complete_s)}</td>}
                  {rage && <td className="num">
                    <Status kind={pctStatus(l.rage_quit_pct, 5, 12, false)}>
                      {fmtNum(l.rage_quits)} · {fmtPct(l.rage_quit_pct, 0)}
                    </Status>
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
      )}

      {deaths && (
      <Widget span={6} title="Deaths by level & cause" actions={<a href="#/heatmaps">Heatmaps →</a>}>
        <BarList rows={funnel.map((l) => ({ label: l.level, segments: causes.map((c) => ({ label: c, value: l.death_causes[c] || 0, color: causeColor(c) })) }))} />
        <div className="legend" style={{ marginTop: 8 }}>
          {causes.map((c, i) => (
            <span key={c}>
              <i style={{ background: causeColor(c) }} />
              {c}
            </span>
          ))}
        </div>
      </Widget>
      )}
      <Widget span={6} title="Session length">
        <BarList rows={data.session_length.labels.map((label, i) => ({ label, value: data.session_length.counts[i], color: '#3d8cf5' }))} />
      </Widget>

      {r && r.status !== 'empty' && (
        <Widget span={12} title="Retention" sub="of the players first seen each day, the share who played again 1, 7 and 30 days later" flush={!anonymous && r.cohorts.length > 0} actions={!anonymous && r.cohorts.length > 0 && <CsvButton name="retention" rows={() => retentionCsv(r)} />}>
          {anonymous ? <RetentionOff /> : r.cohorts.length ? <RetentionTable r={r} /> : <div className="why">No new players in this window. A cohort is the day players were first seen.</div>}
        </Widget>
      )}

      {data.rage_quits.length > 0 && (
      <>
      <GroupTitle>Rage quits</GroupTitle>
      <Widget
        span={12}
        title="Recent rage quits"
        sub="sessions that ended within 20s of a death or failed level, without continuing"
        flush
        actions={<CsvButton name="rage-quits" rows={() => [['When', 'Level', 'Cause', 'x', 'y', 'z', 'Version', 'Session'], ...data.rage_quits.map((r) => [new Date(r.ts).toISOString(), r.level, r.cause, r.x, r.y, r.z, r.version, r.session_id])]} />}
      >
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
      </>
      )}
    </div>
  );
}

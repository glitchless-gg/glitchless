import { useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, Segmented, Status, Empty } from '../components.jsx';
import { LevelMap } from '../heatmap.jsx';
import { fmtNum, fmtPct, causeColor, pctStatus } from '../format.js';
import { NoGame } from './Overview.jsx';

export function Heatmaps({ route }) {
  const f = useFilters();
  const [level, setLevel] = useState(route.query.get('level') || '');
  const [layer, setLayer] = useState('both');
  const [zoom, setZoom] = useState(1);
  const { data } = useQuery('heatmap', { ...f.params, level }, { refreshMs: f.live ? 15000 : 0, enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const lvl = data.level;
  const st = data.stats || {};
  // Heatmaps need positions (setPosition) or placed deaths; many games (puzzles, menus, card games) have neither.
  if (!(data.levels || []).length && !data.density?.samples && !(data.deaths || []).length) {
    return (
      <Empty title="No positions from this game">
        Heatmaps show where players go and where they die in a level. They need the game to send positions with <code>setPosition</code>, which only makes sense for games with a world to move through. The board and Events pages cover everything else.
      </Empty>
    );
  }
  const deaths = st.deaths > 0;
  return (
    <div className="grid">
      <Widget
        span={12}
        title={`${lvl || 'Level'}: where players go${deaths ? ', and where they die' : ''}`}
        sub={data.map ? `map captured in-game by glitchless.captureMap() · ${data.axis === 'xy' ? 'side view' : 'top-down'}` : 'no map captured — showing positions only'}
        actions={
          <>
            <Segmented value={lvl} onChange={(v) => setLevel(v)} options={(data.levels || []).map((l) => ({ value: l, label: l }))} />
            <Segmented
              value={layer}
              onChange={setLayer}
              options={[
                { value: 'both', label: 'All layers' },
                { value: 'density', label: 'Movement' },
                { value: 'deaths', label: 'Deaths' },
              ]}
            />
            <Segmented value={zoom} onChange={setZoom} options={[{ value: 1, label: '1×' }, { value: 2, label: '2×' }, { value: 3, label: '3×' }]} />
          </>
        }
      >
        <LevelMap map={data.map} bounds={data.bounds} axis={data.axis} density={data.density} deaths={data.deaths} hotspots={data.hotspots} zoom={zoom} showDensity={layer !== 'deaths'} showDeaths={layer !== 'density'} />
        <div className="legend" style={{ marginTop: 8 }}>
          {/* Only what this level has: its own death causes, rage quits and time spent. */}
          {[...new Set((data.deaths || []).map((d) => d.cause))].map((c) => (
            <span key={c ?? 'none'}>
              <i style={{ background: causeColor(c), height: 8, width: 8, borderRadius: 4 }} />
              death: {c ?? 'no cause'}
            </span>
          ))}
          {(data.hotspots || []).some((h) => h.rage_quits) && (
            <span>
              <i style={{ background: '#ff4fa3', height: 8, width: 8, borderRadius: 4 }} />
              rage quit
            </span>
          )}
          {data.density?.samples > 0 && (
            <span>
              <i style={{ background: 'linear-gradient(90deg,#5b2ca6,#e0437a,#ffc440)', width: 30 }} />
              time spent (log)
            </span>
          )}
        </div>
      </Widget>
      {st.no_win ? (
        // A run is a start of the level (or, for a game that never sends starts, a death that ends one).
        <QueryValue span={3} label="Runs" value={fmtNum(st.attempts || st.deaths)} sub={`in ${fmtNum(st.sessions)} sessions; nobody wins`} />
      ) : (
        <QueryValue span={3} label="Completion rate" value={fmtPct(st.completion_pct, 0)} status={pctStatus(st.completion_pct, 75, 50)} sub={`${fmtNum(st.completed)} of ${fmtNum(st.sessions)} sessions`} />
      )}
      {deaths && <QueryValue span={3} label="Deaths" value={fmtNum(st.deaths)} sub={`${fmtNum(st.deaths_per_session, 1)} per session`} />}
      {deaths && <QueryValue span={3} label="Rage quits here" value={fmtNum(st.rage_quits)} status={pctStatus(st.rage_quit_pct, 5, 12, false)} sub={`${fmtPct(st.rage_quit_pct)} of sessions`} />}
      <QueryValue span={3} label="Position samples" value={fmtNum(data.density?.samples)} sub="4 Hz per player" />
      {deaths && (
      <Widget span={12} title="Death hotspots" sub="where deaths cluster on this level" flush>
        <table className="dt">
          <thead>
            <tr>
              <th>#</th>
              <th>Where</th>
              <th className="num">Deaths</th>
              <th className="num">Share of level deaths</th>
              <th>Top cause</th>
              <th className="num">Rage quits</th>
            </tr>
          </thead>
          <tbody>
            {(data.hotspots || []).map((h, i) => (
              <tr key={i}>
                <td>
                  <b>#{i + 1}</b>
                </td>
                <td className="mono">
                  x ≈ {h.x} <span className="muted">({h.x_range[0]} → {h.x_range[1]})</span>
                </td>
                <td className="num">{fmtNum(h.deaths)}</td>
                <td className="num">
                  <Status kind={h.share > 0.4 ? 'alert' : h.share > 0.2 ? 'warn' : 'neutral'}>{fmtPct(h.share * 100, 0)}</Status>
                </td>
                <td>
                  <span className="tag" style={{ borderLeft: `3px solid ${causeColor(h.top_cause)}` }}>
                    {h.top_cause}
                  </span>
                </td>
                <td className="num">{fmtNum(h.rage_quits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Widget>
      )}
    </div>
  );
}

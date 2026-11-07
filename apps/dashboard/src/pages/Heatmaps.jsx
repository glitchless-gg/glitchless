import { useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, Segmented, Status, Empty } from '../components.jsx';
import { LevelMap } from '../heatmap.jsx';
import { fmtNum, fmtPct, causeColor, pctStatus } from '../format.js';
import { NoGame } from './Overview.jsx';

// A place on the map (server/src/places.js) as the picker writes it: "level:<id>", "zone:<name>", "all" (the whole
// game), or "" for the server's choice (the first level, else the whole game).
const placeValue = (d) => (d.level != null ? `level:${d.level}` : d.zone != null ? `zone:${d.zone}` : 'all');
function placeParams(v) {
  if (v.startsWith('level:')) return { level: v.slice(6) };
  if (v.startsWith('zone:')) return { zone: v.slice(5) };
  return v === 'all' ? { all: 1 } : {};
}

export function Heatmaps({ route }) {
  const f = useFilters();
  const q = route.query;
  const [place, setPlace] = useState(q.get('level') ? `level:${q.get('level')}` : q.get('zone') ? `zone:${q.get('zone')}` : q.get('all') ? 'all' : '');
  const [layer, setLayer] = useState('both');
  const [zoom, setZoom] = useState(1);
  const { data } = useQuery('heatmap', { ...f.params, ...placeParams(place) }, { refreshMs: f.live ? 15000 : 0, enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const here = placeValue(data);
  const name = data.level ?? data.zone ?? 'Everywhere';
  const levels = data.levels || [];
  const zones = data.zones || [];
  const st = data.stats || {};
  // Heatmaps need positions (setPosition) or placed deaths; many games (puzzles, menus, card games) have neither.
  if (!levels.length && !zones.length && !data.density?.samples && !(data.deaths || []).length) {
    return (
      <Empty title="No positions from this game">
        Heatmaps show where players go and where they die, in a level, a zone or a whole hub. They need the game to send positions with <code>setPosition</code>, which only makes sense for games with a world to move through. The board and Events pages cover everything else.
      </Empty>
    );
  }
  const deaths = st.deaths > 0;
  // A game of levels alone keeps its row of level buttons; with zones, or players moving with no level set (a hub,
  // a lobby), the places go in one list: the levels, the zones, and everywhere at once.
  const anywhere = zones.length || data.no_level || here === 'all';
  const view = data.axis === 'xy' ? 'side view' : 'seen from above';
  return (
    <div className="grid">
      <Widget
        span={12}
        title={`${name}: where players go${deaths ? ', and where they die' : ''}`}
        sub={data.map ? `${data.map.uploaded ? 'over the uploaded background' : 'over the map captured in-game by glitchless.captureMap()'} · ${view}` : `no picture of this place yet, showing positions only · ${view}`}
        actions={
          // On a phone the place, the layers and the zoom wrap onto lines of their own rather than run off the screen.
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
            {anywhere ? (
              <select className="btn" value={here} onChange={(e) => setPlace(e.target.value)} aria-label="Place" style={{ maxWidth: 220 }}>
                {levels.length > 0 && (
                  <optgroup label="Levels">
                    {levels.map((l) => (
                      <option key={l} value={`level:${l}`}>
                        {l}
                      </option>
                    ))}
                  </optgroup>
                )}
                {zones.length > 0 && (
                  <optgroup label="Zones">
                    {zones.map((z) => (
                      <option key={z} value={`zone:${z}`}>
                        {z}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="all">Everywhere</option>
              </select>
            ) : (
              <Segmented value={here} onChange={setPlace} options={levels.map((l) => ({ value: `level:${l}`, label: l }))} />
            )}
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
          </div>
        }
      >
        <LevelMap map={data.map} bounds={data.bounds} axis={data.axis} density={data.density} deaths={data.deaths} hotspots={data.hotspots} zoom={zoom} showDensity={layer !== 'deaths'} showDeaths={layer !== 'density'} />
        <div className="legend" style={{ marginTop: 8 }}>
          {/* Only what this place has: its own death causes, rage quits and time spent. */}
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
      {data.level == null ? (
        // A zone or the whole game has no level to complete: the sessions that went there.
        <QueryValue span={3} label="Sessions here" value={fmtNum(st.sessions)} sub={data.zone != null ? `went to ${data.zone}` : 'moved or died anywhere'} />
      ) : st.no_win ? (
        // A run is a start of the level (or, for a game that never sends starts, a death that ends one).
        <QueryValue span={3} label="Runs" value={fmtNum(st.attempts || st.deaths)} sub={`in ${fmtNum(st.sessions)} sessions; nobody wins`} />
      ) : (
        <QueryValue span={3} label="Completion rate" value={fmtPct(st.completion_pct, 0)} status={pctStatus(st.completion_pct, 75, 50)} sub={`${fmtNum(st.completed)} of ${fmtNum(st.sessions)} sessions`} />
      )}
      {deaths && <QueryValue span={3} label="Deaths" value={fmtNum(st.deaths)} sub={`${fmtNum(st.deaths_per_session, 1)} per session`} />}
      {deaths && <QueryValue span={3} label="Rage quits here" value={fmtNum(st.rage_quits)} status={pctStatus(st.rage_quit_pct, 5, 12, false)} sub={`${fmtPct(st.rage_quit_pct)} of sessions`} />}
      <QueryValue span={3} label="Position samples" value={fmtNum(data.density?.samples)} sub="4 Hz per player" />
      {deaths && (
      <Widget span={12} title="Death hotspots" sub={`where deaths cluster ${data.level != null ? 'on this level' : data.zone != null ? 'in this zone' : 'across the game'}`} flush>
        <div className="tablewrap">
        <table className="dt">
          <thead>
            <tr>
              <th>#</th>
              <th>Where</th>
              <th className="num">Deaths</th>
              <th className="num">Share of deaths here</th>
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
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                  x ≈ {h.x} <span className="muted">({h.x_range[0]} → {h.x_range[1]})</span>
                  {h.z != null && <>, z ≈ {h.z}</>}
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
        </div>
      </Widget>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, TimeSeries, BarList, Histogram, Status, GroupTitle, Segmented } from '../components.jsx';
import { fmtNum, fmtMs, fmtPct, frameStatus, pctStatus, timeAgo, PALETTE } from '../format.js';
import { NoGame } from './Overview.jsx';
import { fmtPing, fmtPerHour, pingKind, reasonWords } from '../genre.jsx';

const CAUSE_LABEL = { script: 'Long script (LoAF)', shader_compile: 'Shader compile', gc: 'GC pause', asset_load: 'Asset loading', texture_upload: 'Texture uploads', geometry_upload: 'Geometry uploads', object_spawn: 'Object spawn', scene_change: 'Scene change', render: 'Long render', frozen: 'Frozen frame', unattributed: 'Unattributed' };

export function Performance({ route }) {
  const f = useFilters();
  const focus = route.query.get('level');
  const [dim, setDim] = useState('gpu_tier');
  const [where, setWhere] = useState('level');
  // A split by a session property (A6), from a finding's link (?by_prop=class) or picked below.
  const [prop, setProp] = useState(() => route.query.get('by_prop') || '');
  const { data } = useQuery('performance', prop ? { ...f.params, by_prop: prop } : f.params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  // A finding's link to a section (?section=network) scrolls to it once the page has drawn.
  const section = route.query.get('section');
  const net = useRef(null);
  const drawn = !!data;
  useEffect(() => {
    if (drawn && section === 'network') net.current?.scrollIntoView({ block: 'start' });
  }, [drawn, section]);
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const k = data.kpis;
  const budget = k.frame_budget_ms || 16.67;
  const s = data.series;
  const versionSeries = Object.entries(s.p95_by_version || {}).map(([v, values], i) => ({ label: `p95 · ${v}`, values, color: PALETTE[i % PALETTE.length] }));
  const dims = { gpu_tier: data.by_gpu_tier, browser: data.by_browser, gpu: data.by_gpu, platform: data.by_platform, version: data.by_version, steam_branch: data.by_steam_branch, steam_build: data.by_steam_build };
  // Steam branches and builds only for a game whose sessions read them from Steamworks (SPEC §4c).
  const segments = [{ value: 'gpu_tier', label: 'GPU tier' }, { value: 'gpu', label: 'GPU' }, { value: 'browser', label: 'Browser' }, { value: 'platform', label: 'Platform' }, { value: 'version', label: 'Version' }, ...(data.by_steam_branch?.length ? [{ value: 'steam_branch', label: 'Steam branch' }] : []), ...(data.by_steam_build?.length ? [{ value: 'steam_build', label: 'Steam build' }] : [])];
  const gauges = data.hitch_context?.gauges || [];
  const preceding = data.hitch_context?.preceding_events || [];

  return (
    <div className="grid">
      <QueryValue label="p50 frame time" value={k.frame_p50?.toFixed(1)} unit="ms" status={frameStatus(k.frame_p50, budget)} />
      <QueryValue label="p95 frame time" value={k.frame_p95?.toFixed(1)} unit="ms" status={frameStatus(k.frame_p95, budget)} sub={`budget ${budget.toFixed(1)}ms`} />
      <QueryValue label="p99 frame time" value={k.frame_p99?.toFixed(1)} unit="ms" status={frameStatus(k.frame_p99, budget)} />
      <QueryValue label="Hitches / min" value={fmtNum(k.hitches_per_min, 2)} status={pctStatus(k.hitches_per_min, 1, 4, false)} sub={`${fmtNum(k.hitches)} total · ${k.frozen_frames} frozen`} />
      <QueryValue label="Avg draw calls" value={fmtNum(k.draw_calls)} sub={`render CPU ${fmtMs(k.render_cpu_ms, 2)}/frame`} status={pctStatus(k.draw_calls, 300, 800, false)} />
      <QueryValue label="Time to first frame" value={k.ttff_p50 != null ? (k.ttff_p50 / 1000).toFixed(2) : null} unit="s" sub={`p95 ${k.ttff_p95 != null ? (k.ttff_p95 / 1000).toFixed(2) + 's' : '–'}`} status={pctStatus(k.ttff_p95, 3000, 8000, false)} />

      <Widget span={8} title="p95 frame time by version" sub="deployments compared on the same time axis">
        <TimeSeries ts={s.ts} height={220} unit="ms" series={versionSeries} thresholds={[{ value: budget, color: '#1fae84', label: 'budget' }, { value: 33.3, color: '#ff6b57', label: 'jank (30fps)' }]} />
      </Widget>
      <Widget span={4} title="Frame time distribution" sub="share of all frames">
        <Histogram edges={data.distribution.edges} counts={data.distribution.counts} budget={budget} />
      </Widget>

      <Widget span={12} title={where === 'zone' ? 'By zone' : 'By level'} sub="where the frame budget goes" actions={data.by_zone?.length ? <Segmented value={where} onChange={setWhere} options={[{ value: 'level', label: 'Level' }, { value: 'zone', label: 'Zone' }]} /> : null} info={where === 'zone' ? 'A zone is a region inside a level the game names with setZone (a district, a dungeon floor). Frames count under the zone they were drawn in; sessions are left out, since one session crosses many zones.' : null} flush>
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{where === 'zone' ? 'Zone' : 'Level'}</th>
                <th className="num">Sessions</th>
                <th className="num">p50</th>
                <th className="num">p95</th>
                <th className="num">p99</th>
                <th className="num">Over budget</th>
                <th className="num">Hitches/min</th>
                <th className="num">Draw calls (avg / max)</th>
                <th className="num">Triangles</th>
                <th className="num">Geometries (max)</th>
                <th>Game context (max)</th>
              </tr>
            </thead>
            <tbody>
              {(where === 'zone' && data.by_zone ? data.by_zone : data.by_level).map((l) => (
                <tr key={l.key} className={where === 'level' && focus === l.key ? 'sel' : ''}>
                  <td>
                    <b>{l.key}</b>
                  </td>
                  <td className="num">{fmtNum(l.sessions)}</td>
                  <td className="num">{fmtMs(l.p50)}</td>
                  <td className="num">
                    <Status kind={frameStatus(l.p95, budget)}>{fmtMs(l.p95)}</Status>
                  </td>
                  <td className="num">{fmtMs(l.p99)}</td>
                  <td className="num">{fmtPct(l.pct_over_budget)}</td>
                  <td className="num">{fmtNum(l.hitches_per_min, 2)}</td>
                  <td className="num">
                    {fmtNum(l.draw_calls)} / <span className={l.draw_calls_max > 800 ? 'alert-t' : ''}>{fmtNum(l.draw_calls_max)}</span>
                  </td>
                  <td className="num">{fmtNum(l.triangles)}</td>
                  <td className="num">{fmtNum(l.geometries_max)}</td>
                  <td>
                    {Object.entries(l.ctx_max || {}).map(([key, v]) => (
                      <span className="tag" key={key}>
                        {key}: {fmtNum(v)}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>

      {data.network && <Network n={data.network} anchor={net} />}

      <GroupTitle>Hitch analysis</GroupTitle>
      <Widget span={4} title="Likely causes" sub="attributed per hitch (frame > 50ms)">
        <BarList rows={Object.entries(data.hitch_causes).sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ label: CAUSE_LABEL[c] || c, value: n, color: c === 'script' ? 'var(--ink)' : c === 'shader_compile' ? '#3d8cf5' : '#f2a93b' }))} />
      </Widget>
      <Widget span={4} title="What's on screen during hitches" sub="game context gauges: hitch frames vs smooth frames">
        {gauges.length ? (
          <table className="dt">
            <thead>
              <tr>
                <th>Gauge</th>
                <th className="num">During hitch</th>
                <th className="num">Otherwise</th>
              </tr>
            </thead>
            <tbody>
              {gauges.map((g) => (
                <tr key={g.key}>
                  <td className="mono">{g.key}</td>
                  <td className="num alert-t">
                    <b>{fmtNum(g.median_during_hitch)}</b>
                  </td>
                  <td className="num">{fmtNum(g.median_otherwise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">Call glitchless.setContext({'{ particles, enemies }'}) to correlate hitches with game state.</div>
        )}
      </Widget>
      <Widget span={4} title="Events right before a hitch" sub="within 1.5s · ranked by lift over the event's base rate">
        <BarList rows={preceding.map((p) => ({ label: p.event, value: p.share * 100, display: `${fmtPct(p.share * 100, 0)} · ${p.lift}×`, color: p.lift >= 3 ? '#ff6b57' : '#c9d1df', title: `base rate ${fmtPct(p.base_rate * 100, 0)}` }))} max={100} />
      </Widget>
      <Widget span={12} title="Recent hitches" sub="with Long Animation Frame script attribution where the browser supports it" flush>
        <div className="tablewrap" style={{ maxHeight: 320 }}>
          <table className="dt">
            <thead>
              <tr>
                <th>When</th>
                <th>Level</th>
                <th className="num">Duration</th>
                <th>Causes</th>
                <th>Top script</th>
                <th className="num">Draw calls</th>
                <th>Context</th>
                <th>Preceded by</th>
                <th>Session</th>
              </tr>
            </thead>
            <tbody>
              {data.hitches.slice(0, 60).map((h, i) => (
                <tr key={i} className="click" onClick={() => f.go(`sessions/${h.session_id}`)}>
                  <td className="muted">{timeAgo(h.ts)}</td>
                  <td>{h.level}</td>
                  <td className="num">
                    <Status kind={h.duration_ms > 100 ? 'alert' : 'warn'}>{fmtMs(h.duration_ms, 0)}</Status>
                  </td>
                  <td>{(h.causes || []).map((c) => <span className="tag" key={c}>{c}</span>)}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {h.loaf?.[0] ? `${h.loaf[0].fn || '(anonymous)'} · ${h.loaf[0].source} · ${fmtMs(h.loaf[0].ms, 0)}` : '–'}
                  </td>
                  <td className="num">{fmtNum(h.draw_calls)}</td>
                  <td>
                    {Object.entries(h.ctx || {}).map(([key, v]) => (
                      <span className="tag" key={key}>
                        {key}: {fmtNum(v)}
                      </span>
                    ))}
                  </td>
                  <td className="muted" style={{ fontSize: 11.5 }}>
                    {(h.recent || []).slice(-3).join(' → ')}
                  </td>
                  <td className="mono muted" style={{ fontSize: 11 }}>
                    {h.session_id.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>

      <GroupTitle>Devices</GroupTitle>
      <Widget span={6} title="p95 frame time by segment" actions={<Segmented value={dim} onChange={setDim} options={segments} />}>
        <BarList
          rows={(dims[dim] || []).map((g) => ({ label: `${g.key} (${g.sessions})`, value: g.p95, display: fmtMs(g.p95), color: frameStatus(g.p95, budget) === 'ok' ? '#1fae84' : frameStatus(g.p95, budget) === 'warn' ? '#f2a93b' : '#ff6b57', title: `${g.sessions} sessions` }))}
        />
      </Widget>
      <Widget span={6} title="Scene memory" sub="avg renderer geometries & JS heap — growth that never drops is a leak">
        <TimeSeries
          ts={s.ts}
          height={170}
          series={[
            { label: 'geometries', values: s.geometries, color: 'var(--ink)' },
            { label: 'JS heap (MB)', values: s.heap_mb, color: '#3d8cf5' },
          ]}
        />
        <div style={{ display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
          {Object.entries(data.memory || {}).map(([v, m]) => (
            <div key={v} className="spotcard">
              <span className="tag">{v}</span> geometries {fmtNum(m.median_first)} → <b className={m.geometries_growth_per_level_load > 40 ? 'alert-t' : 'ok-t'}>{fmtNum(m.median_last)}</b>
              <div className="muted">+{fmtNum(m.geometries_growth_per_level_load)} per level load · {m.sessions} sessions</div>
            </div>
          ))}
        </div>
      </Widget>
      {f.properties?.length > 0 && <ByProperty data={data} prop={prop} setProp={setProp} keys={f.properties.map((p) => p.key)} budget={budget} />}
    </div>
  );
}

// The game's network (A8; SPEC §3 performance network): ping, lag, loss and disconnects, by level, version, platform
// and connection, for a game that sends network samples.
function Network({ n, anchor }) {
  const [by, setBy] = useState('level');
  const k = n.kpis;
  const rows = { level: n.by_level, version: n.by_version, platform: n.by_platform, link: n.by_link }[by] || [];
  const options = [
    { value: 'level', label: 'Level' },
    { value: 'version', label: 'Version' },
    { value: 'platform', label: 'Platform' },
    ...(n.by_link?.length ? [{ value: 'link', label: 'Connection' }] : []),
  ];
  const reasons = Object.entries(k.disconnect_reasons || {}).sort((a, b) => b[1] - a[1]);
  const sessions = rows.some((r) => r.sessions != null);
  return (
    <>
      <div ref={anchor} className="s12" style={{ scrollMarginTop: 12 }}>
        <GroupTitle>Network</GroupTitle>
      </div>
      <QueryValue label="Median ping" value={fmtPing(k.ping_p50)} status={pingKind(k.ping_p50)} sub={`slowest 5% ${fmtPing(k.ping_p95)}`} info="Ping is the round trip to the game's server, from the game's own network samples. A host's own round trip (zero) is left out." />
      <QueryValue label="Play lagging" value={fmtPct(k.lag_pct, 0)} status={pctStatus(k.lag_pct, 5, 15, false)} sub="of connected time over 150 ms" />
      <QueryValue label="Packets lost" value={fmtPct(k.loss_pct, 2)} status={pctStatus(k.loss_pct, 1, 3, false)} sub={k.jitter_ms != null ? `jitter ${fmtPing(k.jitter_ms)}` : null} />
      <QueryValue label="Disconnects" value={fmtPerHour(k.disconnects_per_hour)} status={pctStatus(k.disconnects_per_hour, 0.5, 2, false)} sub={`${fmtNum(k.disconnects)} in ${fmtNum(k.hours, 1)} hours played`} />
      <QueryValue label="Attempts ended by one" value={k.disconnect_pct == null ? '–' : fmtPct(k.disconnect_pct)} status={pctStatus(k.disconnect_pct, 2, 8, false)} sub="level attempts a disconnect cut short" />
      <QueryValue label="Why they dropped" value={reasons.length ? reasonWords(reasons[0][0]) : 'none'} sub={reasons.length ? reasons.map(([r, c]) => `${fmtNum(c)} ${reasonWords(r).toLowerCase()}`).join(' · ') : 'no disconnects'} />
      <Widget span={12} title="Network by segment" sub="where ping, loss and disconnects are worst" actions={<Segmented value={by} onChange={setBy} options={options} />} flush>
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{options.find((o) => o.value === by)?.label}</th>
                {sessions && <th className="num">Sessions</th>}
                <th className="num">Median ping</th>
                <th className="num">Slowest 5%</th>
                <th className="num">Lagging</th>
                <th className="num">Loss</th>
                <th className="num">Disconnects / h</th>
                <th className="num">Attempts ended</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <b>{r.key}</b>
                  </td>
                  {sessions && <td className="num">{fmtNum(r.sessions)}</td>}
                  <td className="num">
                    <Status kind={pingKind(r.ping_p50)}>{fmtPing(r.ping_p50)}</Status>
                  </td>
                  <td className="num">{fmtPing(r.ping_p95)}</td>
                  <td className="num">{fmtPct(r.lag_pct, 0)}</td>
                  <td className="num">{fmtPct(r.loss_pct, 2)}</td>
                  <td className="num" title={Object.entries(r.disconnect_reasons || {}).map(([x, c]) => `${fmtNum(c)} ${reasonWords(x).toLowerCase()}`).join(', ')}>
                    {fmtPerHour(r.disconnects_per_hour)}
                  </td>
                  <td className="num">{r.disconnect_pct == null ? '–' : fmtPct(r.disconnect_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
    </>
  );
}

// Frame time and crashes by a session property (A6): each value of the picked key (a class, a graphics preset).
function ByProperty({ data, prop, setProp, keys, budget }) {
  const rows = data.by_prop?.key === prop ? data.by_prop.rows : null;
  return (
    <Widget
      span={12}
      title="By property"
      sub={prop ? `each ${prop}: frame time, hitches and crashes` : 'split frame time by what the game says about each session'}
      actions={
        <label className="tvar">
          <span>$property</span>
          <select value={prop} onChange={(e) => setProp(e.target.value)}>
            <option value="">pick one</option>
            {keys.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      }
      flush={!!rows?.length}
    >
      {!prop ? (
        <div className="muted">Pick a property to see whether one value of it (a class, a graphics preset, a region) plays worse than the rest.</div>
      ) : !rows ? (
        <div className="loading-bar" />
      ) : rows.length ? (
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{prop}</th>
                <th className="num">Sessions</th>
                <th className="num">p50</th>
                <th className="num">p95</th>
                <th className="num">Over budget</th>
                <th className="num">Hitches/min</th>
                <th className="num">Without a crash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <b>{r.key}</b>
                  </td>
                  <td className="num">{fmtNum(r.all_sessions ?? r.sessions)}</td>
                  <td className="num">{fmtMs(r.p50)}</td>
                  <td className="num">
                    <Status kind={frameStatus(r.p95, budget)}>{fmtMs(r.p95)}</Status>
                  </td>
                  <td className="num">{fmtPct(r.pct_over_budget)}</td>
                  <td className="num">{fmtNum(r.hitches_per_min, 2)}</td>
                  <td className="num">
                    <Status kind={pctStatus(r.crash_free_pct, 99, 95)}>{fmtPct(r.crash_free_pct, 1)}</Status>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="why">No session in this window has {prop}.</div>
      )}
    </Widget>
  );
}

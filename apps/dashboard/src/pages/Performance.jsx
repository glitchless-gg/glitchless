import { useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, TimeSeries, BarList, Histogram, Status, GroupTitle, Segmented } from '../components.jsx';
import { fmtNum, fmtMs, fmtPct, frameStatus, pctStatus, timeAgo, PALETTE } from '../format.js';
import { NoGame } from './Overview.jsx';

const CAUSE_LABEL = { script: 'Long script (LoAF)', shader_compile: 'Shader compile', gc: 'GC pause', asset_load: 'Asset loading', texture_upload: 'Texture uploads', geometry_upload: 'Geometry uploads', object_spawn: 'Object spawn', scene_change: 'Scene change', render: 'Long render', frozen: 'Frozen frame', unattributed: 'Unattributed' };

export function Performance({ route }) {
  const f = useFilters();
  const focus = route.query.get('level');
  const [dim, setDim] = useState('gpu_tier');
  const { data } = useQuery('performance', f.params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
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

      <Widget span={12} title="By level" sub="where the frame budget goes" flush>
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Level</th>
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
              {data.by_level.map((l) => (
                <tr key={l.key} className={focus === l.key ? 'sel' : ''}>
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
    </div>
  );
}

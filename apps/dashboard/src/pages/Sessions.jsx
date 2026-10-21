import { useEffect, useMemo, useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, Status, TimeSeries, Icon, Segmented } from '../components.jsx';
import { LevelMap } from '../heatmap.jsx';
import { fmtNum, fmtMs, fmtDuration, fmtTime, timeAgo, frameStatus } from '../format.js';
import { NoGame } from './Overview.jsx';

export function Sessions() {
  const f = useFilters();
  const [filter, setFilter] = useState('all');
  const { data } = useQuery('sessions', f.params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const rows = (data.sessions || []).filter((s) => {
    if (filter === 'crashed') return s.crashed;
    if (filter === 'rage') return s.rage_quit;
    if (filter === 'errors') return s.errors > 0;
    if (filter === 'slow') return s.p95 > 33.3;
    if (filter === 'synthetic') return s.session_type === 'synthetic';
    return true;
  });
  return (
    <div className="grid">
      <Widget
        span={12}
        title={`${fmtNum(rows.length)} sessions`}
        sub="click a session to replay it"
        flush
        actions={
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'errors', label: 'With errors' },
              { value: 'slow', label: 'Slow (p95 > 33ms)' },
              { value: 'rage', label: 'Rage quits' },
              { value: 'crashed', label: 'Crashed' },
              { value: 'synthetic', label: 'Synthetic' },
            ]}
          />
        }
      >
        <div className="tablewrap" style={{ maxHeight: 'calc(100vh - 190px)' }}>
          <table className="dt">
            <thead>
              <tr>
                <th>Started</th>
                <th>Player</th>
                <th>Version</th>
                <th>Device</th>
                <th>Levels</th>
                <th className="num">Duration</th>
                <th className="num">p95 frame</th>
                <th className="num">Deaths</th>
                <th className="num">Errors</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.session_id} className="click" onClick={() => f.go(`sessions/${s.session_id}`)}>
                  <td className="muted">{timeAgo(s.start)}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {s.player_id.slice(0, 10)} {s.session_type === 'synthetic' && <Status kind="brand">bot</Status>}
                  </td>
                  <td>
                    <span className="tag">{s.version}</span>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {s.browser} · {s.gpu} <span className="tag">{s.gpu_tier}</span>
                  </td>
                  <td>
                    {s.levels.map((l) => (
                      <span key={l} className="tag" style={s.completed.includes(l) ? { background: '#efe7fb', color: '#5420a0' } : undefined}>
                        {l}
                      </span>
                    ))}
                  </td>
                  <td className="num">{fmtDuration(s.duration_s)}</td>
                  <td className="num">
                    <Status kind={frameStatus(s.p95)}>{fmtMs(s.p95)}</Status>
                  </td>
                  <td className="num">{s.deaths}</td>
                  <td className="num">{s.errors ? <span className="alert-t">{s.errors}</span> : 0}</td>
                  <td>
                    {s.crashed && <Status kind="alert">crashed</Status>} {s.rage_quit && <Status kind="warn">rage quit · {s.rage?.level}</Status>}{' '}
                    {!s.crashed && !s.rage_quit && (s.completed.length ? <Status kind="ok">cleared {s.completed.length}</Status> : <Status kind="neutral">{s.ended ? 'left' : 'playing'}</Status>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
    </div>
  );
}

function describe(e) {
  switch (e.type) {
    case 'session_start':
      return [`Session started`, `${e.device?.browser ?? ''} ${e.device?.browser_version ?? ''} · ${e.device?.os ?? ''} · ${e.device?.gpu ?? ''} (${e.device?.gpu_tier ?? '?'})`];
    case 'level_start':
      return [`▶ ${e.level} started`, ''];
    case 'level_complete':
      return [`✓ ${e.level} completed`, `${e.duration_s}s · score ${e.score ?? '–'}`];
    case 'level_fail':
      return [`✗ ${e.level} failed`, e.cause || ''];
    case 'death':
      return [`Died: ${e.cause}`, `x=${e.x} y=${e.y}`];
    case 'error':
      return [e.message, `${e.kind} · ${e.fn || ''} ${e.source ? `(${e.source}:${e.line})` : ''}`];
    case 'hitch':
      return [`Hitch ${fmtMs(e.duration_ms, 0)}`, `${(e.causes || []).join(', ')} · ${Object.entries(e.ctx || {}).map(([k, v]) => `${k} ${fmtNum(v)}`).join(' · ')}`];
    case 'custom':
      return e.name === 'annotation' ? [`Agent: ${e.attrs?.note}`, 'agent annotation'] : [e.name, Object.entries(e.attrs || {}).map(([k, v]) => `${k}=${v}`).join(' ')];
    case 'load':
      return e.ttff_ms != null ? [`First frame`, `${e.ttff_ms}ms after navigation`] : [`First input`, `${e.ttp_ms}ms`];
    case 'session_end':
      return [`Session ended`, `${e.reason} after ${fmtDuration(e.duration_s)}`];
    default:
      return [e.type, ''];
  }
}

function cls(e) {
  if (e.type === 'error') return 'error';
  if (e.type === 'death' || e.type === 'level_fail') return 'death';
  if (e.type === 'hitch') return 'hitch';
  if (e.type.startsWith('level')) return 'level';
  if (e.type === 'custom' && e.name === 'annotation') return 'annotation';
  return '';
}

export function SessionDetail({ route }) {
  const f = useFilters();
  const id = route.arg;
  const { data } = useQuery('session', { service: f.service, id, from: Date.now() - 7 * 86400e3 }, { enabled: !!f.service });
  const [t, setT] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [showNoisy, setShowNoisy] = useState(false);
  // Samples taken outside a level (title screen, reloads) have no map to draw on.
  const positions = useMemo(() => (data?.positions || []).filter((p) => p[1] != null), [data]);
  const t0 = positions[0]?.[0] ?? data?.session?.start;
  const t1 = positions.at(-1)?.[0] ?? t0;

  useEffect(() => {
    if (data && t == null) setT(t0);
  }, [data, t, t0]);
  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      setT((cur) => {
        const next = (cur ?? t0) + 100 * speed;
        if (next >= t1) {
          setPlaying(false);
          return t1;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(iv);
  }, [playing, speed, t0, t1]);

  const state = useMemo(() => {
    if (!positions.length || t == null) return null;
    let i = 0;
    while (i < positions.length - 1 && positions[i + 1][0] <= t) i++;
    const level = positions[i][1];
    const levelPts = positions.filter((p) => p[1] === level && p[0] <= t).map((p) => [p[2], p[3], p[4]]);
    return { level, cursor: [positions[i][2], positions[i][3], positions[i][4]], path: levelPts };
  }, [positions, t]);

  if (!data) return <div className="loading-bar" />;
  if (data.error) return <div className="empty">Session not found in the last 7 days.</div>;
  const s = data.session;
  // High-frequency custom events (pickups) drown out the story; collapse them unless asked.
  const counts = {};
  for (const e of data.timeline) if (e.type === 'custom') counts[e.name] = (counts[e.name] || 0) + 1;
  const noisy = new Set(Object.entries(counts).filter(([, n]) => n > 12).map(([k]) => k));
  const timeline = showNoisy ? data.timeline : data.timeline.filter((e) => !(e.type === 'custom' && noisy.has(e.name)));
  const map = state && data.maps?.[state.level];
  const deathsHere = data.timeline.filter((e) => e.type === 'death' && e.level === state?.level && e.ts <= (t ?? 0));
  const frames = data.frames || [];
  const currentIdx = timeline.reduce((acc, e, i) => (e.ts <= (t ?? 0) ? i : acc), -1);
  const markers = [
    ...(t ? [{ ts: t, label: '▶', color: '#14213d' }] : []),
    ...data.timeline.filter((e) => e.type === 'error').slice(0, 5).map((e) => ({ ts: e.ts, label: 'error', color: '#ff6b57' })),
    ...(s.annotations || []).map((a) => ({ ts: a.ts, label: 'agent', color: '#3d8cf5' })),
  ];

  return (
    <div className="grid">
      <Widget span={12}>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', paddingTop: 8 }}>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              SESSION
            </div>
            <div className="mono" style={{ fontWeight: 600 }}>
              {s.session_id}
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              STARTED
            </div>
            {fmtTime(s.start, true)}
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              DURATION
            </div>
            {fmtDuration(s.duration_s)}
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              DEVICE
            </div>
            {s.browser} · {s.os} · {s.gpu} <span className="tag">{s.gpu_tier}</span>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              VERSION
            </div>
            <span className="tag">{s.version}</span> {s.session_type === 'synthetic' && <Status kind="brand">synthetic</Status>}
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              P95 FRAME
            </div>
            <Status kind={frameStatus(s.p95)}>{fmtMs(s.p95)}</Status>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {s.crashed && <Status kind="alert">crashed</Status>}
            {s.rage_quit && <Status kind="warn">rage quit on {s.rage?.level}</Status>}
            <Status kind="neutral">{s.deaths} deaths</Status>
            <Status kind={s.errors ? 'alert' : 'ok'}>{s.errors} errors</Status>
          </div>
        </div>
      </Widget>
      <Widget
        span={8}
        title={`Game replay${state ? ` — ${state.level}` : ''}`}
        sub="reconstructed from 4 Hz position telemetry — no video recorded"
        actions={
          <>
            <button className="btn primary" onClick={() => (t >= t1 ? (setT(t0), setPlaying(true)) : setPlaying(!playing))}>
              <Icon name={playing ? 'pause' : 'play'} /> {playing ? 'Pause' : 'Play'}
            </button>
            <Segmented value={speed} onChange={setSpeed} options={[{ value: 1, label: '1×' }, { value: 4, label: '4×' }, { value: 16, label: '16×' }]} />
          </>
        }
      >
        {state ? (
          <>
            <LevelMap map={map ? { image: map.image } : null} bounds={map?.bounds || autoBounds(positions.filter((p) => p[1] === state.level))} axis={map?.axis || 'xy'} path={state.path} cursor={state.cursor} deaths={deathsHere.map((d) => ({ ...d }))} />
            <input type="range" min={t0} max={t1} value={t ?? t0} onChange={(e) => setT(Number(e.target.value))} style={{ width: '100%', marginTop: 10, accentColor: '#14213d' }} />
            <div className="muted mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
              <span>{fmtTime(t0)}</span>
              <span>
                +{fmtDuration(((t ?? t0) - t0) / 1000)} · {state.level}
              </span>
              <span>{fmtTime(t1)}</span>
            </div>
          </>
        ) : (
          <div className="empty">No position data recorded for this session.</div>
        )}
      </Widget>
      <Widget
        span={4}
        title="Timeline"
        sub="click to seek"
        flush
        actions={
          noisy.size > 0 && (
            <label className="muted" style={{ fontSize: 11.5, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={showNoisy} onChange={(e) => setShowNoisy(e.target.checked)} /> show {[...noisy].join(', ')} ({[...noisy].reduce((a, k) => a + counts[k], 0)})
            </label>
          )
        }
      >
        <div className="timeline" style={{ maxHeight: 460, overflowY: 'auto', padding: '0 12px 8px' }}>
          {timeline.map((e, i) => {
            const [title, detail] = describe(e);
            return (
              <div
                key={i}
                className={`tl ${cls(e)} ${i === currentIdx ? 'cur' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  setPlaying(false);
                  setT(Math.max(t0, Math.min(t1, e.ts)));
                }}
              >
                <span className="tt">+{fmtDuration((e.ts - (s.start ?? t0)) / 1000)}</span>
                <span className="ti" />
                <span>
                  <b>{title}</b>
                  {detail && (
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {detail}
                    </div>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </Widget>
      <Widget span={12} title="Frame time during this session" sub="p95 per 5s window, with draw calls">
        <TimeSeries
          ts={frames.map((fr) => fr.ts)}
          height={180}
          unit="ms"
          series={[
            { label: 'p95 frame (ms)', values: frames.map((fr) => fr.p95), color: '#14213d', width: 2 },
            { label: 'worst frame (ms)', values: frames.map((fr) => fr.max), color: '#ff6b57', dash: [3, 3] },
          ]}
          thresholds={[{ value: 16.7, color: '#1fae84', label: 'budget' }]}
          markers={markers}
          onPick={(i) => !playing && frames[i] && setT(Math.max(t0, Math.min(t1, frames[i].ts)))}
        />
      </Widget>
    </div>
  );
}

function autoBounds(pts) {
  if (!pts.length) return null;
  const xs = pts.map((p) => p[2]);
  const ys = pts.map((p) => p[3]);
  return { min: [Math.min(...xs) - 2, Math.min(...ys) - 2], max: [Math.max(...xs) + 2, Math.max(...ys) + 4] };
}

import { useState } from 'react';
import { useFilters } from '../filters.js';
import { useLive } from '../api.js';
import { Widget, Segmented, Status } from '../components.jsx';
import { fmtTime, fmtMs, fmtNum } from '../format.js';
import { NoGame } from './Overview.jsx';

const KIND = { error: 'alert', death: 'warn', hitch: 'warn', level_complete: 'ok', level_start: 'brand', level_fail: 'warn', session_start: 'info', session_end: 'neutral', custom: 'neutral', frame_window: 'neutral', load: 'info' };

function line(e) {
  switch (e.type) {
    case 'frame_window':
      return `fps=${e.fps} p95=${fmtMs(e.ft_p95)} max=${fmtMs(e.ft_max, 0)} draw_calls=${fmtNum(e.draw_calls)} geometries=${fmtNum(e.geometries)} ${Object.entries(e.ctx || {}).map(([k, v]) => `${k}=${fmtNum(v)}`).join(' ')}`;
    case 'hitch':
      return `${fmtMs(e.duration_ms, 0)} causes=[${(e.causes || []).join(',')}] ${e.loaf?.[0] ? `script=${e.loaf[0].fn}@${e.loaf[0].source}` : ''}`;
    case 'error':
      return `${e.message} ${e.fn ? `at ${e.fn} (${e.source}:${e.line})` : ''}`;
    case 'death':
      return `cause=${e.cause} x=${e.x} y=${e.y}`;
    case 'custom':
      return `${e.name} ${JSON.stringify(e.attrs || {})}`;
    case 'session_start':
      return `${e.device?.browser} · ${e.device?.gpu} (${e.device?.gpu_tier})`;
    case 'level_complete':
      return `${e.duration_s}s score=${e.score}`;
    case 'load':
      return e.ttff_ms != null ? `ttff=${e.ttff_ms}ms` : `ttp=${e.ttp_ms}ms`;
    default:
      return e.cause || e.reason || '';
  }
}

export function LiveTail() {
  const f = useFilters();
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('game');
  useLive(f.service, (batch) => {
    if (paused) return;
    setEvents((prev) => [...batch.reverse(), ...prev].slice(0, 500));
  });
  if (!f.service) return <NoGame />;
  const shown = events.filter((e) => (filter === 'all' ? true : filter === 'game' ? e.type !== 'frame_window' : filter === 'perf' ? e.type === 'frame_window' || e.type === 'hitch' : e.type === 'error'));
  return (
    <div className="grid">
      <Widget
        span={12}
        title="Live Tail"
        sub={`streaming every event from ${f.service} as players play`}
        flush
        actions={
          <>
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'game', label: 'Gameplay' },
                { value: 'perf', label: 'Frames & hitches' },
                { value: 'errors', label: 'Errors' },
                { value: 'all', label: 'Everything' },
              ]}
            />
            <button className="btn" onClick={() => setPaused(!paused)}>
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button className="btn" onClick={() => setEvents([])}>
              Clear
            </button>
          </>
        }
      >
        <div className="livefeed" style={{ maxHeight: 'calc(100vh - 170px)', overflowY: 'auto' }}>
          {!shown.length && <div className="empty">Waiting for events… open the game and play a level.</div>}
          {shown.map((e, i) => (
            <div className="row" key={`${e.ts}-${i}`}>
              <span className="muted">{fmtTime(e.ts)}</span>
              <span>
                <Status kind={KIND[e.type] || 'neutral'}>{e.type === 'custom' ? e.name : e.type}</Status>
              </span>
              <span className="muted">
                {e.level || '–'} <span className="tag">{e.version}</span>
              </span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span className="muted">{e.session_id?.slice(0, 8)}</span> {line(e)}
              </span>
            </div>
          ))}
        </div>
      </Widget>
    </div>
  );
}

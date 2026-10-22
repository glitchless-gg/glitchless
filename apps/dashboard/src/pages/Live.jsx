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

// Only events of these names (custom events) or types (error, death, level_complete…); none: every event.
export function matches(e, names) {
  return !names?.length || names.includes(e.type) || (e.type === 'custom' && names.includes(e.name));
}

// The events as they arrive, newest first (at most 500). `names` keeps only those events.
export function useLiveEvents(service, names) {
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  useLive(service, (batch) => {
    if (paused) return;
    const kept = batch.filter((e) => matches(e, names));
    if (kept.length) setEvents((prev) => [...kept.reverse(), ...prev].slice(0, 500));
  });
  return { events, paused, setPaused, clear: () => setEvents([]) };
}

export function LiveFeed({ events, maxHeight, waiting = 'Waiting for events… open the game and play.' }) {
  return (
    <div className="livefeed" style={{ maxHeight, overflowY: 'auto' }}>
      {!events.length && <div className="empty">{waiting}</div>}
      {events.map((e, i) => (
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
  );
}

// The Live Tail view. A dashboard page can start it on some events (options.events: names or types); the
// box above the feed changes that while watching.
export function LiveTail({ page }) {
  const f = useFilters();
  const preset = (page?.options?.events || []).join(', ');
  const [only, setOnly] = useState(preset);
  const [filter, setFilter] = useState(preset ? 'all' : 'game');
  const names = only
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const live = useLiveEvents(f.service, null);
  if (!f.service) return <NoGame />;
  const shown = live.events.filter((e) => matches(e, names) && (filter === 'all' ? true : filter === 'game' ? e.type !== 'frame_window' : filter === 'perf' ? e.type === 'frame_window' || e.type === 'hitch' : e.type === 'error'));
  return (
    <div className="grid">
      <Widget
        span={12}
        title={page?.title || 'Live Tail'}
        sub={names.length ? `${names.join(', ')} from ${f.service}, as players play` : `every event from ${f.service}, as players play`}
        flush
        actions={
          <>
            <input className="btn live-only" value={only} onChange={(e) => setOnly(e.target.value)} placeholder="Only events named… (buy, error)" title="Event names or types, comma-separated" />
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
            <button className="btn" onClick={() => live.setPaused(!live.paused)}>
              {live.paused ? 'Resume' : 'Pause'}
            </button>
            <button className="btn" onClick={live.clear}>
              Clear
            </button>
          </>
        }
      >
        <LiveFeed events={shown} maxHeight="calc(100vh - 170px)" />
      </Widget>
    </div>
  );
}

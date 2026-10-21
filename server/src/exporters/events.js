// What every exporter needs to know about Glitchless events, whatever the backend.

// Event types that become log records (frame windows and positions are metrics or map data, not logs).
export const LOG_TYPES = new Set(['session_start', 'session_end', 'level_start', 'level_complete', 'level_fail', 'death', 'error', 'hitch', 'custom', 'load']);

// Device context arrives once, on session_start; later events in the session only carry the session id.
export class SessionContext {
  constructor(max = 20_000) {
    this.max = max;
    this.sessions = new Map();
  }

  // Remember the session's device, then return the context for this event.
  observe(e) {
    if (e.type === 'session_start') {
      this.sessions.set(e.session_id, {
        gpu_tier: e.device?.gpu_tier || 'unknown',
        browser: (e.device?.browser || 'unknown').toLowerCase(),
        os: (e.device?.os || 'unknown').toLowerCase(),
        session_type: e.session_type || 'user',
      });
      if (this.sessions.size > this.max) this.sessions.delete(this.sessions.keys().next().value);
    }
    return this.get(e.session_id);
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || {};
  }
}

// One human-readable line per event: the log message.
export function describe(e) {
  switch (e.type) {
    case 'session_start':
      return `Session started on ${e.device?.browser ?? '?'} / ${e.device?.gpu ?? '?'} (${e.device?.gpu_tier ?? '?'} tier)`;
    case 'session_end':
      return `Session ended after ${e.duration_s}s (${e.reason})`;
    case 'level_start':
      return `Level ${e.level} started`;
    case 'level_complete':
      return `Level ${e.level} completed in ${e.duration_s}s`;
    case 'level_fail':
      return `Level ${e.level} failed (${e.cause ?? 'unknown'})`;
    case 'death':
      return `Player died on ${e.level} at x=${e.x} (${e.cause})`;
    case 'error':
      return e.message;
    case 'hitch':
      return `Hitch ${e.duration_ms}ms on ${e.level}${e.causes?.length ? ` (${e.causes.join(', ')})` : ''}`;
    case 'custom':
      return `${e.name}${e.attrs?.note ? `: ${e.attrs.note}` : ''}`;
    case 'load':
      return e.ttff_ms != null ? `First frame after ${e.ttff_ms}ms` : `First input after ${e.ttp_ms}ms`;
    default:
      return e.type;
  }
}

// The error's class: "TypeError" for a JS error, otherwise the SDK's kind (promise, webgl, script, …).
export function errorType(e) {
  if (e.kind !== 'js') return e.kind || 'Error';
  const m = (e.message || '').match(/^(?:Uncaught )?([A-Z][A-Za-z]*Error)\b/);
  return m ? m[1] : 'Error';
}

export function slug(s) {
  return String(s ?? 'unknown').toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').slice(0, 100);
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// For status output: never show credentials that ride in a URL.
export function redactUrl(u) {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

// The live tail's streams for the whole dashboard page (api.js useLive): one per address however many live panels watch
// it (the Live Tail view, each live panel on a board), each panel keeping only the events it shows.
//
// A stream is read with fetch rather than EventSource, so a refusal can be told apart by its answer:
//   429 { busy: true, reason: 'busy' }    the server has no room: 'busy', tried again by itself
//   429 { busy: true, reason: 'yours' }   this person or key has its share of streams open (other tabs, other panels):
//                                         'yours', tried again by itself, so it starts when one of those closes
//   401, 403                              signed out, or no access: 'refused', never tried again; onUnauthorized (401)
//                                         lets the page's own signed-out handling show
//   no answer at all                      'offline', tried again by itself
// Tries wait Retry-After at least, from RETRY_MS doubling up to MAX_RETRY_MS. A stream the host ends (Glitchless Cloud
// ends each after 25 s, SPEC §6 openLive) is opened again after REOPEN_MS; one that ends within SHORT_MS of opening
// backs off as a failed try does, so a server that closes at once is never asked twice a second. No React here, so it
// runs in a test as it runs in the page.
export const RETRY_MS = 3000;
export const MAX_RETRY_MS = 30000;
export const REOPEN_MS = 500;
export const SHORT_MS = 5000;

// request(url, signal) → a Response (fetch's); setTimer and clearTimer as setTimeout's; onUnauthorized() when the
// server says the session is gone.
export function createLiveStreams({ request = (url, signal) => fetch(url, { signal, headers: { accept: 'text/event-stream' } }), setTimer = setTimeout, clearTimer = clearTimeout, onUnauthorized = () => {}, now = Date.now } = {}) {
  const streams = new Map(); // url → { url, ctrl, listeners, state, wait, timer }
  const current = (s) => streams.get(s.url) === s;

  function set(s, state) {
    if (s.state === state) return;
    s.state = state;
    for (const l of s.listeners) l.onState?.(state);
  }

  function later(s, ms) {
    s.timer = setTimer(() => {
      s.timer = null;
      if (current(s)) connect(s);
    }, ms);
  }

  function retry(s, state, retryAfterS = 0) {
    set(s, state);
    later(s, Math.max(s.wait, retryAfterS * 1000));
    s.wait = Math.min(s.wait * 2, MAX_RETRY_MS);
  }

  // One SSE message: its data lines, as JSON. Comments (": ping") and anything else are skipped.
  function deliver(s, message) {
    const data = message
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let batch;
    try {
      batch = JSON.parse(data);
    } catch {
      return;
    }
    for (const l of s.listeners) {
      try {
        l.onEvents?.(batch);
      } catch {}
    }
  }

  async function connect(s) {
    const ctrl = new AbortController();
    s.ctrl = ctrl;
    let res;
    try {
      res = await request(s.url, ctrl.signal);
    } catch {
      if (!ctrl.signal.aborted && current(s)) retry(s, 'offline');
      return;
    }
    if (!current(s) || ctrl.signal.aborted) return;
    if (res.status === 401 || res.status === 403) {
      set(s, 'refused');
      if (res.status === 401) onUnauthorized();
      return;
    }
    if (!res.ok || !res.body) {
      const body = await res.json?.().catch(() => null);
      const after = Number(res.headers?.get?.('retry-after')) || 0;
      retry(s, body?.reason === 'yours' ? 'yours' : 'busy', after);
      return;
    }
    set(s, 'live');
    const opened = now();
    const reader = res.body.getReader();
    const text = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += text.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          deliver(s, buffer.slice(0, at));
          buffer = buffer.slice(at + 2);
        }
      }
    } catch {
      // dropped mid-stream: opened again below
    }
    if (!current(s) || ctrl.signal.aborted) return;
    if (now() - opened < SHORT_MS) {
      later(s, s.wait);
      s.wait = Math.min(s.wait * 2, MAX_RETRY_MS);
    } else {
      s.wait = RETRY_MS;
      later(s, REOPEN_MS);
    }
  }

  // listener: { onEvents(batch), onState('connecting' | 'live' | 'busy' | 'yours' | 'offline' | 'refused') }. Answers the
  // function that stops listening; the stream closes when its last listener goes.
  function subscribe(url, listener) {
    let s = streams.get(url);
    if (!s) {
      s = { url, ctrl: null, listeners: new Set(), state: 'connecting', wait: RETRY_MS, timer: null };
      streams.set(url, s);
      connect(s);
    }
    s.listeners.add(listener);
    listener.onState?.(s.state);
    return () => {
      s.listeners.delete(listener);
      if (s.listeners.size) return;
      streams.delete(url);
      if (s.timer) clearTimer(s.timer);
      s.ctrl?.abort();
    };
  }

  return { subscribe, open: () => streams.size };
}

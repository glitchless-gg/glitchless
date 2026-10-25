import { useCallback, useEffect, useRef, useState } from 'react';

export const API_BASE = (import.meta.env.VITE_GLITCHLESS_API || '').replace(/\/$/, '');

// Set by a hosting shell (see shell.js): extra headers and query parameters for every request (such as
// the selected project), what to do on a 401 instead of asking for a read key, and the API URL to show
// in setup instructions when it isn't the dashboard's own origin.
let context = { headers: {}, params: {}, onUnauthorized: null, publicUrl: null };
export function setApiContext(next) {
  context = { ...context, ...next };
}

export function publicApiUrl() {
  return context.publicUrl || API_BASE || window.location.origin;
}

function apiKey() {
  try {
    return localStorage.getItem('glitchless.apiKey') || '';
  } catch {
    return '';
  }
}

export async function api(name, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  const res = await fetch(`${API_BASE}/v1/query/${name}?${qs}`, {
    headers: { 'x-glitchless-client': 'dashboard', ...(apiKey() ? { 'x-glitchless-api-key': apiKey() } : {}), ...context.headers },
  });
  if (res.status === 401 && context.onUnauthorized) {
    context.onUnauthorized();
    throw new Error(`${name}: HTTP 401`);
  }
  if (res.status === 401) {
    const key = window.prompt('This Glitchless API needs a read key (x-glitchless-api-key):');
    if (key) {
      localStorage.setItem('glitchless.apiKey', key);
      return api(name, params);
    }
  }
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const data = await res.json();
  if (data?.meta) for (const fn of metaListeners) fn(name, data.meta);
  return data;
}

// Told the meta of every query answer: how a range was answered (by day past 31 days, estimated parts,
// a view that covers less of it).
const metaListeners = new Set();
export function onMeta(fn) {
  metaListeners.add(fn);
  return () => metaListeners.delete(fn);
}

// A change, such as saving a game's board: JSON in and out, with the same headers as queries. Throws with
// the server's message (a board that doesn't validate says what to fix).
export async function apiSend(method, path, body = null) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-glitchless-client': 'dashboard', ...(apiKey() ? { 'x-glitchless-api-key': apiKey() } : {}), ...context.headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// A request with the dashboard's own headers, answered as it comes: a game's brand, its images, an upload.
export function apiFetch(path, init = {}) {
  return fetch(`${API_BASE}${path}`, { ...init, headers: { 'x-glitchless-client': 'dashboard', ...(apiKey() ? { 'x-glitchless-api-key': apiKey() } : {}), ...context.headers, ...init.headers } });
}

export async function health() {
  const res = await fetch(`${API_BASE}/v1/health`);
  return res.json();
}

// Fetch a query, re-run when params change, optionally poll. Keeps the previous data while
// reloading so charts don't flash empty on every refresh.
export function useQuery(name, params, { refreshMs = 0, enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const key = JSON.stringify([name, params]);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!enabled) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    api(name, params)
      .then((data) => id === seq.current && setState({ data, error: null, loading: false }))
      .catch((error) => id === seq.current && setState((s) => ({ ...s, error, loading: false })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  useEffect(() => {
    load();
    if (!refreshMs) return;
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);
  return { ...state, reload: load };
}

export function useLive(service, onEvents) {
  const cb = useRef(onEvents);
  cb.current = onEvents;
  useEffect(() => {
    if (!service) return;
    const extra = new URLSearchParams(context.params).toString();
    const es = new EventSource(`${API_BASE}/v1/live?service=${encodeURIComponent(service)}${apiKey() ? `&api_key=${apiKey()}` : ''}${extra ? `&${extra}` : ''}`);
    es.onmessage = (m) => {
      try {
        cb.current(JSON.parse(m.data));
      } catch {}
    };
    return () => es.close();
  }, [service]);
}

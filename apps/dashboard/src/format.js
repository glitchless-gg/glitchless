export function fmtNum(v, d = 0) {
  if (v == null || Number.isNaN(v)) return '–';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}

// Money in its currency, with the symbol and two decimals ("$1,234.50", "€4.99"); `short` for chart axes
// ("$1.2K"). A code the browser doesn't know is written after the number.
export function fmtMoney(v, currency, short = false) {
  if (v == null || Number.isNaN(v)) return '–';
  try {
    return Number(v).toLocaleString('en-US', short ? { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 } : { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return `${short ? fmtNum(v, 1) : Number(v).toFixed(2)} ${currency}`;
  }
}

// A sum (server/src/sums.js): money when it has a currency, else a number with up to two decimals.
export function fmtSum(v, currency) {
  return currency ? fmtMoney(v, currency) : fmtNum(v, 2);
}

export function fmtMs(v, d = 1) {
  if (v == null) return '–';
  if (v >= 1000) return (v / 1000).toFixed(2) + 's';
  return Number(v).toFixed(v >= 100 ? 0 : d) + 'ms';
}

export function fmtPct(v, d = 1) {
  if (v == null) return '–';
  return Number(v).toFixed(d) + '%';
}

export function fmtDuration(s) {
  if (s == null) return '–';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

export function timeAgo(ts) {
  if (!ts) return '–';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function fmtTime(ts, withDate = false) {
  if (!ts) return '–';
  const d = new Date(ts);
  const t = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return withDate ? `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${t}` : t;
}

// Frame-time grading against a frame budget (conditional formatting).
export function frameStatus(ms, budget = 16.67) {
  if (ms == null) return 'neutral';
  if (ms <= budget * 1.15) return 'ok';
  if (ms <= 33.4) return 'warn';
  return 'alert';
}

export function pctStatus(v, ok, warn, higherIsBetter = true) {
  if (v == null) return 'neutral';
  if (higherIsBetter) return v >= ok ? 'ok' : v >= warn ? 'warn' : 'alert';
  return v <= ok ? 'ok' : v <= warn ? 'warn' : 'alert';
}

export const PALETTE = ['#14213d', '#3d8cf5', '#1fae84', '#f2a93b', '#ff6b57', '#4fc1d9', '#2ee6a6', '#8a94a6'];
// A death cause's colour: the same for a cause on every page and level, whatever the game calls its causes.
const CAUSE_PALETTE = ['#3d8cf5', '#f2a93b', '#ff6b57', '#1fae84', '#4fc1d9', '#2ee6a6', '#b07cf2', '#e0437a'];
export function causeColor(cause) {
  if (cause == null || cause === '' || cause === 'unknown') return '#8a94a6';
  let h = 0;
  for (const ch of String(cause)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CAUSE_PALETTE[h % CAUSE_PALETTE.length];
}

export function colorFor(key, i) {
  return PALETTE[i % PALETTE.length];
}

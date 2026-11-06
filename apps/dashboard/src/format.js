export function fmtNum(v, d = 0) {
  if (v == null || Number.isNaN(v)) return '–';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}

// Money in its currency, with the symbol and two decimals ("$1,234.50", "€4.99"); `short` for chart axes
// ("$1.2K"). A code the browser doesn't know is written after the number. Robux (Roblox's currency) are whole:
// "2,400 Robux", "24.5k Robux"; on an axis, Roblox's own short mark: "2.4k R$".
export function fmtMoney(v, currency, short = false) {
  if (v == null || Number.isNaN(v)) return '–';
  if (currency === 'ROBUX') {
    if (short) return `${Math.abs(v) >= 1e6 ? `${fmtNum(v / 1e6, 1)}M` : Math.abs(v) >= 1e3 ? `${fmtNum(v / 1e3, 1)}k` : fmtNum(v)} R$`;
    return `${Math.abs(v) >= 1e4 ? fmtNum(v, 1) : Math.round(v).toLocaleString('en-US')} Robux`;
  }
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

// Frame-time grading (conditional formatting), each frame against its own screen's budget: `over` is the share of
// frames (in %) slower than 1.15× their own window's budget (a row's pct_over_budget), so a 60 Hz phone drawing every
// frame on time reads green next to 120 Hz ones. A percentile `ms` (p95 by default; `q` says which) is green while
// fewer than its tail of frames are over (p95: under 5%), red once three times that are (p95: 15%; p50: half of them)
// or once it is janky on any screen (over 33.4 ms, two 60 Hz frames), yellow between. SPEC §4 "Frame budget".
export function frameStatus(over, ms = null, q = 0.95) {
  if (over == null) return 'neutral';
  const tail = Math.round((1 - q) * 1000) / 10;
  if (over < tail) return 'ok';
  if (over >= Math.min(tail * 3, 50) || ms > 33.4) return 'alert';
  return 'warn';
}

// A screen is common when it has this share (in %) or more of the frame windows: the Performance page splits its
// headline by screen, and frame-time charts draw a budget line for each, once two or more are.
export const COMMON_SCREEN_PCT = 10;

// The common screens of a performance answer's by_display rows (fastest first), or none when players' screens are
// one refresh rate.
export function commonScreens(rows) {
  const common = (rows || []).filter((r) => r.windows_pct >= COMMON_SCREEN_PCT);
  return common.length > 1 ? common : [];
}

// A frame-time chart's budget lines: one per common screen, from frame_budgets ({ budget_ms: % of frame windows }),
// labelled with its refresh rate, or the one budget when players' screens are one rate.
export function budgetLines(budgets, budget) {
  const common = Object.entries(budgets || {})
    .filter(([, share]) => share >= COMMON_SCREEN_PCT)
    .map(([b]) => Number(b))
    .sort((a, b) => a - b);
  if (common.length < 2) return budget ? [{ value: budget, color: '#1fae84', label: 'budget' }] : [];
  return common.map((b) => ({ value: b, color: '#1fae84', label: `${Math.round(1000 / b)} Hz budget`, hz: Math.round(1000 / b) }));
}

export function pctStatus(v, ok, warn, higherIsBetter = true) {
  if (v == null) return 'neutral';
  if (higherIsBetter) return v >= ok ? 'ok' : v >= warn ? 'warn' : 'alert';
  return v <= ok ? 'ok' : v <= warn ? 'warn' : 'alert';
}

// The first is the ink (navy, or pale on dark: styles.css), so a chart's main series reads on either.
export const PALETTE = ['var(--ink)', '#3d8cf5', '#1fae84', '#f2a93b', '#ff6b57', '#4fc1d9', '#2ee6a6', '#8a94a6'];
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

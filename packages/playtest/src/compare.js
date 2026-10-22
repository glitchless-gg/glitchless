// Compares two playtest runs metric by metric. Every check reports one of:
//   regression (fails the change), warning (reported, still passes), improvement, same.

import { DEFAULT_THRESHOLDS } from './config.js';

const OVERALL = ['pct_frames_over_budget', 'frame_p95', 'render_cpu_ms', 'update_cpu_ms', 'draw_calls', 'hitches_per_min', 'errors_per_session', 'deaths_per_session', 'level_completion_pct', 'geometries_growth_per_level_load'];
const PER_LEVEL = ['pct_frames_over_budget', 'frame_p95', 'render_cpu_ms', 'update_cpu_ms', 'draw_calls'];

export function judge(before, after, t) {
  if (before == null || after == null || !t) return null;
  const diff = after - before;
  const changePct = before ? (diff / Math.abs(before)) * 100 : diff ? Infinity : 0;
  // Worse or better only when the change clears BOTH margins.
  const significant = Math.abs(diff) >= (t.abs ?? 0) && Math.abs(changePct) >= (t.pct ?? 0) && diff !== 0;
  const worse = t.higher === false ? diff < 0 : diff > 0;
  const status = !significant ? 'same' : !worse ? 'improvement' : t.severity === 'fail' ? 'regression' : 'warning';
  return { before, after, change_pct: Number.isFinite(changePct) ? Math.round(changePct) : null, status };
}

export function compareRuns(baseline, candidate, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const b = baseline.summary || {};
  const c = candidate.summary || {};
  const checks = [];

  for (const key of OVERALL) {
    const r = judge(b[key], c[key], t[key]);
    if (r) checks.push({ id: key, label: t[key].label, scope: 'all levels', ...r });
  }

  const levels = [...new Set([...Object.keys(b.levels || {}), ...Object.keys(c.levels || {})])].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  for (const level of levels) {
    const bl = b.levels?.[level];
    const cl = c.levels?.[level];
    if (bl && !cl) {
      checks.push({ id: `level.reached.${level}`, label: 'Level reached', scope: level, before: 'yes', after: 'no', change_pct: null, status: 'warning' });
      continue;
    }
    if (!bl || !cl) continue;
    for (const key of PER_LEVEL) {
      const r = judge(bl[key], cl[key], t[`level.${key}`]);
      if (r) checks.push({ id: `level.${key}.${level}`, label: t[`level.${key}`].label, scope: level, ...r });
    }
  }

  const baseErrors = new Map((b.errors || []).map((e) => [e.fingerprint, e]));
  const candErrors = new Map((c.errors || []).map((e) => [e.fingerprint, e]));
  const newErrors = [...candErrors.values()].filter((e) => !baseErrors.has(e.fingerprint));
  const fixedErrors = [...baseErrors.values()].filter((e) => !candErrors.has(e.fingerprint));
  if (newErrors.length) checks.push({ id: 'new_errors', label: t.new_errors.label, scope: 'all levels', before: 0, after: newErrors.length, change_pct: null, status: t.new_errors.severity === 'fail' ? 'regression' : 'warning' });
  if (fixedErrors.length) checks.push({ id: 'fixed_errors', label: 'Error types gone', scope: 'all levels', before: fixedErrors.length, after: 0, change_pct: null, status: 'improvement' });

  const bc = b.crashes || 0;
  const cc = c.crashes || 0;
  if (cc !== bc) checks.push({ id: 'crashes', label: t.new_crashes.label, scope: 'all levels', before: bc, after: cc, change_pct: null, status: cc > bc ? (t.new_crashes.severity === 'fail' ? 'regression' : 'warning') : 'improvement' });

  // Comparisons are only fair when the same bots played the same scenarios on the same machine.
  const notes = [];
  const sig = (run) => JSON.stringify((run.scenarios || []).map((s) => s.params));
  if (sig(baseline) !== sig(candidate)) notes.push('The two runs used different scenarios, so differences may come from the bots rather than the code.');
  if (baseline.machine?.gpu && candidate.machine?.gpu && baseline.machine.gpu !== candidate.machine.gpu) notes.push(`Different GPUs (${baseline.machine.gpu} vs ${candidate.machine.gpu}): frame times are not comparable across machines.`);
  const capped = (candidate.scenarios || []).filter((s) => !s.finished).length;
  if (capped) notes.push(`${capped} candidate run(s) hit the time cap before finishing.`);

  const regressions = checks.filter((x) => x.status === 'regression');
  return {
    verdict: regressions.length ? 'fail' : 'pass',
    regressions,
    warnings: checks.filter((x) => x.status === 'warning'),
    improvements: checks.filter((x) => x.status === 'improvement'),
    checks,
    new_errors: newErrors,
    fixed_errors: fixedErrors,
    notes,
  };
}

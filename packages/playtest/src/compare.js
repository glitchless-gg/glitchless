// Compares two playtest runs metric by metric. Every check reports one of:
//   regression (fails the change), warning (reported, still passes), improvement, same.

import { DEFAULT_THRESHOLDS } from './config.js';

// A metric a run doesn't have (GPU time in a browser, draw calls in GameMaker) is skipped.
const OVERALL = ['pct_frames_over_budget', 'frame_p95', 'frame_p99', 'render_cpu_ms', 'update_cpu_ms', 'gpu_ms', 'rhi_cpu_ms', 'physics_ms', 'draw_calls', 'hitches_per_min', 'errors_per_session', 'deaths_per_session', 'level_completion_pct', 'geometries_growth_per_level_load', 'gc_ms', 'gc_collections'];
const PER_LEVEL = ['pct_frames_over_budget', 'frame_p95', 'frame_p99', 'render_cpu_ms', 'update_cpu_ms', 'gpu_ms', 'draw_calls'];
const FRAME_TIME = new Set(['pct_frames_over_budget', 'frame_p95', 'frame_p99', 'hitches_per_min']);

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

  // An engine build's growth over a run, key by key (objects, nodes, instances, MB): a new leak grows more.
  const mg = t.memory_growth;
  for (const key of Object.keys(c.memory_growth || {})) {
    const r = mg && judge(b.memory_growth?.[key], c.memory_growth[key], { ...mg, abs: /_mb$/.test(key) ? (mg.abs_mb ?? mg.abs) : mg.abs });
    if (r) checks.push({ id: `memory_growth.${key}`, label: `${mg.label} (${key.replace(/_mb$/, ' MB').replace(/_/g, ' ')})`, scope: 'all levels', ...r });
  }

  // An engine build's runs one by one, when there are several: a slower run is not diluted by the others.
  const bs = b.by_scenario || {};
  const cs = c.by_scenario || {};
  if (Object.keys(bs).length > 1 && Object.keys(cs).length > 1) {
    for (const name of Object.keys(cs)) {
      const br = bs[name];
      const cr = cs[name];
      if (!br || br.crashed || cr.crashed) continue;
      const scope = `run "${name}"`;
      for (const key of PER_LEVEL) {
        const r = judge(br[key], cr[key], t[`level.${key}`]);
        if (r) checks.push({ id: `run.${key}.${name}`, label: t[`level.${key}`].label, scope, ...r });
      }
    }
  }
  // Where each run ended up: the same seed reaching another level means the game plays differently now.
  for (const name of Object.keys(cs)) {
    const before = bs[name]?.level_end;
    const after = cs[name]?.level_end;
    if (before != null && after != null && before !== after) checks.push({ id: `run.level_end.${name}`, label: 'Level at the end of the run', scope: `run "${name}"`, before, after, change_pct: null, status: 'warning' });
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
  const sig = (run) => JSON.stringify((run.scenarios || []).map((s) => ({ params: s.params, args: s.args, seconds: s.seconds, warmup: s.warmup })));
  if (sig(baseline) !== sig(candidate)) notes.push('The two runs used different scenarios, so differences may come from the bots rather than the code.');
  if ((baseline.kind || 'web') !== (candidate.kind || 'web')) notes.push('One run played a web game in a browser and the other an engine build: their numbers are not comparable.');
  if (baseline.machine?.gpu && candidate.machine?.gpu && baseline.machine.gpu !== candidate.machine.gpu) notes.push(`Different GPUs (${baseline.machine.gpu} vs ${candidate.machine.gpu}): frame times are not comparable across machines.`);
  else if (!baseline.machine?.gpu && baseline.machine?.cpu && candidate.machine?.cpu && baseline.machine.cpu !== candidate.machine.cpu) notes.push(`Different machines (${baseline.machine.cpu} vs ${candidate.machine.cpu}): frame times are not comparable across machines.`);
  const capped = (candidate.scenarios || []).filter((s) => !s.finished && !s.crashed).length;
  if (capped) notes.push(`${capped} candidate run(s) hit the time cap before finishing.`);
  notes.push(...(candidate.notes || []));

  // Frame times only fail a change when both runs measured the same way. Headless, nothing is drawn and frames run
  // uncapped; against a different frame budget (another refresh rate, or one the SDK misread), slow frames are
  // counted against another line. Either way those checks warn instead of failing.
  const headless = !!(b.headless || c.headless);
  const budgetOf = (s, name) => (name ? s.by_scenario?.[name]?.frame_budget_ms : s.frame_budget_ms);
  const differs = (name) => {
    const x = budgetOf(b, name);
    const y = budgetOf(c, name);
    return x != null && y != null && Math.abs(x - y) > 0.05;
  };
  // The whole-run number mixes every run, so any run on another budget skews it.
  const budgetDiffers = (name) => (name ? differs(name) : differs(null) || Object.keys(c.by_scenario || {}).some(differs));
  const scenarioOf = (id) => (id.startsWith('run.') ? id.split('.').slice(2).join('.') : null);
  const softened = new Set();
  for (const x of checks) {
    if (x.status !== 'regression') continue;
    const metric = x.id.replace(/^(level|run)\./, '').split('.')[0];
    const why = headless && FRAME_TIME.has(metric) ? 'headless' : metric === 'pct_frames_over_budget' && budgetDiffers(scenarioOf(x.id)) ? 'budget' : null;
    if (!why) continue;
    x.status = 'warning';
    softened.add(why);
  }
  if (softened.has('headless') && !c.headless) notes.push('A run was headless, where frames run uncapped: frame times only warn here. Measure with a window to gate on them.');
  if (softened.has('budget')) notes.push(`The runs measured slow frames against different frame budgets (${[b.frame_budget_ms, c.frame_budget_ms].filter((v) => v != null).join(' vs ')} ms overall, or a run's own), so slow frames only warn here.`);

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

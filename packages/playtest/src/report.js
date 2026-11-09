// Markdown reports for a terminal, an agent, or a pull-request comment.

const fmt = (v) => (v == null ? '–' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 })) : String(v));
const change = (c) => (c.change_pct == null ? '' : `${c.change_pct > 0 ? '+' : ''}${c.change_pct}%`);
const runs = (n) => `${n} autoplay run${n === 1 ? '' : 's'}`;
// memory_growth keys as words: orphan_nodes → orphan nodes, static_mb → static MB.
export const growthKey = (k) => k.replace(/_mb$/, ' MB').replace(/_/g, ' ');
const where = (c) => (c.scope === 'all levels' ? c.label : `${c.label}, ${c.scope}`);

function describeRun(run) {
  const git = run.git ? `${run.git.sha}${run.git.dirty ? ' + uncommitted changes' : ''}` : 'no git info';
  return `\`${run.name || 'this run'}\` (${git}, ${run.created?.slice(0, 16).replace('T', ' ')} UTC)`;
}

function table(rows) {
  if (!rows.length) return '';
  return ['| Metric | Baseline | Candidate | Change |', '| --- | ---: | ---: | ---: |', ...rows.map((c) => `| ${where(c)} | ${fmt(c.before)} | ${fmt(c.after)} | ${change(c)} |`)].join('\n');
}

export function comparisonReport(baseline, candidate, cmp) {
  const out = [];
  const n = cmp.regressions.length;
  out.push(`## Glitchless playtest: ${cmp.verdict === 'fail' ? `FAIL, ${n} regression${n === 1 ? '' : 's'}` : 'PASS'}`);
  out.push('');
  out.push(`Baseline ${describeRun(baseline)} vs candidate ${describeRun(candidate)}.`);
  const m = candidate.machine || {};
  out.push(`${runs((candidate.scenarios || []).length)} each · ${candidate.service} · ${[m.browser, m.gpu].filter(Boolean).join(' · ')}`);
  for (const note of cmp.notes) out.push(`\n> ${note}`);
  if (n) out.push('', '### Regressions', '', table(cmp.regressions));
  if (cmp.new_errors.length) {
    out.push('', '### New errors', '');
    for (const e of cmp.new_errors) out.push(`- \`${e.message}\` at ${e.location || 'unknown location'}: ${e.count}× in ${e.sessions} run(s) (fingerprint \`${e.fingerprint}\`)`);
  }
  if (cmp.warnings.length) out.push('', '### Warnings', '', table(cmp.warnings));
  if (cmp.improvements.length) out.push('', '### Improvements', '', table(cmp.improvements));
  if (cmp.fixed_errors.length) {
    out.push('', '### Errors that no longer happen', '');
    for (const e of cmp.fixed_errors) out.push(`- \`${e.message}\` at ${e.location || 'unknown location'}`);
  }
  out.push(...crashedRuns(candidate));
  const same = cmp.checks.filter((c) => c.status === 'same');
  if (same.length) out.push('', '<details><summary>Unchanged metrics</summary>', '', table(same), '', '</details>');
  return out.join('\n');
}

// An engine build's crashed or frozen runs, with the last lines each printed: what an agent needs to fix it.
function crashedRuns(run) {
  const crashed = (run.scenarios || []).filter((r) => r.crashed);
  if (!crashed.length) return [];
  const out = ['', '### Crashed runs', ''];
  for (const r of crashed) out.push(`- ${r.scenario || 'run'}: ${r.reason}, after ${r.elapsed_s} s. Last lines it printed:`, '', '```', r.output_tail || '(nothing)', '```', '');
  return out;
}

export function runReport(run) {
  const s = run.summary || {};
  const engine = run.kind === 'engine';
  const out = [`## Glitchless playtest run ${describeRun(run)}`, ''];
  out.push(`${runs((run.scenarios || []).length)} · ${run.service} · ${[run.machine?.browser, run.machine?.gpu].filter(Boolean).join(' · ')}`, '');
  out.push('| Metric | Value |', '| --- | ---: |');
  // A web run always shows the browser's metrics; an engine build only what its engine reports.
  const rows = [
    ['Slow frames (% over budget)', s.pct_frames_over_budget, true],
    ['Frame time p95 (ms)', s.frame_p95, true],
    ['Frame time p99 (ms)', s.frame_p99],
    ['Render CPU per frame (ms)', s.render_cpu_ms, true],
    ['Update CPU per frame (ms)', s.update_cpu_ms],
    ['GPU per frame (ms)', s.gpu_ms],
    ['RHI thread per frame (ms)', s.rhi_cpu_ms],
    ['Physics per frame (ms)', s.physics_ms],
    ['Draw calls per frame', s.draw_calls, true],
    ['Hitches per minute', s.hitches_per_min, true],
    ['Errors per run', s.errors_per_session, true],
    ['Crashed runs', s.crashes, true],
    ['Deaths per run', s.deaths_per_session, !engine],
    ['Level completion (%)', s.level_completion_pct, !engine],
    ['Garbage collection per run (ms)', s.gc_ms],
    ['Garbage collections per run', s.gc_collections],
  ];
  for (const [k, v, always] of rows) if (v != null || (always && !engine)) out.push(`| ${k} | ${fmt(v)} |`);
  const growth = Object.entries(s.memory_growth || {}).filter(([, v]) => v);
  if (growth.length) out.push('', `Growth over a run: ${growth.map(([k, v]) => `${growthKey(k)} ${v > 0 ? '+' : ''}${fmt(v)}`).join(', ')}.`);
  if (engine && s.by_scenario) {
    out.push('', '| Run | Frames | Slow frames (%) | Frame p95 (ms) | Frame p99 (ms) | Hitches | Errors | Levels |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const [name, r] of Object.entries(s.by_scenario)) {
      if (r.crashed) out.push(`| ${name} | crashed (${r.reason}) | | | | | | |`);
      else out.push(`| ${name} | ${fmt(r.frames)} | ${fmt(r.pct_frames_over_budget)} | ${fmt(r.frame_p95)} | ${fmt(r.frame_p99)} | ${fmt(r.hitches)} | ${fmt(r.errors)} | ${r.level_start == null && r.level_end == null ? '–' : r.level_start === r.level_end ? r.level_end : `${r.level_start ?? '–'} → ${r.level_end ?? '–'}`} |`);
    }
  }
  const levels = Object.entries(s.levels || {});
  if (levels.length) {
    const update = levels.some(([, v]) => v.update_cpu_ms != null);
    out.push('', `| Level | Slow frames (%) | Frame p95 (ms) | Draw calls | Render CPU (ms) |${update ? ' Update CPU (ms) |' : ''}`, `| --- | ---: | ---: | ---: | ---: |${update ? ' ---: |' : ''}`);
    for (const [l, v] of levels) out.push(`| ${l} | ${fmt(v.pct_frames_over_budget)} | ${fmt(v.frame_p95)} | ${fmt(v.draw_calls)} | ${fmt(v.render_cpu_ms)} |${update ? ` ${fmt(v.update_cpu_ms)} |` : ''}`);
  }
  if (s.errors?.length) {
    out.push('', 'Errors:');
    for (const e of s.errors) out.push(`- \`${e.message}\` at ${e.location || 'unknown location'}: ${e.count}×`);
  }
  out.push(...crashedRuns(run));
  for (const note of run.notes || []) out.push('', `> ${note}`);
  return out.join('\n');
}

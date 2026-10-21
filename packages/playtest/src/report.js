// Markdown reports for a terminal, an agent, or a pull-request comment.

const fmt = (v) => (v == null ? '–' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 })) : String(v));
const change = (c) => (c.change_pct == null ? '' : `${c.change_pct > 0 ? '+' : ''}${c.change_pct}%`);
const runs = (n) => `${n} autoplay run${n === 1 ? '' : 's'}`;
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
  const same = cmp.checks.filter((c) => c.status === 'same');
  if (same.length) out.push('', '<details><summary>Unchanged metrics</summary>', '', table(same), '', '</details>');
  return out.join('\n');
}

export function runReport(run) {
  const s = run.summary || {};
  const out = [`## Glitchless playtest run ${describeRun(run)}`, ''];
  out.push(`${runs((run.scenarios || []).length)} · ${run.service} · ${[run.machine?.browser, run.machine?.gpu].filter(Boolean).join(' · ')}`, '');
  out.push('| Metric | Value |', '| --- | ---: |');
  const rows = [
    ['Slow frames (% over budget)', s.pct_frames_over_budget],
    ['Frame time p95 (ms)', s.frame_p95],
    ['Render CPU per frame (ms)', s.render_cpu_ms],
    ['Draw calls per frame', s.draw_calls],
    ['Hitches per minute', s.hitches_per_min],
    ['Errors per run', s.errors_per_session],
    ['Crashed runs', s.crashes],
    ['Deaths per run', s.deaths_per_session],
    ['Level completion (%)', s.level_completion_pct],
  ];
  for (const [k, v] of rows) out.push(`| ${k} | ${fmt(v)} |`);
  const levels = Object.entries(s.levels || {});
  if (levels.length) {
    out.push('', '| Level | Slow frames (%) | Frame p95 (ms) | Draw calls | Render CPU (ms) |', '| --- | ---: | ---: | ---: | ---: |');
    for (const [l, v] of levels) out.push(`| ${l} | ${fmt(v.pct_frames_over_budget)} | ${fmt(v.frame_p95)} | ${fmt(v.draw_calls)} | ${fmt(v.render_cpu_ms)} |`);
  }
  if (s.errors?.length) {
    out.push('', 'Errors:');
    for (const e of s.errors) out.push(`- \`${e.message}\` at ${e.location || 'unknown location'}: ${e.count}×`);
  }
  return out.join('\n');
}

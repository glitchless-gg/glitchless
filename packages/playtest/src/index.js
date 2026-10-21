// Glitchless playtest: autoplay bots play the game on the current code, and the result is compared with
// a saved baseline. Used by the glitchless-playtest CLI and the glitchless_playtest MCP tool.
//
//   await playtest({ saveAs: 'baseline' })          // before a change
//   await playtest({ compareTo: 'baseline' })       // after it → { verdict, report, ... }

import { loadConfig } from './config.js';
import { playtestRun, fetchSummary } from './run.js';
import { compareRuns } from './compare.js';
import { comparisonReport, runReport } from './report.js';
import { saveRun, loadRun, listRuns } from './runs.js';

export { loadConfig, DEFAULT_SCENARIOS, DEFAULT_THRESHOLDS } from './config.js';
export { compareRuns, judge } from './compare.js';
export { comparisonReport, runReport } from './report.js';
export { saveRun, loadRun, listRuns } from './runs.js';
export { playtestRun, loadPlaywright } from './run.js';

/**
 * @param {object} o
 * @param {string} [o.saveAs]       save this run under a name (e.g. "baseline")
 * @param {string} [o.compareTo]    compare with a saved run (default "baseline" when it exists and we're not saving over it)
 * @param {string} [o.baselineUrl]  play a baseline against another running build first, then compare
 * @param {boolean} [o.quick]       first scenario only
 * @param {number} [o.maxSeconds]   cap each run
 * @param {object} [o.config]       overrides for glitchless.playtest.json / defaults (game, server, service, channel, headed, api_key)
 * @param {(msg: string) => void} [o.log]
 */
export async function playtest({ saveAs, compareTo, baselineUrl, quick = false, maxSeconds, config = {}, cwd = process.cwd(), log = () => {} } = {}) {
  const cfg = loadConfig(cwd, config);
  let scenarios = quick ? cfg.scenarios.slice(0, 1) : cfg.scenarios;
  if (maxSeconds) scenarios = scenarios.map((s) => ({ ...s, max_s: maxSeconds }));

  let baseline = null;
  if (baselineUrl) {
    log(`Baseline: playing ${baselineUrl}`);
    baseline = { ...(await playtestRun(cfg, { game: baselineUrl, scenarios, log })), name: 'baseline-url' };
  } else {
    const target = compareTo ?? (saveAs === 'baseline' ? null : 'baseline');
    if (target) {
      baseline = loadRun(cfg.runs_dir, target);
      if (!baseline && compareTo) throw new Error(`No saved playtest run named "${compareTo}" in ${cfg.runs_dir}. Saved runs: ${listRuns(cfg.runs_dir).join(', ') || 'none'}. Save one first with --save ${compareTo}.`);
      if (baseline?.scenarios && !quick && baseline.scenarios.length === 1 && scenarios.length > 1) {
        scenarios = scenarios.slice(0, 1); // the baseline was a quick run; play the same scenario
      }
    }
  }

  log(`Candidate: playing ${cfg.game}`);
  const candidate = await playtestRun(cfg, { scenarios, log });
  const files = { latest: saveRun(cfg.runs_dir, 'latest', candidate) };
  if (saveAs) files[saveAs] = saveRun(cfg.runs_dir, saveAs, candidate);
  candidate.name = saveAs || 'latest';

  if (!baseline) {
    const report = `${runReport(candidate)}\n\n${saveAs ? `Saved as \`${saveAs}\`.` : 'No baseline to compare with. Save one before changing the code with `--save baseline`.'}`;
    return { verdict: 'none', report, candidate, files };
  }
  baseline = await matchingBaseline(cfg, baseline, candidate, log);
  const comparison = compareRuns(baseline, candidate, cfg.thresholds);
  return { verdict: comparison.verdict, report: comparisonReport(baseline, candidate, comparison), comparison, baseline, candidate, files };
}

// A quick run plays fewer scenarios than a full baseline. Comparing it with the baseline's totals
// would mix in runs the candidate never played, so ask the server for just the matching baseline
// sessions. If the server no longer has them, keep the full baseline (compareRuns notes the mismatch).
async function matchingBaseline(cfg, baseline, candidate, log) {
  const key = (s) => JSON.stringify(s.params);
  const wanted = new Set((candidate.scenarios || []).map(key));
  const have = baseline.scenarios || [];
  const subset = have.filter((s) => wanted.has(key(s)) && s.session_id);
  if (subset.length === have.length || subset.length !== wanted.size) return baseline;
  try {
    const created = Date.parse(baseline.created);
    log(`Comparing with the ${subset.length} matching baseline run(s) only`);
    const summary = await fetchSummary(cfg, baseline.service, subset.map((s) => s.session_id), created - 2 * 3600e3, { log, timeoutMs: 0 });
    if (!summary?.sessions) return baseline;
    return { ...baseline, scenarios: subset, summary, name: `${baseline.name} (matching runs)` };
  } catch {
    return baseline;
  }
}

// Compare two saved runs without playing anything.
export function compareSaved(a, b, { cwd = process.cwd(), config = {} } = {}) {
  const cfg = loadConfig(cwd, config);
  const baseline = loadRun(cfg.runs_dir, a);
  const candidate = loadRun(cfg.runs_dir, b);
  if (!baseline || !candidate) throw new Error(`Saved runs needed: ${[!baseline && a, !candidate && b].filter(Boolean).join(', ')} not found in ${cfg.runs_dir}.`);
  const comparison = compareRuns(baseline, candidate, cfg.thresholds);
  return { verdict: comparison.verdict, report: comparisonReport(baseline, candidate, comparison), comparison, baseline, candidate };
}

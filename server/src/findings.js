// Findings: turns raw telemetry into ranked, evidence-backed findings.
// Written for two readers: a human on the dashboard, and a coding agent over MCP — so every
// finding says what's wrong, how sure we are (numbers), where to look, and what usually fixes it.

import { performance, errorIssues, funnel, versions, deathHotspots, eventLift, deathsOf, levelFacts, round, pct } from './analytics.js';
import { inFirstSeenOrder, valueQuantile, valueCount, addValueMaps } from './facts.js';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function findings(ctx, maps = []) {
  const out = [];
  const perf = performance(ctx);
  const budget = perf.kpis.frame_budget_ms || 16.67;
  const totalSessions = ctx.sessions.size || 1;

  // 1. Frame-time spikes per level, with correlated gauges and preceding events.
  const levels = perf.by_level.filter((l) => l.frames > 300 && l.key !== '(menu)');
  const best = levels.reduce((b, l) => (l.p95 != null && (!b || l.p95 < b.p95) ? l : b), null);
  for (const l of levels) {
    if (l.p95 == null || l.p95 < Math.max(budget * 1.5, 22)) continue;
    const severity = l.p95 >= 50 ? 'critical' : l.p95 >= 33.3 ? 'high' : 'medium';
    const facts = levelFacts(ctx, l.key);
    const corr = correlateGauges(facts);
    const preceding = eventLift(ctx, l.key).filter((p) => p.lift >= 2);
    const evidenceBits = [];
    if (corr[0]) evidenceBits.push(`hitches coincide with high \`${corr[0].key}\` (median ${fmt(corr[0].during)} during hitches vs ${fmt(corr[0].otherwise)} otherwise)`);
    if (preceding[0] && preceding[0].share >= 0.3) evidenceBits.push(`${Math.round(preceding[0].share * 100)}% of hitches come within 1.5s of a \`${preceding[0].event}\` event (${preceding[0].lift}× its base rate)`);
    const carried = carriedGauges(ctx, l.key, best?.key);
    if (!corr.length && carried[0]) evidenceBits.push(`\`${carried[0].key}\` sits at ${fmt(carried[0].here)} for this whole level vs ${fmt(carried[0].baseline)} on ${best.key} — objects created earlier are never cleaned up`);
    if (l.draw_calls && best?.draw_calls && l.draw_calls > best.draw_calls * 2) evidenceBits.push(`draw calls average ${fmt(l.draw_calls)} (${best.key}: ${fmt(best.draw_calls)})`);
    const causes = { ...facts.hc };
    const engine = engineOf([...ctx.sessions.values()].filter((s) => s.fwLevels.has(l.key)));
    out.push({
      id: `perf-level-${l.key}`,
      severity,
      category: 'performance',
      title: `Frame-time spikes on ${l.key}: p95 ${l.p95}ms vs ${round(budget, 1)}ms budget`,
      summary:
        `${l.key} misses the frame budget on ${l.pct_over_budget}% of frames (${l.hitches_per_min} hitches/min${best && best.key !== l.key ? `; ${best.key} p95 is ${best.p95}ms` : ''}).` +
        (evidenceBits.length ? ` Evidence: ${evidenceBits.join('; ')}.` : ''),
      evidence: { level: l.key, p50: l.p50, p95: l.p95, p99: l.p99, hitches_per_min: l.hitches_per_min, draw_calls_avg: l.draw_calls, draw_calls_max: l.draw_calls_max, correlated_gauges: corr.slice(0, 3), carried_over_gauges: carried.slice(0, 3), preceding_events: preceding.slice(0, 3), hitch_causes: causes, sessions: l.sessions },
      suggestion: perfSuggestion(corr.length ? corr : carried, preceding, causes, l, engine),
      link: { page: 'performance', level: l.key },
      impact: l.sessions / totalSessions,
    });
  }

  // 2. GPU / scene memory leaks: geometry counts that grow with every level load.
  const leaky = Object.entries(perf.memory).filter(([, m]) => m.geometries_growth_per_level_load >= 40 && m.sessions >= 3);
  const latestLeak = leaky.sort((a, b) => semver(b[0], a[0]))[0];
  for (const [version, m] of latestLeak ? [latestLeak] : []) {
    const older = leaky.filter(([v]) => v !== version).map(([v, o]) => `${v}: +${Math.round(o.geometries_growth_per_level_load)}`);
    out.push({
      id: `leak-geometries-${version}`,
      severity: m.geometries_growth_per_level_load > 150 ? 'high' : 'medium',
      category: 'memory',
      title: `Geometry leak in ${version}: +${Math.round(m.geometries_growth_per_level_load)} geometries per level load`,
      summary: `Across ${m.sessions} sessions with 2+ level loads, renderer geometry count grows from a median of ${fmt(m.median_first)} to ${fmt(m.median_last)} and never comes back down${older.length ? ` (also in ${older.join(', ')} per load)` : ''}. GPU memory grows until low-end devices stutter or lose the WebGL context.`,
      evidence: { version, ...m },
      suggestion: 'When unloading a level, call geometry.dispose(), material.dispose() and texture.dispose() for everything you remove (scene.remove() alone does not free GPU memory). Share one geometry/material across identical tiles instead of creating one per mesh.',
      link: { page: 'performance', section: 'memory' },
      impact: m.sessions / totalSessions,
    });
  }

  // 2b. Godot node leaks: orphan nodes (removed from the tree, never freed) that pile up with every level load.
  const orphaned = Object.entries(perf.node_growth).filter(([, m]) => m.orphan_nodes_growth_per_level_load >= 40 && m.sessions >= 3);
  const latestOrphans = orphaned.sort((a, b) => semver(b[0], a[0]))[0];
  for (const [version, m] of latestOrphans ? [latestOrphans] : []) {
    const older = orphaned.filter(([v]) => v !== version).map(([v, o]) => `${v}: +${Math.round(o.orphan_nodes_growth_per_level_load)}`);
    const treeGrows = m.nodes_growth_per_level_load >= 40;
    out.push({
      id: `leak-orphan-nodes-${version}`,
      severity: m.orphan_nodes_growth_per_level_load > 250 ? 'high' : 'medium',
      category: 'memory',
      title: `Node leak in ${version}: +${Math.round(m.orphan_nodes_growth_per_level_load)} orphan nodes per level load`,
      summary: `Across ${m.sessions} sessions with 2+ level loads, orphan nodes (taken out of the scene tree but never freed) grow from a median of ${fmt(m.orphan_nodes_median_first)} to ${fmt(m.orphan_nodes_median_last)} and never come back down${older.length ? ` (also in ${older.join(', ')} per load)` : ''}.${treeGrows ? ` The live tree grows too, from ${fmt(m.nodes_median_first)} to ${fmt(m.nodes_median_last)} nodes.` : ''} Each orphan keeps its memory, scripts and resources, so memory climbs with every level until a phone runs out and the OS kills the game.`,
      evidence: { version, ...m },
      suggestion:
        'Call queue_free() on every node you take out of the tree: remove_child() alone does not free it. Don\'t keep references to removed nodes in arrays, dictionaries or autoloads; clear them when the level ends. To find the culprits, call Node.print_orphan_nodes() in a debug build after a level change.' +
        (treeGrows ? ' The live tree grows as well, so also look for nodes added to an autoload or get_tree().root that outlive their level.' : ''),
      link: { page: 'performance', section: 'memory' },
      impact: m.sessions / totalSessions,
    });
  }

  // 3. Errors, ranked by sessions affected.
  for (const issue of errorIssues(ctx).slice(0, 6)) {
    if (issue.sessions < 2 && issue.count < 5) continue;
    const share = issue.sessions / totalSessions;
    const severity = issue.kind === 'webgl_context_lost' || share > 0.25 ? 'high' : share > 0.05 ? 'medium' : 'low';
    const crumbs = issue.breadcrumbs?.map((b) => b.name || b.type).filter(Boolean).slice(-4) || [];
    out.push({
      id: `error-${issue.fingerprint}`,
      severity,
      category: 'stability',
      title: `${issue.message.slice(0, 90)}`,
      summary: `${issue.count} occurrences in ${issue.sessions} sessions (${issue.sessions_pct}% of sessions)${issue.levels.length ? ` on ${issue.levels.join(', ')}` : ''}, first seen in ${issue.first_version}. ${issue.fatal ? (issue.kind === 'script' ? 'Unhandled script error — the function stopped part way.' : 'Unhandled — reaches window.onerror.') : ''}${crumbs.length ? ` Typically right after: ${crumbs.join(' → ')}.` : ''}`,
      evidence: { fingerprint: issue.fingerprint, kind: issue.kind, location: issue.location, stack: issue.stack?.split('\n').slice(0, 6).join('\n'), count: issue.count, sessions: issue.sessions, versions: issue.versions, levels: issue.levels, breadcrumbs: issue.breadcrumbs },
      suggestion: !issue.location
        ? 'Reproduce with the breadcrumbs above and guard the failing path.'
        : engineOf([ctx.sessions.get(issue.sample_session)]) === 'godot'
          ? `Start at ${issue.location}. The error fires during normal play (not on load), so look for a node that is null or already freed (a get_node() path that no longer exists, or a node freed earlier: check is_instance_valid()) or a missing dictionary key on the code path triggered by ${crumbs.at(-1) || 'the preceding game event'}. Make it fail safe and apply game state (score, pickups) before anything that can fail: release exports skip most script errors silently, and a call on a typed null crashes the game.`
          : `Start at ${issue.location}. The error fires during normal play (not on load), so look for an unchecked lookup (e.g. a pool/array .find() returning undefined) on the code path triggered by ${crumbs.at(-1) || 'the preceding game event'}. Make it fail safe and make sure game state (score, pickups) is applied before anything that can throw.`,
      link: { page: 'errors', fingerprint: issue.fingerprint },
      impact: share,
    });
  }

  // 4. Difficulty spikes: death hotspots + rage quits.
  const fun = funnel(ctx);
  for (let i = 0; i < fun.length; i++) {
    const l = fun[i];
    const deaths = deathsOf(ctx, l.level).filter((d) => typeof d.x === 'number');
    if (deaths.length < 10) continue;
    const ragers = new Map();
    for (const s of ctx.sessions.values()) if (s.rage_quit && s.rage?.level === l.level) ragers.set(s.session_id, s.rage.ts);
    const spots = deathHotspots(
      deaths.map((d) => ({ ...d, rage_quit: ragers.get(d.session_id) === d.ts })),
      maps.find((m) => m.level === l.level)?.axis || 'xy',
    );
    const top = spots[0];
    if (!top || top.share < 0.3) continue;
    const prev = fun[i - 1];
    const dropVsPrev = prev?.completion_pct != null && l.completion_pct != null ? round(prev.completion_pct - l.completion_pct, 1) : null;
    const severity = top.share > 0.5 && (l.rage_quit_pct > 10 || (l.completion_pct ?? 100) < 50) ? 'high' : 'medium';
    out.push({
      id: `design-hotspot-${l.level}-${Math.round(top.x)}`,
      severity,
      category: 'design',
      title: `Difficulty spike on ${l.level} at x≈${top.x}: ${Math.round(top.share * 100)}% of the level's deaths`,
      summary: `${top.deaths} of ${deaths.length} deaths on ${l.level} happen between x=${top.x_range[0]} and x=${top.x_range[1]} (mostly "${top.top_cause}"). Completion rate is ${l.completion_pct}%${dropVsPrev != null ? ` (${dropVsPrev > 0 ? '-' : '+'}${Math.abs(dropVsPrev)} pts vs ${prev.level})` : ''} and ${l.rage_quits} sessions rage-quit here (${l.rage_quit_pct}% of sessions that reached it).`,
      evidence: { level: l.level, hotspot: top, other_hotspots: spots.slice(1, 3), completion_pct: l.completion_pct, previous_level_completion_pct: prev?.completion_pct ?? null, deaths_per_session: l.deaths_per_session, rage_quits: l.rage_quits, rage_quit_pct: l.rage_quit_pct },
      suggestion: `Look at the level data around x=${top.x_range[0]}–${top.x_range[1]}: if it's a ${top.top_cause === 'fell' ? 'gap, shorten it or widen the landing platform' : 'hazard, telegraph it earlier or reduce its speed/range'}, consider a checkpoint just before it, then compare completion and rage-quit rates between versions to confirm the fix.`,
      link: { page: 'players', level: l.level },
      impact: (l.sessions || 0) / totalSessions,
    });
  }

  // 5. Version-over-version regressions and wins.
  const vers = versions(ctx).filter((v) => v.sessions >= 5);
  if (vers.length >= 2) {
    const [prev, cur] = vers.slice(-2);
    const p95Delta = prev.frame_p95 && cur.frame_p95 ? (cur.frame_p95 - prev.frame_p95) / prev.frame_p95 : 0;
    const changes = [];
    if (Math.abs(p95Delta) >= 0.15) changes.push(`p95 frame time ${prev.frame_p95}ms → ${cur.frame_p95}ms`);
    if (Math.abs((cur.error_free_pct ?? 0) - (prev.error_free_pct ?? 0)) >= 5) changes.push(`error-free sessions ${prev.error_free_pct}% → ${cur.error_free_pct}%`);
    if (Math.abs((cur.level_completion_pct ?? 0) - (prev.level_completion_pct ?? 0)) >= 5) changes.push(`level completion ${prev.level_completion_pct}% → ${cur.level_completion_pct}%`);
    if (Math.abs((cur.rage_quit_pct ?? 0) - (prev.rage_quit_pct ?? 0)) >= 3) changes.push(`rage quits ${prev.rage_quit_pct}% → ${cur.rage_quit_pct}%`);
    if (changes.length) {
      const better = p95Delta < 0 || (cur.error_free_pct ?? 0) > (prev.error_free_pct ?? 0);
      out.push({
        id: `version-${prev.version}-${cur.version}`,
        severity: better ? 'info' : p95Delta > 0.3 ? 'high' : 'medium',
        category: 'release',
        title: `${cur.version} vs ${prev.version}: ${better ? 'improved' : 'regressed'} — ${changes[0]}`,
        summary: changes.join('; ') + '.',
        evidence: { previous: prev, current: cur },
        suggestion: better ? 'Ship it. Keep the monitor on p95 frame time so this improvement is protected.' : `Diff ${prev.version}..${cur.version} for changes to rendering, effects or level loading.`,
        link: { page: 'versions' },
        impact: cur.sessions / totalSessions,
      });
    }
  }

  // 6. Device gap: low-tier GPUs far worse than high-tier.
  const hi = perf.by_gpu_tier.find((t) => t.key === 'high' || t.key === 'mid');
  const lo = perf.by_gpu_tier.find((t) => t.key === 'low');
  if (hi && lo && lo.sessions >= 3 && lo.p95 > Math.max(hi.p95 * 2, 25)) {
    out.push({
      id: 'device-gap-low-tier',
      severity: 'medium',
      category: 'performance',
      title: `Low-tier GPUs struggle: p95 ${lo.p95}ms vs ${hi.p95}ms on ${hi.key}-tier`,
      summary: `${lo.sessions} sessions on low-tier GPUs (integrated Intel HD/UHD, mobile) spend ${lo.pct_over_budget}% of frames over budget.`,
      evidence: { low: lo, reference: hi },
      suggestion:
        engineOf([...ctx.sessions.values()].filter((s) => s.device?.gpu_tier === 'low')) === 'godot'
          ? 'Add a quality tier: when gpu_tier is low or p95 stays above budget for 5s, render 3D at a lower resolution (Viewport.scaling_3d_scale around 0.7), turn off shadows, glow and SSAO in the WorldEnvironment, drop MSAA and halve particle amounts.'
          : 'Add a quality tier: cap devicePixelRatio at 1.5, disable shadows/post-processing and halve particle counts when gpu_tier is low or p95 stays above budget for 5s.',
      link: { page: 'performance', section: 'devices' },
      impact: lo.sessions / totalSessions,
    });
  }

  // 7. Slow first frame.
  if (perf.kpis.ttff_p95 && perf.kpis.ttff_p95 > 4000) {
    const godot = engineOf([...ctx.sessions.values()].filter((s) => s.ttff != null)) === 'godot';
    out.push({
      id: 'load-ttff',
      severity: perf.kpis.ttff_p95 > 8000 ? 'high' : 'medium',
      category: 'performance',
      title: `Slow start: p95 time-to-first-frame is ${(perf.kpis.ttff_p95 / 1000).toFixed(1)}s`,
      summary: godot
        ? 'Players expect to be playing within seconds of opening the game, and some give up during a long splash screen.'
        : 'Web portals expect gameplay within ~20s and every extra second costs conversion-to-play.',
      evidence: { ttff_p50: perf.kpis.ttff_p50, ttff_p95: perf.kpis.ttff_p95 },
      suggestion: godot
        ? 'Keep the first scene small and load the rest in the background with ResourceLoader.load_threaded_request(), preload() only what the first screen needs, turn on the Shader Baker in the export preset (Godot 4.5+) so the first frame does not wait on shader compiles, and use VRAM-compressed textures.'
        : 'Lazy-load non-first-level assets, compress textures (KTX2/Basis) and meshes (Draco/Meshopt), and warm shaders with renderer.compileAsync before the first frame.',
      link: { page: 'performance', section: 'load' },
      impact: 1,
    });
  }

  return out
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.impact - a.impact)
    .map((f) => ({ ...f, impact: round(f.impact, 3), impact_pct: pct(f.impact, 1) }));
}

// Gauges whose median during this level's hitches is far above their median in its calm frame windows.
function correlateGauges(facts) {
  const out = [];
  for (const key of inFirstSeenOrder(facts.hk)) {
    if (valueCount(facts.hg[key]) < 3) continue;
    const d = valueQuantile(facts.hg[key], 0.5);
    const o = valueCount(facts.wc[key]) ? valueQuantile(facts.wc[key], 0.5) : 0;
    const ratio = (d + 1) / (o + 1);
    if (ratio >= 2) out.push({ key, during: d, otherwise: o, ratio: round(ratio, 1) });
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

// Gauges that are high for the whole level (not just during hitches) compared with the smoothest level.
function carriedGauges(ctx, level, baselineLevel) {
  if (!baselineLevel || baselineLevel === level) return [];
  // Every frame window's gauges: calm ones and those with hitches.
  const values = (lvl) => {
    const f = levelFacts(ctx, lvl);
    // Listed as an object's keys would be (integer-like keys first), as the raw path collected them.
    const keys = Object.keys(Object.fromEntries(inFirstSeenOrder(f.wk).map((k) => [k, 1])));
    return { keys, counts: addValueMaps(addValueMaps({}, f.wc), f.wh) };
  };
  const here = values(level);
  const base = values(baselineLevel);
  return here.keys
    .map((key) => ({ key, here: valueQuantile(here.counts[key], 0.5), baseline: valueQuantile(base.counts[key] || { 0: 1 }, 0.5) ?? 0 }))
    .filter((g) => g.here >= 50 && g.here > (g.baseline + 1) * 3)
    .sort((a, b) => b.here / (b.baseline + 1) - a.here / (a.baseline + 1));
}

// Which SDK sent most of these sessions, so fix advice names that engine's APIs (three.js for the browser SDK).
function engineOf(sessions) {
  let godot = 0;
  let n = 0;
  for (const s of sessions) {
    n++;
    if (s?.sdk?.startsWith('glitchless-godot/')) godot++;
  }
  return godot * 2 > n ? 'godot' : 'web';
}

// One tip per Godot hitch cause. The SDK names causes from what the long frame measured: pipeline
// compiles, a scene swap, 50+ nodes added, or process / physics / render time taking the frame.
const GODOT_CAUSE_TIPS = {
  shader_compile: 'Some hitches compile rendering pipelines: draw every material, mesh and particle effect the level uses once behind the loading screen (e.g. off-camera) so it compiles before play, and don\'t create new material variants mid-level; on Forward+ and Mobile, Godot 4.4+ ubershaders cover most of the rest.',
  node_spawn: 'Some hitches add many nodes in one frame: pool and reuse nodes instead of calling instantiate() and add_child() in a burst, and draw many copies with one MultiMeshInstance2D/3D or GPUParticles node instead of a node each.',
  scene_change: 'Some hitches come with a scene change: load the next scene in the background with ResourceLoader.load_threaded_request() and switch once load_threaded_get_status() reports it loaded.',
  script: 'Some hitches are long _process() or _physics_process() frames: spread big loops, sorts and searches over several frames (or a WorkerThreadPool task) and cache get_node() lookups.',
  physics: 'Some hitches are long physics steps: cut the number of active bodies and Area overlaps, use simple collision shapes, and turn off monitoring on areas that don\'t need it.',
  render: 'Some hitches are long render frames: cut draw calls and shadow-casting lights, and batch repeated meshes with MultiMesh.',
  frozen: 'Some frames froze for over 0.7s: something blocked the main thread (a large load() or instantiate(), or a long loop); move it to a background thread or behind a loading screen.',
};

function godotPerfSuggestion(corr, preceding, causes, level) {
  const tips = [];
  const gauge = corr[0]?.key;
  const trigger = preceding[0]?.share >= 0.3 ? preceding[0].event : null;
  if (gauge || trigger) {
    tips.push(
      `Find the code that runs on ${trigger ? `\`${trigger}\`` : 'the hitch'}${gauge ? ` and drives \`${gauge}\`` : ''}. If it spawns many nodes, draw them with one MultiMeshInstance2D/3D or GPUParticles node instead of a node each, pool and reuse nodes instead of calling instantiate() per effect, and queue_free() them (or return them to the pool) when the effect ends.`,
    );
  }
  if (gauge === 'orphan_nodes') tips.push('`orphan_nodes` counts nodes taken out of the tree but never freed: call queue_free() on what you remove (remove_child() alone does not free it) and drop references to removed nodes.');
  const top = Object.entries(causes).filter(([c]) => GODOT_CAUSE_TIPS[c]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [c] of top) tips.push(GODOT_CAUSE_TIPS[c]);
  if (!tips.length) tips.push(`Profile ${level.key} with the Profiler and Visual Profiler in Godot's Debugger panel; check draw calls (${level.draw_calls} avg) in the Monitors tab.`);
  return tips.join(' ');
}

function perfSuggestion(corr, preceding, causes, level, engine) {
  if (engine === 'godot') return godotPerfSuggestion(corr, preceding, causes, level);
  const tips = [];
  const gauge = corr[0]?.key;
  const trigger = preceding[0]?.share >= 0.3 ? preceding[0].event : null;
  if (gauge || trigger) {
    tips.push(
      `Find the code that runs on ${trigger ? `\`${trigger}\`` : 'the hitch'}${gauge ? ` and drives \`${gauge}\`` : ''}. If it creates many meshes, render them with one InstancedMesh or THREE.Points, share a single geometry/material, pool objects instead of allocating per effect, and remove + dispose() them when the effect ends.`,
    );
  }
  if (causes.shader_compile) tips.push('Some hitches coincide with new shader programs: pre-compile materials with renderer.compileAsync(scene, camera) during loading.');
  if (causes.gc) tips.push('Heap drops during hitches suggest GC pauses: avoid per-frame allocations (new Vector3, arrays, closures) in the update loop.');
  if (causes.asset_load) tips.push('Hitches overlap asset loads: preload before the level starts.');
  if (!tips.length) tips.push(`Profile ${level.key} with the overlay open and \`glitchless_measure\`; check draw calls (${level.draw_calls} avg) and triangles.`);
  return tips.join(' ');
}

function semver(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function fmt(v) {
  if (v == null) return '–';
  return v >= 1000 ? v.toLocaleString('en-US') : String(Math.round(v * 10) / 10);
}

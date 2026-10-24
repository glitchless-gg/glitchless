// Findings: turns raw telemetry into ranked, evidence-backed findings.
// Written for two readers: a human on the dashboard, and a coding agent over MCP — so every
// finding says what's wrong, how sure we are (numbers), where to look, and what usually fixes it.

import { performance, errorIssues, funnel, versions, deathHotspots, eventLift, deathsOf, levelFacts, sessionCount, gaugeClimbs, noWin, rageDeathTs, quantile, round, pct } from './analytics.js';
import { dailySdks } from './daily.js';
import { inFirstSeenOrder, valueQuantile, valueCount, addValueMaps } from './facts.js';
import { reportFindings } from './reports.js';
import { storeFindings } from './reviews.js';
import { WEB_ENGINES, WEB_ENGINE_FATAL_WORDS, WEB_ENGINE_QUALITY_TIPS, WEB_ENGINE_SLOW_START_TIPS, webEngineErrorSuggestion, webEnginePerfSuggestion } from './web-engine-advice.js';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const PROGRESS = /score|point|xp|coin|gold|money|cash|kill|time|elapsed|distance|depth|wave|level|round|turn|stage|streak|combo|best|second/i;

// Hitch causes (SPEC §2 `hitch`, and each engine's in §5–§5c) as a title names them. A load cause is the level
// loading; a generic one says only where the frame's time went.
const CAUSE_WORDS = {
  pso_compile: 'pipeline states created on first use',
  shader_compile: 'shader compiles',
  gc: 'garbage collection',
  level_stream: 'streamed levels',
  asset_load: 'asset loads',
  node_spawn: 'nodes added in bursts',
  object_spawn: 'objects spawned in bursts',
  texture_upload: 'texture uploads',
  geometry_upload: 'geometry uploads',
  physics: 'long physics steps',
  script: 'long game code frames',
  render: 'long render frames',
  frozen: 'frozen frames',
};
const LOAD_CAUSES = ['map_load', 'scene_change'];
const GENERIC_CAUSES = ['script', 'render', 'frozen'];
// Stalls worth naming however rarely they come: a shader or pipeline built the first time something is drawn.
const COMPILE_CAUSES = ['pso_compile', 'shader_compile'];

export function findings(ctx, maps = []) {
  const out = [];
  const perf = performance(ctx);
  const budget = perf.kpis.frame_budget_ms || 16.67;
  const totalSessions = sessionCount(ctx) || 1;

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
    const engine = engineIn(ctx, (s) => s.fwLevels.has(l.key));
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

  // 1b. Hitches on a level whose p95 is within budget: one-off stalls during play (a pipeline state created
  // the first time an effect is drawn, a garbage collection every so often) that players feel and percentiles
  // hide. Hitches with a level's own load (a map load, a scene change) are the load, not play, and don't count.
  // A load usually does everything at once (an Unreal map load also loads packages, collects garbage and
  // creates pipeline states), so each load hitch comes off every other cause's count as well.
  for (const l of levels) {
    if (out.some((f) => f.id === `perf-level-${l.key}`)) continue;
    const facts = levelFacts(ctx, l.key);
    const loads = LOAD_CAUSES.reduce((k, c) => k + (facts.hc[c] || 0), 0);
    const n = l.hitches - loads;
    const perMin = l.hitches ? round((l.hitches_per_min * n) / l.hitches, 2) : 0;
    // Most frequent first, ties by name: the raw path and a store list facts in different orders.
    const causes = Object.fromEntries(
      Object.entries(facts.hc)
        .filter(([c, k]) => c !== 'unattributed' && !LOAD_CAUSES.includes(c) && k > loads)
        .map(([c, k]) => [c, k - loads])
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    );
    // The cause that names the stall first; time on a thread, or a frame over 0.7s, only says where it went.
    const named = Object.keys(causes).sort((a, b) => GENERIC_CAUSES.includes(a) - GENERIC_CAUSES.includes(b));
    if (n < 3 || (l.sessions < 2 && n < 5) || perMin < 0.5 || !named.length) continue;
    const specific = named.filter((c) => !GENERIC_CAUSES.includes(c));
    // The title names a cause only when it covers enough of the stalls: one collection among ten unexplained
    // stalls is not what they come from.
    const lead = { causes: (specific.length ? specific : named).slice(0, 2) };
    lead.share = (causes[lead.causes[0]] || 0) / n;
    // Under two a minute, only first-use compiles: an occasional garbage collection or upload is the normal
    // cost of a game, and a finding for each would bury the ones that matter.
    if (perMin < 2 && !specific.some((c) => COMPILE_CAUSES.includes(c))) continue;
    const engine = engineIn(ctx, (s) => s.fwLevels.has(l.key));
    const corr = correlateGauges(facts);
    const preceding = eventLift(ctx, l.key).filter((p) => p.lift >= 2);
    out.push({
      id: `hitches-level-${l.key}`,
      severity: perMin >= 2 ? 'medium' : 'low',
      category: 'performance',
      title: `Hitches on ${l.key}: ${perMin} a minute, ${lead.share >= 0.3 ? `from ${lead.causes.map((c) => CAUSE_WORDS[c] || c).join(' and ')}` : 'most with no recorded cause'}`,
      summary:
        `${l.key} keeps its p95 at ${l.p95}ms, but ${n} frames stalled during play (${perMin} per minute) in ${l.sessions} ${l.sessions === 1 ? 'session' : 'sessions'}: each is a stutter the player sees, though percentiles hide it. Causes: ${named.map((c) => `${c} ${causes[c]}`).join(', ')}.` +
        (preceding[0] && preceding[0].share >= 0.3 ? ` ${Math.round(preceding[0].share * 100)}% come within 1.5s of a \`${preceding[0].event}\` event.` : ''),
      evidence: { level: l.key, hitches: n, hitches_per_min: perMin, p95: l.p95, hitch_causes: causes, load_hitches: loads, correlated_gauges: corr.slice(0, 3), preceding_events: preceding.slice(0, 3), sessions: l.sessions },
      suggestion: perfSuggestion(corr, preceding, causes, l, engine),
      link: { page: 'performance', level: l.key },
      impact: l.sessions / totalSessions,
    });
  }

  // 2. GPU / scene memory leaks: geometry counts that grow with every level load.
  const leaky = Object.entries(perf.memory).filter(([, m]) => m.geometries_growth_per_level_load >= 40 && m.sessions >= 3);
  const latestLeak = leaky.sort((a, b) => semver(b[0], a[0]))[0];
  for (const [version, m] of latestLeak ? [latestLeak] : []) {
    const older = leaky.filter(([v]) => v !== version).map(([v, o]) => `${v}: +${Math.round(o.geometries_growth_per_level_load)}`);
    // The Unity SDK sends its mesh count where three.js sends geometries.
    const unity = engineIn(ctx, (s) => s.version === version && s.geo) === 'unity';
    out.push({
      id: `leak-geometries-${version}`,
      severity: m.geometries_growth_per_level_load > 150 ? 'high' : 'medium',
      category: 'memory',
      title: unity ? `Mesh leak in ${version}: +${Math.round(m.geometries_growth_per_level_load)} meshes per level load` : `Geometry leak in ${version}: +${Math.round(m.geometries_growth_per_level_load)} geometries per level load`,
      summary: unity
        ? `Across ${m.sessions} sessions with 2+ level loads, the number of meshes in memory grows from a median of ${fmt(m.median_first)} to ${fmt(m.median_last)} and never comes back down${older.length ? ` (also in ${older.join(', ')} per load)` : ''}. Memory climbs with every level until a phone runs out and the OS kills the game.`
        : `Across ${m.sessions} sessions with 2+ level loads, renderer geometry count grows from a median of ${fmt(m.median_first)} to ${fmt(m.median_last)} and never comes back down${older.length ? ` (also in ${older.join(', ')} per load)` : ''}. GPU memory grows until low-end devices stutter or lose the WebGL context.`,
      evidence: { version, ...m },
      suggestion: unity
        ? 'Meshes and materials made at runtime (new Mesh(), Instantiate() of a material) are not freed with their GameObject: Destroy() them in OnDestroy. Reading renderer.material or meshFilter.mesh makes a copy each time; use sharedMaterial and sharedMesh, or destroy the copies. Call Resources.UnloadUnusedAssets() after unloading a level.'
        : 'When unloading a level, call geometry.dispose(), material.dispose() and texture.dispose() for everything you remove (scene.remove() alone does not free GPU memory). Share one geometry/material across identical tiles instead of creating one per mesh.',
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

  // 2c. Texture leaks: renderer texture counts that grow with every level load.
  const texLeaky = Object.entries(perf.texture_growth || {}).filter(([, m]) => m.textures_growth_per_level_load >= 10 && m.sessions >= 3);
  const latestTex = texLeaky.sort((a, b) => semver(b[0], a[0]))[0];
  for (const [version, m] of latestTex ? [latestTex] : []) {
    const older = texLeaky.filter(([v]) => v !== version).map(([v, o]) => `${v}: +${Math.round(o.textures_growth_per_level_load)}`);
    out.push({
      id: `leak-textures-${version}`,
      severity: m.textures_growth_per_level_load >= 40 ? 'high' : 'medium',
      category: 'memory',
      title: `Texture leak in ${version}: +${Math.round(m.textures_growth_per_level_load)} textures per level load`,
      summary: `Across ${m.sessions} sessions with 2+ level loads, renderer texture count grows from a median of ${fmt(m.median_first)} to ${fmt(m.median_last)} and never comes back down${older.length ? ` (also in ${older.join(', ')} per load)` : ''}. Each texture holds GPU memory (4MB for a 1024×1024 one), so low-end devices stutter, then lose the WebGL context.`,
      evidence: { version, ...m },
      suggestion: 'Call texture.dispose() for every texture you stop using: disposing a material does not free its maps. Load each image once and share the texture (keep your own cache, or set THREE.Cache.enabled = true) instead of loading it per object or per level; canvas textures and render targets made at runtime need dispose() too.',
      link: { page: 'performance', section: 'memory' },
      impact: m.sessions / totalSessions,
    });
  }

  // 2d. Context gauges (setContext) that keep climbing: a leak in the game's own words. Progress counters
  // (score, time, kills) climb by design, so they're left out by name.
  const climbs = gaugeClimbs(ctx)
    .filter((g) => g.climbing >= 3 && g.climbing >= g.sessions * 0.6 && !PROGRESS.test(g.key))
    .sort((a, b) => b.climbing - a.climbing);
  const leak = out.find((f) => f.id.startsWith('leak-geometries-') || f.id.startsWith('leak-textures-'));
  if (leak && climbs.length) {
    leak.summary += ` Gauges that also keep climbing: ${climbs.slice(0, 3).map((g) => `\`${g.key}\` (${fmt(g.median_first)} → ${fmt(g.median_last)} in ${g.climbing} of ${g.sessions} sessions)`).join(', ')}.`;
    leak.evidence.climbing_gauges = climbs.slice(0, 3);
  }
  const gaugeEngine = climbs.length ? gameEngine(ctx) : null;
  for (const g of leak ? [] : climbs.slice(0, 3)) {
    out.push({
      id: `leak-gauge-${g.key}`,
      severity: 'medium',
      category: 'memory',
      title: `\`${g.key}\` keeps climbing: median ${fmt(g.median_first)} → ${fmt(g.median_last)} per session`,
      summary: `In ${g.climbing} of the ${g.sessions} sessions that report it, the \`${g.key}\` gauge climbed from a median of ${fmt(g.median_first)} to ${fmt(g.median_last)} and was still at its peak when the session ended. Something is made and never removed: it holds memory now, and frame time as it grows.`,
      evidence: g,
      suggestion: gaugeEngine === 'unreal' ? unrealGaugeLeak(g.key) : gaugeEngine === 'gamemaker' ? gamemakerGaugeLeak(g.key) : `Find where the game adds to \`${g.key}\` and check that each one goes away when it's done (an effect that finished, an object off screen, a level that ended): remove it from the scene and dispose its geometry, materials and textures, or return it to a pool.`,
      link: { page: 'performance', section: 'memory' },
      impact: g.climbing / totalSessions,
    });
  }

  // 3. Errors, ranked by sessions affected.
  for (const issue of errorIssues(ctx).slice(0, 6)) {
    if (issue.sessions < 2 && issue.count < 5) continue;
    const share = issue.sessions / totalSessions;
    const severity = issue.kind === 'webgl_context_lost' || issue.kind === 'crash' || share > 0.25 ? 'high' : share > 0.05 ? 'medium' : 'low';
    const crumbs = issue.breadcrumbs?.map((b) => b.name || b.type).filter(Boolean).slice(-4) || [];
    out.push({
      id: `error-${issue.fingerprint}`,
      severity,
      category: 'stability',
      title: `${issue.message.slice(0, 90)}`,
      summary: `${issue.count} occurrences in ${issue.sessions} sessions (${issue.sessions_pct}% of sessions)${issue.levels.length ? ` on ${issue.levels.join(', ')}` : ''}, first seen in ${issue.first_version}. ${issue.fatal ? fatalWords(ctx, issue) || 'Unhandled — reaches window.onerror.' : ''}${crumbs.length ? ` Typically right after: ${crumbs.join(' → ')}.` : ''}`,
      evidence: { fingerprint: issue.fingerprint, kind: issue.kind, location: issue.location, stack: issue.stack?.split('\n').slice(0, 6).join('\n'), count: issue.count, sessions: issue.sessions, versions: issue.versions, levels: issue.levels, breadcrumbs: issue.breadcrumbs },
      suggestion: !issue.location ? 'Reproduce with the breadcrumbs above and guard the failing path.' : errorSuggestion(engineIn(ctx, (s) => s.session_id === issue.sample_session), issue, crumbs),
      link: { page: 'errors', fingerprint: issue.fingerprint },
      impact: share,
    });
  }

  // 4. Difficulty spikes: death hotspots + rage quits.
  const fun = funnel(ctx);
  // A game nobody wins (endless, flappy) has no completion rate or rage quits to cite: its hotspots stand on
  // how the deaths bunch.
  const sum = (f) => fun.reduce((a, l) => a + f(l), 0);
  const endless = noWin({ sessions: sessionCount(ctx), starts: sum((l) => l.attempts), completes: sum((l) => l.completed), fails: sum((l) => l.fails + l.deaths) });
  const spiked = new Set();
  for (let i = 0; i < fun.length; i++) {
    const l = fun[i];
    const deaths = deathsOf(ctx, l.level).filter((d) => typeof d.x === 'number');
    if (deaths.length < 10) continue;
    const ragers = new Map();
    for (const s of ctx.sessions.values()) if (s.rage_quit && s.rage?.level === l.level) ragers.set(s.session_id, rageDeathTs(s.rage));
    // Without a captured map, a level whose deaths have depth is top-down, as the heatmap decides.
    const axis = maps.find((m) => m.level === l.level)?.axis || (deaths.some((d) => Math.abs(d.z) > 0.01) ? 'xz' : 'xy');
    const spots = deathHotspots(
      deaths.map((d) => ({ ...d, rage_quit: d.rage_quit ?? ragers.get(d.session_id) === d.ts })),
      axis,
    );
    const top = spots[0];
    if (!top || top.share < 0.3) continue;
    spiked.add(l.level);
    const prev = fun[i - 1];
    const dropVsPrev = prev?.completion_pct != null && l.completion_pct != null ? round(prev.completion_pct - l.completion_pct, 1) : null;
    const severity = top.share > 0.5 && (endless || l.rage_quit_pct > 10 || (l.completion_pct ?? 100) < 50) ? 'high' : 'medium';
    const topDown = axis !== 'xy';
    const at = topDown ? `x≈${top.x}, z≈${top.z}` : `x≈${top.x}`;
    const area = topDown ? `x=${top.x_range[0]}–${top.x_range[1]}, z=${top.z_range[0]}–${top.z_range[1]}` : `x=${top.x_range[0]}–${top.x_range[1]}`;
    const fix = topDown
      ? `find what makes it deadly (an enemy, a trap, a choke point) and telegraph it earlier, soften it or give players a way around it`
      : `if it's a ${top.top_cause === 'fell' ? 'gap, shorten it or widen the landing platform' : 'hazard, telegraph it earlier or reduce its speed/range'}`;
    out.push({
      id: `design-hotspot-${l.level}-${Math.round(top.x)}`,
      severity,
      category: 'design',
      title: `Difficulty spike on ${l.level} at ${at}: ${Math.round(top.share * 100)}% of the level's deaths`,
      summary:
        `${top.deaths} of ${deaths.length} deaths on ${l.level} happen ${topDown ? `in ${area}` : `between x=${top.x_range[0]} and x=${top.x_range[1]}`} (mostly "${top.top_cause}"). ` +
        (endless
          ? 'No session completes a level in this game, so every run ends in a death, and more of them end here than anywhere else.'
          : `Completion rate is ${l.completion_pct}%${dropVsPrev != null ? ` (${dropVsPrev > 0 ? '-' : '+'}${Math.abs(dropVsPrev)} pts vs ${prev.level})` : ''} and ${l.rage_quits} sessions rage-quit here (${l.rage_quit_pct}% of sessions that reached it).`),
      evidence: { level: l.level, axis, hotspot: top, other_hotspots: spots.slice(1, 3), no_win: endless, completion_pct: l.completion_pct, previous_level_completion_pct: prev?.completion_pct ?? null, deaths_per_session: l.deaths_per_session, rage_quits: l.rage_quits, rage_quit_pct: l.rage_quit_pct },
      suggestion: `Look at the level data around ${area}: ${fix}, consider a checkpoint just before it, then compare ${endless ? 'deaths there' : 'completion and rage-quit rates'} between versions to confirm the fix.`,
      link: { page: 'players', level: l.level },
      impact: (l.sessions || 0) / totalSessions,
    });
  }

  // 4b. Walls: a level far fewer sessions get through than the others, whether or not its deaths bunch (or
  // it has any: a tower-defence wave, a puzzle, a timer). Levels with a hotspot above already have a finding.
  const judged = fun.filter((l) => l.sessions >= 5 && l.completion_pct != null);
  if (!endless && judged.filter((l) => l.completed > 0).length >= 2) {
    for (const l of judged) {
      if (spiked.has(l.level) || l.completion_pct > 70) continue;
      const others = judged.filter((o) => o !== l).map((o) => o.completion_pct);
      const typical = others.length ? round(quantile(others, 0.5), 1) : null;
      if (typical == null || typical - l.completion_pct < 25) continue;
      out.push({
        id: `design-wall-${l.level}`,
        severity: l.completion_pct < 50 || l.rage_quit_pct >= 25 ? 'high' : 'medium',
        category: 'design',
        title: `${l.level} is a wall: ${l.completion_pct}% of the sessions that reach it get through`,
        summary:
          `${l.completed} of the ${l.sessions} sessions that start ${l.level} complete it, against a median of ${typical}% on the other levels.` +
          (l.deaths ? ` Its ${l.deaths} deaths (${l.deaths_per_session} per session) are spread out, not at one spot.` : ` Nobody dies on it: ${l.fails ? `${l.fails} fails end the attempts` : 'sessions end before they finish it'}.`) +
          (l.rage_quits ? ` ${l.rage_quits} sessions rage-quit here (${l.rage_quit_pct}% of sessions that reached it).` : ''),
        evidence: { level: l.level, sessions: l.sessions, completed: l.completed, completion_pct: l.completion_pct, other_levels_median_pct: typical, deaths: l.deaths, deaths_per_session: l.deaths_per_session, fails: l.fails, rage_quits: l.rage_quits, rage_quit_pct: l.rage_quit_pct },
        suggestion: `Play ${l.level} against the level before it and list what steps up (enemy count, speed, timers, resources, the rules). Ease the biggest step, or add a level that teaches it, then compare ${l.level}'s completion rate between versions.`,
        link: { page: 'players', level: l.level },
        impact: l.sessions / totalSessions,
      });
    }
  }

  // 5. Version-over-version regressions and wins.
  const vers = versions(ctx).filter((v) => v.sessions >= 5);
  if (vers.length >= 2) {
    const [prev, cur] = vers.slice(-2);
    const p95Delta = prev.frame_p95 && cur.frame_p95 ? (cur.frame_p95 - prev.frame_p95) / prev.frame_p95 : 0;
    const changes = [];
    // Percentage points of crash-free sessions lost (an alert's crash-free rule names this finding).
    const crashDrop = (prev.crash_free_pct ?? 100) - (cur.crash_free_pct ?? 100);
    if (Math.abs(p95Delta) >= 0.15) changes.push(`p95 frame time ${prev.frame_p95}ms → ${cur.frame_p95}ms`);
    if (Math.abs(crashDrop) >= 2) changes.push(`crash-free sessions ${prev.crash_free_pct}% → ${cur.crash_free_pct}%`);
    if (Math.abs((cur.error_free_pct ?? 0) - (prev.error_free_pct ?? 0)) >= 5) changes.push(`error-free sessions ${prev.error_free_pct}% → ${cur.error_free_pct}%`);
    if (Math.abs((cur.level_completion_pct ?? 0) - (prev.level_completion_pct ?? 0)) >= 5) changes.push(`level completion ${prev.level_completion_pct}% → ${cur.level_completion_pct}%`);
    if (Math.abs((cur.rage_quit_pct ?? 0) - (prev.rage_quit_pct ?? 0)) >= 3) changes.push(`rage quits ${prev.rage_quit_pct}% → ${cur.rage_quit_pct}%`);
    if (changes.length) {
      const better = crashDrop < 2 && (p95Delta < 0 || (cur.error_free_pct ?? 0) > (prev.error_free_pct ?? 0));
      out.push({
        id: `version-${prev.version}-${cur.version}`,
        severity: better ? 'info' : p95Delta > 0.3 || crashDrop >= 5 ? 'high' : 'medium',
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
      suggestion: QUALITY_TIER_TIPS[engineIn(ctx, (s) => s.device?.gpu_tier === 'low')],
      link: { page: 'performance', section: 'devices' },
      impact: lo.sessions / totalSessions,
    });
  }

  // 7. Slow first frame.
  if (perf.kpis.ttff_p95 && perf.kpis.ttff_p95 > 4000) {
    const engine = engineIn(ctx, (s) => s.ttff != null);
    out.push({
      id: 'load-ttff',
      severity: perf.kpis.ttff_p95 > 8000 ? 'high' : 'medium',
      category: 'performance',
      title: `Slow start: p95 time-to-first-frame is ${(perf.kpis.ttff_p95 / 1000).toFixed(1)}s`,
      summary:
        engine === 'godot' || engine === 'unity' || engine === 'unreal' || engine === 'gamemaker'
          ? 'Players expect to be playing within seconds of opening the game, and some give up during a long splash screen.'
          : 'Web portals expect gameplay within ~20s and every extra second costs conversion-to-play.',
      evidence: { ttff_p50: perf.kpis.ttff_p50, ttff_p95: perf.kpis.ttff_p95 },
      suggestion: SLOW_START_TIPS[engine],
      link: { page: 'performance', section: 'load' },
      impact: 1,
    });
  }

  // 8. Players' bug reports piling up on one level (ctx.reports, which app.js reads for the range).
  out.push(...reportFindings(ctx, totalSessions, gameEngine(ctx)));

  // 9. Store reviews (Steam) about stutter, lag, fps, freezes or crashes rising after a build (ctx.stores, reviews.js).
  out.push(...storeFindings(ctx, out));

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

// Which SDK sent most of these sessions, so fix advice names that engine's APIs: 'godot', 'unity', 'unreal',
// 'gamemaker', 'phaser', 'babylon', 'playcanvas', or 'web' (the browser SDK on its own or with three.js).
const SDK_ENGINES = { 'glitchless-godot/': 'godot', 'glitchless-unity/': 'unity', 'glitchless-unreal/': 'unreal', 'glitchless-gamemaker/': 'gamemaker', 'glitchless-phaser/': 'phaser', ...WEB_ENGINES };
function engineOf(sessions) {
  return engineOfSdks(sessions.map((s) => [s?.sdk || '', 1]));
}

// The engine of the sessions that pass `keep`. A daily context has no sessions, only how many each SDK
// sent: its advice follows the SDK of most of the range's sessions.
function engineIn(ctx, keep) {
  if (ctx.daily) return engineOfSdks(Object.entries(dailySdks(ctx)));
  return engineOf([...ctx.sessions.values()].filter(keep));
}

// The engine of the game's sessions in the range, for advice that isn't about one session.
export function gameEngine(ctx) {
  return engineIn(ctx, () => true);
}

// [sdk, sessions] pairs → engine.
function engineOfSdks(pairs) {
  const counts = {};
  let n = 0;
  for (const [sdk, k] of pairs) {
    n += k;
    const engine = Object.entries(SDK_ENGINES).find(([prefix]) => sdk.startsWith(prefix))?.[1];
    if (engine) counts[engine] = (counts[engine] || 0) + k;
  }
  const [top, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  return count * 2 > n ? top : 'web';
}

const FATAL_WORDS = {
  script: 'Unhandled script error — the function stopped part way.',
  exception: 'Unhandled exception — Unity skipped the rest of that callback, so whatever came after it never ran.',
  game_loop_stopped: "Phaser's game loop stopped — the game froze and the player could only leave.",
  crash: 'The game crashed — written down as it died and sent on the next launch.',
};

// The words for a fatal error, in the engine of the session it was seen in.
function fatalWords(ctx, issue) {
  return WEB_ENGINE_FATAL_WORDS[`${engineIn(ctx, (s) => s.session_id === issue.sample_session)}:${issue.kind}`] || FATAL_WORDS[issue.kind];
}

function errorSuggestion(engine, issue, crumbs) {
  const where = `Start at ${issue.location}. The error fires during normal play (not on load), so look for`;
  const trigger = crumbs.at(-1) || 'the preceding game event';
  switch (engine) {
    case 'godot':
      return `${where} a node that is null or already freed (a get_node() path that no longer exists, or a node freed earlier: check is_instance_valid()) or a missing dictionary key on the code path triggered by ${trigger}. Make it fail safe and apply game state (score, pickups) before anything that can fail: release exports skip most script errors silently, and a call on a typed null crashes the game.`;
    case 'unity':
      return `${where} a reference that is missing or already destroyed (a GetComponent() or Find() that returned null, an inspector field left empty, an object Destroy()ed earlier: a MissingReferenceException) or a dictionary or array lookup on the code path triggered by ${trigger}. Make it fail safe and apply game state (score, pickups) before anything that can throw: the rest of that Update() or coroutine is skipped every time it throws.`;
    case 'phaser':
      return `${where} an unchecked lookup (a Group's getFirstDead() or a table entry that returns null or undefined, a destroyed game object still referenced from a timer, tween or physics callback) on the code path triggered by ${trigger}. In Phaser an uncaught error inside update(), a physics callback or an event handler stops the game loop for good, so make the path fail safe and apply game state (score, pickups) before anything that can throw.`;
    case 'unreal':
      return unrealErrorSuggestion(where, issue.kind, trigger);
    case 'babylon':
    case 'playcanvas':
      return webEngineErrorSuggestion(engine, where, trigger);
    case 'gamemaker':
      return gamemakerErrorSuggestion(where, issue, trigger);
    default:
      return `${where} an unchecked lookup (e.g. a pool/array .find() returning undefined) on the code path triggered by ${trigger}. Make it fail safe and make sure game state (score, pickups) is applied before anything that can throw.`;
  }
}

// The Unreal plugin's error kinds (SPEC §5c): a Blueprint runtime error, an ensure, a crash sent on the next
// launch, or a UE_LOG error (its fn is the log category).
function unrealErrorSuggestion(where, kind, trigger) {
  switch (kind) {
    case 'script':
      return `${where} a Blueprint reading a reference that is None (an actor destroyed earlier, a Cast that failed, a variable never set) on the path triggered by ${trigger}. Check it with an Is Valid node (or a validated Get) before using it, and apply game state (score, pickups) before anything that can fail: Unreal stops the Blueprint function at the error, so the nodes after it never run.`;
    case 'ensure':
      return `${where} why the ensure's condition is false on the path triggered by ${trigger}: most often a UObject pointer that is null or pending kill (an actor destroyed earlier, a component not created yet, a raw pointer garbage collection already freed). Test it with IsValid(), which checks for both, keep it in a UPROPERTY() or a TWeakObjectPtr, and handle the case instead of only flagging it: if (!ensure(IsValid(Target))) return;. An ensure reports only its first failure in a run, so count sessions, not occurrences.`;
    case 'crash':
      return `${where} a null or dangling pointer (a UObject kept in a raw pointer without UPROPERTY(), which garbage collection frees, or an actor destroyed earlier), an array index out of range, or a check() that failed, on the path triggered by ${trigger}. Keep UObjects in UPROPERTY() members or TWeakObjectPtr, test them with IsValid(), and turn check()s a player can reach into ensure()s with a fallback. Package with debug files (the .dSYM on a Mac, the .pdb on Windows) so crash stacks have file and line numbers.`;
    default:
      return `${where} what makes the game or the engine log this error (for a UE_LOG error, fn is its log category) on the path triggered by ${trigger}: often an asset or class that failed to load (renamed or moved, or a soft reference that was never cooked) or a UObject that is null or pending kill. Fix the reference (re-save the assets that point at it, or add it to the cook) or guard the use with IsValid().`;
  }
}

const QUALITY_TIER_TIPS = {
  unreal: 'Add a quality tier: when gpu_tier is low (a Steam Deck is) or p95 stays above budget for 5s, lower the scalability groups (UGameUserSettings::SetOverallScalabilityLevel, or sg.ShadowQuality, sg.GlobalIlluminationQuality, sg.ReflectionQuality, sg.PostProcessQuality and sg.EffectsQuality one by one; RunHardwareBenchmark picks levels per machine), render at a lower r.ScreenPercentage and let TSR upscale, swap Lumen for cheaper lighting (r.DynamicGlobalIlluminationMethod and r.ReflectionMethod) and cut shadow cost (fewer shadow-casting lights, r.Shadow.Virtual.Enable 0 for plain shadow maps).',
  godot:'Add a quality tier: when gpu_tier is low or p95 stays above budget for 5s, render 3D at a lower resolution (Viewport.scaling_3d_scale around 0.7), turn off shadows, glow and SSAO in the WorldEnvironment, drop MSAA and halve particle amounts.',
  unity: 'Add a quality tier: when the device tier is low or p95 stays above budget for 5s, switch QualitySettings to a lower level, render at a lower scale (renderScale on the URP asset, or ScalableBufferManager), turn off shadows and post-processing, and halve particle counts.',
  gamemaker: 'Add a quality tier: when p95 stays above budget for 5s (or on a low-tier GPU), turn off what costs most per frame: shaders and full-screen surface effects, particle density (part_type and part_emitter amounts), and the size of the application surface (surface_resize(application_surface, ...) with display_set_gui_size for the GUI), and turn on texture group prefetching so pages are not swapped in during play.',
  phaser: 'Add a quality tier: when gpu_tier is low or p95 stays above budget for 5s, render at a lower resolution (a smaller game size with Scale.FIT, and resolution 1), drop preFX/postFX filters and lights, and halve particle emitter quantities.',
  web: 'Add a quality tier: cap devicePixelRatio at 1.5, disable shadows/post-processing and halve particle counts when gpu_tier is low or p95 stays above budget for 5s.',
  ...WEB_ENGINE_QUALITY_TIPS,
};

const SLOW_START_TIPS = {
  unreal: 'Make the startup map tiny (a menu with little in it), load the first level behind a loading screen (the MoviePlayer, or a widget while the level streams in), load what that level needs with the Asset Manager instead of hard references from the game instance, and let the bundled PSO cache precompile behind the loading screen rather than during play.',
  godot:'Keep the first scene small and load the rest in the background with ResourceLoader.load_threaded_request(), preload() only what the first screen needs, turn on the Shader Baker in the export preset (Godot 4.5+) so the first frame does not wait on shader compiles, and use VRAM-compressed textures.',
  unity: 'Keep the first scene small and load the rest with SceneManager.LoadSceneAsync() or Addressables, move heavy Awake()/Start() work behind the first frame, warm shaders behind the splash screen with a ShaderVariantCollection, and use compressed textures (ASTC on phones).',
  gamemaker: 'Keep the first room light (a menu with little in it), prefetch only the texture groups it draws (texturegroup_load, or texture_prefetch) and load the rest behind a loading room, set heavy texture groups to load on demand (Dynamic Texture Groups) instead of at start, and move big Create-event work (building grids, reading files, json_parse of large data) out of the first frame.',
  phaser: 'Have the Preloader load only what the menu and first level need and load later levels in their own scenes, pack images into texture atlases, and ship compressed audio (and compressed textures where the target supports them).',
  web: 'Lazy-load non-first-level assets, compress textures (KTX2/Basis) and meshes (Draco/Meshopt), and warm shaders with renderer.compileAsync before the first frame.',
  ...WEB_ENGINE_SLOW_START_TIPS,
};

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

// Phaser hitch causes: what the slow step did (spawned 50+ objects, made a texture, started a scene) or
// where its time went (update code, rendering).
const PHASER_CAUSE_TIPS = {
  object_spawn: 'Some hitches add many game objects in one step: create them once and recycle them through a Group (getFirstDead / setActive) or use one particle emitter instead of an object each, and destroy() what you are done with.',
  texture_upload: 'Some hitches make a texture mid-game (generateTexture, a canvas or render texture): make it once in the preloader and reuse the key; every new texture is uploaded to the GPU on the frame it is made, and textures stay in memory until removed.',
  scene_change: 'Some hitches come with a scene starting: load its files in a preloader scene first and keep heavy work in create() small, or spread it over the first frames.',
  script: 'Some hitches are long update steps: look for loops over every object, physics colliders added per object instead of per group, and handlers added with events.on() on every restart (they pile up because scene events outlive shutdown).',
  render: 'Some hitches are long render steps: cut texture switches with atlases, avoid redrawing Graphics every frame (draw once, or bake to a texture), and limit preFX/postFX.',
  gc: 'Heap drops during hitches suggest GC pauses: avoid creating objects, arrays and closures every frame in update().',
  asset_load: 'Hitches overlap file loads: load in a preloader scene before play starts.',
  frozen: 'Some frames froze for over 0.7s: something blocked the main thread for that long; move it behind a loading screen or split it up.',
};

function phaserPerfSuggestion(corr, preceding, causes, level) {
  const tips = [];
  const gauge = corr[0]?.key;
  const trigger = preceding[0]?.share >= 0.3 ? preceding[0].event : null;
  if (gauge || trigger) tips.push(`Find the code that runs on ${trigger ? `\`${trigger}\`` : 'the hitch'}${gauge ? ` and drives \`${gauge}\`` : ''}.`);
  if (gauge === 'physics_bodies') tips.push('`physics_bodies` counts arcade or matter bodies: objects that are faded out or off screen still simulate until destroyed or disabled (disableBody(true, true)). Recycle them through a Group, and add one collider per group rather than per object.');
  if (gauge === 'game_objects') tips.push('`game_objects` counts everything on the running scenes\' display lists: something adds objects and never destroys them. Destroy them when their effect ends, or recycle them through a Group.');
  if (gauge === 'listeners') tips.push('`listeners` counts event handlers on the game and its scenes. It climbs when a scene adds handlers with this.events.on() or this.game.events.on() in create() and never removes them: scene events survive a restart, so remove them in a shutdown handler or use once().');
  if (gauge === 'particles') tips.push('`particles` counts live particles: lower the emitters\' quantity and lifespan, or stop() emitters that are off screen.');
  if (gauge === 'tweens') tips.push('`tweens` counts running tweens: one tween per object in a burst is costly; tween a container, or a whole group at once, and make sure looping tweens are stopped.');
  const top = Object.entries(causes).filter(([c]) => PHASER_CAUSE_TIPS[c]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [c] of top) tips.push(PHASER_CAUSE_TIPS[c]);
  if (!tips.length) tips.push(`Profile ${level.key} with glitchless_measure and glitchless_inspect_scene: look at update and render CPU, draw calls (${level.draw_calls} avg) and the busiest event listeners.`);
  return tips.join(' ');
}

// Unity hitch causes, from what the slow frame measured: a GC collection, shader compiles, a scene
// load, or where the frame's time went (scripts, physics, rendering).
const UNITY_CAUSE_TIPS = {
  gc: 'Some hitches are garbage collections: cut per-frame allocations (new lists, LINQ, string building, boxing, GetComponents() without a list), cache what Update() needs, and turn on incremental GC in Player Settings.',
  shader_compile: 'Some hitches compile shaders on first use: warm them behind the loading screen with a ShaderVariantCollection (WarmUp), and strip variants you do not use.',
  scene_change: 'Some hitches come with a scene load: use SceneManager.LoadSceneAsync() (allowSceneActivation for a loading screen) or Addressables, and keep Awake()/Start() of the new scene light.',
  object_spawn: 'Some hitches Instantiate() many objects at once: pool and reuse them (UnityEngine.Pool.ObjectPool), or draw many copies with a particle system or GPU instancing.',
  script: 'Some hitches are long Update()/LateUpdate() frames: spread big loops over several frames (a coroutine, or a job with the Jobs system), and cache GetComponent()/Find() results instead of calling them every frame.',
  physics: 'Some hitches are long physics steps: fewer active rigidbodies and colliders, simpler collider shapes, a larger Fixed Timestep, and a Maximum Allowed Timestep that stops the physics catch-up spiral.',
  render: 'Some hitches are long render frames: cut draw calls and SetPass calls (static and dynamic batching, the SRP Batcher, GPU instancing) and real-time shadows.',
  frozen: 'Some frames froze for over 0.7s: something blocked the main thread (a synchronous load, Resources.Load of a large asset, a long loop); move it to a background thread or behind a loading screen.',
};

function unityPerfSuggestion(corr, preceding, causes, level) {
  const tips = [];
  const gauge = corr[0]?.key;
  const trigger = preceding[0]?.share >= 0.3 ? preceding[0].event : null;
  if (gauge || trigger) tips.push(`Find the code that runs on ${trigger ? `\`${trigger}\`` : 'the hitch'}${gauge ? ` and drives \`${gauge}\`` : ''}. If it spawns many objects, pool and reuse them instead of calling Instantiate() and Destroy() per effect, or use one particle system.`);
  const top = Object.entries(causes).filter(([c]) => UNITY_CAUSE_TIPS[c]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [c] of top) tips.push(UNITY_CAUSE_TIPS[c]);
  if (!tips.length) tips.push(`Profile ${level.key} with the Unity Profiler (CPU and Rendering modules) in a development build; check draw calls (${level.draw_calls} avg).`);
  return tips.join(' ');
}

// Unreal hitch causes, from what the long frame measured (SPEC §5c): pipeline states created at draw time,
// shader compiles (the editor), a garbage collection, a map load, a streamed level, a blocking asset load,
// or where the frame's time went (the game thread, the render or RHI thread or the GPU).
const UNREAL_CAUSE_TIPS = {
  pso_compile:
    'Some hitches create pipeline states (PSOs) on the spot, the first time a material, mesh or effect is drawn. Keep PSO precaching on (r.PSOPrecaching 1, the default) so components compile theirs while they load, and ship a bundled PSO cache for what precaching misses (materials set at runtime, effects spawned later): play a Development build with -logPSO, turn the recorded files into a cache with the ShaderPipelineCacheTools commandlet and add it to the build (r.ShaderPipelineCache.Enabled). Spawn first-use effects once behind the loading screen. -LogCmds="LogPSOHitching Verbose" names the material and pass of each one.',
  shader_compile:
    'Some hitches wait for shaders to compile, which happens in the editor (Play In Editor compiles them on first use); a cooked build compiles shaders when it is cooked and creates pipeline states at runtime instead. Let the editor finish compiling before measuring, measure a packaged Development build for what players see, and keep its pipeline states out of play with PSO precaching and a bundled PSO cache.',
  gc: 'Some hitches are garbage collections, and their cost grows with the number of UObjects: pool actors and objects (hide and reuse them) instead of SpawnActor or NewObject for every shot, spark or damage event, keep short-lived data in USTRUCTs or plain C++ rather than UObjects, cluster what lives long (gc.CreateGCClusters, gc.ActorClusteringEnabled), and run full collections where players don\'t see them (ForceGarbageCollection behind a loading screen, with gc.TimeBetweenPurgingPendingKillObjects setting how often it runs on its own).',
  map_load:
    'Some hitches come with a map load: OpenLevel loads the whole map on the game thread. Cover it with a loading screen (the MoviePlayer), or stay in a persistent map and stream levels in with Level Streaming or World Partition, so loads run in the background; keep BeginPlay of the new map light.',
  level_stream:
    'Some hitches add a streamed level to the world: request it before the player gets there (streaming volumes, or a larger World Partition loading range), never block on it (bShouldBlockOnLoad, FlushLevelStreaming), and spread adding its actors over frames with s.LevelStreamingComponentsRegistrationGranularity and the async loading budget (s.AsyncLoadingTimeLimit, s.PriorityAsyncLoadingExtraTime).',
  asset_load:
    'Some hitches load assets on the game thread: a hard reference loaded on first use, LoadObject or LoadSynchronous, or a FlushAsyncLoading. Load ahead of time with the Asset Manager or FStreamableManager::RequestAsyncLoad (Async Load Asset in Blueprint), use soft references for things the level may not need, and keep s.AsyncLoadingTimeLimit (the game thread\'s share of each frame for finishing loads) small.',
  script:
    'Some hitches are long game-thread frames: record a trace with Unreal Insights (-trace=default) or use stat game, stat unit and stat startfile to find the function. Usual suspects are Blueprint Tick doing loops or searches (GetAllActorsOfClass, ForEach over arrays), many actors ticking that don\'t need to (turn Tick off, or raise the tick interval), and big spawns in one frame: move hot Blueprint loops to C++, use timers and events instead of Tick, and spread the work over frames.',
  render:
    'Some hitches are long render-thread, RHI or GPU frames: stat scenerendering, stat rhi and stat gpu (or ProfileGPU) show where. Cut draw calls (instanced static meshes, merged actors, HLOD for distant geometry, Nanite for dense meshes), shadow-casting lights and overdraw from translucency.',
  frozen:
    'Some frames froze for over 0.7s: something blocked the game thread for that long (a synchronous load, FlushAsyncLoading, a big spawn, a long loop); move it to an async load or behind a loading screen.',
};

// A climbing gauge in an Unreal game. The plugin sends UObject and actor counts as gauges of its own; the rest
// are the game's. UObjects that pile up between collections and then drop look the same at the session's end.
function unrealGaugeLeak(key) {
  if (key === 'objects')
    return 'UObjects pile up: something calls NewObject (or spawns actors) faster than garbage collection frees them, or keeps them alive. Pool what is made per shot, spark or hit, keep short-lived data in USTRUCTs instead of UObjects, and clear the TArray and TMap UPROPERTYs that still point at objects from an earlier level: anything a UPROPERTY references survives garbage collection. In a Development build, `obj list` (with class=<Class>) and `memreport -full` show which class keeps growing.';
  if (key === 'actors')
    return 'Actors pile up in the world: something spawns them and never destroys them. Destroy() each one when it is done, or give short-lived ones a lifespan (SetLifeSpan), return pooled ones to the pool, and check actors spawned into a persistent level that outlive the level they belonged to. `obj list class=<Class>` in a Development build shows which class keeps growing.';
  return `Find where the game adds to \`${key}\` and check that each one goes away when it's done (an effect that finished, an actor off screen, a level that ended): Destroy() actors or return them to a pool, and drop the references (a UPROPERTY array keeps UObjects alive through garbage collection).`;
}

function unrealPerfSuggestion(corr, preceding, causes, level) {
  const tips = [];
  const gauge = corr[0]?.key;
  const trigger = preceding[0]?.share >= 0.3 ? preceding[0].event : null;
  // Spawning advice only when a count rises with the hitches; an event alone says where to look, and the
  // causes say what it does there (draws something new, collects, loads).
  if (gauge) tips.push(`Find the code that runs on ${trigger ? `\`${trigger}\`` : 'the hitch'} and drives \`${gauge}\`. If it spawns actors or creates UObjects per effect, pool and reuse them instead of SpawnActor and NewObject each time, and draw many copies with one Niagara system or instanced static mesh.`);
  else if (trigger) tips.push(`Find the code that runs on \`${trigger}\`.`);
  if (gauge === 'objects') tips.push('`objects` counts UObjects: when it climbs, something calls NewObject (or spawns actors) faster than garbage collection frees them, and each collection then has more to check.');
  if (gauge === 'actors') tips.push('`actors` counts actors in the world: something spawns actors and never destroys them; give short-lived ones a lifespan (SetLifeSpan) or return them to a pool.');
  // Causes that name the stall (a pipeline state, a collection, a load) before where its time went.
  const top = Object.entries(causes).filter(([c]) => UNREAL_CAUSE_TIPS[c]).sort((a, b) => GENERIC_CAUSES.includes(a[0]) - GENERIC_CAUSES.includes(b[0]) || b[1] - a[1]).slice(0, 3);
  for (const [c] of top) tips.push(UNREAL_CAUSE_TIPS[c]);
  if (!tips.length) tips.push(`Profile ${level.key} with Unreal Insights (-trace=default) in a Development build, or stat unit and stat game; stat rhi counts draw calls${level.draw_calls != null ? ` (${level.draw_calls} avg here)` : ''}.`);
  return tips.join(' ');
}

// GameMaker hitch causes (SPEC §5d), from what the long frame measured: a texture page fetched on first draw, a
// room change, a collection, a burst of new instances, or the Step or Draw events taking the frame.
const GAMEMAKER_CAUSE_TIPS = {
  texture_upload:
    'Some hitches load a texture page the first time something on it is drawn: put what a room draws together in one texture group, prefetch it before the room starts (texturegroup_load or texture_prefetch, behind a loading room or a fade), and keep sprites drawn together on the same page so drawing them does not swap pages (the debug overlay counts texture swaps).',
  scene_change:
    'Some hitches come with a room change: room_goto builds the whole room in one frame (every instance\'s Create event, the layers, the tiles). Keep Create events light (no file reads, big loops or json_parse there), spread setup over the first frames, prefetch the room\'s texture groups in the room before, and cover the change with a fade or a loading room.',
  gc: 'Some hitches are garbage collections: avoid making arrays, structs and method closures every step (build them once in Create and reuse them), don\'t rebuild strings every frame, and run collections where players don\'t see them (gc_enable(false) during a fight, then gc_collect() at a checkpoint, or gc_target_frame_time to cap the time each frame spends on it).',
  object_spawn:
    'Some hitches create many instances in one step: pool them (deactivate and reuse instead of instance_create_layer / instance_destroy for every bullet or spark), and draw effects with a particle system (part_system_create, part_particles_create) instead of an instance each.',
  script:
    'Some hitches are long Step frames: look for with() loops over every instance, collision checks against everything (use collision_* functions on the nearest few, or a spatial grid), ds_list and array sorts each step, and pathfinding run for every instance at once (spread it over frames). Build with YYC for code that is still slow.',
  render:
    'Some hitches are long Draw frames: cut texture swaps and vertex batches (sprites on the same texture page, fewer draw_set_colour/shader/blend changes between draws), draw static scenery with tile layers or a vertex buffer instead of an instance each, and reuse surfaces instead of creating them each frame.',
  frozen:
    'Some frames froze for over 0.7s: something blocked the game for that long (a big file read, json_parse of large data, a room with thousands of instances, a long loop); move it to a loading room or split it over frames (a time source works well for that).',
};

function gamemakerPerfSuggestion(corr, preceding, causes, level) {
  const tips = [];
  const gauge = corr[0]?.key;
  const trigger = preceding[0]?.share >= 0.3 ? preceding[0].event : null;
  if (gauge) tips.push(`Find the code that runs on ${trigger ? `\`${trigger}\`` : 'the hitch'} and drives \`${gauge}\`. If it creates instances per effect, pool and reuse them instead of instance_create_layer and instance_destroy each time, or draw the effect with a particle system.`);
  else if (trigger) tips.push(`Find the code that runs on \`${trigger}\`.`);
  if (gauge === 'instances') tips.push('`instances` counts every instance: when it climbs, instances are made faster than they are destroyed (or are persistent and follow the player from room to room), and every Step and Draw event costs more.');
  if (gauge === 'surfaces') tips.push('`surfaces` counts surfaces in memory: create a surface once, check surface_exists() before drawing to it (they can be lost), and surface_free() it when done; a surface_create() in a Step or Draw event leaks one every frame.');
  const top = Object.entries(causes).filter(([c]) => GAMEMAKER_CAUSE_TIPS[c]).sort((a, b) => GENERIC_CAUSES.includes(a[0]) - GENERIC_CAUSES.includes(b[0]) || b[1] - a[1]).slice(0, 3);
  for (const [c] of top) tips.push(GAMEMAKER_CAUSE_TIPS[c]);
  if (!tips.length) tips.push(`Profile ${level.key} with GameMaker's profiler (run in Debug mode, the Profile tab) and the debug overlay (show_debug_overlay(true)): it shows Step and Draw time, texture swaps and vertex batches.`);
  return tips.join(' ');
}

// A climbing gauge in a GameMaker game. The SDK sends the instance count and the runner's surface, DS and buffer
// counts as gauges; GameMaker frees none of the latter by itself.
function gamemakerGaugeLeak(key) {
  if (key === 'instances') return 'Instances pile up: something creates them and never destroys them, or makes them persistent so they follow the player into every room. instance_destroy() each one when it is done (an effect that finished, a bullet off screen), keep persistent for the few controllers that need it, and pool what is made per shot or spark. instance_number(obj) per object in the debug overlay shows which object keeps growing.';
  if (key === 'surfaces') return 'Surfaces pile up: something calls surface_create() and never surface_free(). Create each surface once (in Create, or the first time it is needed, after checking surface_exists()), reuse it every frame, and free it in the Clean Up event of the instance that owns it.';
  if (key === 'ds_maps' || key === 'ds_lists' || key === 'ds_grids') return `\`${key}\` pile up: GameMaker never frees DS structures by itself, so each ds_*_create() needs a ds_*_destroy() (in the Clean Up event of the instance that owns it). Structs and arrays are freed by the garbage collector, so they are the safer choice for new code.`;
  if (key === 'buffers') return 'Buffers pile up: each buffer_create() or buffer_load() needs a buffer_delete() when its data has been used (after an HTTP reply, a file save or a network packet).';
  return `Find where the game adds to \`${key}\` and check that each one goes away when it's done (an effect that finished, an instance off screen, a room that ended): instance_destroy() instances or return them to a pool, and free surfaces, DS structures and buffers by hand.`;
}

// GameMaker's error kinds (SPEC §5d): a crash (an unhandled exception stops the game; sent on the next launch) or
// an error the game caught and reported (glitchless_error, kind manual).
function gamemakerErrorSuggestion(where, issue, trigger) {
  const m = issue.message || '';
  let cause = `a variable read before it was set, an instance or a struct field that isn't there, or an array index out of range on the path triggered by ${trigger}`;
  if (/unable to find (any )?instance/i.test(m)) cause = `an object read (obj.var or a with()) when it has no instances left, often one destroyed earlier, on the path triggered by ${trigger}: check instance_exists() first, or keep the instance's id and test that`;
  else if (/not set before reading/i.test(m)) cause = `a variable read before anything set it, on the path triggered by ${trigger}: set every instance variable in Create (or check variable_instance_exists()), and read optional struct fields with struct[$ "name"], which gives undefined instead of stopping the game`;
  else if (/index|out of range|bounds/i.test(m)) cause = `an array or DS index past the end, on the path triggered by ${trigger}: check array_length() (or ds_list_size()) first`;
  if (issue.kind === 'crash') return `${where} ${cause}. An unhandled exception stops a GameMaker game, so make that path fail safe (or wrap risky code in try/catch and report it with glitchless_error), and apply game state (score, pickups) before anything that can fail.`;
  return `${where} ${cause}. The game caught this one and carried on; fix the cause so the fallback isn't needed.`;
}

function perfSuggestion(corr, preceding, causes, level, engine) {
  if (engine === 'godot') return godotPerfSuggestion(corr, preceding, causes, level);
  if (engine === 'gamemaker') return gamemakerPerfSuggestion(corr, preceding, causes, level);
  if (engine === 'phaser') return phaserPerfSuggestion(corr, preceding, causes, level);
  if (engine === 'unity') return unityPerfSuggestion(corr, preceding, causes, level);
  if (engine === 'unreal') return unrealPerfSuggestion(corr, preceding, causes, level);
  if (engine === 'babylon' || engine === 'playcanvas') return webEnginePerfSuggestion(engine, corr, preceding, causes, level);
  const tips = [];
  const gauge = corr[0]?.key;
  const trigger = preceding[0]?.share >= 0.3 ? preceding[0].event : null;
  if (gauge || trigger) {
    // Lights cost per pixel and change every material's shader, so their fix is not the mesh one.
    const fix = /light/i.test(gauge || '')
      ? 'If it adds lights, keep their number constant: a small pool of lights moved to where they are needed, or emissive materials and glow sprites instead of a light per object.'
      : 'If it creates many meshes, render them with one InstancedMesh or THREE.Points, share a single geometry/material, pool objects instead of allocating per effect, and remove + dispose() them when the effect ends.';
    tips.push(`Find the code that runs on ${trigger ? `\`${trigger}\`` : 'the hitch'}${gauge ? ` and drives \`${gauge}\`` : ''}. ${fix}`);
  }
  if (causes.shader_compile) tips.push('Some hitches coincide with new shader programs: pre-compile materials with renderer.compileAsync(scene, camera) during loading, and keep the number of lights constant (adding or removing a light recompiles every lit material).');
  if (causes.texture_upload) tips.push('Some hitches upload many textures in one frame (a CanvasTexture per object, or needsUpdate on every change): share one texture or atlas across objects, redraw only what changed, and dispose() textures with the objects that used them.');
  if (causes.geometry_upload) tips.push('Some hitches upload many geometry buffers in one frame: share one geometry between copies (or an InstancedMesh), and create them before they are needed rather than on the frame they appear.');
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

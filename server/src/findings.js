// Findings: turns raw telemetry into ranked, evidence-backed findings.
// Written for two readers: a human on the dashboard, and a coding agent over MCP — so every
// finding says what's wrong, how sure we are (numbers), where to look, and what usually fixes it.

import { performance, errorIssues, funnel, versions, deathHotspots, eventLift, deathsOf, levelFacts, sessionCount, round, pct } from './analytics.js';
import { dailySdks } from './daily.js';
import { inFirstSeenOrder, valueQuantile, valueCount, addValueMaps } from './facts.js';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

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
      summary: `${issue.count} occurrences in ${issue.sessions} sessions (${issue.sessions_pct}% of sessions)${issue.levels.length ? ` on ${issue.levels.join(', ')}` : ''}, first seen in ${issue.first_version}. ${issue.fatal ? FATAL_WORDS[issue.kind] || 'Unhandled — reaches window.onerror.' : ''}${crumbs.length ? ` Typically right after: ${crumbs.join(' → ')}.` : ''}`,
      evidence: { fingerprint: issue.fingerprint, kind: issue.kind, location: issue.location, stack: issue.stack?.split('\n').slice(0, 6).join('\n'), count: issue.count, sessions: issue.sessions, versions: issue.versions, levels: issue.levels, breadcrumbs: issue.breadcrumbs },
      suggestion: !issue.location ? 'Reproduce with the breadcrumbs above and guard the failing path.' : errorSuggestion(engineIn(ctx, (s) => s.session_id === issue.sample_session), issue, crumbs),
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
      deaths.map((d) => ({ ...d, rage_quit: d.rage_quit ?? ragers.get(d.session_id) === d.ts })),
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
        engine === 'godot' || engine === 'unity'
          ? 'Players expect to be playing within seconds of opening the game, and some give up during a long splash screen.'
          : 'Web portals expect gameplay within ~20s and every extra second costs conversion-to-play.',
      evidence: { ttff_p50: perf.kpis.ttff_p50, ttff_p95: perf.kpis.ttff_p95 },
      suggestion: SLOW_START_TIPS[engine],
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

// Which SDK sent most of these sessions, so fix advice names that engine's APIs: 'godot', 'unity',
// 'phaser', or 'web' (the browser SDK on its own or with three.js).
const SDK_ENGINES = { 'glitchless-godot/': 'godot', 'glitchless-unity/': 'unity', 'glitchless-phaser/': 'phaser' };
function engineOf(sessions) {
  return engineOfSdks(sessions.map((s) => [s?.sdk || '', 1]));
}

// The engine of the sessions that pass `keep`. A daily context has no sessions, only how many each SDK
// sent: its advice follows the SDK of most of the range's sessions.
function engineIn(ctx, keep) {
  if (ctx.daily) return engineOfSdks(Object.entries(dailySdks(ctx)));
  return engineOf([...ctx.sessions.values()].filter(keep));
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
};

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
    default:
      return `${where} an unchecked lookup (e.g. a pool/array .find() returning undefined) on the code path triggered by ${trigger}. Make it fail safe and make sure game state (score, pickups) is applied before anything that can throw.`;
  }
}

const QUALITY_TIER_TIPS = {
  godot: 'Add a quality tier: when gpu_tier is low or p95 stays above budget for 5s, render 3D at a lower resolution (Viewport.scaling_3d_scale around 0.7), turn off shadows, glow and SSAO in the WorldEnvironment, drop MSAA and halve particle amounts.',
  unity: 'Add a quality tier: when the device tier is low or p95 stays above budget for 5s, switch QualitySettings to a lower level, render at a lower scale (renderScale on the URP asset, or ScalableBufferManager), turn off shadows and post-processing, and halve particle counts.',
  phaser: 'Add a quality tier: when gpu_tier is low or p95 stays above budget for 5s, render at a lower resolution (a smaller game size with Scale.FIT, and resolution 1), drop preFX/postFX filters and lights, and halve particle emitter quantities.',
  web: 'Add a quality tier: cap devicePixelRatio at 1.5, disable shadows/post-processing and halve particle counts when gpu_tier is low or p95 stays above budget for 5s.',
};

const SLOW_START_TIPS = {
  godot: 'Keep the first scene small and load the rest in the background with ResourceLoader.load_threaded_request(), preload() only what the first screen needs, turn on the Shader Baker in the export preset (Godot 4.5+) so the first frame does not wait on shader compiles, and use VRAM-compressed textures.',
  unity: 'Keep the first scene small and load the rest with SceneManager.LoadSceneAsync() or Addressables, move heavy Awake()/Start() work behind the first frame, warm shaders behind the splash screen with a ShaderVariantCollection, and use compressed textures (ASTC on phones).',
  phaser: 'Have the Preloader load only what the menu and first level need and load later levels in their own scenes, pack images into texture atlases, and ship compressed audio (and compressed textures where the target supports them).',
  web: 'Lazy-load non-first-level assets, compress textures (KTX2/Basis) and meshes (Draco/Meshopt), and warm shaders with renderer.compileAsync before the first frame.',
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

function perfSuggestion(corr, preceding, causes, level, engine) {
  if (engine === 'godot') return godotPerfSuggestion(corr, preceding, causes, level);
  if (engine === 'phaser') return phaserPerfSuggestion(corr, preceding, causes, level);
  if (engine === 'unity') return unityPerfSuggestion(corr, preceding, causes, level);
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

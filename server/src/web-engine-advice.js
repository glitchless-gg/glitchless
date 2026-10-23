// Fix advice for the browser SDK's Babylon.js and PlayCanvas adapters (SPEC §1), in each engine's own APIs. findings.js
// picks the engine from the session's SDK name (glitchless-babylon/…, glitchless-playcanvas/…) and asks here.

export const WEB_ENGINES = { 'glitchless-babylon/': 'babylon', 'glitchless-playcanvas/': 'playcanvas' };

// What an error's summary says when the error kind is fatal, where it differs from the other engines'.
export const WEB_ENGINE_FATAL_WORDS = {
  'babylon:game_loop_stopped': "Babylon.js's render loop stopped — the game froze and the player could only leave.",
  'playcanvas:js': 'Unhandled — PlayCanvas skips the rest of that script method every time (and its debug build turns the script off).',
};

export function webEngineErrorSuggestion(engine, where, trigger) {
  if (engine === 'babylon')
    return `${where} an unchecked lookup (scene.getMeshByName() or a table entry that returns null or undefined, a mesh already disposed but still used by an observer or a timer) on the code path triggered by ${trigger}. In Babylon.js an uncaught error inside the render loop (an onBeforeRenderObservable observer, an action, an animation event) stops engine.runRenderLoop for good, so make the path fail safe, remove a mesh's observers when it is disposed (mesh.onDisposeObservable), and apply game state (score, pickups) before anything that can throw.`;
  if (engine === 'playcanvas')
    return `${where} an unchecked lookup (entity.findByName() or a table entry that returns null or undefined, an entity already destroyed but still used by a script, a timer or an app.on() handler) on the code path triggered by ${trigger}. PlayCanvas keeps running after a script throws, but the rest of that update() is skipped every frame (and the debug build turns the script off), so make the path fail safe, remove app.on() handlers in the script's 'destroy' event, and apply game state (score, pickups) before anything that can throw.`;
  return null;
}

export const WEB_ENGINE_QUALITY_TIPS = {
  babylon: "Add a quality tier: when gpu_tier is low or p95 stays above budget for 5s, render at a lower resolution (engine.setHardwareScalingLevel(1.5) or 2), turn off shadows and post-processes, freeze what doesn't change (scene.freezeActiveMeshes(), material.freeze()) and halve particle counts; Babylon's SceneOptimizer can step through these for you.",
  playcanvas: 'Add a quality tier: when gpu_tier is low or p95 stays above budget for 5s, render at a lower resolution (app.graphicsDevice.maxPixelRatio = 1), turn off shadows and post effects, keep a fixed few lights and halve particle counts.',
};

export const WEB_ENGINE_SLOW_START_TIPS = {
  babylon: 'Load only what the first level needs (AssetsManager or LoadAssetContainerAsync, the rest later), import only the modules you use from @babylonjs/core instead of the whole package, ship compressed textures (KTX2) and Draco or meshopt meshes, and await scene.whenReadyAsync() behind a loading screen so shaders compile before the first frame.',
  playcanvas: 'Preload only what the first scene needs (turn preload off for the rest and load it by tag later), ship compressed textures (Basis) and Draco meshes, and render the first scene once behind the loading screen so its shaders compile before play.',
};

// One tip per hitch cause the adapters name (SPEC §1): what the slow frame compiled, created or uploaded, or where
// its time went.
const CAUSE_TIPS = {
  babylon: {
    shader_compile:
      "Some hitches compile shaders on first use: compile every material the level uses behind the loading screen (await material.forceCompilationAsync(mesh), or scene.whenReadyAsync() before the first frame), and don't bake per-object values (a colour, a seed) into a ShaderMaterial's source: register the shader once in ShaderStore.ShadersStore (Effect.ShadersStore) and pass the value as a uniform, so every copy shares one compiled effect.",
    object_spawn:
      'Some hitches create many meshes in one frame: draw copies as instances (mesh.createInstance()) or thin instances (mesh.thinInstanceAdd(), one draw call for thousands), clone from one source mesh instead of calling MeshBuilder per copy, and pool them (setEnabled(false) and reuse) instead of dispose() and re-create.',
    texture_upload:
      'Some hitches upload textures mid-game (a new Texture or DynamicTexture per object, or dynamicTexture.update() every frame): create textures before the level starts, share one texture or atlas between copies, and redraw a DynamicTexture only when what it shows changes.',
    geometry_upload: 'Some hitches upload many vertex buffers in one frame: share geometry through instances or thin instances rather than building a mesh per copy, and build meshes before the frame they appear.',
    scene_change:
      'Some hitches come with a new scene: load its assets first (AssetsManager, or LoadAssetContainerAsync then addAllToScene()) and await scene.whenReadyAsync() behind a loading screen (engine.displayLoadingUI()) before rendering it, so its shaders compile before play.',
    script:
      'Some hitches are long update frames (onBeforeRenderObservable observers, animations, physics): look for loops over every mesh (scene.getMeshByName() is a search), observers added per spawn and never removed, and new Vector3 or Matrix objects every frame (use the ...ToRef methods and TmpVectors).',
    render:
      "Some hitches are long render frames: cut draw calls with instances, thin instances or Mesh.MergeMeshes() for static scenery; when the set of visible meshes doesn't change, scene.freezeActiveMeshes() skips their evaluation every frame; freeze materials that don't change (material.freeze()) and keep shadow casters and render targets few.",
    gc: 'Heap drops during hitches suggest GC pauses: avoid creating Vector3, Matrix, Color and arrays every frame; use the ...ToRef and ...InPlace methods and TmpVectors.',
    asset_load: 'Hitches overlap asset loads: load with the AssetsManager or LoadAssetContainerAsync before the level starts, behind a loading screen.',
    frozen: 'Some frames froze for over 0.7s: something blocked the main thread for that long (a synchronous load, a big MergeMeshes(), a long loop); move it behind a loading screen or split it up.',
  },
  playcanvas: {
    shader_compile:
      "Some hitches compile shaders the first time a material variant is drawn: create materials once instead of per spawn and keep their settings the same (each new combination of maps, lighting and options is a new shader), and draw everything the level uses once behind the loading screen (enable it for a frame under the loading screen, or app.render() before play) so the shaders are built before the player sees them.",
    object_spawn:
      'Some hitches add many entities in one frame: clone one prepared entity instead of building each, pool entities (enabled = false, then reuse) instead of destroy() and new Entity, and draw many copies of one mesh with hardware instancing (meshInstance.setInstancing()) or a batch group (app.batcher).',
    geometry_upload: 'Some hitches create many vertex buffers in one frame (a new Mesh per object): share one Mesh between mesh instances or draw the copies with hardware instancing (meshInstance.setInstancing()), and build meshes before the frame they appear.',
    texture_upload: 'Some hitches create or upload textures mid-game (a new Texture or canvas texture per object): load textures as assets before the level starts, share one texture or atlas, and upload() a dynamic texture only when it changed.',
    scene_change: 'Some hitches come with a scene load: load the next scene\'s assets first (tag them and load by tag), switch with app.scenes.changeScene() behind a loading screen, and render one frame before play so its shaders compile.',
    script: 'Some hitches are long update frames: look for scripts that search the hierarchy every frame (findByName(), find()), new Vec3 or Mat4 objects every update (keep scratch ones), and app.on() handlers added on every spawn or restart and never removed with off().',
    render: 'Some hitches are long render frames: cut draw calls by batching (batch groups and app.batcher), hardware instancing for repeated meshes and shared materials, and keep shadow-casting lights few.',
    gc: 'Heap drops during hitches suggest GC pauses: avoid new Vec3, Mat4, Quat and arrays in every update; keep scratch objects.',
    asset_load: 'Hitches overlap asset loads: preload what the level needs (preload on, or load its assets by tag before starting it).',
    frozen: 'Some frames froze for over 0.7s: something blocked the main thread for that long (a synchronous load, a big hierarchy built at once, a long loop); move it behind a loading screen or split it up.',
  },
};

// The adapters' own gauges (SPEC §1), when one rises with the hitches.
const GAUGE_TIPS = {
  babylon: {
    meshes: '`meshes` counts meshes in the scene: something creates them and never disposes them. dispose() what is done (or setEnabled(false) and reuse it), and draw many copies as instances or thin instances of one mesh.',
    active_meshes: '`active_meshes` counts the meshes Babylon draws each frame: merge or cull scenery, use instances, and call scene.freezeActiveMeshes() once a level\'s static meshes are in place.',
    materials: '`materials` counts materials: one per copy (a clone, or a new StandardMaterial or ShaderMaterial per spawn) costs a shader bind each, and a compile each when its source or defines differ. Share one material.',
    textures: '`textures` counts textures: dispose() the ones you stop using, load each image once, and share it.',
    render_observers: "`render_observers` counts the scene's before- and after-render observers: it climbs when something adds one per spawn or restart (onBeforeRenderObservable.add() or registerBeforeRender()) and never removes it. Keep the observer add() returns and remove() it when its object goes, or use addOnce().",
  },
  playcanvas: {
    entities: '`entities` counts entities in the hierarchy: something creates them and never calls destroy(). Destroy what is done, or pool and reuse it (enabled = false).',
    mesh_instances: '`mesh_instances` counts what the renderer culls and draws each frame: share meshes, and use hardware instancing or batch groups for repeated objects.',
    materials: '`materials` counts distinct materials in use: a new StandardMaterial per entity breaks batching and binds a shader per draw. Share one, or clone only what really differs.',
    textures: '`textures` counts textures on the device: destroy() the ones you stop using, load each image once as an asset and share it.',
    lights: '`lights` counts light components: every dynamic light costs every lit material, and changing how many there are rebuilds shaders on WebGL. Keep a fixed few, or use clustered lighting.',
  },
};

const GENERIC = ['script', 'render', 'frozen'];

export function webEnginePerfSuggestion(engine, corr, preceding, causes, level) {
  const tips = [];
  const gauge = corr[0]?.key;
  const trigger = preceding[0]?.share >= 0.3 ? preceding[0].event : null;
  if (gauge || trigger) tips.push(`Find the code that runs on ${trigger ? `\`${trigger}\`` : 'the hitch'}${gauge ? ` and drives \`${gauge}\`` : ''}.`);
  if (gauge && GAUGE_TIPS[engine][gauge]) tips.push(GAUGE_TIPS[engine][gauge]);
  // Causes that name the stall (a compile, a spawn, an upload) before where its time went.
  const top = Object.entries(causes)
    .filter(([c]) => CAUSE_TIPS[engine][c])
    .sort((a, b) => GENERIC.includes(a[0]) - GENERIC.includes(b[0]) || b[1] - a[1])
    .slice(0, 3);
  for (const [c] of top) tips.push(CAUSE_TIPS[engine][c]);
  if (!tips.length) tips.push(`Profile ${level.key} with glitchless_measure and glitchless_inspect_scene: look at update and render CPU, draw calls (${level.draw_calls} avg) and the largest mesh groups.`);
  return tips.join(' ');
}

// Writes the GameMaker project files (Glitchless.yyp and each asset's .yy) from the list below and the .gml files on
// disk, in the format GameMaker 2024.2 and later save (LTS 2026, IDE 2026.0.0.16), and makes the local package.
//
//   node gamemaker/tools/project.mjs           rewrite the .yyp and .yy files (after adding a script, object or event)
//   node gamemaker/tools/project.mjs package   also write gamemaker/dist/Glitchless-<version>.yymps, the SDK on its own
//
// An object's events come from its .gml files: Create_0.gml is Create, Step_1.gml Begin Step, Draw_76.gml Pre-Draw,
// Other_62.gml Async HTTP, and so on. The options files follow YoYo Games' ImGUI-Sample (MIT, Opera Norway AS).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'Glitchless';
const IDE_VERSION = '2026.0.0.16';
const SDK_VERSION = /#macro GLITCHLESS_VERSION "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'scripts/__glitchless_core/__glitchless_core.gml'), 'utf8'))[1];

const SDK = {
  folder: 'Glitchless',
  scripts: ['Glitchless', '__glitchless_core', '__glitchless_send', '__glitchless_sketch', '__glitchless_text', '__glitchless_device', '__glitchless_bug_report', '__glitchless_play', '__glitchless_engine'],
  objects: { obj_glitchless: { persistent: true }, obj_glitchless_tail: { persistent: true } },
};
const DEMO = {
  folder: 'Demo',
  scripts: ['demo'],
  objects: { obj_demo: { persistent: true }, obj_spark: {}, obj_bonus_target: {} },
  rooms: { rm_boot: ['obj_demo'], rm_level_1: [], rm_level_2: [], rm_level_3: [] },
  included: ['glitchless_fixture.json'],
};
const EVENT_TYPES = { Create: 0, Destroy: 1, Alarm: 2, Step: 3, Collision: 4, Keyboard: 5, Mouse: 6, Other: 7, Draw: 8, KeyPress: 9, KeyRelease: 10, CleanUp: 12, Gesture: 13, PreCreate: 14 };

// ───────────────────────────── GameMaker's JSON ─────────────────────────────

// A number GameMaker writes with a decimal point (1.0, 32.0).
class Float {
  constructor(v) {
    this.v = v;
  }
}
const f = (v) => new Float(v);

function inline(v) {
  if (v instanceof Float) return Number.isInteger(v.v) ? v.v.toFixed(1) : String(v.v);
  if (Array.isArray(v)) return v.length ? `[${v.map((x) => inline(x) + ',').join('')}]` : '[]';
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${inline(x)},`).join('')}}`;
  return JSON.stringify(v);
}

// The top level and its plain objects one key a line; arrays one inline item a line; everything deeper inline.
function gmJson(obj) {
  const lines = ['{'];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length && v.some((x) => x && typeof x === 'object')) {
      lines.push(`  ${JSON.stringify(k)}:[`);
      for (const x of v) lines.push(`    ${inline(x)},`);
      lines.push('  ],');
    } else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Float)) {
      lines.push(`  ${JSON.stringify(k)}:{`);
      for (const [k2, x] of Object.entries(v)) lines.push(`    ${JSON.stringify(k2)}:${inline(x)},`);
      lines.push('  },');
    } else lines.push(`  ${JSON.stringify(k)}:${inline(v)},`);
  }
  lines.push('}');
  return lines.join('\n');
}

function write(rel, text) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A GUID that stays the same from run to run, so rewriting the project changes nothing.
function guid(seed) {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ───────────────────────────── assets ─────────────────────────────

const folderRef = (folder) => ({ name: folder, path: `folders/${folder}.yy` });

function scriptYy(name, folder) {
  return gmJson({ $GMScript: 'v1', '%Name': name, isCompatibility: false, isDnD: false, name, parent: folderRef(folder), resourceType: 'GMScript', resourceVersion: '2.0' });
}

function events(name) {
  const dir = path.join(ROOT, 'objects', name);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.gml')) : [];
  return files
    .map((file) => {
      const m = /^([A-Za-z]+)_(\d+)\.gml$/.exec(file);
      if (!m || !(m[1] in EVENT_TYPES)) throw new Error(`objects/${name}/${file}: not an event file name`);
      return { type: EVENT_TYPES[m[1]], num: Number(m[2]) };
    })
    .sort((a, b) => a.type - b.type || a.num - b.num)
    .map((e) => ({ $GMEvent: 'v1', '%Name': '', collisionObjectId: null, eventNum: e.num, eventType: e.type, isDnD: false, name: '', resourceType: 'GMEvent', resourceVersion: '2.0' }));
}

function objectYy(name, folder, { persistent = false, visible = true } = {}) {
  return gmJson({
    $GMObject: '',
    '%Name': name,
    eventList: events(name),
    managed: true,
    name,
    overriddenProperties: [],
    parent: folderRef(folder),
    parentObjectId: null,
    persistent,
    physicsAngularDamping: f(0.1),
    physicsDensity: f(0.5),
    physicsFriction: f(0.2),
    physicsGroup: 1,
    physicsKinematic: false,
    physicsLinearDamping: f(0.1),
    physicsObject: false,
    physicsRestitution: f(0.1),
    physicsSensor: false,
    physicsShape: 1,
    physicsShapePoints: [],
    physicsStartAwake: true,
    properties: [],
    resourceType: 'GMObject',
    resourceVersion: '2.0',
    solid: false,
    spriteId: null,
    spriteMaskId: null,
    visible,
  });
}

function roomYy(name, folder, objects) {
  const instances = objects.map((obj, i) => {
    const inst = `inst_${crypto.createHash('sha1').update(`${name}/${obj}/${i}`).digest('hex').slice(0, 8).toUpperCase()}`;
    return { $GMRInstance: 'v4', '%Name': inst, colour: 4294967295, frozen: false, hasCreationCode: false, ignore: false, imageIndex: 0, imageSpeed: f(1), inheritCode: false, inheritedItemId: null, inheritItemSettings: false, isDnd: false, name: inst, objectId: { name: obj, path: `objects/${obj}/${obj}.yy` }, properties: [], resourceType: 'GMRInstance', resourceVersion: '2.0', rotation: f(0), scaleX: f(1), scaleY: f(1), x: f(0), y: f(0) };
  });
  const view = { hborder: 32, hport: 540, hspeed: -1, hview: 540, inherit: false, objectId: null, vborder: 32, visible: false, vspeed: -1, wport: 960, wview: 960, xport: 0, xview: 0, yport: 0, yview: 0 };
  return gmJson({
    $GMRoom: 'v1',
    '%Name': name,
    creationCodeFile: '',
    inheritCode: false,
    inheritCreationOrder: false,
    inheritLayers: false,
    instanceCreationOrder: instances.map((i) => ({ name: i.name, path: `rooms/${name}/${name}.yy` })),
    isDnd: false,
    layers: [
      { $GMRInstanceLayer: '', '%Name': 'Instances', depth: 0, effectEnabled: true, effectType: null, gridX: 32, gridY: 32, hierarchyFrozen: false, inheritLayerDepth: false, inheritLayerSettings: false, inheritSubLayers: true, inheritVisibility: true, instances, layers: [], name: 'Instances', properties: [], resourceType: 'GMRInstanceLayer', resourceVersion: '2.0', userdefinedDepth: false, visible: true },
      { $GMRBackgroundLayer: '', '%Name': 'Background', animationFPS: f(15), animationSpeedType: 0, colour: 4281533713, depth: 100, effectEnabled: true, effectType: null, gridX: 32, gridY: 32, hierarchyFrozen: false, hspeed: f(0), htiled: false, inheritLayerDepth: false, inheritLayerSettings: false, inheritSubLayers: true, inheritVisibility: true, layers: [], name: 'Background', properties: [], resourceType: 'GMRBackgroundLayer', resourceVersion: '2.0', spriteId: null, stretch: false, userdefinedAnimFPS: false, userdefinedDepth: false, visible: true, vspeed: f(0), vtiled: false, x: 0, y: 0 },
    ],
    name,
    parent: folderRef(folder),
    parentRoom: null,
    physicsSettings: { inheritPhysicsSettings: false, PhysicsWorld: false, PhysicsWorldGravityX: f(0), PhysicsWorldGravityY: f(10), PhysicsWorldPixToMetres: f(0.1) },
    resourceType: 'GMRoom',
    resourceVersion: '2.0',
    roomSettings: { Height: 540, inheritRoomSettings: false, persistent: false, Width: 960 },
    sequenceId: null,
    views: Array(8).fill(view),
    viewSettings: { clearDisplayBuffer: true, clearViewBackground: false, enableViews: false, inheritViewSettings: false },
    volume: f(1),
  });
}

function options() {
  const display = 'Glitchless Demo';
  write('options/main/options_main.yy', gmJson({
    $GMMainOptions: 'v5', '%Name': 'Main', name: 'Main', option_allow_instance_change: false, option_audio_error_behaviour: false, option_author: '', option_collision_compatibility: false, option_copy_on_write_enabled: false, option_draw_colour: 4294967295, option_gameguid: guid('glitchless-gamemaker-demo'), option_gameid: '0', option_game_speed: 60, option_legacy_json_parsing: false, option_legacy_number_conversion: false, option_legacy_other_behaviour: false, option_legacy_primitive_drawing: false, option_mips_for_3d_textures: false, option_remove_unused_assets: false, option_sci_usesci: false, option_spine_licence: false, option_steam_app_id: '0', option_template_description: null, option_template_icon: '${base_options_dir}/main/template_icon.png', option_template_image: '${base_options_dir}/main/template_image.png', option_window_colour: 255, resourceType: 'GMMainOptions', resourceVersion: '2.0',
  }) + '\n');
  write('options/mac/options_mac.yy', gmJson({
    $GMMacOptions: '', '%Name': 'macOS', name: 'macOS', option_mac_allow_fullscreen: false, option_mac_allow_incoming_network: false, option_mac_allow_outgoing_network: true, option_mac_apple_sign_in: false, option_mac_app_category: 'Games', option_mac_app_id: 'gg.glitchless.demo', option_mac_arm64: true, option_mac_build_app_store: false, option_mac_build_number: 0, option_mac_copyright: '', option_mac_disable_sandbox: false, option_mac_display_cursor: true, option_mac_display_name: display, option_mac_enable_retina: false, option_mac_enable_steam: false, option_mac_icon_png: '${base_options_dir}/mac/icons/1024.png', option_mac_installer_background_png: '${base_options_dir}/mac/splash/installer_background.png', option_mac_interpolate_pixels: true, option_mac_menu_dock: false, option_mac_min_version: '10.10', option_mac_output_dir: '~/gamemakerstudio2', option_mac_resize_window: false, option_mac_scale: 0, option_mac_signing_identity: 'Developer ID Application:', option_mac_splash_png: '${base_options_dir}/mac/splash/splash.png', option_mac_start_fullscreen: false, option_mac_team_id: '', option_mac_texture_page: '2048x2048', option_mac_version: '0.1.0.0', option_mac_vsync: true, option_mac_x86_64: true, resourceType: 'GMMacOptions', resourceVersion: '2.0',
  }) + '\n');
  write('options/windows/options_windows.yy', gmJson({
    $GMWindowsOptions: 'v2', '%Name': 'Windows', name: 'Windows', option_windows_allow_fullscreen_switching: false, option_windows_borderless: false, option_windows_company_info: 'Glitchless', option_windows_copyright_info: '', option_windows_copy_exe_to_dest: false, option_windows_d3dswapeffectdiscard: false, option_windows_description_info: display, option_windows_disable_sandbox: false, option_windows_display_cursor: true, option_windows_display_name: display, option_windows_enable_steam: false, option_windows_executable_name: 'GlitchlessDemo.exe', option_windows_icon: '${base_options_dir}/windows/icons/icon.ico', option_windows_installer_finished: '${base_options_dir}/windows/installer/finished.bmp', option_windows_installer_header: '${base_options_dir}/windows/installer/header.bmp', option_windows_interpolate_pixels: true, option_windows_license: '${base_options_dir}/windows/installer/license.txt', option_windows_nsis_file: '${base_options_dir}/windows/installer/nsis_script.nsi', option_windows_product_info: display, option_windows_resize_window: false, option_windows_save_location: 0, option_windows_scale: 0, option_windows_sleep_margin: 10, option_windows_splash_screen: '${base_options_dir}/windows/splash/splash.png', option_windows_start_fullscreen: false, option_windows_steam_use_alternative_launcher: false, option_windows_texture_page: '2048x2048', option_windows_use_raw_mouse: false, option_windows_use_splash: false, option_windows_version: '0.1.0.0', option_windows_vsync: true, resourceType: 'GMWindowsOptions', resourceVersion: '2.0',
  }) + '\n');
  write('options/linux/options_linux.yy', gmJson({
    $GMLinuxOptions: '', '%Name': 'Linux', name: 'Linux', option_linux_allow_fullscreen: false, option_linux_disable_sandbox: false, option_linux_display_cursor: true, option_linux_display_name: display, option_linux_display_splash: false, option_linux_enable_steam: false, option_linux_homepage: 'https://glitchless.gg', option_linux_icon: '${base_options_dir}/linux/icons/64.png', option_linux_interpolate_pixels: true, option_linux_long_desc: '', option_linux_maintainer_email: '', option_linux_resize_window: false, option_linux_scale: 0, option_linux_short_desc: '', option_linux_splash_screen: '${base_options_dir}/linux/splash/splash.png', option_linux_start_fullscreen: false, option_linux_sync: true, option_linux_texture_page: '2048x2048', option_linux_version: '0.1.0.0', resourceType: 'GMLinuxOptions', resourceVersion: '2.0',
  }) + '\n');
}

// ───────────────────────────── the project ─────────────────────────────

function projectYyp({ name, groups, rooms = [], included = [], meta = {}, template = 'game' }) {
  const resources = [];
  for (const g of groups) {
    for (const s of g.scripts) resources.push({ id: { name: s, path: `scripts/${s}/${s}.yy` } });
    for (const o of Object.keys(g.objects)) resources.push({ id: { name: o, path: `objects/${o}/${o}.yy` } });
    for (const r of Object.keys(g.rooms || {})) resources.push({ id: { name: r, path: `rooms/${r}/${r}.yy` } });
  }
  resources.sort((a, b) => (a.id.path.split('/')[0] + '/' + a.id.name.toLowerCase()).localeCompare(b.id.path.split('/')[0] + '/' + b.id.name.toLowerCase()));
  return gmJson({
    $GMProject: 'v1',
    '%Name': name,
    AudioGroups: [{ $GMAudioGroup: 'v1', '%Name': 'audiogroup_default', exportDir: '', name: 'audiogroup_default', resourceType: 'GMAudioGroup', resourceVersion: '2.0', targets: -1 }],
    configs: { children: [], name: 'Default' },
    defaultScriptType: 1,
    Folders: groups.map((g) => ({ $GMFolder: '', '%Name': g.folder, folderPath: `folders/${g.folder}.yy`, name: g.folder, resourceType: 'GMFolder', resourceVersion: '2.0' })),
    ForcedPrefabProjectReferences: [],
    IncludedFiles: included.map((file) => ({ $GMIncludedFile: '', '%Name': file, CopyToMask: -1, filePath: 'datafiles', name: file, resourceType: 'GMIncludedFile', resourceVersion: '2.0' })),
    isEcma: false,
    LibraryEmitters: [],
    MetaData: { IDEVersion: IDE_VERSION, ...meta },
    name,
    resources,
    resourceType: 'GMProject',
    resourceVersion: '2.0',
    RoomOrderNodes: rooms.map((r) => ({ roomId: { name: r, path: `rooms/${r}/${r}.yy` } })),
    templateType: template,
    TextureGroups: [{ $GMTextureGroup: '', '%Name': 'Default', autocrop: true, border: 2, compressFormat: 'bz2', customOptions: '', directory: '', groupParent: null, isScaled: true, loadType: 'default', mipsToGenerate: 0, name: 'Default', resourceType: 'GMTextureGroup', resourceVersion: '2.0', targets: -1 }],
  });
}

function resourceOrder(groups) {
  const order = [];
  for (const g of groups) {
    [...g.scripts, ...Object.keys(g.objects), ...Object.keys(g.rooms || {})].forEach((n, i) => {
      const dir = g.scripts.includes(n) ? 'scripts' : g.objects[n] ? 'objects' : 'rooms';
      order.push({ name: n, order: i + 1, path: `${dir}/${n}/${n}.yy` });
    });
  }
  return gmJson({ FolderOrderSettings: groups.map((g, i) => ({ name: g.folder, order: i + 1, path: `folders/${g.folder}.yy` })), ResourceOrderSettings: order });
}

function writeAssets(groups) {
  for (const g of groups) {
    for (const s of g.scripts) write(`scripts/${s}/${s}.yy`, scriptYy(s, g.folder) + '\n');
    for (const [o, opts] of Object.entries(g.objects)) write(`objects/${o}/${o}.yy`, objectYy(o, g.folder, opts) + '\n');
    for (const [r, objs] of Object.entries(g.rooms || {})) write(`rooms/${r}/${r}.yy`, roomYy(r, g.folder, objs) + '\n');
  }
}

writeAssets([SDK, DEMO]);
options();
write(`${NAME}.yyp`, projectYyp({ name: NAME, groups: [SDK, DEMO], rooms: Object.keys(DEMO.rooms), included: DEMO.included }) + '\n');
write(`${NAME}.resource_order`, resourceOrder([SDK, DEMO]) + '\n');
console.log(`wrote ${NAME}.yyp: ${SDK.scripts.length + DEMO.scripts.length} scripts, ${Object.keys({ ...SDK.objects, ...DEMO.objects }).length} objects, ${Object.keys(DEMO.rooms).length} rooms`);

// ───────────────────────────── the local package (.yymps) ─────────────────────────────

if (process.argv[2] === 'package') {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-yymps-'));
  try {
    const files = [];
    const copy = (rel) => {
      const to = path.join(stage, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), to);
      files.push(rel);
    };
    const pkgName = `Glitchless`;
    const yyp = projectYyp({ name: pkgName, groups: [SDK], meta: { PackageType: 'Asset', PackageName: 'Glitchless', PackageID: 'gg.glitchless.gamemaker', PackagePublisher: 'Glitchless', PackageVersion: SDK_VERSION }, template: null });
    fs.writeFileSync(path.join(stage, `${pkgName}.yyp`), yyp + '\n');
    fs.writeFileSync(path.join(stage, `${pkgName}.resource_order`), resourceOrder([SDK]) + '\n');
    fs.writeFileSync(path.join(stage, 'metadata.json'), JSON.stringify({ package_id: 'gg.glitchless.gamemaker', display_name: 'Glitchless', version: SDK_VERSION, package_type: 'asset', ide_version: IDE_VERSION }, null, 2) + '\n');
    files.unshift('metadata.json', `${pkgName}.resource_order`, `${pkgName}.yyp`);
    for (const s of SDK.scripts) for (const ext of ['gml', 'yy']) copy(`scripts/${s}/${s}.${ext}`);
    for (const o of Object.keys(SDK.objects)) {
      copy(`objects/${o}/${o}.yy`);
      for (const e of fs.readdirSync(path.join(ROOT, 'objects', o)).filter((x) => x.endsWith('.gml'))) copy(`objects/${o}/${e}`);
    }
    // The .yy files point at the package's folder, which its .yyp lists.
    const md5 = (rel) => crypto.createHash('md5').update(fs.readFileSync(path.join(stage, rel))).digest('hex').toUpperCase();
    const manifest = ['\uFEFF<?xml version="1.0" encoding="utf-8"?>', '<files>', ...files.map((rel) => `\t<file md5="${md5(rel)}">${rel.replace(/\//g, '\\')}</file>`), '</files>', ''].join('\r\n');
    fs.writeFileSync(path.join(stage, 'yymanifest.xml'), manifest);
    const out = path.join(ROOT, 'dist', `Glitchless-${SDK_VERSION}.yymps`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.rmSync(out, { force: true });
    execFileSync('zip', ['-q', '-X', '-r', out, 'metadata.json', `${pkgName}.yyp`, `${pkgName}.resource_order`, 'yymanifest.xml', 'scripts', 'objects'], { cwd: stage });
    console.log(`wrote ${path.relative(path.join(ROOT, '..'), out)} (${fs.statSync(out).size} bytes, ${files.length} files)`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

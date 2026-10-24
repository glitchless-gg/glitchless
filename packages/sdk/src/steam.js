// Steam facts for a game that ships on Steam with Electron and steamworks.js (SPEC §4c): the Steam build and beta
// branch it runs, the Steam hardware, Big Picture, the first controller's Steam Input type and the game's Steam
// language. Read once, at init, from the client the game passes as `steam` (what steamworks.init() returned).
// Nothing else is ever called: steamworks.js aborts the process when a call comes before its init(), so the SDK
// never loads or probes it by itself. No Steam ID is read.

// steamworks.js's InputType (Steamworks' ESteamInputType) → the name every Glitchless SDK sends.
const INPUT_TYPES = {
  Unknown: 'unknown',
  SteamController: 'steam_controller',
  XBox360Controller: 'xbox_360',
  XBoxOneController: 'xbox_one',
  GenericGamepad: 'generic_xinput',
  PS4Controller: 'ps4',
  AppleMFiController: 'apple_mfi',
  AndroidController: 'android',
  SwitchJoyConPair: 'switch_joycon_pair',
  SwitchJoyConSingle: 'switch_joycon_single',
  SwitchProController: 'switch_pro',
  MobileTouch: 'mobile_touch',
  PS3Controller: 'ps3',
  PS5Controller: 'ps5',
  SteamDeckController: 'steam_deck',
};
// ESteamHardwareType (ISteamUtils::IsRunningOnSteamHardware, SDK 1.65), as a number or its name.
const HARDWARE = ['none', 'deck', 'machine', 'frame'];
const HARDWARE_NAMES = { None: 'none', SteamDeck: 'deck', SteamMachine: 'machine', SteamFrame: 'frame' };

// The facts a steamworks.js client answers, or null when it isn't one. A wrapper without a call (steamworks.js has
// nothing for family sharing or timed trials) leaves that fact out.
export function readSteam(client) {
  if (!client || typeof client !== 'object' || !client.apps) return null;
  const call = (ns, fn) => {
    try {
      const f = client[ns]?.[fn];
      return typeof f === 'function' ? f.call(client[ns]) : undefined;
    } catch {
      return undefined;
    }
  };
  const flag = (v) => (typeof v === 'boolean' ? v : undefined);
  const facts = {};
  const build = Number(call('apps', 'appBuildId'));
  // 0 outside a build downloaded from Steam.
  if (Number.isSafeInteger(build) && build > 0) facts.steam_build = build;
  const beta = call('apps', 'currentBetaName');
  // null on the default branch, which Steam calls "public".
  if (beta !== undefined) facts.steam_branch = typeof beta === 'string' && beta ? beta.slice(0, 64) : 'public';
  const hardware = call('utils', 'isRunningOnSteamHardware');
  if (hardware !== undefined) facts.steam_hardware = HARDWARE[hardware] || HARDWARE_NAMES[hardware] || 'none';
  else {
    // Deprecated in SDK 1.65 for IsRunningOnSteamHardware, which steamworks.js doesn't have yet.
    const deck = flag(call('utils', 'isSteamRunningOnSteamDeck'));
    if (deck !== undefined) facts.steam_hardware = deck ? 'deck' : 'none';
  }
  for (const [key, ns, fn] of [
    ['proton', 'utils', 'isRunningUnderProton'],
    ['big_picture', 'utils', 'isSteamInBigPictureMode'],
    ['family_shared', 'apps', 'isSubscribedFromFamilySharing'],
    ['timed_trial', 'apps', 'isTimedTrial'],
  ]) {
    const v = flag(call(ns, fn));
    if (v !== undefined) facts[key] = v;
  }
  // Steam Input answers only once the game has called input.init(); before that there are no controllers.
  const controllers = call('input', 'getControllers');
  const first = Array.isArray(controllers) ? controllers[0] : null;
  if (first && typeof first.getType === 'function') {
    try {
      const type = first.getType();
      facts.steam_controller = INPUT_TYPES[type] || (typeof type === 'string' && type ? 'other' : 'unknown');
    } catch {
      // A controller that went away between the two calls.
    }
  }
  const language = call('apps', 'currentGameLanguage');
  if (typeof language === 'string' && language) facts.steam_language = language.slice(0, 32);
  return Object.keys(facts).length ? facts : null;
}

// A device with the Steam facts added: Steam hardware refines the SDK's own Steam Deck guess.
export function withSteam(device, steam) {
  if (!steam) return device;
  const out = { ...device, ...steam };
  if (steam.steam_hardware === 'deck') Object.assign(out, { steam_deck: true, gpu_tier: 'low' });
  return out;
}

// The version a game that passes none reports: its Steam build, so versions compare build by build.
export function steamVersion(steam) {
  return steam?.steam_build ? `steam-${steam.steam_build}` : null;
}

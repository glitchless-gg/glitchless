extends RefCounted
## Steam facts for session_start when the game already uses GodotSteam (SPEC
## §4c): the Steam build and beta branch it runs, the Steam hardware (Steam
## Deck, Steam Machine, Steam Frame), Proton, Big Picture, the first
## controller's Steam Input type, Family Sharing, a timed trial and the game's
## Steam language.
##
## Only the Steam singleton the game already has is read
## (Engine.has_singleton("Steam")), and only once GodotSteam says Steam is
## initialised: before that its calls print engine errors. A GodotSteam
## without a call leaves that fact out. No Steam ID, owner or name is ever
## read. PRIVACY.md beside this file lists every field; keep the two in step.

const HARDWARE := ["none", "deck", "machine", "frame"]  # SteamHardwareType
const CONTROLLERS := [
	"unknown", "steam_controller", "xbox_360", "xbox_one", "generic_xinput", "ps4", "apple_mfi", "android",
	"switch_joycon_pair", "switch_joycon_single", "switch_pro", "mobile_touch", "ps3", "ps5", "steam_deck",
	"steamos_handheld", "switch2_pro", "steam_controller_2026", "steam_frame_controllers",
]  # InputType, Steamworks' ESteamInputType


## The facts of the game's GodotSteam, or {} without one or before it is initialised.
static func read() -> Dictionary:
	if not Engine.has_singleton("Steam"):
		return {}
	return read_from(Engine.get_singleton("Steam"))


## The facts an object shaped like GodotSteam's Steam singleton answers. Tests pass fakes here.
static func read_from(steam: Object) -> Dictionary:
	if steam == null or not initialised(steam):
		return {}
	var facts := {}
	var build: Variant = _call(steam, "getAppBuildId")
	if build is int and build > 0:  # 0 outside a build downloaded from Steam
		facts.steam_build = build
	var beta: Variant = _call(steam, "getCurrentBetaName")
	if beta is String:  # "" on the default branch, which Steam calls "public"
		facts.steam_branch = beta.substr(0, 64) if beta != "" else "public"
	var hardware: Variant = _call(steam, "isRunningOnSteamHardware")  # GodotSteam 4.21, SDK 1.65
	if hardware is int:
		facts.steam_hardware = HARDWARE[hardware] if hardware >= 0 and hardware < HARDWARE.size() else "none"
	else:
		var deck: Variant = _call(steam, "isSteamRunningOnSteamDeck")  # removed in 4.21
		if deck is bool:
			facts.steam_hardware = "deck" if deck else "none"
	for pair in [["proton", "isRunningUnderProton"], ["big_picture", "isSteamInBigPictureMode"], ["family_shared", "isSubscribedFromFamilySharing"]]:
		var v: Variant = _call(steam, pair[1])
		if v is bool:
			facts[pair[0]] = v
	var trial: Variant = _call(steam, "isTimedTrial")  # {seconds_allowed, seconds_played} on a trial, else {}
	if trial is Dictionary:
		facts.timed_trial = not trial.is_empty()
	# Steam Input lists controllers only once the game has called inputInit() and runFrame().
	var controllers: Variant = _call(steam, "getConnectedControllers")
	if controllers is Array and controllers.size() > 0 and steam.has_method("getInputTypeForHandle"):
		facts.steam_controller = controller_name(steam.call("getInputTypeForHandle", controllers[0]))
	var language: Variant = _call(steam, "getCurrentGameLanguage")
	if language is String and language != "":
		facts.steam_language = language.substr(0, 32)
	return facts


## GodotSteam says Steam is up: steamInitEx() (or initialising from the Project
## Settings) leaves its result, and steamInit() with an app ID sets current_app_id.
static func initialised(steam: Object) -> bool:
	if steam.has_method("get_steam_init_result"):
		var result: Variant = steam.call("get_steam_init_result")
		if result is Dictionary and result.has("status"):
			return int(result.status) == 0  # STEAM_API_INIT_RESULT_OK
	if "current_app_id" in steam:
		return int(steam.get("current_app_id")) > 0
	return false


static func controller_name(kind: Variant) -> String:
	if not (kind is int):
		return "other"
	return CONTROLLERS[kind] if kind >= 0 and kind < CONTROLLERS.size() else "other"


## Adds the facts to a session_start device: Steam hardware refines device.gd's own Steam Deck guess.
static func add_to(device: Dictionary, facts: Dictionary) -> void:
	device.merge(facts, true)
	if facts.get("steam_hardware") == "deck":
		device.steam_deck = true
		device.gpu_tier = "low"


static func _call(steam: Object, method: String) -> Variant:
	return steam.call(method) if steam.has_method(method) else null

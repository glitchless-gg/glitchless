extends SceneTree
## Steam facts from GodotSteam (steam.gd), with fakes shaped like GodotSteam's
## Steam singleton: read only once Steam is initialised, never a Steam ID, and
## the Steam build as the version a game passes none. test/e2e.mjs runs it.
##   godot --headless --path godot --script res://test/steam_test.gd

const SteamInfo := preload("res://addons/glitchless/steam.gd")
const Glitchless := preload("res://addons/glitchless/glitchless.gd")


## GodotSteam 4.21 (Steamworks SDK 1.65), as far as steam.gd reads it.
class FakeSteam:
	extends Object
	var status := 0  # get_steam_init_result().status; -1: never initialised
	var current_app_id := 480
	var build := 18231
	var beta := ""
	var hardware := 0
	var controllers: Array = []
	var touched: Array[String] = []

	func get_steam_init_result() -> Dictionary:
		return {} if status < 0 else {"status": status, "verbal": ""}

	func getAppBuildId() -> int:
		return _use("getAppBuildId", build)

	func getCurrentBetaName() -> String:
		return _use("getCurrentBetaName", beta)

	func isRunningOnSteamHardware() -> int:
		return _use("isRunningOnSteamHardware", hardware)

	func isRunningUnderProton() -> bool:
		return _use("isRunningUnderProton", hardware == 1)

	func isSteamInBigPictureMode() -> bool:
		return _use("isSteamInBigPictureMode", false)

	func isSubscribedFromFamilySharing() -> bool:
		return _use("isSubscribedFromFamilySharing", true)

	func isTimedTrial() -> Dictionary:
		return _use("isTimedTrial", {"seconds_allowed": 3600, "seconds_played": 60})

	func getConnectedControllers() -> Array:
		return _use("getConnectedControllers", controllers)

	func getInputTypeForHandle(handle: int) -> int:
		return _use("getInputTypeForHandle", 13 if handle == controllers[0] else 3)

	func getCurrentGameLanguage() -> String:
		return _use("getCurrentGameLanguage", "french")

	func getSteamID() -> int:
		return _use("getSteamID", 76561197960287930)

	func getAppOwner() -> int:
		return _use("getAppOwner", 76561197960287930)

	func _use(name: String, value: Variant) -> Variant:
		touched.append(name)
		return value


## A GodotSteam before 4.21, started with steamInit(app_id): no init result, no Steam hardware, Proton or input.
class OldSteam:
	extends Object
	var current_app_id := 0

	func getAppBuildId() -> int:
		return 0

	func getCurrentBetaName() -> String:
		return "nightly"

	func isSteamRunningOnSteamDeck() -> bool:
		return true

var _failed := 0


func _init() -> void:
	var steam := FakeSteam.new()
	steam.beta = "beta"
	steam.hardware = 1
	steam.controllers = [7001, 7002]
	var facts := SteamInfo.read_from(steam)
	_check("GodotSteam answers the build, branch and hardware", facts.get("steam_build") == 18231 and facts.get("steam_branch") == "beta" and facts.get("steam_hardware") == "deck", JSON.stringify(facts))
	_check("…Proton, Big Picture, Family Sharing and a timed trial", facts.get("proton") == true and facts.get("big_picture") == false and facts.get("family_shared") == true and facts.get("timed_trial") == true, JSON.stringify(facts))
	_check("…the first controller's Steam Input type and the game's language", facts.get("steam_controller") == "ps5" and facts.get("steam_language") == "french", JSON.stringify(facts))
	_check("no Steam ID or owner is read", not ("getSteamID" in steam.touched) and not ("getAppOwner" in steam.touched), str(steam.touched))

	var public := FakeSteam.new()
	public.build = 0
	public.hardware = 2
	var p := SteamInfo.read_from(public)
	_check("the default branch is public, build 0 sends no build, no controllers none", p.get("steam_branch") == "public" and not p.has("steam_build") and p.get("steam_hardware") == "machine" and not p.has("steam_controller"), JSON.stringify(p))

	var down := FakeSteam.new()
	down.status = 2  # STEAM_API_INIT_RESULT_NO_STEAM_CLIENT
	_check("nothing when steamInitEx failed, and nothing is called", SteamInfo.read_from(down).is_empty() and down.touched.is_empty(), str(down.touched))
	var never := FakeSteam.new()
	never.status = -1
	never.current_app_id = 0
	_check("nothing before GodotSteam is initialised", SteamInfo.read_from(never).is_empty() and never.touched.is_empty(), str(never.touched))
	var old := OldSteam.new()
	_check("steamInit() without an app ID can't be told apart from no init: nothing", SteamInfo.read_from(old).is_empty())
	old.current_app_id = 480
	var o := SteamInfo.read_from(old)
	_check("an older GodotSteam sends what it has", o == {"steam_branch": "nightly", "steam_hardware": "deck"}, JSON.stringify(o))
	_check("controller names, and other past the known ones", SteamInfo.controller_name(14) == "steam_deck" and SteamInfo.controller_name(18) == "steam_frame_controllers" and SteamInfo.controller_name(99) == "other")

	var device := {"os": "Linux", "gpu_tier": "mid", "steam_deck": false}
	SteamInfo.add_to(device, {"steam_hardware": "deck", "steam_build": 5})
	_check("Steamworks' Steam Deck is a Steam Deck", device.steam_deck == true and device.gpu_tier == "low" and device.steam_build == 5, JSON.stringify(device))

	_check("no Steam singleton, no facts", SteamInfo.read().is_empty())
	for o2 in [public, down, never, old]:
		o2.free()
	_steam = steam


var _steam: FakeSteam


# The addon itself, in the tree, with the fake registered as the Steam singleton the game would have.
func _initialize() -> void:
	var steam := _steam
	Engine.register_singleton("Steam", steam)
	var gd := Glitchless.new()
	var own := Glitchless.new()
	root.add_child(gd)
	root.add_child(own)
	await process_frame  # the nodes are ready once the tree runs
	gd.init("skyline", "", "prod", "http://127.0.0.1:9", {"enabled": true})
	var start: Dictionary = gd._session_start_event()
	_check("session_start carries the facts", start.device.get("steam_build") == 18231 and start.device.get("steam_branch") == "beta" and start.device.get("steam_deck") == true, JSON.stringify(start.device))
	_check("no version given: the Steam build is the version", gd._version == "steam-18231", gd._version)
	_check("no Steam ID anywhere in session_start", not JSON.stringify(start).contains("76561197960287930"))
	own.init("skyline", "2.0.1", "prod", "http://127.0.0.1:9", {"enabled": true})
	_check("the game's own version wins", own._version == "2.0.1", own._version)
	Engine.unregister_singleton("Steam")
	for n in [gd, own]:
		root.remove_child(n)
		n.free()
	steam.free()
	print("steam tests: %d failed" % _failed)
	quit(1 if _failed else 0)


func _check(name: String, ok: bool, detail: String = "") -> void:
	print("%s %s%s" % ["ok" if ok else "FAIL", name, "" if ok or detail == "" else " (%s)" % detail])
	if not ok:
		_failed += 1

extends RefCounted
## What Glitchless says about the device in session_start.
##
## Anonymous mode sends only coarse facts that many thousands of phones share:
## the OS name, a low / mid / high tier, the renderer, the screen size and
## refresh rate. Full mode adds the model, OS version, GPU name, core count and
## memory. PRIVACY.md beside this file lists every field; keep the two in step.


static func info(full: bool) -> Dictionary:
	var os_name := OS.get_name()
	var mobile := OS.has_feature("mobile")
	var cores := OS.get_processor_count()
	var mem := float(OS.get_memory_info().get("physical", -1))
	var mem_gb := mem / 1073741824.0 if mem > 0 else -1.0
	var adapter := RenderingServer.get_video_adapter_name()
	var tier := device_tier(cores, mem_gb)
	var deck := steam_deck()
	var d := {
		"browser": "Godot",  # the runtime, in the field the dashboard groups by
		"browser_version": "%d.%d.%d" % [Engine.get_version_info().major, Engine.get_version_info().minor, Engine.get_version_info().patch],
		"os": "SteamOS" if steam_os() else os_name,
		"mobile": mobile,
		"device_tier": tier,
		# Every phone GPU is "low" next to a desktop one, so on phones the GPU tier is the device tier. A Steam
		# Deck's is "low" too, as the Unreal plugin has it.
		"gpu_tier": tier if mobile else "low" if deck else gpu_tier(adapter),
		"renderer": RenderingServer.get_current_rendering_method(),
		"driver": RenderingServer.get_current_rendering_driver_name(),
		"screen": screen_size(),
		"dpr": snappedf(DisplayServer.screen_get_scale(), 0.01),
		"refresh_hz": refresh_rate(),
		"steam_deck": deck,
	}
	var where := distribution()
	if where != "":
		d["distribution"] = where
	if full:
		d["model"] = OS.get_model_name()
		d["os_version"] = OS.get_version()
		d["gpu"] = adapter
		d["gpu_vendor"] = RenderingServer.get_video_adapter_vendor()
		d["cores"] = cores
		d["memory_gb"] = roundi(mem_gb) if mem_gb > 0 else null
	return d


## A dedicated server's own machine, for session_start's server.host (SPEC §5,
## server mode): its OS, cores and memory, never its address or host name.
static func server_host() -> Dictionary:
	var mem := float(OS.get_memory_info().get("physical", -1))
	return {"os": OS.get_name(), "cores": OS.get_processor_count(), "memory_gb": roundi(mem / 1073741824.0) if mem > 0 else null}


## This process's resident memory (mem_mb) and the CPU seconds it has used
## (cpu_s), for server windows: from /proc/self on Linux, where dedicated
## servers run. Elsewhere only mem_mb, from the engine's static memory, which
## debug builds alone count.
static func process_usage() -> Dictionary:
	if OS.get_name() == "Linux":
		return parse_proc(_read_small("/proc/self/status"), _read_small("/proc/self/stat"))
	var static_mem := OS.get_static_memory_usage()
	return {"mem_mb": snappedf(static_mem / 1048576.0, 0.1)} if static_mem > 0 else {}


## VmRSS from /proc/self/status, and utime plus stime from /proc/self/stat
## (fields 14 and 15, in clock ticks of 1/100 s), counted after the ")" that
## ends the process name, since the name itself can hold spaces.
static func parse_proc(status: String, stat: String) -> Dictionary:
	var out := {}
	for line in status.split("\n"):
		if line.begins_with("VmRSS:"):
			out.mem_mb = snappedf(float(line.substr(6).strip_edges().split(" ")[0]) / 1024.0, 0.1)
	var close := stat.rfind(")")
	if close > 0:
		var fields := stat.substr(close + 1).strip_edges().split(" ")
		if fields.size() > 12:
			out.cpu_s = (float(fields[11]) + float(fields[12])) / 100.0
	return out


static var _facts: Variant = null  # read once a launch


static func steam_deck() -> bool:
	return is_steam_deck(_steam_deck_facts())


## A Deck running SteamOS, or one Steam started (a Windows build under Proton
## runs on SteamOS too): "SteamOS" in place of Linux or Windows, as Unreal says.
static func steam_os() -> bool:
	return is_steam_os(_steam_deck_facts())


static func is_steam_os(facts: Dictionary) -> bool:
	return is_steam_deck(facts) and (_os_release_id(str(facts.get("os_release", ""))) == "steamos" or str(facts.get("env", "")) != "")


static func _steam_deck_facts() -> Dictionary:
	if _facts == null:
		_facts = steam_deck_facts()
	return _facts


## What says a game runs on a Steam Deck: Steam's SteamDeck=1, the board's
## maker and name, and the OS. A Linux build reads /sys and /etc; a Windows
## build under Proton reads the same files through Wine's Z: drive.
static func steam_deck_facts() -> Dictionary:
	var root := "Z:" if OS.get_name() == "Windows" else ""
	if OS.get_name() not in ["Linux", "Windows", "FreeBSD"]:
		return {"env": OS.get_environment("SteamDeck")}
	return {
		"env": OS.get_environment("SteamDeck"),
		"board_vendor": _read_small(root + "/sys/class/dmi/id/board_vendor"),
		"board_name": _read_small(root + "/sys/class/dmi/id/board_name"),
		"os_release": _read_small(root + "/etc/os-release"),
	}


## A Steam Deck: Steam says so (SteamDeck=1, under Steam and Proton), the board
## is Valve's Jupiter (LCD) or Galileo (OLED), or the OS is SteamOS
## (ID=steamos in os-release). The same rule as the browser SDK's, Unity's and
## Unreal's.
static func is_steam_deck(facts: Dictionary) -> bool:
	if str(facts.get("env", "")).strip_edges() == "1":
		return true
	var vendor := str(facts.get("board_vendor", "")).strip_edges().to_lower()
	var board := str(facts.get("board_name", "")).strip_edges().to_lower()
	if vendor == "valve" and board in ["jupiter", "galileo"]:
		return true
	return _os_release_id(str(facts.get("os_release", ""))) == "steamos"


static func _os_release_id(os_release: String) -> String:
	for line in os_release.split("\n"):
		if line.strip_edges().begins_with("ID="):
			return line.strip_edges().substr(3).trim_prefix("\"").trim_suffix("\"").to_lower()
	return ""


static func _read_small(path: String) -> String:
	if not FileAccess.file_exists(path):
		return ""
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var out := ""
	while not f.eof_reached() and out.length() < 4096:
		out += f.get_line() + "\n"
	return out


## low / mid / high from cores and memory: coarse enough that it cannot tell
## one phone from another of its kind.
static func device_tier(cores: int, mem_gb: float) -> String:
	if mem_gb <= 0:
		return "unknown"
	if mem_gb < 3.0 or cores <= 4:
		return "low"
	if mem_gb >= 6.0 and cores >= 6:
		return "high"
	return "mid"


## The browser SDK's GPU tiers (packages/sdk/src/device.js), for desktops.
static func gpu_tier(name: String) -> String:
	var s := name.to_lower()
	if _has(s, "swiftshader|llvmpipe|software|basic render"):
		return "software"
	if _has(s, "apple m\\d+ (pro|max|ultra)|rtx|radeon rx|radeon pro|quadro|geforce gtx 1[06-9]|arc a7"):
		return "high"
	if _has(s, "adreno|mali|powervr|apple a\\d+|apple gpu$"):
		return "low"
	if _has(s, "intel.*(hd|uhd) graphics|intel\\(r\\) (hd|uhd)"):
		return "low"
	if _has(s, "apple m\\d+|apple gpu|iris|arc|radeon|geforce|nvidia"):
		return "mid"
	return "unknown"


## The screen the game is on, in pixels. On the iPhone Duo this changes as the
## phone opens and closes, which is how fold state shows up.
static func screen_size() -> Array:
	var screen := DisplayServer.window_get_current_screen()
	var size := DisplayServer.screen_get_size(screen)
	return [size.x, size.y]


static func window_size() -> Array:
	var size := DisplayServer.window_get_size()
	return [size.x, size.y]


## The screen's refresh rate as the OS reports it: the panel's highest, not the
## rate the game runs at (some 60 Hz iPhones report 120; a ProMotion iPhone in
## Low Power Mode runs at 60). frame_window.hz is the rate measured from frames.
static func refresh_rate() -> Variant:
	var hz := DisplayServer.screen_get_refresh_rate(DisplayServer.window_get_current_screen())
	return roundi(hz) if hz > 0 else null


## Firebase Test Lab, where Google Play's pre-launch report runs each new build
## on Google's own phones, sets the system setting firebase.test.lab to "true".
## Those runs are bots, so their sessions are synthetic. Read through the
## AndroidRuntime singleton (Godot 4.4 and later), so no Android plugin is needed;
## the value is only read here, never sent.
static func test_lab() -> bool:
	return is_test_lab(_test_lab_setting())


static func is_test_lab(setting: Variant) -> bool:
	return setting != null and str(setting).strip_edges() == "true"


static func _test_lab_setting() -> Variant:
	if OS.get_name() != "Android" or not Engine.has_singleton("AndroidRuntime"):
		return null
	var runtime: Variant = Engine.get_singleton("AndroidRuntime")
	var context: Variant = runtime.getApplicationContext()
	var settings: Variant = JavaClassWrapper.wrap("android.provider.Settings$System")
	if context == null or settings == null:
		return null
	return settings.getString(context.getContentResolver(), "firebase.test.lab")


static var _distribution: Variant = null  # read once a launch


## Where an iOS build was installed from: "app_store", "testflight" (TestFlight,
## and App Review, which installs the same way), "development" (from Xcode, an
## ad hoc or enterprise profile, or the Simulator), or "" when it can't tell and
## on every other OS. Read from files the app can already see, so no plugin is
## needed; only the answer is sent, never a path.
static func distribution() -> String:
	if _distribution == null:
		_distribution = ios_distribution(_ios_install_facts()) if OS.get_name() == "iOS" else ""
	return _distribution


## TestFlight and development installs buy in Apple's sandbox, for free: their
## sessions are testers', and their purchases aren't revenue.
static func is_sandbox(where: String) -> bool:
	return where == "testflight" or where == "development"


## The rule, from what the files say (SPEC §4b). Apple writes an App Store
## receipt, StoreKit/receipt in the app's data container, with every App Store
## install; a TestFlight install has none until a sandbox purchase writes
## StoreKit/sandboxReceipt; a build signed for development carries its profile,
## embedded.mobileprovision, in the bundle. So no receipt on an iPhone or iPad
## is TestFlight; on a Mac (an iPad app there) it says nothing.
static func ios_distribution(facts: Dictionary) -> String:
	var home := str(facts.get("home", ""))
	if facts.get("receipt", false):
		return "app_store"
	if facts.get("provisioned", false) or home.contains("/CoreSimulator/"):
		return "development"
	if facts.get("sandbox_receipt", false):
		return "testflight"
	if home.begins_with("/var/mobile/Containers/Data/Application/") or home.begins_with("/private/var/mobile/Containers/Data/Application/"):
		return "testflight"
	return ""


static func _ios_install_facts() -> Dictionary:
	# The data container: $HOME on iOS, and user:// is its Documents folder.
	var home := OS.get_environment("HOME")
	if home == "":
		home = OS.get_user_data_dir().get_base_dir()
	var bundle := OS.get_executable_path().get_base_dir()
	return {
		"home": home,
		"receipt": FileAccess.file_exists(home + "/StoreKit/receipt") or FileAccess.file_exists(bundle + "/StoreKit/receipt"),
		"sandbox_receipt": FileAccess.file_exists(home + "/StoreKit/sandboxReceipt") or FileAccess.file_exists(bundle + "/StoreKit/sandboxReceipt"),
		"provisioned": FileAccess.file_exists(bundle + "/embedded.mobileprovision"),
	}


static func _has(s: String, pattern: String) -> bool:
	var re := RegEx.create_from_string(pattern)
	return re.search(s) != null

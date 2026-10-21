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
	var d := {
		"browser": "Godot",  # the runtime, in the field the dashboard groups by
		"browser_version": "%d.%d.%d" % [Engine.get_version_info().major, Engine.get_version_info().minor, Engine.get_version_info().patch],
		"os": os_name,
		"mobile": mobile,
		"device_tier": tier,
		# Every phone GPU is "low" next to a desktop one, so on phones the GPU tier is the device tier.
		"gpu_tier": tier if mobile else gpu_tier(adapter),
		"renderer": RenderingServer.get_current_rendering_method(),
		"driver": RenderingServer.get_current_rendering_driver_name(),
		"screen": screen_size(),
		"dpr": snappedf(DisplayServer.screen_get_scale(), 0.01),
		"refresh_hz": refresh_rate(),
	}
	if full:
		d["model"] = OS.get_model_name()
		d["os_version"] = OS.get_version()
		d["gpu"] = adapter
		d["gpu_vendor"] = RenderingServer.get_video_adapter_vendor()
		d["cores"] = cores
		d["memory_gb"] = roundi(mem_gb) if mem_gb > 0 else null
	return d


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


static func refresh_rate() -> Variant:
	var hz := DisplayServer.screen_get_refresh_rate(DisplayServer.window_get_current_screen())
	return roundi(hz) if hz > 0 else null


static func _has(s: String, pattern: String) -> bool:
	var re := RegEx.create_from_string(pattern)
	return re.search(s) != null

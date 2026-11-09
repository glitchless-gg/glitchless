extends RefCounted
## The page a web export runs in, read through JavaScriptBridge. Off the web
## nothing here touches JavaScript: the reads answer empty and the beacon false.
##
## Godot names itself where a browser would, so without this every player of a
## Godot web game was browser "Godot", OS "Web". device.gd takes the browser,
## its major version, the OS, whether it is a phone, the pixel ratio, the screen
## and the GPU from here instead, read by the browser SDK's own rules
## (packages/sdk/src/device.js; godot/test/web.mjs holds the two to the same
## answers), so a Godot web game splits by browser and OS like a Three.js one.
##
## It also tells glitchless.gd what the page does (listen): Godot hears nothing
## as a tab is hidden or closed, and a web export can't wait for a request then,
## so the last batches go by navigator.sendBeacon (beacon), as the browser SDK
## sends its own. And it reads the page's address, which never leaves the
## device: a page on the developer's own machine follows the debug-build rule,
## and ?glitchless there is --glitchless (flags).

# Fields that are a number or null (JSON's "not measured") are written `value if known else null`: Godot warns that
# the two branches differ in type, which is the point, so that warning is off for this file.
@warning_ignore_start("incompatible_ternary")

const HIDDEN := 0  ## another tab or app, or the phone locked: the browser may freeze or drop the page from here
const SHOWN := 1  ## visible again
const LEAVING := 2  ## pagehide: closed, another page, or into the back-forward cache
const RESTORED := 3  ## back from the back-forward cache

## The page's address can stand in for these flags, since a web build has no
## command line: ?glitchless is --glitchless. Only these: the intake and the
## rest stay the game's to set, so a link can't send a player's data elsewhere.
const PAGE_FLAGS: Array[String] = ["glitchless", "glitchless-debug", "glitchless-synthetic"]

## device.js's BROWSERS: each browser's own token and its major version, the
## first rule that matches winning. Edge and Opera also say Chrome/, and every
## browser on iOS also says Safari/, so order, not position in the string, decides.
const BROWSERS: Array = [
	["Edg(?:e|A|iOS)?/(\\d+)", "Edge"],
	["OPR/(\\d+)", "Opera"],
	["(?:Firefox|FxiOS)/(\\d+)", "Firefox"],
	["(?:Chrome|CriOS)/(\\d+)", "Chrome"],
	["Version/(\\d+)", "Safari"],
	["Safari/(\\d+)", "Safari"],
]

## What the page says, raw: the user agent, userAgentData.mobile (Chromium on
## https; null elsewhere), devicePixelRatio, the screen in CSS pixels,
## navigator.hardwareConcurrency (Godot's own count stops at 2 on the web),
## navigator.deviceMemory (Chromium; GB, rounded and capped by the browser), the
## GPU from a WebGL context of its own (the unmasked renderer, as the browser SDK
## probes it; Godot's own name for it is "WebKit WebGL"), and the page's address.
const READ_JS := """(function () {
	var f = { ua: '', mobile: null, dpr: null, screen: null, cores: null, memory: null, gpu: '', vendor: '', protocol: '', host: '', search: '' };
	try {
		var nav = navigator;
		f.ua = nav.userAgent || '';
		if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean') f.mobile = nav.userAgentData.mobile;
		if (typeof nav.hardwareConcurrency === 'number') f.cores = nav.hardwareConcurrency;
		if (typeof nav.deviceMemory === 'number') f.memory = nav.deviceMemory;
		if (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) f.dpr = devicePixelRatio;
		if (typeof screen !== 'undefined' && screen.width > 0) f.screen = [screen.width, screen.height];
		f.protocol = location.protocol;
		f.host = location.hostname;
		f.search = location.search;
	} catch (e) {}
	try {
		var canvas = document.createElement('canvas');
		var gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
		if (gl) {
			var ext = gl.getExtension('WEBGL_debug_renderer_info');
			f.gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
			f.vendor = String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR) || '');
			var lose = gl.getExtension('WEBGL_lose_context');
			if (lose) lose.loseContext();
		}
	} catch (e) {}
	return JSON.stringify(f);
})()"""

static var _facts: Variant = null  # read once a launch
static var _flags: Variant = null

var _callbacks: Array = []  # the JavaScript functions listen() made, kept so the page can call them


static func in_page() -> bool:
	return OS.has_feature("web")


## The page's raw facts (READ_JS), once a launch; {} off the web or when the
## page can't be read.
static func facts() -> Dictionary:
	if _facts == null:
		_facts = {}
		if in_page():
			var json: Variant = JavaScriptBridge.eval(READ_JS, true)
			var parsed: Variant = JSON.parse_string(str(json)) if json is String else null
			if parsed is Dictionary:
				_facts = parsed
	return _facts


## What the page says about the device, in the browser SDK's words: browser,
## browser_version (major), os, mobile, dpr (2 places), screen, steam_deck,
## gpu and gpu_vendor (cleaned), cores and memory_gb (null when the browser
## doesn't say: Firefox and Safari keep the memory to themselves). device.gd
## decides which of them a mode sends.
static func device(page: Dictionary) -> Dictionary:
	var ua := str(page.get("ua", ""))
	var gpu := clean_gpu(str(page.get("gpu", "")))
	var d := parse_user_agent(ua, page.get("mobile"))
	var dpr: Variant = page.get("dpr")
	d.dpr = roundf(float(dpr) * 100.0) / 100.0 if (dpr is float or dpr is int) and float(dpr) > 0.0 else null  # device.js's round2: 2.625 is 2.63
	var screen: Variant = page.get("screen")
	d.screen = [int(screen[0]), int(screen[1])] if screen is Array and screen.size() == 2 and float(screen[0]) > 0.0 and float(screen[1]) > 0.0 else null
	d.steam_deck = is_steam_deck(ua, str(page.get("gpu", "")))
	d.gpu = gpu
	d.gpu_vendor = clean_vendor(str(page.get("vendor", "")), str(page.get("gpu", "")))
	var cores: Variant = page.get("cores")
	d.cores = int(cores) if (cores is float or cores is int) and float(cores) > 0.0 else null
	var memory: Variant = page.get("memory")
	d.memory_gb = memory if (memory is float or memory is int) and float(memory) > 0.0 else null
	return d


## device.js's parseUserAgent, rule for rule: the browser and its major
## version, the OS, and whether it is a phone (userAgentData's answer where the
## browser gives one, else the user agent's).
static func parse_user_agent(ua: String, uad_mobile: Variant) -> Dictionary:
	var browser := "Other"
	var version := ""
	for rule: Array in BROWSERS:
		var m := RegEx.create_from_string(rule[0]).search(ua)
		if m:
			browser = rule[1]
			version = m.get_string(1)
			break
	var os_name := "Other"
	if _has(ua, "iPhone|iPad|iPod"):
		os_name = "iOS"
	elif ua.contains("Android"):
		os_name = "Android"
	elif ua.contains("Mac OS X") or ua.contains("Macintosh"):
		os_name = "macOS"
	elif ua.contains("Windows"):
		os_name = "Windows"
	elif ua.contains("CrOS"):
		os_name = "ChromeOS"
	elif ua.contains("Linux"):
		os_name = "Linux"
	var mobile: bool = bool(uad_mobile) if uad_mobile is bool else _has(ua, "Mobi|Android|iPhone|iPad")
	return {"browser": browser, "browser_version": version if version != "" else null, "os": os_name, "mobile": mobile}


## A Steam Deck, as far as a browser can tell: a user agent that names it, or
## AMD's Van Gogh GPU, made for the Deck. device.js's isSteamDeck; browsers that
## hide the GPU say nothing.
static func is_steam_deck(ua: String, gpu: String) -> bool:
	return _has(ua, "(?i)steam ?deck") or _has(gpu, "(?i)\\bvangogh\\b|custom gpu 0(405|932)\\b")


## device.js's cleanGpu: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro,
## Unspecified Version)" is "Apple M3 Pro".
static func clean_gpu(s: String) -> String:
	if s == "":
		return "unknown"
	var angle := RegEx.create_from_string("ANGLE \\((.+)\\)").search(s)
	if angle:
		var parts := angle.get_string(1).split(",")
		var name := (parts[1] if parts.size() > 1 and parts[1].strip_edges() != "" else parts[0]).strip_edges()
		name = RegEx.create_from_string("^ANGLE Metal Renderer:\\s*").sub(name, "")
		name = RegEx.create_from_string("\\s*Direct3D.*$").sub(name, "")
		name = RegEx.create_from_string("\\s*\\(0x[0-9A-Fa-f]+\\)").sub(name, "", true)
		name = RegEx.create_from_string("\\s*vs_\\d_\\d.*$").sub(name, "")
		name = RegEx.create_from_string("\\s*OpenGL.*$").sub(name, "")
		name = name.strip_edges()
		return name if name != "" else s
	return s.strip_edges()


## device.js's cleanVendor.
static func clean_vendor(vendor: String, renderer: String) -> String:
	var s := ("%s %s" % [vendor, renderer]).to_lower()
	for rule: Array in [["apple", "Apple"], ["nvidia|geforce", "NVIDIA"], ["amd|radeon", "AMD"], ["intel", "Intel"], ["qualcomm|adreno", "Qualcomm"], ["arm|mali", "ARM"], ["swiftshader|google", "Google (software)"]]:
		if _has(s, rule[0]):
			return rule[1]
	return vendor if vendor != "" else "unknown"


## Whether the page is on the developer's own machine or network: a file, the
## editor's Run in Browser (localhost), a server on this computer, or one on
## the local network (a phone trying the build). Those runs follow the debug
## rule; a page anywhere else is played by players.
static func is_local(protocol: String, host: String) -> bool:
	var h := host.trim_prefix("[").trim_suffix("]").to_lower()
	if protocol == "file:" or h == "" or h == "localhost" or h == "::1" or h.ends_with(".localhost") or h.ends_with(".local"):
		return true
	return _has(h, "^(127\\.|10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.)")


## The flags in a page's query string (PAGE_FLAGS only): "?glitchless&x=1" is
## ["--glitchless"], and so is "?glitchless=1".
static func flags_from(search: String) -> PackedStringArray:
	var out := PackedStringArray()
	for pair in search.trim_prefix("?").split("&", false):
		var eq := pair.find("=")
		var key := (pair if eq < 0 else pair.substr(0, eq)).uri_decode()
		if key in PAGE_FLAGS:
			out.append("--" + key)
	return out


## This page's flags, on the web; none elsewhere.
static func flags() -> PackedStringArray:
	if _flags == null:
		var page := facts()
		_flags = flags_from(str(page.get("search", ""))) if not page.is_empty() else PackedStringArray()
	return _flags


## A web export on a page that isn't on the developer's own machine: players are
## playing it, whether or not it was exported with debug on (Godot's export
## dialog has it on unless it's unticked).
static func hosted() -> bool:
	var page := facts()
	return in_page() and not page.is_empty() and not is_local(str(page.get("protocol", "")), str(page.get("host", "")))


## Queues a POST of body (text/plain, so no CORS preflight; the server reads the
## JSON whatever it says) that the browser sends even after the page has gone,
## and waits for nothing. False off the web, or when the browser turns it down
## (it takes about 64 KB of beacons at a time, for the whole page).
static func beacon(url: String, body: String) -> bool:
	if not in_page():
		return false
	var nav: Variant = JavaScriptBridge.get_interface("navigator")
	if nav == null:
		return false
	return nav.sendBeacon(url, body) == true


## Calls on_page with HIDDEN, SHOWN, LEAVING or RESTORED as the page does. The
## call comes straight from the browser's event, between frames, so what it
## sends goes before the page does.
func listen(on_page: Callable) -> void:
	if not in_page() or not _callbacks.is_empty():
		return
	var window: Variant = JavaScriptBridge.get_interface("window")
	var document: Variant = JavaScriptBridge.get_interface("document")
	if window == null or document == null:
		return
	var visibility := JavaScriptBridge.create_callback(func(_args: Array) -> void:
		on_page.call(HIDDEN if str(document.visibilityState) == "hidden" else SHOWN))
	var hide := JavaScriptBridge.create_callback(func(_args: Array) -> void:
		on_page.call(LEAVING))
	var show := JavaScriptBridge.create_callback(func(args: Array) -> void:
		if not args.is_empty() and args[0] != null and args[0].persisted == true:
			on_page.call(RESTORED))
	document.addEventListener("visibilitychange", visibility)
	window.addEventListener("pagehide", hide)
	window.addEventListener("pageshow", show)
	_callbacks = [visibility, hide, show]


static func _has(s: String, pattern: String) -> bool:
	return RegEx.create_from_string(pattern).search(s) != null

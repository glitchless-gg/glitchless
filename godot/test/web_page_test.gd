extends SceneTree
## A web export reads its page by the browser SDK's rules (web_page.gd against
## packages/sdk/src/device.js): browsers' user agents, GPUs and the Steam Deck,
## with the answers device.js gave, written by test/web.mjs to --fixture=PATH.
## Also which pages are on the developer's own machine, the flags a page's
## address can give, and that nothing here touches JavaScript off the web.
##   godot --headless --path godot --script res://test/web_page_test.gd -- --fixture=PATH

const WebPage := preload("res://addons/glitchless/web_page.gd")
const Device := preload("res://addons/glitchless/device.gd")

var _failed := 0


func _init() -> void:
	var path := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--fixture="):
			path = a.substr(10)
	var fixture: Variant = JSON.parse_string(FileAccess.get_file_as_string(path)) if path != "" else null
	_check("the fixture from device.js was read", fixture is Dictionary)
	if fixture is Dictionary:
		for c: Dictionary in fixture.user_agents:
			var got := WebPage.parse_user_agent(c.ua, c.uad_mobile)
			var want := {"browser": c.browser, "browser_version": c.browser_version if c.browser_version != "" else null, "os": c.os, "mobile": c.mobile}
			_check("user agent as device.js reads it: %s (mobile %s) -> %s" % [c.ua.substr(0, 90), c.uad_mobile, want], got == want)
		for c: Dictionary in fixture.gpus:
			var clean := WebPage.clean_gpu(c.renderer)
			_check("GPU as device.js cleans it: %s -> %s, %s, %s" % [c.renderer, c.clean, c.vendor_clean, c.tier], clean == c.clean and WebPage.clean_vendor(c.vendor, c.renderer) == c.vendor_clean and Device.gpu_tier(clean) == c.tier)
		for c: Dictionary in fixture.decks:
			_check("Steam Deck as device.js tells it: %s / %s -> %s" % [c.ua.substr(0, 60), c.gpu, c.deck], WebPage.is_steam_deck(c.ua, c.gpu) == c.deck)
	for local: Array in [["http:", "localhost"], ["http:", "127.0.0.1"], ["http:", "[::1]"], ["file:", ""], ["http:", "192.168.1.20"], ["http:", "10.0.0.5"], ["http:", "172.20.1.1"], ["http:", "game.localhost"], ["http:", "mac-mini.local"]]:
		_check("a page on the developer's own machine or network: %s//%s" % local, WebPage.is_local(local[0], local[1]))
	for hosted: Array in [["https:", "html-classic.itch.zone"], ["https:", "mygame.pages.dev"], ["https:", "172.32.0.1"], ["https:", "localhost.example.com"]]:
		_check("a page players play: %s//%s" % hosted, not WebPage.is_local(hosted[0], hosted[1]))
	_check("?glitchless is --glitchless, with or without a value", WebPage.flags_from("?glitchless") == PackedStringArray(["--glitchless"]) and WebPage.flags_from("?x=1&glitchless=1") == PackedStringArray(["--glitchless"]))
	_check("?glitchless-debug and ?glitchless-synthetic too", WebPage.flags_from("?glitchless-debug&glitchless-synthetic") == PackedStringArray(["--glitchless-debug", "--glitchless-synthetic"]))
	_check("a link can't send a player's data elsewhere: no intake, no server, nothing else", WebPage.flags_from("?glitchless-intake=https://elsewhere.example&glitchless-server&autoplay") == PackedStringArray())
	_check("no query, no flags", WebPage.flags_from("").is_empty() and WebPage.flags_from("?").is_empty())
	var page := WebPage.device({"ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36", "mobile": false, "dpr": 2.0000001, "screen": [1512.0, 982.0], "cores": 12.0, "memory": 8.0, "gpu": "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)", "vendor": "Google Inc. (Apple)"})
	_check("a page's facts as a device: Chrome 156 on macOS, dpr to 2 places, the screen in whole pixels", page.browser == "Chrome" and page.browser_version == "156" and page.os == "macOS" and not page.mobile and page.dpr == 2.0 and page.screen == [1512, 982] and page.screen[0] is int)
	_check("and its GPU, cores and memory", page.gpu == "Apple M3 Pro" and page.gpu_vendor == "Apple" and page.cores == 12 and page.memory_gb == 8.0 and not page.steam_deck)
	var bare := WebPage.device({})
	_check("a page that couldn't be read says Other and nothing else", bare.browser == "Other" and bare.browser_version == null and bare.os == "Other" and bare.dpr == null and bare.screen == null and bare.cores == null and bare.memory_gb == null and bare.gpu == "unknown")
	var info := Device.web_info(false, {"ua": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36", "mobile": true, "dpr": 2.625, "screen": [412, 915], "cores": 8, "memory": 8, "gpu": "ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)"})
	_check("a web export's device: the browser SDK's fields, a tier from the page's cores and memory, the GPU's tier", info.browser == "Chrome" and info.os == "Android" and info.mobile and info.device_tier == "high" and info.gpu_tier == "low" and info.screen == [412, 915] and info.dpr == 2.63)
	_check("anonymous mode sends no GPU name, cores or memory", not info.has("gpu") and not info.has("cores") and not info.has("memory_gb") and not info.has("model"))
	var full := Device.web_info(true, {"ua": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "gpu": "AMD Custom GPU 0405 (vangogh, LLVM 15.0.7, DRM 3.54, 6.5.0-valve22-1-neptune-65)", "vendor": "AMD"})
	_check("full mode adds the cleaned GPU; a Deck's GPU tier is low", full.gpu == "AMD Custom GPU 0405 (vangogh, LLVM 15.0.7, DRM 3.54, 6.5.0-valve22-1-neptune-65)" and full.gpu_vendor == "AMD" and full.steam_deck and full.gpu_tier == "low" and full.model == null and full.memory_gb == null)
	_check("off the web nothing reads the page", not WebPage.in_page() and WebPage.facts().is_empty() and WebPage.flags().is_empty() and not WebPage.hosted() and not WebPage.beacon("http://127.0.0.1:9/v1/intake", "{}"))
	_check("and this machine's device is still Godot's", Device.info(false).browser == "Godot")
	print("web page tests: %d failed" % _failed)
	quit(1 if _failed else 0)


func _check(name: String, ok: bool) -> void:
	print("%s %s" % ["ok" if ok else "FAIL", name])
	if not ok:
		_failed += 1

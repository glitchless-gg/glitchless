extends SceneTree
## Checks the parts of bug reports that need no server: the screenshot shrinks
## until it fits, events are slimmed, hotkeys are read. test/e2e.mjs runs it.
##   godot --headless --path godot --script res://test/bug_report_test.gd

const BugReport := preload("res://addons/glitchless/bug_report.gd")
const Glitchless := preload("res://addons/glitchless/glitchless.gd")

var _failed := 0


func _init() -> void:
	var noise := _noise(1920, 1080)
	var url := BugReport.fit_screenshot(noise)
	_check("a noisy 1920x1080 screenshot shrinks until it fits in 200,000 characters", url.begins_with("data:image/jpeg;base64,") and url.length() <= 200000, "%d characters" % url.length())
	var back := _decode(url)
	_check("…and is at most 960 px wide", back != null and back.get_width() <= 960 and back.get_width() < 1920, "%s" % (back.get_size() if back else "not a JPEG"))

	var portrait := _decode(BugReport.fit_screenshot(_noise(1080, 1920)))
	_check("a portrait screenshot is at most 960 px on its longer side", portrait != null and portrait.get_height() <= 960, "%s" % (portrait.get_size() if portrait else "not a JPEG"))

	var small := Image.create_empty(200, 100, false, Image.FORMAT_RGBA8)
	small.fill(Color.CORNFLOWER_BLUE)
	var kept := _decode(BugReport.fit_screenshot(small))
	_check("a small screenshot keeps its size", kept != null and kept.get_size() == Vector2i(200, 100), "%s" % (kept.get_size() if kept else "not a JPEG"))

	_check("a screenshot that never fits is left out", BugReport.fit_screenshot(noise, 2000) == "", "")
	_check("no image, no screenshot", BugReport.fit_screenshot(null) == "" and BugReport.fit_screenshot(Image.new()) == "", "")

	var slim := Glitchless._slim({
		"type": "error", "ts": 5, "level": "l1", "kind": "script", "message": "x".repeat(500),
		"stack": "at a\nat b", "fingerprint": "abc", "recent": ["pickup"], "attrs": {"slot": 2},
	})
	_check("an error is slimmed to when, what and its message (200 characters)", _keys(slim) == ["ts", "type", "level", "kind", "message", "attrs"] and slim.message.length() == 200, JSON.stringify(slim.keys()))
	var big := Glitchless._slim({"type": "custom", "ts": 6, "level": null, "name": "buy", "attrs": {"what": "y".repeat(400)}})
	_check("attributes over 300 characters are left out", not big.has("attrs") and big.name == "buy", JSON.stringify(big.keys()))
	var hitch := Glitchless._slim({"type": "hitch", "ts": 7, "level": "l2", "duration_ms": 120.5, "causes": ["script"], "ctx": {"a": 1}, "draw_calls": 40})
	_check("a hitch keeps its length and causes", _keys(hitch) == ["ts", "type", "level", "duration_ms", "causes"], JSON.stringify(hitch.keys()))

	_check("hotkeys: a Key, its name, or none", Glitchless._keycode(KEY_F9) == KEY_F9 and Glitchless._keycode("F8") == KEY_F8 and Glitchless._keycode(null) == KEY_NONE and Glitchless._keycode("") == KEY_NONE, "")

	print("bug report tests: %d failed" % _failed)
	quit(1 if _failed else 0)


func _check(name: String, ok: bool, why: String) -> void:
	if ok:
		print("ok ", name)
	else:
		_failed += 1
		print("FAIL ", name, (": " + why) if why != "" else "")


# Keys set as d.key are StringNames, as d["key"] Strings: compare them as text.
func _keys(d: Dictionary) -> Array:
	return d.keys().map(func(k: Variant) -> String: return str(k))


func _noise(w: int, h: int) -> Image:
	var rng := RandomNumberGenerator.new()
	rng.seed = 7
	var bytes := PackedByteArray()
	bytes.resize(w * h * 3)
	for i in bytes.size():
		bytes[i] = rng.randi() % 256
	return Image.create_from_data(w, h, false, Image.FORMAT_RGB8, bytes)


func _decode(url: String) -> Image:
	if not url.begins_with("data:image/jpeg;base64,"):
		return null
	var img := Image.new()
	return img if img.load_jpg_from_buffer(Marshalls.base64_to_raw(url.get_slice(",", 1))) == OK else null

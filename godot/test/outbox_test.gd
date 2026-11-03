extends SceneTree
## A session cut in two by the outbox (SPEC §2 session_start.continued), in
## glitchless.gd without a server. In anonymous mode the outbox is saved
## without the session ID, so the next launch sends an earlier session's
## batches under a new one. When that session's first batch, with its
## session_start, went out before the game closed, the rest arrived with no
## session_start: the server took them for a player's session with no device
## (Starlift 1.1.3's Google Play test phones). The outbox now keeps each
## session's session_start, which holds no ID, and the next launch sends it
## first, marked continued. test/e2e.mjs runs it.
##   godot --headless --path godot --script res://test/outbox_test.gd

const Glitchless := preload("res://addons/glitchless/glitchless.gd")
const ErrorLogger := preload("res://addons/glitchless/logger.gd")

var _failed := 0


func _init() -> void:
	_clean()
	_first_batch_sent()
	_nothing_sent()
	_install_mode()
	_clean()
	print("outbox tests: %d failed" % _failed)
	quit(1 if _failed else 0)


# The first batch went out; the game closed with the rest waiting.
func _first_batch_sent() -> void:
	_clean()
	var g := _game({"session_type": "synthetic"})
	g.level_start("endless_normal")
	g._frame(16.7)
	g.flush()
	_check("the first batch starts with session_start", not g._outbox.is_empty() and g._outbox[0].events[0].type == "session_start")
	var sid: String = g.session_id
	g._outbox.pop_front()  # the server took it
	g._save_outbox()
	g.error("active uniforms exceed GL_MAX_FRAGMENT_UNIFORM_VECTORS (261)")
	for i in 10:
		g._frame(16.7)
	g.flush()
	var text := FileAccess.get_file_as_string(Glitchless.OUTBOX_PATH)
	var saved: Dictionary = JSON.parse_string(text)
	_check("the rest is saved, without its session_start", not saved.batches.is_empty() and saved.batches.all(func(b: Dictionary) -> bool: return not b.events.any(func(e: Dictionary) -> bool: return e.type == "session_start")))
	_check("its session_start is saved beside it", saved.get("starts", []).size() == 1 and saved.starts[0].event.type == "session_start" and saved.starts[0].event.session_type == "synthetic")
	_check("no session or player ID is written", not text.contains(sid) and not text.contains("\"sid\"") and not text.contains("\"pid\""))
	g.free()

	var next := _game()
	var b0: Dictionary = next._outbox[0]
	var start: Dictionary = b0.events[0]
	_check("the next launch sends it first, alone in its own batch", start.type == "session_start" and b0.events.size() == 1)
	_check("marked continued, with the session's own type and device", start.get("continued") == true and start.session_type == "synthetic" and start.device is Dictionary and start.device.has("os"))
	_check("under the same new ID as the rest, with its own batch ID", next._outbox.size() == 2 and b0.sid == next._outbox[1].sid and b0.sid != sid and b0.bid != next._outbox[1].bid)
	_check("the rest follows: the error", next._outbox[1].events.any(func(e: Dictionary) -> bool: return e.type == "error"))
	next.free()


# Nothing went out: the saved batches have the session_start already, so none is added.
func _nothing_sent() -> void:
	_clean()
	var g := _game()
	g.level_start("orbit_1")
	g._frame(16.7)
	g.flush()
	g.free()
	var next := _game()
	var starts: Array = []
	for b: Dictionary in next._outbox:
		starts.append_array(b.events.filter(func(e: Dictionary) -> bool: return e.type == "session_start"))
	_check("a session saved whole keeps its one session_start, not continued", starts.size() == 1 and not starts[0].has("continued"))
	next.free()


# Install mode saves the session ID, so the rest keeps its session: no start is saved or added.
func _install_mode() -> void:
	_clean()
	var g := _game({"privacy": "install"})
	g.flush()
	g._outbox.pop_front()
	g.track("pickup", "coin")
	g.flush()
	var saved: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(Glitchless.OUTBOX_PATH))
	_check("install mode saves the session ID and no starts", saved.batches[0].has("sid") and not saved.has("starts"))
	g.free()
	var next := _game({"privacy": "install"})
	_check("…and its rest goes under the same session, with nothing added", next._outbox.size() == 1 and next._outbox[0].sid == saved.batches[0].sid)
	next.free()


# The autoload's script, out of the tree, as _ready() leaves it. It has no
# HTTPRequest, so nothing is sent.
func _game(opts: Dictionary = {}) -> Node:
	var g: Node = Glitchless.new()
	g._win = g._new_window()
	g._ring.resize(Glitchless.RING_SIZE)
	g._logger = ErrorLogger.new()
	g._retry_at = 1 << 62
	var o := {"network": false, "enabled": true}
	o.merge(opts, true)
	g.init("starlift", "1.1.3", "prod", "http://127.0.0.1:9", o)
	g._started_at = Glitchless._now()  # as _ready() starts the session in a game
	return g


func _clean() -> void:
	for p: String in [Glitchless.ENABLED_PATH, Glitchless.OUTBOX_PATH, Glitchless.SERVER_OUTBOX_PATH, Glitchless.PLAYER_PATH, Glitchless.LAUNCHED_PATH]:
		if FileAccess.file_exists(p):
			DirAccess.remove_absolute(p)


func _check(name: String, ok: bool, detail: String = "") -> void:
	print("%s %s" % ["ok" if ok else "FAIL", name])
	if not ok:
		_failed += 1
		if detail != "":
			print("    ", detail)

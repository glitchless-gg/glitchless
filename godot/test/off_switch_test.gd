extends SceneTree
## The player's off switch (SPEC §4d) in glitchless.gd without a server:
## set_enabled(false) drops everything waiting and sends nothing more, not even
## a session_end; set_enabled(true) starts a new session with the properties
## and groups still set; a call that changes nothing does nothing; a saved
## choice is read before the first frame; opt_in starts a device off; the
## build's own switch holds; an attempt open at the switch has no outcome after
## it; a bug report answers "off". test/e2e.mjs runs it, then plays the demo
## with the switch against a fake intake.
##   godot --headless --path godot --script res://test/off_switch_test.gd

const Glitchless := preload("res://addons/glitchless/glitchless.gd")
const ErrorLogger := preload("res://addons/glitchless/logger.gd")

var _failed := 0


func _init() -> void:
	_run()


func _run() -> void:
	_clean()
	_off_mid_session()
	_on_again()
	_changes_nothing()
	_saved_off()
	_opt_in()
	_build_off()
	_server()
	await _bug_reports()
	_clean()
	print("off switch tests: %d failed" % _failed)
	quit(1 if _failed else 0)


func _off_mid_session() -> void:
	_clean()
	var g := _game({"privacy": "install"})
	g.set_properties({"mode": "squads"})
	var run: String = g.set_group("run")
	g.set_zone("ashen_wastes")
	g.set_context({"blocks": 12})
	g.level_start("voyage_3")
	g._frame(16.7)
	g.flush()
	_check("before: a batch waits in the outbox, saved on the device", not g._outbox.is_empty() and FileAccess.file_exists(Glitchless.OUTBOX_PATH))
	g.track("pickup", "coin")
	g.count("kill", {"monster": "elite"})
	for i in 40:
		g._frame(16.7)
	g._frame(250.0)  # a hitch, waiting for its window to close
	g.net_sample(40.0)
	g._in_flight = 1  # a batch on its way
	g._http = HTTPRequest.new()
	var sent: int = g.stats.sent
	g.set_enabled(false)
	_check("off: the choice is saved first, as off", _saved() == "off")
	_check("off: is_enabled() is false", not g.is_enabled())
	_check("off: the queue, the open window with its counters and network samples, and the waiting hitch are dropped", g._queue.is_empty() and g._win.frames == 0 and g._win.counts.is_empty() and g._win.net.is_empty() and g._pending_hitches.is_empty())
	_check("off: the batches waiting and the outbox on the device are dropped", g._outbox.is_empty() and not FileAccess.file_exists(Glitchless.OUTBOX_PATH))
	g._on_sent(HTTPRequest.RESULT_SUCCESS, 202, PackedStringArray(), PackedByteArray())
	_check("off: the answer to a batch already on its way is ignored", g.stats.sent == sent and g._in_flight == -1)
	g._process(0.016)
	g._physics_process(0.016)
	g.track("pickup", "coin")
	g.count("kill")
	g.death(1.0, 2.0, "fell")
	g.error("save slot unreadable")
	g.net_sample(30.0)
	g.set_property("rank", "gold")
	g.set_group("match", "match-0001-arena")
	g.level_fail("voyage_3", "lost")
	g._on_background()
	g._shutdown("quit")
	_check("off: nothing more is kept, and closing sends no level_abandon or session_end", _all(g).is_empty() and g._win.frames == 0 and g._win.counts.is_empty() and g._win.net.is_empty() and g.stats.errors == 0)
	_check("off: no outbox is written as the game closes", not FileAccess.file_exists(Glitchless.OUTBOX_PATH))
	_check("off: what the game said stays in memory: level, properties, groups, zone, gauges", g.level == "voyage_3" and g._props == {"mode": "squads", "rank": "gold"} and g._groups.get("run") == run and g._groups.has("match") and g.zone == "ashen_wastes" and g._ctx.get("blocks") == 12.0, JSON.stringify([g._props, g._groups]))
	_check("off: the player ID stays on the device", FileAccess.file_exists(Glitchless.PLAYER_PATH) and g.player_id.begins_with("p_"))
	g._http.free()
	g.free()


func _on_again() -> void:
	_clean()
	var g := _game()
	g.set_properties({"mode": "squads"})
	var match_id: String = g.set_group("match", "match-0001-arena")
	g.level_start("voyage_3")
	for i in 40:
		g._frame(16.7)
	g.flush()
	var first: String = g.session_id
	g.set_enabled(false)
	g.set_property("rank", "gold")
	g.set_enabled(true)
	_check("on: the choice is saved as on", _saved() == "on")
	_check("on: a new session with a new ID, and is_enabled() is true", g.session_id != first and g.is_enabled())
	_check("on: measured from the next frame", g._last_us == 0 and g._win.frames == 0)
	g._frame(16.7)
	g.track("pickup", "coin")
	g.level_complete("voyage_3", 10)
	g.level_fail("voyage_3", "lost")
	g.level_abandon()
	g.flush()
	var events := _all(g)
	_check("on: session_start comes first, with the properties still set", not events.is_empty() and events[0].type == "session_start" and events[0].get("props") == {"mode": "squads", "rank": "gold"}, JSON.stringify(events.slice(0, 1)))
	var groups := _of(g, "group")
	_check("on: a group event for each group still set", groups.size() == 1 and groups[0].id == match_id and groups[0].kind == "match", JSON.stringify(groups))
	_check("on: no load is sent again, and nothing of the first session", _of(g, "load").is_empty() and _of(g, "session_end").is_empty() and g._outbox.all(func(b: Dictionary) -> bool: return b.sid == g.session_id))
	_check("on: events carry the level, but the attempt open at the switch gets no outcome", _of(g, "custom")[0].level == "voyage_3" and _of(g, "level_complete").is_empty() and _of(g, "level_fail").is_empty() and _of(g, "level_abandon").is_empty())
	g.level_start("voyage_4")
	g.level_complete("voyage_4", 20)
	_check("on: the next level's start and outcome are sent", _of(g, "level_start").size() == 1 and _of(g, "level_complete").size() == 1 and _of(g, "level_complete")[0].level == "voyage_4")
	g._on_background()
	_check("on: going to the background ends the new session as usual", _of(g, "session_end").size() == 1)
	g.free()


func _changes_nothing() -> void:
	_clean()
	var g := _game()
	g.flush()
	_check("a game that never calls set_enabled saves no choice", not FileAccess.file_exists(Glitchless.ENABLED_PATH))
	var sid: String = g.session_id
	var n := _all(g).size()
	g.set_enabled(true)
	_check("on while on: nothing changes", g.session_id == sid and _all(g).size() == n and g.is_enabled())
	_check("…and the game's choice is saved", _saved() == "on")
	g.set_enabled(false)
	var epoch: int = g._epoch
	g.set_enabled(false)
	_check("off while off: nothing changes", g._epoch == epoch and not g.is_enabled() and _saved() == "off")
	g.free()


func _saved_off() -> void:
	_clean()
	_write(Glitchless.ENABLED_PATH, "off")
	var batch := {"bid": "b_0123456789abcdef", "service": "starlift", "env": "prod", "version": "1.3.0", "group": "1", "events": [{"type": "session_start", "ts": Glitchless._now()}]}
	_write(Glitchless.OUTBOX_PATH, JSON.stringify({"v": 1, "batches": [batch]}))
	var g := _new()
	_check("a saved off is read as the autoload is made, before any frame", g._player_off and g._choice == "off")
	_check("…and an earlier launch's outbox is deleted unread", not FileAccess.file_exists(Glitchless.OUTBOX_PATH) and g._outbox.is_empty())
	g._process(0.016)
	g._process(0.016)
	g.track("menu")
	g.count("tap")
	g.death(1.0, 2.0)
	g.error("x")
	g.set_context({"blocks": 3})
	g.net_sample(30.0)
	_check("before init(): no frames are timed and nothing is kept", g._win.frames == 0 and g._first_frame_ms == 0 and g._queue.is_empty() and g._win.counts.is_empty() and g._win.net.is_empty() and g.stats.errors == 0)
	_check("measure() says Glitchless is off", str(g._probe_result({"frames": 0}, 1.0).get("error", "")).begins_with("Glitchless is off"))
	_start(g)
	g.flush()
	_check("init(): nothing is sent, and is_enabled() is false", not g.is_enabled() and _all(g).is_empty() and not FileAccess.file_exists(Glitchless.OUTBOX_PATH))
	_check("init(): nothing but the choice is written on the device", not FileAccess.file_exists(Glitchless.LAUNCHED_PATH))
	g.open_bug_report()
	_check("the bug report form doesn't open", g._bug_form == null)
	g.level_start("menu")
	g.set_enabled(true)
	g.flush()
	_check("on: a session starts, with no load (the launch's first frame wasn't measured)", g.is_enabled() and _of(g, "session_start").size() == 1 and _of(g, "load").is_empty())
	g.level_complete("menu")
	_check("on: a level started while off gets no outcome", _of(g, "level_complete").is_empty())
	g.free()


func _opt_in() -> void:
	_clean()
	var g := _new()
	g.track("menu")
	for i in 40:
		g._frame(16.7)
	_check("before init(), with no saved choice, frames and events are kept", g._win.frames == 40 and g._queue.size() == 1)
	_start(g, {"opt_in": true})
	_check("opt_in: with no saved choice the device starts off", not g.is_enabled() and g._player_off)
	_check("…and init() drops what was kept before it", g._queue.is_empty() and g._win.frames == 0)
	_check("…and saves no choice until the game asks", not FileAccess.file_exists(Glitchless.ENABLED_PATH))
	g.set_enabled(true)
	g._frame(16.7)
	g.flush()
	_check("opt_in, then set_enabled(true): on, saved, and a session starts", g.is_enabled() and _saved() == "on" and _of(g, "session_start").size() == 1)
	_check("…with no load: it was measured before the player said yes", _of(g, "load").is_empty())
	g.free()

	var h := _game({"opt_in": true})
	_check("a saved on wins over opt_in", h.is_enabled())
	h.free()

	_clean()
	var k := _new()
	k.set_enabled(true)  # before init(): the game passes its own setting early
	_start(k, {"opt_in": true})
	_check("set_enabled(true) before init() holds over opt_in", k.is_enabled() and _saved() == "on")
	k.free()

	_clean()
	_write(Glitchless.ENABLED_PATH, "off")
	var m := _game()
	_check("a saved off holds without opt_in", not m.is_enabled())
	m.free()


func _build_off() -> void:
	_clean()
	var g := _game({"enabled": false})
	_check("a build that sends nothing: is_enabled() is false", not g.is_enabled())
	g.set_enabled(false)
	g.set_enabled(true)
	g.track("pickup")
	g.flush()
	_check("set_enabled(true) can't turn it on, but saves the choice", not g.is_enabled() and _saved() == "on" and _all(g).is_empty())
	g.free()

	var h := _new()
	h.init("starlift", "1.4.0", "prod", "", {"network": false, "enabled": true})
	h.set_enabled(true)
	_check("…nor one with no intake", not h.is_enabled())
	h.free()


func _server() -> void:
	_clean()
	var g := _game({"role": "server"})
	g._features = {"server_mode": true}
	var t := Time.get_ticks_usec()
	g._tick_at = t - 5000
	g._end_tick(t)
	g.flush()
	_check("a server's batches wait in server_outbox.json", FileAccess.file_exists(Glitchless.SERVER_OUTBOX_PATH))
	g.set_enabled(false)
	_check("off: a server drops its batches and its outbox on the device", g._outbox.is_empty() and not FileAccess.file_exists(Glitchless.SERVER_OUTBOX_PATH))
	g._physics_process(0.016)
	g._physics_process(0.016)
	_check("…and times no ticks", g._win.ticks == 0)
	g.free()

	_write(Glitchless.SERVER_OUTBOX_PATH, JSON.stringify({"v": 1, "batches": [{"bid": "b_0123456789abcdef", "service": "starlift", "env": "prod", "version": "1.3.0", "group": "1", "events": [{"type": "server_window", "ts": Glitchless._now()}]}]}))
	var h := _game({"role": "server"})
	_check("a saved off: a server's outbox found at init() is deleted unread", not h.is_enabled() and h._outbox.is_empty() and not FileAccess.file_exists(Glitchless.SERVER_OUTBOX_PATH))
	h.free()

	_clean()
	var k := _game({"role": "server", "opt_in": true})
	_check("opt_in leaves a server on: it has no player to ask", k.is_enabled() and not k._player_off and _saved() == "")
	k.free()


func _bug_reports() -> void:
	_clean()
	var g := _game({"bug_reports": true})
	g.set_enabled(false)
	var r: Dictionary = await g.report_bug("the bonus never paid out", false)
	_check("a bug report from the game's own UI answers off, and nothing is taken or kept", r == {"sent": false, "reason": "off"} and _all(g).is_empty() and g._untimed == 0, JSON.stringify(r))
	var key := InputEventKey.new()
	key.keycode = KEY_F8
	key.physical_keycode = KEY_F8
	key.pressed = true
	g._input(key)
	_check("F8 doesn't open the form", g._bug_form == null)
	g.free()


# The autoload's script, out of the tree, as _ready() leaves it. It has no
# HTTPRequest, so nothing is sent.
func _new() -> Node:
	var g: Node = Glitchless.new()
	g._win = g._new_window()
	g._ring.resize(Glitchless.RING_SIZE)
	g._logger = ErrorLogger.new()
	g._retry_at = 1 << 62
	return g


func _start(g: Node, opts: Dictionary = {}) -> Node:
	var o := {"network": false, "enabled": true}
	o.merge(opts, true)
	g.init("starlift", "1.4.0", "prod", "http://127.0.0.1:9", o)
	return g


func _game(opts: Dictionary = {}) -> Node:
	return _start(_new(), opts)


# Every event waiting: cut into batches, or still queued.
func _all(g: Node) -> Array:
	var all: Array = []
	for b: Dictionary in g._outbox:
		all.append_array(b.events)
	all.append_array(g._queue)
	return all


func _of(g: Node, type: String) -> Array:
	return _all(g).filter(func(e: Dictionary) -> bool: return e.type == type)


func _saved() -> String:
	return FileAccess.get_file_as_string(Glitchless.ENABLED_PATH) if FileAccess.file_exists(Glitchless.ENABLED_PATH) else ""


func _write(path: String, text: String) -> void:
	DirAccess.make_dir_recursive_absolute(Glitchless.SAVE_DIR)
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string(text)
	f.close()


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

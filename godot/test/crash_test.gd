extends SceneTree
## Godot itself crashing (SPEC §5), in glitchless.gd without a server. No
## GDScript runs once the engine dies, so a player build keeps
## user://glitchless/running.json while a session plays and removes it on every
## normal quit and on the way to the background; the next launch that finds it
## sends the session's crash: an error of kind crash and a session_end with
## reason crash, through the outbox like the rest of the session. Godot's crash
## handler (debug builds) adds what it printed, kept in crash.log; without it
## (release builds, a kill) the crash says the game stopped without closing.
## test/e2e.mjs runs it, then crashes the demo for real.
##   godot --headless --path godot --script res://test/crash_test.gd

const Glitchless := preload("res://addons/glitchless/glitchless.gd")
const ErrorLogger := preload("res://addons/glitchless/logger.gd")

const HANDLER := """
================================================================
handle_crash: Program crashed with signal 11
Engine version: Godot Engine v4.7.2.stable.official (ed1daf0bf001b61586d9930840f2f1394092c079)
Dumping the backtrace. Please include this when reporting the bug on: https://github.com/godotengine/godot/issues
Load address: 102e40000

[1] 185aa2144 (libsystem_platform.dylib+4144) - _sigtramp + 56
[2] 107595b18 (main+4755b18) - ZSTD_decompressStream_simpleArgs + 23220
-- END OF C++ BACKTRACE --
================================================================
GDScript backtrace (most recent call first):
    [0] _spawn_wave (res://game/waves.gd:88)
    [1] _process (res://game/level.gd:12)
-- END OF GDSCRIPT BACKTRACE --
================================================================
"""

var _failed := 0


func _init() -> void:
	_run()


func _run() -> void:
	_clean()
	_no_word()
	_handler_word()
	_nothing_sent_yet()
	_install_mode()
	_quit_and_background()
	_not_written()
	_stale_files()
	await _in_the_tree()
	_clean()
	print("crash tests: %d failed" % _failed)
	quit(1 if _failed else 0)


# A session plays, its first batch goes out, and the game dies with no word (a release build: no crash handler).
func _no_word() -> void:
	_clean()
	var g := _game({"session_type": "synthetic"})
	g.level_start("orbit_1")
	g._frame(16.7)
	g.flush()
	var sid: String = g.session_id
	g._outbox.pop_front()  # the server took it
	g._save_outbox()
	g.level_start("orbit_2")  # after the last flush: the crash still names it
	_check("a session that plays leaves running.json", FileAccess.file_exists(Glitchless.RUNNING_PATH))
	var text := FileAccess.get_file_as_string(Glitchless.RUNNING_PATH)
	var r: Dictionary = JSON.parse_string(text)
	_check("…with the session's start, level and build, and no session or player ID", r.start.type == "session_start" and r.level == "orbit_2" and r.version == "1.1.3" and not text.contains(sid) and not r.has("sid") and not r.has("pid"))
	g.free()  # the game dies: no _exit_tree, nothing more written

	var next := _game()
	_check("the next launch sends the session's start again, then its crash", next._outbox.size() == 2 and next._outbox[0].events[0].type == "session_start" and next._outbox[0].events[0].get("continued") == true and next._outbox[0].events[0].session_type == "synthetic")
	var b: Dictionary = next._outbox[1]
	var err: Dictionary = b.events[0]
	var end: Dictionary = b.events[1]
	_check("…under one new ID, not the session's", b.sid == next._outbox[0].sid and b.sid != sid and b.bid.begins_with("b_"))
	_check("…an error of kind crash, saying the game stopped without closing", err.type == "error" and err.kind == "crash" and err.message == "The game stopped without closing" and err.fn == null and err.fingerprint == Glitchless._fingerprint("crash", err.message, ""), str(err))
	_check("…with the level it was on and the last events", err.level == "orbit_2" and end.level == "orbit_2" and err.recent.has("level_start"), str(err))
	_check("…and the session's end, reason crash, with no level_abandon", end.type == "session_end" and end.reason == "crash" and end.duration_s >= 0.0 and b.events.size() == 2 and end.ts == err.ts)
	_check("…timed when the session was last seen running", err.ts == int(r.alive) or err.ts >= int(r.alive), str([err.ts, r.alive]))
	_check("running.json is gone, and the crash is in the outbox before the next launch can stop", not FileAccess.file_exists(Glitchless.RUNNING_PATH) and FileAccess.get_file_as_string(Glitchless.OUTBOX_PATH).contains("\"crash\""))
	var saved: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(Glitchless.OUTBOX_PATH))
	_check("…saved as the outbox saves anonymous sessions: no IDs, the start beside it", not FileAccess.get_file_as_string(Glitchless.OUTBOX_PATH).contains("\"sid\"") and saved.get("starts", []).size() >= 1)
	next.free()


# Godot's crash handler spoke (a debug build): its words are the crash's message, frames and stack.
func _handler_word() -> void:
	_clean()
	var g := _game()
	g.level_start("orbit_1")
	g.flush()
	g._on_crash()  # NOTIFICATION_CRASH, as Godot's crash handler sends it
	_check("the crash handler starts crash.log with the time, level and last events", FileAccess.file_exists(Glitchless.CRASH_LOG_PATH) and g._logger.crash_path == Glitchless.CRASH_LOG_PATH)
	var head: Variant = JSON.parse_string(FileAccess.get_file_as_string(Glitchless.CRASH_LOG_PATH).split("\n")[0])
	_check("…on its first line", head is Dictionary and head.level == "orbit_1" and head.recent.has("level_start"), str(head))
	for line in HANDLER.split("\n"):
		g._logger._log_message(line + "\n", true)
	g._logger._log_message("an ordinary print after it\n", false)
	g.free()
	var next := _game()
	var crash := _crash_of(next)
	_check("the next launch sends the handler's message", crash.get("message") == "Program crashed with signal 11", str(crash))
	_check("…with the script's top frame as fn, source and line", crash.get("fn") == "_spawn_wave" and crash.get("source") == "waves.gd" and crash.get("line") == 88, str(crash))
	_check("…and a stack: the script's frames, then the engine's", str(crash.get("stack")).begins_with("crash: Program crashed with signal 11\n    at _spawn_wave (res://game/waves.gd:88)\n    at _process (res://game/level.gd:12)\nEngine version: Godot Engine v4.7.2") and str(crash.get("stack")).contains("[2] 107595b18"), str(crash.get("stack")))
	_check("…grouped by its own fingerprint, apart from a crash with no word", crash.get("fingerprint") == Glitchless._fingerprint("crash", "Program crashed with signal 11", "_spawn_wave"))
	_check("crash.log is gone too", not FileAccess.file_exists(Glitchless.CRASH_LOG_PATH))
	next.free()


# The game died before its first batch went: the session's saved batches have its start, and the crash follows them.
func _nothing_sent_yet() -> void:
	_clean()
	var g := _game()
	g.level_start("orbit_1")
	g.flush()  # offline: the batch stays in the outbox
	g.free()
	var next := _game()
	var starts := 0
	for b: Dictionary in next._outbox:
		starts += b.events.filter(func(e: Dictionary) -> bool: return e.type == "session_start").size()
	_check("unsent batches keep their one start, the crash after them under the same ID", starts == 1 and next._outbox.size() == 2 and next._outbox[1].events[0].kind == "crash" and next._outbox[0].sid == next._outbox[1].sid)
	next.free()


# Install mode saves the session ID, as its outbox does: the crash joins the session it ended.
func _install_mode() -> void:
	_clean()
	var g := _game({"privacy": "install"})
	g.flush()
	var sid: String = g.session_id
	var pid: String = g.player_id
	g._outbox.clear()
	g._save_outbox()
	var r: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(Glitchless.RUNNING_PATH))
	_check("install mode: running.json has the session and player IDs, and no start", r.sid == sid and r.pid == pid and not r.has("start"))
	g.free()
	var next := _game({"privacy": "install"})
	_check("…so the crash goes under the session it ended, with nothing added", next._outbox.size() == 1 and next._outbox[0].sid == sid and next._outbox[0].pid == pid and next._outbox[0].events[0].kind == "crash")
	next.free()


# Quitting, closing and the background are no crash: running.json goes, and comes back with the game.
func _quit_and_background() -> void:
	_clean()
	var g := _game()
	g.flush()
	g._shutdown("quit")
	_check("a quit removes running.json", not FileAccess.file_exists(Glitchless.RUNNING_PATH))
	g.free()
	var next := _game()
	_check("…so the next launch sends no crash", _crash_of(next).is_empty())
	next.flush()
	next._on_background()
	_check("going to the background removes it (a phone may stop the game there)", not FileAccess.file_exists(Glitchless.RUNNING_PATH))
	next.flush()
	_check("…and nothing writes it while away", not FileAccess.file_exists(Glitchless.RUNNING_PATH))
	next._on_foreground()
	_check("back in the same session, it's written again at once", FileAccess.file_exists(Glitchless.RUNNING_PATH))
	next._on_background()
	next._paused_at -= 400_000  # longer than session_timeout: a new session
	next._on_foreground()
	_check("back after long away: none until the new session's first batch", not FileAccess.file_exists(Glitchless.RUNNING_PATH))
	var sid: String = next.session_id
	next.flush()
	var r: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(Glitchless.RUNNING_PATH))
	_check("…then it holds the new session", int(r.group) == next._started_at and r.start.ts == next._started_at and next.session_id == sid)
	next.set_enabled(false)
	_check("turning Glitchless off removes it", not FileAccess.file_exists(Glitchless.RUNNING_PATH))
	next.free()


# Where a leftover running.json would say nothing true, none is written.
func _not_written() -> void:
	for opts: Dictionary in [{"sample_rate": 0.0}, {"enabled": false}, {"server": true}]:
		_clean()
		var g := _game(opts)
		g.level_start("orbit_1")
		g.flush()
		g._on_crash()
		_check("none for %s" % JSON.stringify(opts), not FileAccess.file_exists(Glitchless.RUNNING_PATH) and not FileAccess.file_exists(Glitchless.CRASH_LOG_PATH))
		g.free()
	_clean()
	var g := _game()
	g._on_crash()
	_check("none before the session's first batch, crash.log neither", not FileAccess.file_exists(Glitchless.RUNNING_PATH) and not FileAccess.file_exists(Glitchless.CRASH_LOG_PATH))
	g.free()
	# A server on the same machine leaves a player build's alone.
	_clean()
	_write(Glitchless.RUNNING_PATH, JSON.stringify({"v": 1, "group": Glitchless._now(), "alive": Glitchless._now(), "service": "starlift", "version": "1.1.3"}))
	var server := _game({"server": true})
	server._shutdown("quit")
	_check("a server neither sends a player build's crash nor removes it", server._outbox.all(func(b: Dictionary) -> bool: return not b.events.any(func(e: Dictionary) -> bool: return e.get("kind") == "crash")) and FileAccess.file_exists(Glitchless.RUNNING_PATH))
	server.free()


# Files that aren't one session's crash send nothing and go.
func _stale_files() -> void:
	_clean()
	_write(Glitchless.CRASH_LOG_PATH, JSON.stringify({"at": Glitchless._now()}) + HANDLER)
	var g := _game()
	_check("a crash.log alone (a crash before the first batch) sends nothing and goes", _crash_of(g).is_empty() and not FileAccess.file_exists(Glitchless.CRASH_LOG_PATH))
	g.free()
	_clean()
	var now := Glitchless._now()
	_write(Glitchless.CRASH_LOG_PATH, JSON.stringify({"at": now - 60_000}) + HANDLER)
	_write(Glitchless.RUNNING_PATH, JSON.stringify({"v": 1, "group": now - 10_000, "alive": now - 5_000, "service": "starlift", "version": "1.1.3", "level": "orbit_3"}))
	g = _game()
	var crash := _crash_of(g)
	_check("a crash.log from before the session is an older crash's: this one has no word", crash.get("message") == "The game stopped without closing" and crash.get("level") == "orbit_3", str(crash))
	g.free()
	_clean()
	_write(Glitchless.RUNNING_PATH, JSON.stringify({"v": 1, "group": now - 8 * 86400_000, "alive": now - 8 * 86400_000, "service": "starlift", "version": "1.1.3"}))
	g = _game()
	_check("a crash older than the outbox keeps anything is dropped, and its file goes", _crash_of(g).is_empty() and not FileAccess.file_exists(Glitchless.RUNNING_PATH))
	g.free()
	_clean()
	_write(Glitchless.RUNNING_PATH, "{\"v\": 1, \"gro")
	g = _game()
	_check("a cut-off running.json sends nothing and goes", _crash_of(g).is_empty() and not FileAccess.file_exists(Glitchless.RUNNING_PATH))
	g.free()


# In the tree, as a game has it: flushes write running.json on a worker thread, a quit waits for that write so it
# can't put the file back, and the next launch's crash has paths on the device cut down, as every error's are.
func _in_the_tree() -> void:
	_clean()
	await process_frame
	var g := await _tree_game()
	g.flush()
	_check("tree: a flush hands running.json to a worker", g._running_task >= 0)
	g._shutdown("quit")
	_check("tree: a quit waits for that write, then removes it", g._running_task < 0 and not FileAccess.file_exists(Glitchless.RUNNING_PATH))
	for i in 3:
		await process_frame
	_check("tree: and nothing puts it back", not FileAccess.file_exists(Glitchless.RUNNING_PATH))
	g.queue_free()
	await process_frame

	var dying := await _tree_game()
	dying.flush()
	dying._wait_for_running()
	dying.notification(NOTIFICATION_CRASH)
	# What Godot's crash handler prints next reaches the logger the autoload added.
	dying._logger._log_message("handle_crash: Program crashed with signal 11\n", true)
	dying._logger._log_message("[1] 1 (/Users/alice/Games/Starlift.app/Contents/MacOS/libgame.dylib+12) - boom\n", true)
	dying._logger.crash_path = ""  # the game would be dead here: this test's own prints stay out
	dying._watch_crash = false  # leaving the tree is no quit here: the files stay for the next launch
	dying.queue_free()
	await process_frame
	var next := await _tree_game()
	var crash := _crash_of(next)
	_check("tree: NOTIFICATION_CRASH, and the next launch sends what the handler said", crash.get("message") == "Program crashed with signal 11", str(crash))
	_check("tree: …the user name in its paths cut out, as in every error", str(crash.get("stack")).contains("/Users/~/Games") and not str(crash.get("stack")).contains("alice"), str(crash.get("stack")))
	next._watch_crash = false
	next.queue_free()
	await process_frame


func _tree_game() -> Node:
	var g: Node = Glitchless.new()
	root.add_child(g)  # _ready() runs, as for the autoload
	await process_frame
	g._retry_at = 1 << 62
	g.init("starlift", "1.1.3", "prod", "http://127.0.0.1:9", {"network": false, "enabled": true})
	g._next_flush = 1 << 62
	return g


func _crash_of(g: Node) -> Dictionary:
	for b: Dictionary in g._outbox:
		for e: Dictionary in b.events:
			if e.get("kind") == "crash":
				return e
	return {}


# The autoload's script, out of the tree, as _ready() leaves it. It has no HTTPRequest, so nothing is sent.
func _game(opts: Dictionary = {}) -> Node:
	var g: Node = Glitchless.new()
	g._win = g._new_window()
	g._ring.resize(Glitchless.RING_SIZE)
	g._logger = ErrorLogger.new()
	g._retry_at = 1 << 62
	g._started_at = Glitchless._now()  # as _ready() starts the session in a game
	var o := {"network": false, "enabled": true}
	o.merge(opts, true)
	if o.get("server"):
		o.erase("server")
		o.role = "server"
	g.init("starlift", "1.1.3", "prod", "http://127.0.0.1:9", o)
	return g


func _write(path: String, text: String) -> void:
	DirAccess.make_dir_recursive_absolute(Glitchless.SAVE_DIR)
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string(text)
	f.close()


func _clean() -> void:
	for p: String in [Glitchless.ENABLED_PATH, Glitchless.OUTBOX_PATH, Glitchless.SERVER_OUTBOX_PATH, Glitchless.PLAYER_PATH, Glitchless.LAUNCHED_PATH, Glitchless.RUNNING_PATH, Glitchless.CRASH_LOG_PATH]:
		if FileAccess.file_exists(p):
			DirAccess.remove_absolute(p)


func _check(name: String, ok: bool, detail: String = "") -> void:
	print("%s %s" % ["ok" if ok else "FAIL", name])
	if not ok:
		_failed += 1
		if detail != "":
			print("    ", detail)

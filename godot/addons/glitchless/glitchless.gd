extends Node
## Autoload "Glitchless": frame times, hitches, errors and play events for a
## Glitchless server, in the shape the browser SDK (packages/sdk/src/core.js)
## sends them, so the dashboard, findings, Datadog forwarding and the MCP tools
## take a Godot game as they are. Needs Godot 4.5 or later, for the error logger.
##
##   Glitchless.init("starlift", "1.4.0", "prod", "https://glitchless.example.com")
##   Glitchless.level_start("voyage_3")
##   Glitchless.track("play", "endless")
##   Glitchless.death(pos.x, pos.y, "meteor")
##   Glitchless.set_context({"blocks": blocks.size()})
##   Glitchless.report_bug(note)  # or bug_reports in init options: F8 opens a form
##
## Frame times are measured from the start of the game; events wait in memory
## until init() says where to send them. Every few seconds they go out as one
## batch, and again when the game goes to the background or closes. Batches
## that could not be sent are kept in user://glitchless/ and sent on a later launch.
##
## Debug builds send nothing unless the game is run with --glitchless, so a
## developer's phone does not skew the numbers. Anonymous mode, the default,
## sends nothing that can be tied to a person; install mode adds a random
## player ID kept on the device, so returning players can be counted (retention):
## PRIVACY.md beside this file lists every field each mode sends.
##
## Flags (after "--" on the command line):
##   --glitchless                  send from a debug build too
##   --glitchless-intake=URL       send to this server instead (and turn sending on)
##   --glitchless-measure=SECONDS  print frame stats as one line of JSON and quit
##   --glitchless-warmup=SECONDS   with --glitchless-measure: wait this long before measuring
##   --glitchless-out=PATH         with --glitchless-measure: write the JSON to this file too
##   --glitchless-synthetic        mark the session as a bot's (--autoplay does too)
##   --glitchless-debug            print each batch as it is sent

const SDK_VERSION := "0.2.0"
const SDK := "glitchless-godot/" + SDK_VERSION

const Sketch := preload("sketch.gd")
const ErrorLogger := preload("logger.gd")
const Device := preload("device.gd")
const BugReport := preload("bug_report.gd")

const HITCH_MS := 50.0  # one frame over 50 ms is a stutter a player sees
const JANK_MS := 33.4  # two missed 60 Hz frames
const FROZEN_MS := 700.0  # Android vitals' "frozen frame"
const MAX_ERRORS_PER_FINGERPRINT := 25
const MAX_QUEUE := 2000
const MAX_HITCH_EVENTS_PER_WINDOW := 3  # frame_window.hitches still counts every one
const RAGE_INPUT_COUNT := 4  # the same key four times in a second
const RAGE_INPUT_WINDOW_MS := 1000
const BATCH_BYTES := 60000
const MAX_OUTBOX_EVENTS := 4000
const MAX_OUTBOX_AGE_MS := 6 * 86400 * 1000  # the server files anything over 7 days old under "now"
const SEND_DEADLINE_MS := 1500  # how long closing or going to the background may wait on the network
const RING_SIZE := 240
const BUG_RECENT := 20  # game events and hitches a bug report carries
const BUG_FRAMES := 6  # frame windows a bug report carries
const ADDON_DIR := "res://addons/glitchless/"
const SAVE_DIR := "user://glitchless"
const OUTBOX_PATH := "user://glitchless/outbox.json"
const PLAYER_PATH := "user://glitchless/player_id"  # install and full mode
const ID_CHARS := "abcdefghijklmnopqrstuvwxyz0123456789"
const PIPELINE_MONITORS: Array[int] = [
	Performance.PIPELINE_COMPILATIONS_CANVAS,
	Performance.PIPELINE_COMPILATIONS_MESH,
	Performance.PIPELINE_COMPILATIONS_SURFACE,
	Performance.PIPELINE_COMPILATIONS_DRAW,
	Performance.PIPELINE_COMPILATIONS_SPECIALIZATION,
]

## Everything init() takes in its options. PRIVACY.md says what each changes.
const DEFAULTS := {
	"client_token": "gl_pub_dev",
	"privacy": "anonymous",  # "install" adds a random player ID kept on the device; "full" that, device detail and positions
	"positions": null,  # death and movement positions; null: on in full mode only
	"sample_rate": 1.0,
	"flush_interval": 5.0,  # seconds between batches
	"position_hz": 4.0,
	"session_type": "",  # "user" or "synthetic"; "": synthetic with --autoplay
	"session_timeout": 300.0,  # seconds in the background after which coming back is a new session
	"capture_warnings": false,
	"engine_gauges": true,  # node and object counts in ctx, where the findings look for leaks
	"measure_render_time": true,
	"rage_input": null,  # null: on except on phones, where fast tapping is normal play
	"enabled": null,  # null: off in debug builds unless --glitchless
	"debug": false,
	# true, or {"hotkey": KEY_F8, "pause": true, "screenshot": true}: players send bug reports from a form in the game
	"bug_reports": false,
}

## The bug report form opened or closed. The game is paused meanwhile unless
## bug_reports has "pause": false; then pause and resume the game here.
signal bug_report_opened
signal bug_report_closed

var session_id := ""
var player_id := ""  ## stays empty in anonymous mode
var enabled := false  ## whether anything is sent; decided by init()
var sampled := true
var level: Variant = null
var stats := {"sent": 0, "failed": 0, "errors": 0, "hitches": 0, "deaths": 0, "last_status": "idle"}

var _opts := DEFAULTS.duplicate()
var _inited := false
var _service := "unknown-game"
var _version := "0.0.0"
var _env := "dev"
var _intake := ""
var _privacy := "anonymous"
var _full := false
var _positions := false
var _session_type := "user"
var _rage_input := false
var _engine_gauges := true
var _measure_render := true
var _debug := false

var _started_at := 0  # unix ms of this session's start
var _level_started := 0  # ticks ms
var _ctx := {}
var _recent: Array[Dictionary] = []  # the last game events, for breadcrumbs: {name, t}
var _queue: Array[Dictionary] = []
var _outbox: Array[Dictionary] = []  # batches: {id, service, env, version, sid, pid, group, events}
var _next_batch_id := 1
var _in_flight := -1  # id of the batch _http is sending
var _http: HTTPRequest
var _retry_at := 0
var _backoff := 0.0
var _session_start_sent := false
var _load_sent := false
var _ended := false
var _shut := false
var _paused_at := 0
var _logger: ErrorLogger
var _error_counts := {}
var _error_log := {}  # fingerprint -> {message, kind, location, count}, for measure()
var _probes: Array[Dictionary] = []
var _pending_hitches: Array[Dictionary] = []
var _win: Dictionary
var _ring := PackedFloat32Array()
var _ring_idx := 0
var _ring_count := 0
var _budget_ms := 1000.0 / 60.0
var _hz := 60
var _early: Array[float] = []
var _recent_median := 0.0
var _frame_id := 0
var _last_us := 0
var _untimed := 0  # frames not to time (taking a bug report's screenshot)
var _pending_long := {}
var _throttled := false
var _first_frame_ms := 0
var _first_input_ms := 0
var _key_history := {}
var _position: Variant = null
var _pos_buffer: Array = []
var _next_flush := 0
var _next_pos := 0
var _vp: RID
var _screen: Array = []
var _window: Array = []
var _engine := {}
var _scrubbers: Array = []  # [RegEx, replacement], made in _ready
var _history: Array[Dictionary] = []  # the last game events, slimmed, for bug reports
var _recent_hitches: Array[Dictionary] = []
var _recent_windows: Array[Dictionary] = []  # {ts, level, fps, p95} of the last frame windows
var _bug_opts := {}  # bug_reports from init options; empty while they're off
var _bug_hotkey := KEY_NONE
var _bug_form: BugReport

# What the frame that just ended cost, read at the start of the next one.
var _f_calls := 0
var _f_tris := 0
var _f_render := 0.0
var _f_gpu := 0.0
var _f_process := 0.0
var _f_physics := 0.0
var _f_pipelines := 0
var _f_nodes_added := 0
var _f_scene_changed := false
var _pipelines := 0
var _nodes := 0
var _scene := 0
var _head_us := 0
var _tail_process_ms := 0.0
var _physics_head_us := 0
var _physics_us := 0


## Runs last in every frame (see _ready), so the time between Glitchless's own
## _process and this one is what all the game's _process code took.
class _Tail extends Node:
	var on_process: Callable
	var on_physics: Callable

	func _process(_delta: float) -> void:
		on_process.call()

	func _physics_process(_delta: float) -> void:
		on_physics.call()


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_priority = -(1 << 30)
	process_physics_priority = -(1 << 30)
	var tail := _Tail.new()
	tail.name = "Tail"
	tail.on_process = _on_tail_process
	tail.on_physics = _on_tail_physics
	tail.process_mode = Node.PROCESS_MODE_ALWAYS
	tail.process_priority = 1 << 30
	tail.process_physics_priority = 1 << 30
	add_child(tail)
	_started_at = _now()
	_win = _new_window()
	_ring.resize(RING_SIZE)
	_vp = get_viewport().get_viewport_rid()
	_set_measure_render(true)
	for rule: Array in [
		["(/Users|/home)/[^/\\s'\"]+", "$1/~"],  # a macOS or Linux user name
		["([A-Za-z]:[\\\\/]Users[\\\\/])[^\\\\/\\s'\"]+", "$1~"],  # a Windows one
		["[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}", "<id>"],  # iOS app container IDs
	]:
		_scrubbers.append([RegEx.create_from_string(rule[0]), rule[1]])
	_logger = ErrorLogger.new()
	OS.add_logger(_logger)
	_http = HTTPRequest.new()
	_http.timeout = 10.0
	_http.request_completed.connect(_on_sent)
	add_child(_http)
	_check_screen()
	_debug = _has_flag("--glitchless-debug")
	_next_flush = Time.get_ticks_msec() + int(float(_opts.flush_interval) * 1000.0)
	var seconds := _flag_value("--glitchless-measure")
	if seconds != "":
		_run_measure_flag.call_deferred(float(seconds), float(_flag_value("--glitchless-warmup", "0")), _flag_value("--glitchless-out"))


func _exit_tree() -> void:
	_shutdown("quit")
	if _logger:
		OS.remove_logger(_logger)


# ───────────────────────────── the game's calls ─────────────────────────────

## Says who the game is and where to send. Until this is called nothing is sent,
## but frame times, errors and events are kept, so a game may call it late.
## version defaults to application/config/version. options: see DEFAULTS.
func init(service: String, version: String = "", env: String = "prod", intake: String = "", options: Dictionary = {}) -> void:
	if _inited:
		return
	_inited = true
	_opts.merge(options, true)
	_service = service.to_lower() if service != "" else "unknown-game"
	_version = version if version != "" else str(ProjectSettings.get_setting("application/config/version", ""))
	if _version == "":
		_version = "0.0.0"
	_env = env if env != "" else "prod"
	var flag_intake := _flag_value("--glitchless-intake")
	_intake = (flag_intake if flag_intake != "" else intake).trim_suffix("/")
	_privacy = str(_opts.privacy) if str(_opts.privacy) in ["install", "full"] else "anonymous"
	_full = _privacy == "full"
	_positions = _full if _opts.positions == null else bool(_opts.positions)
	_rage_input = not OS.has_feature("mobile") if _opts.rage_input == null else bool(_opts.rage_input)
	_engine_gauges = bool(_opts.engine_gauges)
	_debug = _debug or bool(_opts.debug)
	_logger.capture_warnings = bool(_opts.capture_warnings)
	_set_measure_render(bool(_opts.measure_render_time))
	if str(_opts.session_type) != "":
		_session_type = str(_opts.session_type)
	elif _has_flag("--autoplay") or _has_flag("--glitchless-synthetic") or _has_flag("--glitchless-measure") or DisplayServer.get_name() == "headless":
		_session_type = "synthetic"
	if _opts.enabled != null:
		enabled = bool(_opts.enabled)
	else:
		enabled = not OS.is_debug_build() or _has_flag("--glitchless") or flag_intake != ""
	enabled = enabled and _intake != ""
	sampled = randf() < float(_opts.sample_rate)
	var bug: Variant = _opts.bug_reports
	if bug is Dictionary or (bug is bool and bug):
		_bug_opts = {"hotkey": KEY_F8, "pause": true, "screenshot": true}
		if bug is Dictionary:
			_bug_opts.merge(bug, true)
		_bug_hotkey = _keycode(_bug_opts.hotkey)
	session_id = _new_id("s_", 16)  # held in memory only; anonymous mode never writes it down
	# The first batch goes soon, so a session that crashes early is still seen.
	_next_flush = Time.get_ticks_msec() + int(minf(2.0, float(_opts.flush_interval)) * 1000.0)
	if not enabled:
		_queue.clear()
		_log("off (debug build without --glitchless, or no intake)")
		return
	DirAccess.make_dir_recursive_absolute(SAVE_DIR)
	if _privacy != "anonymous":
		player_id = _load_player_id()  # install and full mode share it (SPEC §4b)
	elif FileAccess.file_exists(PLAYER_PATH):
		DirAccess.remove_absolute(PLAYER_PATH)  # left by an install- or full-mode build: anonymous mode keeps no ID
	_load_outbox()
	_log("on: %s %s %s -> %s (%s, %s)" % [_service, _version, _env, _intake, _privacy, _session_type])


## Forgets the player ID kept on the device (install and full mode), for a
## game's "reset my ID" setting. This session keeps sending the ID it started
## with; the next launch makes a new one, so nothing joins the two.
func reset_install_id() -> void:
	if FileAccess.file_exists(PLAYER_PATH):
		DirAccess.remove_absolute(PLAYER_PATH)


func level_start(level_id: Variant) -> void:
	_close_window(false)  # so a frame window never spans two levels
	level = str(level_id)
	_level_started = Time.get_ticks_msec()
	_push({"type": "level_start"})
	_remember("level_start")


func level_complete(level_id: Variant = null, score: Variant = null, duration_s: float = -1.0) -> void:
	var lvl: Variant = str(level_id) if level_id != null else level
	var secs := duration_s if duration_s >= 0.0 else (Time.get_ticks_msec() - _level_started) / 1000.0
	_push({"type": "level_complete", "level": lvl, "duration_s": snappedf(secs, 0.01), "score": score})
	_remember("level_complete")


func level_fail(level_id: Variant = null, cause: String = "") -> void:
	var lvl: Variant = str(level_id) if level_id != null else level
	_push({"type": "level_fail", "level": lvl, "cause": cause if cause != "" else null})
	_remember("level_fail")


## A death at a place in the game world. The place is sent only when positions
## are on (full mode, or the positions option); the death and cause always are.
func death(x: float, y: float, cause: String = "unknown", z: float = 0.0) -> void:
	stats.deaths += 1
	var e := {"type": "death", "cause": cause}
	if _positions:
		e.x = snappedf(x, 0.01)
		e.y = snappedf(y, 0.01)
		e.z = snappedf(z, 0.01)
	_push(e)
	_remember("death:" + cause)


## A game event. `what` is one word about it ("endless", "forge"), a number, or
## a dictionary of attributes. Use the game's own words, never anything the
## player typed or anything particular to them.
func track(event: String, what: Variant = null) -> void:
	var attrs := {}
	if what is Dictionary:
		attrs = what
	elif what != null:
		attrs = {"what": what}
	_push({"type": "custom", "name": event, "attrs": attrs})
	_remember(event)


## Numbers that describe what is going on (enemies, particles, blocks). The
## largest value in each frame window is sent, and the current ones go with
## each hitch, so the findings can say what was high when frames stuttered.
## Call it at the end of the frame's work, so a stutter carries the counts the
## slow frame ended with.
func set_context(gauges: Dictionary) -> void:
	for k: Variant in gauges:
		var v: Variant = gauges[k]
		if v is int or v is float:
			_gauge(str(k), float(v))


## The player's place, sampled at position_hz for heatmaps. Ignored unless
## positions are on.
func set_position(p: Variant) -> void:
	if not _positions:
		return
	if p is Vector2:
		_position = [p.x, p.y, 0.0]
	elif p is Vector3:
		_position = [p.x, p.y, p.z]


## Reports an error the game caught itself.
func error(message: String, attrs: Dictionary = {}) -> void:
	var frames: Array[Dictionary] = []
	for bt in Engine.capture_script_backtraces():
		for i in range(bt.get_frame_count()):
			frames.append({"fn": bt.get_frame_function(i), "file": bt.get_frame_file(i), "line": bt.get_frame_line(i)})
	if not frames.is_empty() and frames[0].file.begins_with(ADDON_DIR):
		frames.remove_at(0)  # this function
	_report_error({"kind": "manual", "function": "", "file": "", "line": 0, "code": message, "rationale": "", "type": -1, "frames": frames, "attrs": attrs})


## A player's bug report from the game's own UI: what they typed, a screenshot
## of the game (false sends none, an Image sends that one), where they are and
## what just happened. Sent on its own straight away, from every session:
##   var result := await Glitchless.report_bug(note)
## result.sent is true once the server has it; otherwise result.reason is
## "offline" (nothing is sent from this build) or "error" (it goes with a later batch).
func report_bug(note: String = "", screenshot: Variant = true) -> Dictionary:
	return await _send_report(_bug_snapshot(screenshot), note)


## Opens the bug report form, for a game's own "Report a bug" button. Works
## whether or not bug_reports is on (that adds the hotkey).
func open_bug_report() -> void:
	_bug_report_form().open()


func is_bug_report_open() -> bool:
	return _bug_form != null and _bug_form.is_open


## Frame stats over the next `seconds`, the same numbers as the browser SDK's
## glitchless_measure tool: `var stats := await Glitchless.measure(5.0)`.
func measure(seconds: float = 5.0) -> Dictionary:
	var probe := {
		"sketch": Sketch.new(), "render": Sketch.new(), "gpu": Sketch.new(), "process": Sketch.new(),
		"frames": 0, "max": 0.0, "hitches": [], "calls": 0, "calls_max": 0, "tris": 0,
		"ctx_max": {}, "errors": stats.errors, "fingerprints": _error_log.duplicate(true),
		"level": level, "engine": _sample_engine(),
	}
	_probes.append(probe)
	await get_tree().create_timer(seconds, true, false, true).timeout
	_probes.erase(probe)
	return _probe_result(probe, seconds)


## Closes the current frame window and sends what is waiting. Runs by itself
## every flush_interval seconds.
func flush() -> void:
	_next_flush = Time.get_ticks_msec() + int(float(_opts.flush_interval) * 1000.0)
	_close_window()
	if not _inited:
		return  # kept until init() says where it goes
	if not enabled:
		_queue.clear()
		return
	if not _session_start_sent:
		_queue.push_front(_session_start_event())
		_session_start_sent = true
		if _first_frame_ms > 0 and not _load_sent:
			_load_sent = true
			_queue.append({"type": "load", "ts": _now(), "level": level, "ttff_ms": _first_frame_ms, "assets": null})
	if not sampled:
		_queue.clear()
		stats.last_status = "unsampled"
		return
	if not _queue.is_empty():
		_add_batches(_queue)
		_queue = []
		_save_outbox()
	if not _shut:
		_send_next()  # while closing, _send_now() sends instead: HTTPRequest has left the tree


# ───────────────────────────── frame timing ─────────────────────────────

func _process(_delta: float) -> void:
	# Wall-clock time between frames. The delta Godot passes is smoothed
	# (application/run/delta_smoothing) and scaled by Engine.time_scale, which
	# would hide the very stutters this is here to find.
	var now := Time.get_ticks_usec()
	_head_us = now
	_frame_id += 1
	_read_last_frame()
	if _last_us > 0 and _untimed == 0:
		_frame((now - _last_us) / 1000.0)
	_untimed = maxi(0, _untimed - 1)
	_last_us = now
	for entry in _logger.take():
		_report_error(entry)
	var ms := Time.get_ticks_msec()
	if _positions and _position != null and ms >= _next_pos:
		_next_pos = ms + int(1000.0 / maxf(float(_opts.position_hz), 0.1))
		_pos_buffer.append([_now(), snappedf(_position[0], 0.01), snappedf(_position[1], 0.01), snappedf(_position[2], 0.01)])
	if _frame_id % 30 == 0:
		_sample_engine()
		_check_screen()
	if ms >= _next_flush:
		flush()
	if _inited and enabled and _in_flight < 0 and not _outbox.is_empty() and ms >= _retry_at:
		_send_next()


func _physics_process(_delta: float) -> void:
	_physics_head_us = Time.get_ticks_usec()


func _on_tail_process() -> void:
	_tail_process_ms = (Time.get_ticks_usec() - _head_us) / 1000.0


func _on_tail_physics() -> void:
	_physics_us += Time.get_ticks_usec() - _physics_head_us


# What the frame that just ended cost. Draw calls and render time are the last
# rendered frame's; the pipeline and node counts are totals, so the change
# since the last frame is what that frame added.
func _read_last_frame() -> void:
	_f_calls = int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME))
	_f_tris = int(Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME))
	if _measure_render:
		_f_render = RenderingServer.viewport_get_measured_render_time_cpu(_vp) + RenderingServer.get_frame_setup_time_cpu()
		_f_gpu = RenderingServer.viewport_get_measured_render_time_gpu(_vp)
	var pipelines := 0
	for m in PIPELINE_MONITORS:
		pipelines += int(Performance.get_monitor(m))
	_f_pipelines = pipelines - _pipelines if _frame_id > 1 else 0
	_pipelines = pipelines
	var nodes := int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT))
	_f_nodes_added = nodes - _nodes if _frame_id > 1 else 0
	_nodes = nodes
	var scene := get_tree().current_scene
	var scene_id := scene.get_instance_id() if scene else 0
	_f_scene_changed = scene_id != _scene and _frame_id > 1  # the old scene going, or the new one arriving
	_scene = scene_id
	_f_process = _tail_process_ms
	_f_physics = _physics_us / 1000.0
	_physics_us = 0


# A run of long frames is the OS throttling a hidden window, not the game: a
# single long frame between normal ones is a real freeze; a run is dropped.
func _frame(dt: float) -> void:
	if dt >= 5000.0:
		_pending_long = {}
	elif dt > FROZEN_MS:
		if not _pending_long.is_empty() or _throttled:
			_pending_long = {}
			_throttled = true
		else:
			_pending_long = _snapshot(dt)
	else:
		if not _pending_long.is_empty():
			_on_frame(_pending_long)
		_pending_long = {}
		_throttled = false
		_on_frame(_snapshot(dt))
	# The refresh rate (60 / 90 / 120 Hz, or a cap the game set) from the median early frame.
	if _early.size() < 120 and dt < 100.0:
		_early.append(dt)
		if _early.size() == 120:
			_set_budget(_median(_early))


func _snapshot(dt: float) -> Dictionary:
	return {
		"dt": dt, "calls": _f_calls, "tris": _f_tris, "render": _f_render, "gpu": _f_gpu,
		"process": _f_process, "physics": _f_physics, "pipelines": _f_pipelines,
		"nodes_added": _f_nodes_added, "scene_changed": _f_scene_changed,
	}


func _set_budget(median_dt: float) -> void:
	var hz := 1000.0 / median_dt
	var best := 60
	for r: int in [30, 60, 75, 90, 100, 120, 144, 165, 240]:
		if absf(r - hz) < absf(best - hz):
			best = r
	_hz = best
	_budget_ms = 1000.0 / _hz


func _on_frame(f: Dictionary) -> void:
	var dt: float = f.dt
	var w := _win
	w.frames += 1
	w.sketch.add(dt)
	w.max = maxf(w.max, dt)
	if dt > _budget_ms * 1.5:
		w.slow += 1
	if dt > JANK_MS:
		w.jank += 1
	if dt > FROZEN_MS:
		w.frozen += 1
	w.calls += f.calls
	w.calls_max = maxi(w.calls_max, f.calls)
	w.tris += f.tris
	w.render += f.render
	w.gpu += f.gpu
	w.process += f.process
	w.physics += f.physics
	_ring[_ring_idx] = dt
	_ring_idx = (_ring_idx + 1) % RING_SIZE
	_ring_count = mini(_ring_count + 1, RING_SIZE)
	if _first_frame_ms == 0:
		_first_frame_ms = Time.get_ticks_msec()
	if _frame_id % 16 == 0 and _ring_count >= 30:
		_recent_median = _median(_last_frames(60))

	# A hitch is a stutter: over 50 ms and well above what this device usually
	# does. A device that is slow all the time shows in the percentiles instead.
	var hitch := dt > HITCH_MS and dt > 2.0 * _recent_median
	if hitch:
		_sample_engine()  # the counts this frame ended with go in the hitch's ctx
	for p in _probes:
		p.frames += 1
		p.sketch.add(dt)
		p.max = maxf(p.max, dt)
		p.calls += f.calls
		p.calls_max = maxi(p.calls_max, f.calls)
		p.tris += f.tris
		p.render.add(f.render)
		p.process.add(f.process)
		if f.gpu > 0.0:
			p.gpu.add(f.gpu)
		if hitch:
			p.hitches.append({"ms": snappedf(dt, 0.1), "level": level, "draw_calls": f.calls, "causes": _causes(f), "ctx": _ctx.duplicate(), "recent": _recent_within(1500)})
	if hitch:
		w.hitches += 1
		stats.hitches += 1
		_pending_hitches.append({
			"type": "hitch",
			"ts": _now(),
			"level": level,
			"duration_ms": snappedf(dt, 0.1),
			"frozen": dt > FROZEN_MS,
			"draw_calls": f.calls,
			"triangles": f.tris,
			"programs": null,
			"ctx": _ctx.duplicate(),
			"recent": _recent_within(1500),
			"causes": _causes(f),
			"loaf": [],
			"process_ms": snappedf(f.process, 0.1),
			"physics_ms": snappedf(f.physics, 0.1),
			"render_ms": snappedf(f.render, 0.1),
			"gpu_ms": snappedf(f.gpu, 0.1) if f.gpu > 0.0 else null,
			"pipeline_compiles": f.pipelines,
			"nodes_added": f.nodes_added,
		})


# Likely causes of one long frame, from what that frame measured.
func _causes(f: Dictionary) -> Array[String]:
	var out: Array[String] = []
	var share := maxf(16.0, f.dt * 0.4)
	if f.pipelines > 0:
		out.append("shader_compile")
	if f.scene_changed:
		out.append("scene_change")
	if f.nodes_added >= 50:
		out.append("node_spawn")
	if f.process >= share:
		out.append("script")
	if f.physics >= share:
		out.append("physics")
	if f.render + f.gpu >= share:
		out.append("render")
	if f.dt > FROZEN_MS:
		out.append("frozen")
	return out


func _new_window() -> Dictionary:
	return {
		"started_at": _now(), "started_ms": Time.get_ticks_msec(), "frames": 0, "sketch": Sketch.new(), "max": 0.0,
		"slow": 0, "jank": 0, "hitches": 0, "frozen": 0, "calls": 0, "calls_max": 0, "tris": 0,
		"render": 0.0, "gpu": 0.0, "process": 0.0, "physics": 0.0, "ctx": {},
	}


# fresh: sample the engine counts now. Not when a level starts: whatever the
# game just did to load the new level belongs to the new level.
func _close_window(fresh: bool = true) -> void:
	if fresh and _win.frames > 0:
		_sample_engine()
	var w := _win
	_win = _new_window()
	if w.frames > 0:
		var secs := maxf((Time.get_ticks_msec() - w.started_ms) / 1000.0, 0.001)
		var n: int = w.frames
		var s: Sketch = w.sketch
		_queue_event({
			"type": "frame_window",
			"ts": w.started_at,
			"level": level,
			"duration_s": snappedf(secs, 0.01),
			"frames": n,
			"fps": snappedf(n / secs, 0.1),
			"hz": _hz,
			"budget_ms": snappedf(_budget_ms, 0.01),
			"ft": s.to_json(),
			"ft_p50": _round(s.quantile(0.5), 0.01),
			"ft_p95": _round(s.quantile(0.95), 0.01),
			"ft_p99": _round(s.quantile(0.99), 0.01),
			"ft_max": snappedf(w.max, 0.1),
			"slow": w.slow,
			"jank": w.jank,
			"hitches": w.hitches,
			"frozen": w.frozen,
			"render_ms": snappedf(w.render / n, 0.01) if _measure_render else null,
			"gpu_ms": snappedf(w.gpu / n, 0.01) if w.gpu > 0.0 else null,
			"process_ms": snappedf(w.process / n, 0.01),
			"physics_ms": snappedf(w.physics / n, 0.01),
			"draw_calls": roundi(float(w.calls) / n),
			"draw_calls_max": w.calls_max,
			"triangles": roundi(float(w.tris) / n),
			"geometries": null,
			"textures": null,
			"programs": null,
			"heap_mb": _engine.get("static_mb"),
			"objects": _engine.get("objects"),
			"nodes": _engine.get("nodes"),
			"orphan_nodes": _engine.get("orphan_nodes"),
			"resources": _engine.get("resources"),
			"video_mb": _engine.get("video_mb"),
			"texture_mb": _engine.get("texture_mb"),
			"screen": _screen,
			"window": _window,
			"ctx": w.ctx,
		})
		_recent_windows.append({"ts": w.started_at, "level": level, "fps": snappedf(n / secs, 0.1), "p95": _round(s.quantile(0.95), 0.01)})
		if _recent_windows.size() > 12:
			_recent_windows.pop_front()
	if not _pos_buffer.is_empty():
		_queue_event({"type": "pos", "ts": _pos_buffer[0][0], "level": level, "pts": _pos_buffer})
		_pos_buffer = []
	_pending_hitches.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a.duration_ms > b.duration_ms)
	for h in _pending_hitches.slice(0, MAX_HITCH_EVENTS_PER_WINDOW):
		_queue_event(h)
		_recent_hitches.append(_slim(h))
	if _recent_hitches.size() > BUG_RECENT:
		_recent_hitches = _recent_hitches.slice(_recent_hitches.size() - BUG_RECENT)
	_pending_hitches.clear()


# Engine counts: objects, nodes and orphan nodes (nodes out of the tree that
# were never freed) climb level after level when something leaks. With
# engine_gauges on they go in ctx too, which is where the findings compare a
# slow level's gauges with the smoothest level's.
func _sample_engine() -> Dictionary:
	var static_mem := Performance.get_monitor(Performance.MEMORY_STATIC)  # 0 in release builds
	_engine = {
		"objects": int(Performance.get_monitor(Performance.OBJECT_COUNT)),
		"nodes": int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT)),
		"orphan_nodes": int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT)),
		"resources": int(Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT)),
		"video_mb": snappedf(Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0, 0.1),
		"texture_mb": snappedf(Performance.get_monitor(Performance.RENDER_TEXTURE_MEM_USED) / 1048576.0, 0.1),
		"static_mb": snappedf(static_mem / 1048576.0, 0.1) if static_mem > 0 else null,
	}
	if _engine_gauges:
		_gauge("nodes", _engine.nodes)
		_gauge("orphan_nodes", _engine.orphan_nodes)
		_gauge("objects", _engine.objects)
	return _engine


# The screen size changes when an iPhone Duo opens or closes, or a desktop
# window moves to another screen: a breadcrumb for any stutter that follows.
func _check_screen() -> void:
	var screen := Device.screen_size()
	var win := Device.window_size()
	if _screen.is_empty():
		_screen = screen
		_window = win
	elif screen != _screen or win != _window:
		_screen = screen
		_window = win
		track("screen_change", {"screen": screen, "window": win})


func _gauge(key: String, v: float) -> void:
	_ctx[key] = v
	_win.ctx[key] = maxf(float(_win.ctx.get(key, -INF)), v)
	for p in _probes:
		p.ctx_max[key] = maxf(float(p.ctx_max.get(key, -INF)), v)


func _last_frames(count: int) -> Array[float]:
	var out: Array[float] = []
	for i in range(mini(count, _ring_count), 0, -1):
		out.append(_ring[(_ring_idx - i + RING_SIZE) % RING_SIZE])
	return out


func _set_measure_render(on: bool) -> void:
	_measure_render = on
	RenderingServer.viewport_set_measure_render_time(_vp, on)


# ───────────────────────────── measure ─────────────────────────────

func _probe_result(p: Dictionary, seconds: float) -> Dictionary:
	if p.frames == 0:
		return {"error": "No frames were drawn: the game was paused or in the background."}
	var s: Sketch = p.sketch
	var r: Sketch = p.render
	var g: Sketch = p.gpu
	var pr: Sketch = p.process
	var now := _sample_engine()
	var before: Dictionary = p.engine
	var delta := {}
	for k: String in ["objects", "nodes", "orphan_nodes", "resources", "video_mb", "static_mb"]:
		delta[k] = _round(now[k] - before[k], 0.1) if now[k] != null and before[k] != null else null
	var new_errors: Array[Dictionary] = []
	for fp: String in _error_log:
		var e: Dictionary = _error_log[fp]
		var was: int = p.fingerprints[fp].count if p.fingerprints.has(fp) else 0
		if e.count > was:
			new_errors.append({"message": e.message, "kind": e.kind, "location": e.location, "count": e.count - was})
	var render_p50: float = r.quantile(0.5) if r.n > 0 else 0.0
	return {
		"seconds": seconds,
		"level_start": p.level,
		"level_end": level,
		"frames": p.frames,
		"fps": snappedf(p.frames / seconds, 0.1),
		"frame_budget_ms": snappedf(_budget_ms, 0.01),
		"refresh_hz": Device.refresh_rate(),
		"frame_ms": {"p50": _round(s.quantile(0.5), 0.01), "p95": _round(s.quantile(0.95), 0.01), "p99": _round(s.quantile(0.99), 0.01), "worst": snappedf(p.max, 0.1)},
		"pct_frames_over_budget": snappedf(s.fraction_above(_budget_ms * 1.15) * 100.0, 0.1),
		# CPU time the renderer spent on each frame: it rises with scene cost even while vsync hides it in frame time.
		"render_cpu_ms": {"p50": _round(r.quantile(0.5), 0.01), "p95": _round(r.quantile(0.95), 0.01), "share_of_budget_pct": roundi(render_p50 / _budget_ms * 100.0)} if _measure_render else null,
		"gpu_ms": {"p50": _round(g.quantile(0.5), 0.01), "p95": _round(g.quantile(0.95), 0.01)} if g.n > 0 else null,
		# All the game's _process code in a frame.
		"process_ms": {"p50": _round(pr.quantile(0.5), 0.01), "p95": _round(pr.quantile(0.95), 0.01)},
		"hitches": p.hitches.slice(0, 10),
		"hitch_count": p.hitches.size(),
		"draw_calls": {"avg": roundi(float(p.calls) / p.frames), "max": p.calls_max},
		"triangles_avg": roundi(float(p.tris) / p.frames),
		"peak_context": p.ctx_max,
		"memory": now,
		"memory_delta": delta,
		"new_errors": stats.errors - p.errors,
		"errors": new_errors.slice(0, 5),
		"renderer": RenderingServer.get_current_rendering_method(),
		"headless": DisplayServer.get_name() == "headless",
		"sdk": SDK,
	}


func _run_measure_flag(seconds: float, warmup: float, out_path: String) -> void:
	if warmup > 0.0:
		await get_tree().create_timer(warmup, true, false, true).timeout
	var result := await measure(seconds if seconds > 0.0 else 5.0)
	var line := JSON.stringify({"glitchless_measure": result})
	print(line)
	if out_path != "":
		var f := FileAccess.open(out_path, FileAccess.WRITE)
		if f:
			f.store_string(line + "\n")
			f.close()
	_shutdown("measure")
	get_tree().quit()


# ───────────────────────────── errors ─────────────────────────────

func _report_error(entry: Dictionary) -> void:
	var frames: Array = entry.frames
	if not frames.is_empty() and str(frames[0].file).begins_with(ADDON_DIR) and entry.get("kind") != "manual":
		return  # raised inside Glitchless (a failed send, say): never report it, or it could feed itself
	var kind := _kind_of(entry)
	var message: String = entry.rationale if entry.rationale != "" else entry.code
	message = _scrub(message).strip_edges().substr(0, 500)
	if message == "":
		message = "Unknown error"
	var top: Dictionary = frames[0] if not frames.is_empty() else {}
	var fn: String = top.fn if not top.is_empty() else entry.function
	var file: String = top.file if not top.is_empty() else entry.file
	var line: int = top.line if not top.is_empty() else entry.line
	var fingerprint := _fingerprint(kind, message, fn)
	var count: int = _error_counts.get(fingerprint, 0) + 1
	_error_counts[fingerprint] = count
	stats.errors += 1
	var recent := _recent_names(6)
	_remember("error:" + message.substr(0, 40))
	var location := "%s (%s:%d)" % [fn, file.get_file(), line] if file != "" else ""
	if _error_log.has(fingerprint):
		_error_log[fingerprint].count = count
	else:
		_error_log[fingerprint] = {"message": message, "kind": kind, "location": location, "count": count}
	if count > MAX_ERRORS_PER_FINGERPRINT:
		return
	_push({
		"type": "error",
		"kind": kind,
		"message": message,
		"stack": _scrub(_stack_text(kind, message, entry, frames)),
		"source": file.get_file() if file != "" else null,
		"line": line if file != "" else null,
		"col": null,
		"fn": fn if fn != "" else null,
		"fingerprint": fingerprint,
		"attrs": entry.get("attrs") if entry.get("attrs") else null,
		"recent": recent,
	})


# script: a GDScript runtime error, which stops the function part way (the
# browser's uncaught exception). engine: an error from the engine's own code,
# often a bad call from a script. push_error and push_warning are the game's own.
# Error text can hold paths on the device, and a path can hold the computer's
# user name or, on iPhone, an ID made for this install of the app. Both go.
func _scrub(text: String) -> String:
	var user_dir := OS.get_user_data_dir()
	var out := text.replace(user_dir + "/", "user://").replace(user_dir, "user://")
	for rule: Array in _scrubbers:
		out = (rule[0] as RegEx).sub(out, rule[1], true)
	return out


func _kind_of(entry: Dictionary) -> String:
	if entry.has("kind"):
		return entry.kind
	if entry.function == "push_error":
		return "push_error"
	match int(entry.type):
		Logger.ERROR_TYPE_SCRIPT:
			return "script"
		Logger.ERROR_TYPE_SHADER:
			return "shader"
		Logger.ERROR_TYPE_WARNING:
			return "warning"
	return "engine"


func _stack_text(kind: String, message: String, entry: Dictionary, frames: Array) -> String:
	var lines: Array[String] = ["%s: %s" % [kind, message]]
	if (kind == "engine" or kind == "shader" or frames.is_empty()) and entry.file != "":
		lines.append("    at %s (%s:%d)" % [entry.function, entry.file, entry.line])
	for f: Dictionary in frames.slice(0, 20):
		lines.append("    at %s (%s:%d)" % [f.fn, f.file, f.line])
	return "\n".join(lines).substr(0, 4000)


## The browser SDK's error grouping key (packages/sdk/src/fingerprint.js): the
## kind, the message with long numbers and addresses blanked out, and the
## function it came from, hashed with 32-bit FNV-1a.
static func _fingerprint(kind: String, message: String, fn: String) -> String:
	var s := "%s|%s|%s" % [kind, _normalize_message(message), fn]
	var h := 0x811c9dc5
	for i in s.length():
		h = h ^ s.unicode_at(i)
		h = (h * 0x01000193) & 0xFFFFFFFF
	return "%08x" % h


static func _normalize_message(msg: String) -> String:
	var out := RegEx.create_from_string("^Uncaught\\s+").sub(msg, "")
	out = RegEx.create_from_string("\\d{3,}").sub(out, "N", true)
	out = RegEx.create_from_string("0x[0-9a-fA-F]+").sub(out, "X", true)
	return out.substr(0, 200)


# ───────────────────────────── lifecycle and input ─────────────────────────────

func _notification(what: int) -> void:
	match what:
		NOTIFICATION_APPLICATION_PAUSED:
			_on_background()
		NOTIFICATION_APPLICATION_RESUMED:
			_on_foreground()
		# Control Center, Notification Center, Siri and calls on iOS, and the notification shade on
		# Android, take focus without sending the game to the background, and nothing is drawn until
		# focus comes back. That gap is not a frame, so the frame clock starts again on both sides,
		# as it does for the background. (On desktop it costs one frame per focus change.)
		NOTIFICATION_APPLICATION_FOCUS_OUT:
			_last_us = 0
			_pending_long = {}
			if _inited:
				flush()
		NOTIFICATION_APPLICATION_FOCUS_IN:
			_last_us = 0
		NOTIFICATION_WM_CLOSE_REQUEST:
			if get_tree().auto_accept_quit:
				_shutdown("close")
			elif _inited:
				flush()  # the game decides whether to quit; _exit_tree sends the end
		NOTIFICATION_WM_GO_BACK_REQUEST:
			if get_tree().quit_on_go_back:
				_shutdown("close")


# A phone app in the background is usually never seen again: iOS and Android
# stop it without warning. So going to the background ends the session, and the
# last batch goes out now, while the OS still allows it.
func _on_background() -> void:
	_paused_at = Time.get_ticks_msec()
	_last_us = 0
	_pending_long = {}
	if _inited and enabled and not _ended:
		_ended = true
		_push({"type": "session_end", "reason": "background", "duration_s": snappedf((_now() - _started_at) / 1000.0, 0.1)})
	if _inited and enabled:
		flush()
		_send_now(SEND_DEADLINE_MS)


func _on_foreground() -> void:
	_last_us = 0
	if not _ended:
		return
	_ended = false
	var away := (Time.get_ticks_msec() - _paused_at) / 1000.0
	if away > float(_opts.session_timeout):
		_new_session()
	else:
		track("app_resume", {"away_s": snappedf(away, 0.1)})


# Back after a long time away: a new session with a new random ID. In
# anonymous mode nothing joins it to the last one.
func _new_session() -> void:
	flush()
	session_id = _new_id("s_", 16)
	_started_at = _now()
	_session_start_sent = false
	_recent.clear()
	_history.clear()
	_error_counts.clear()


func _shutdown(reason: String) -> void:
	if _shut:
		return
	_shut = true
	if _inited and enabled and not _ended:
		_ended = true
		_push({"type": "session_end", "reason": reason, "duration_s": snappedf((_now() - _started_at) / 1000.0, 0.1)})
	if _inited and enabled:
		flush()
		_send_now(SEND_DEADLINE_MS)


func _input(event: InputEvent) -> void:
	if not event.is_pressed() or event.is_echo():
		return
	if _bug_hotkey != KEY_NONE and event is InputEventKey and ((event as InputEventKey).physical_keycode == _bug_hotkey or (event as InputEventKey).keycode == _bug_hotkey):
		_bug_report_form().toggle()
		get_viewport().set_input_as_handled()
		return
	var code := ""
	if event is InputEventKey:
		code = str((event as InputEventKey).physical_keycode)
	elif event is InputEventMouseButton or event is InputEventScreenTouch:
		if event.device != InputEvent.DEVICE_ID_EMULATION:  # a touch also arrives as a pretend mouse click
			code = "pointer"
	elif event is InputEventJoypadButton:
		code = "pad%d" % (event as InputEventJoypadButton).button_index
	if code == "":
		return
	var now := Time.get_ticks_msec()
	if _first_input_ms == 0 and _first_frame_ms > 0:
		_first_input_ms = now
		_push({"type": "load", "ttp_ms": now})
	if not _rage_input:
		return
	var hist: Array = _key_history.get(code, []).filter(func(t: int) -> bool: return now - t < RAGE_INPUT_WINDOW_MS)
	hist.append(now)
	_key_history[code] = hist
	if hist.size() == RAGE_INPUT_COUNT:
		track("rage_input", {"key": code, "count": hist.size()})


# ───────────────────────────── events ─────────────────────────────

func _push(e: Dictionary) -> void:
	if _inited and not enabled:
		return
	if not e.has("ts"):
		e.ts = _now()
	if not e.has("level"):
		e.level = level
	_queue_event(e)
	if e.type != "session_end":
		_history.append(_slim(e))
		if _history.size() > BUG_RECENT:
			_history.pop_front()


func _queue_event(e: Dictionary) -> void:
	_queue.append(e)
	if _queue.size() > MAX_QUEUE:
		_queue = _queue.slice(_queue.size() - MAX_QUEUE)


func _remember(event_name: String) -> void:
	_recent.append({"name": event_name, "t": Time.get_ticks_msec()})
	if _recent.size() > 20:
		_recent.pop_front()


func _recent_within(ms: int) -> Array[String]:
	var cutoff := Time.get_ticks_msec() - ms
	var out: Array[String] = []
	for r in _recent:
		if r.t >= cutoff and not out.has(r.name):
			out.append(r.name)
	return out


func _recent_names(count: int) -> Array[String]:
	var out: Array[String] = []
	for r in _recent.slice(maxi(0, _recent.size() - count)):
		out.append(r.name)
	return out


func _session_start_event() -> Dictionary:
	return {
		"type": "session_start",
		"ts": _started_at,
		"level": null,
		"session_type": _session_type,
		"privacy": _privacy,
		"device": Device.info(_full),
		"page": null,
		"nav_ms": null,
	}


# ───────────────────────────── bug reports ─────────────────────────────

func _bug_report_form() -> BugReport:
	if _bug_form == null:
		_bug_form = BugReport.new(self, _bug_opts)
		add_child(_bug_form)
	return _bug_form


# What the player is looking at and doing right now (SPEC §2 bug_report). The
# screenshot is the last frame drawn: true captures it, an Image is used as
# it is, false leaves it out. `image` is the picture for the form's preview.
func _bug_snapshot(screenshot: Variant) -> Dictionary:
	var image: Image = null
	if screenshot is Image:
		image = screenshot
	elif screenshot is bool and screenshot and DisplayServer.get_name() != "headless":
		var tex := get_tree().root.get_texture()
		image = tex.get_image() if tex else null
	# Reading the picture back stalls this frame, and the form's first frame
	# draws it: that isn't the game stuttering, so neither is timed.
	_untimed = 2
	var snap := {"ts": _now(), "level": level, "image": image, "screenshot": BugReport.fit_screenshot(image)}
	if _positions and _position != null:
		snap.position = [snappedf(_position[0], 0.01), snappedf(_position[1], 0.01), snappedf(_position[2], 0.01)]
	# The last game events and hitches, oldest first.
	var recent: Array[Dictionary] = _history.duplicate()
	var hitches: Array[Dictionary] = _recent_hitches.duplicate()
	for h in _pending_hitches:
		hitches.append(_slim(h))
	for h in hitches:
		if snap.ts - int(h.ts) < 60000:
			recent.append(h)
	recent.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a.ts < b.ts)
	snap.recent = recent.slice(maxi(0, recent.size() - BUG_RECENT))
	# Frame rate and p95 of the last windows, and of the one still open.
	var frames := _recent_windows.duplicate()
	if _win.frames > 0:
		var secs := maxf((Time.get_ticks_msec() - _win.started_ms) / 1000.0, 0.001)
		frames.append({"ts": _win.started_at, "level": level, "fps": snappedf(_win.frames / secs, 0.1), "p95": _round(_win.sketch.quantile(0.95), 0.01)})
	snap.frames = frames.slice(maxi(0, frames.size() - BUG_FRAMES))
	return snap


# Sends one report on a request of its own. It waits in the outbox meanwhile,
# so if the send fails, or the game closes first, it goes with a later batch.
func _send_report(snap: Dictionary, note: String) -> Dictionary:
	var e := {"type": "bug_report", "ts": snap.ts, "level": snap.level, "note": note.substr(0, BugReport.MAX_NOTE)}
	if snap.screenshot != "":
		e.screenshot = snap.screenshot
	if snap.has("position"):
		e.x = snap.position[0]
		e.y = snap.position[1]
		e.z = snap.position[2]
	e.recent = snap.recent
	e.frames = snap.frames
	e.device = Device.info(_full)
	_remember("bug_report")
	if not _inited or not enabled:
		return {"sent": false, "reason": "offline"}
	flush()  # the session's own events first, so the report's session is there when someone opens it
	var b := _batch([e])
	b.direct = true
	_outbox.append(b)
	_save_outbox()
	var http := HTTPRequest.new()
	http.timeout = 20.0
	add_child(http)
	var code := 0
	if http.request(_intake_url(), ["Content-Type: application/json"], HTTPClient.METHOD_POST, _body(b)) == OK:
		var r: Array = await http.request_completed
		code = r[1] if r[0] == HTTPRequest.RESULT_SUCCESS else 0
	http.queue_free()
	b.erase("direct")
	var sent := code >= 200 and code < 300
	if sent or (code >= 400 and code < 500 and code != 408 and code != 429):  # a rejected report would only be rejected again
		var i := _outbox_index(b.id)
		if i >= 0:
			_outbox.remove_at(i)
		_save_outbox()
	if sent:
		stats.sent += 1
		return {"sent": true}
	stats.failed += 1
	_log("bug report not sent (HTTP %d): it goes with the next batch" % code)
	return {"sent": false, "reason": "error"}


# A game event as a bug report lists it: when, what, and the few fields that say what happened.
static func _slim(e: Dictionary) -> Dictionary:
	var out := {"ts": e.ts, "type": e.type, "level": e.get("level")}
	for k: String in ["name", "cause", "kind", "reason", "duration_s", "score", "duration_ms", "causes", "x", "y", "z"]:
		if e.get(k) != null:
			out[k] = e[k]
	if e.get("message") != null:
		out.message = str(e.message).substr(0, 200)
	var attrs: Variant = e.get("attrs")
	if attrs is Dictionary and not attrs.is_empty() and JSON.stringify(attrs).length() <= 300:
		out.attrs = attrs
	return out


# A hotkey from options: a Key (KEY_F8), its name ("F8"), or null for none.
static func _keycode(v: Variant) -> Key:
	if v is int:
		return v as Key
	if v is String and v != "":
		return OS.find_keycode_from_string(v)
	return KEY_NONE


# ───────────────────────────── sending ─────────────────────────────

func _add_batches(events: Array[Dictionary]) -> void:
	var chunk: Array[Dictionary] = []
	var size := 0
	for e in events:
		var bytes := JSON.stringify(e).length()
		if not chunk.is_empty() and size + bytes > BATCH_BYTES * 0.9:
			_outbox.append(_batch(chunk))
			chunk = []
			size = 0
		chunk.append(e)
		size += bytes
	if not chunk.is_empty():
		_outbox.append(_batch(chunk))
	var total := 0
	for b in _outbox:
		total += b.events.size()
	while total > MAX_OUTBOX_EVENTS and _outbox.size() > 1 and _outbox[0].id != _in_flight:
		total -= _outbox[0].events.size()
		_outbox.pop_front()


func _batch(events: Array[Dictionary]) -> Dictionary:
	var b := {
		"id": _next_batch_id, "service": _service, "env": _env, "version": _version,
		"sid": session_id, "pid": player_id, "group": _started_at, "events": events,
	}
	_next_batch_id += 1
	return b


func _body(b: Dictionary) -> String:
	return JSON.stringify({
		"service": b.service,
		"env": b.env,
		"version": b.version,
		"session_id": b.sid,
		"player_id": b.pid if b.pid != "" else null,  # the server uses the session ID in its place
		"sdk": SDK,
		"events": b.events,
	})


func _intake_url() -> String:
	return "%s/v1/intake?token=%s" % [_intake, str(_opts.client_token).uri_encode()]


func _send_next() -> void:
	if _in_flight >= 0 or _outbox.is_empty() or Time.get_ticks_msec() < _retry_at:
		return
	var b: Dictionary = {}
	for x: Dictionary in _outbox:
		if not x.get("direct", false):  # a bug report on its own request
			b = x
			break
	if b.is_empty():
		return
	var body := _body(b)
	if _debug:
		print("[glitchless] sending %d events (%d bytes)" % [b.events.size(), body.length()])
	var err := _http.request(_intake_url(), ["Content-Type: application/json"], HTTPClient.METHOD_POST, body)
	if err == OK:
		_in_flight = b.id
	else:
		_retry_later("request failed (%s)" % error_string(err))


func _on_sent(result: int, code: int, _headers: PackedStringArray, _body_bytes: PackedByteArray) -> void:
	var id := _in_flight
	_in_flight = -1
	var i := _outbox_index(id)
	var n: int = _outbox[i].events.size() if i >= 0 else 0
	if result == HTTPRequest.RESULT_SUCCESS and code >= 200 and code < 300:
		stats.sent += n
		stats.last_status = "ok"
		_backoff = 0.0
	elif result == HTTPRequest.RESULT_SUCCESS and code >= 400 and code < 500 and code != 408 and code != 429:
		stats.failed += n  # the server turned it away; sending it again would only fail again
		stats.last_status = "rejected %d" % code
	else:
		stats.failed += n
		_retry_later("HTTP %d, result %d" % [code, result])
		return
	if i >= 0:
		_outbox.remove_at(i)
	_save_outbox()
	_send_next()


func _retry_later(why: String) -> void:
	stats.last_status = "error"
	_backoff = clampf(_backoff * 2.0, 5.0, 300.0)
	_retry_at = Time.get_ticks_msec() + int(_backoff * 1000.0)
	_log("send failed: %s; trying again in %ds" % [why, int(_backoff)])


func _outbox_index(id: int) -> int:
	for i in _outbox.size():
		if _outbox[i].id == id:
			return i
	return -1


# Sends what is waiting before the game closes or goes to the background,
# blocking for at most budget_ms. HTTPRequest cannot: it needs frames, and
# there are no more. Whatever is not sent stays saved for the next launch.
func _send_now(budget_ms: int) -> void:
	if _outbox.is_empty() or not sampled or OS.has_feature("web"):
		return
	if _in_flight >= 0:
		_http.cancel_request()  # it needs frames to finish; send it here instead
		_in_flight = -1
	var deadline := Time.get_ticks_msec() + budget_ms
	var url := _parse_url(_intake)
	if url.is_empty():
		return
	var client := HTTPClient.new()
	if client.connect_to_host(url.host, url.port, TLSOptions.client() if url.tls else null) != OK:
		return
	while client.get_status() in [HTTPClient.STATUS_RESOLVING, HTTPClient.STATUS_CONNECTING]:
		if Time.get_ticks_msec() > deadline:
			return
		client.poll()
		OS.delay_msec(2)
	var path: String = url.path + "/v1/intake?token=" + str(_opts.client_token).uri_encode()
	for b: Dictionary in _outbox.duplicate():
		if client.get_status() != HTTPClient.STATUS_CONNECTED:
			break
		if client.request(HTTPClient.METHOD_POST, path, ["Content-Type: application/json"], _body(b)) != OK:
			break
		while client.get_status() == HTTPClient.STATUS_REQUESTING and Time.get_ticks_msec() < deadline:
			client.poll()
			OS.delay_msec(2)
		if not client.has_response():
			break
		var code := client.get_response_code()
		while client.get_status() == HTTPClient.STATUS_BODY and Time.get_ticks_msec() < deadline:
			client.poll()
			client.read_response_body_chunk()
		if code >= 200 and code < 300:
			stats.sent += b.events.size()
		elif code < 400 or code >= 500 or code == 408 or code == 429:
			break
		var i := _outbox_index(b.id)
		if i >= 0:
			_outbox.remove_at(i)
		if Time.get_ticks_msec() > deadline:
			break
	client.close()
	_save_outbox()


static func _parse_url(url: String) -> Dictionary:
	var tls := url.begins_with("https://")
	var rest := url.trim_prefix("https://").trim_prefix("http://")
	var slash := rest.find("/")
	var host_port := rest if slash < 0 else rest.substr(0, slash)
	var path := "" if slash < 0 else rest.substr(slash).trim_suffix("/")
	var host := host_port
	var port := 443 if tls else 80
	var colon := host_port.rfind(":")
	if colon > 0 and not host_port.ends_with("]"):
		host = host_port.substr(0, colon)
		port = int(host_port.substr(colon + 1))
	if host == "":
		return {}
	return {"tls": tls, "host": host, "port": port, "path": path}


# ───────────────────────────── saved batches ─────────────────────────────

# Batches that have not been sent are saved, so a game played offline is sent
# when the network is back. In anonymous mode they are saved without the
# session ID; on the next launch each earlier session's batches go under a new
# random ID, so nothing written to the device ties two sessions together.
# Install and full mode keep a stored ID anyway, so they save both IDs.
func _save_outbox() -> void:
	if not enabled:
		return
	var out: Array[Dictionary] = []
	for b in _outbox:
		var saved := {"service": b.service, "env": b.env, "version": b.version, "group": b.group, "events": b.events}
		if _privacy != "anonymous":
			saved.sid = b.sid
			saved.pid = b.pid
		out.append(saved)
	if out.is_empty():
		if FileAccess.file_exists(OUTBOX_PATH):
			DirAccess.remove_absolute(OUTBOX_PATH)
		return
	var tmp := OUTBOX_PATH + ".tmp"
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return
	f.store_string(JSON.stringify({"v": 1, "batches": out}))
	f.close()
	DirAccess.rename_absolute(tmp, OUTBOX_PATH)


func _load_outbox() -> void:
	if not FileAccess.file_exists(OUTBOX_PATH):
		return
	var data: Variant = JSON.parse_string(FileAccess.get_file_as_string(OUTBOX_PATH))
	if not data is Dictionary or not data.get("batches") is Array:
		return
	var oldest := _now() - MAX_OUTBOX_AGE_MS
	var fresh_ids := {}
	for saved: Variant in data.batches:
		if not saved is Dictionary or not saved.get("events") is Array:
			continue
		var events: Array[Dictionary] = []
		for e: Variant in saved.events:
			if e is Dictionary and e.has("ts") and float(e.ts) >= oldest:
				e.ts = int(e.ts)  # JSON hands numbers back as floats
				events.append(e)
		if events.is_empty():
			continue
		var group := str(saved.get("group", ""))
		var sid := str(saved.get("sid", ""))
		if sid == "":
			if not fresh_ids.has(group):
				fresh_ids[group] = _new_id("s_", 16)
			sid = fresh_ids[group]
		var b := {
			"id": _next_batch_id, "service": str(saved.get("service", _service)), "env": str(saved.get("env", _env)),
			"version": str(saved.get("version", _version)), "sid": sid, "pid": str(saved.get("pid", "")) if _privacy != "anonymous" else "",
			"group": group, "events": events,
		}
		_next_batch_id += 1
		_outbox.append(b)
	_log("%d saved batches from earlier launches" % _outbox.size())


func _load_player_id() -> String:
	if FileAccess.file_exists(PLAYER_PATH):
		var saved := FileAccess.get_file_as_string(PLAYER_PATH).strip_edges()
		if saved.begins_with("p_"):
			return saved
	var id := _new_id("p_", 12)
	var f := FileAccess.open(PLAYER_PATH, FileAccess.WRITE)
	if f:
		f.store_string(id)
		f.close()
	return id


# ───────────────────────────── helpers ─────────────────────────────

func _log(msg: String) -> void:
	if _debug:
		print("[glitchless] ", msg)


func _has_flag(flag: String) -> bool:
	for a in _args():
		if a == flag or a.begins_with(flag + "="):
			return true
	return false


func _flag_value(flag: String, fallback: String = "") -> String:
	for a in _args():
		if a.begins_with(flag + "="):
			return a.substr(flag.length() + 1)
	return fallback


func _args() -> PackedStringArray:
	return OS.get_cmdline_user_args() + OS.get_cmdline_args()


static func _now() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)


static func _new_id(prefix: String, length: int) -> String:
	var bytes := Crypto.new().generate_random_bytes(length)
	var out := prefix
	for b in bytes:
		out += ID_CHARS[b % ID_CHARS.length()]
	return out


static func _median(values: Array[float]) -> float:
	var sorted := values.duplicate()
	sorted.sort()
	return sorted[sorted.size() / 2] if not sorted.is_empty() else 0.0


static func _round(v: Variant, step: float) -> Variant:
	return snappedf(float(v), step) if v != null else null

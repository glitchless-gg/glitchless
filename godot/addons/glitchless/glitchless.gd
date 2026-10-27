extends Node
## Autoload "Glitchless": frame times, hitches, errors and play events for a
## Glitchless server, in the shape the browser SDK (packages/sdk/src/core.js)
## sends them, so the dashboard, findings, Datadog forwarding and the MCP tools
## take a Godot game as they are. Needs Godot 4.5 or later, for the error logger.
##
##   Glitchless.init("starlift", "1.4.0", "prod", "https://glitchless.example.com")
##   Glitchless.level_start("voyage_3")
##   Glitchless.level_abandon()  # the player went home or restarted mid-level: not a fail
##   Glitchless.track("play", "endless")
##   Glitchless.death(pos.x, pos.y, "meteor")
##   Glitchless.set_context({"blocks": blocks.size()})
##   Glitchless.report_bug(note)  # or bug_reports in init options: F8 opens a form
##   Glitchless.count("kill", {"monster": "elite"})  # a stream of events: counted, sent once a window
##   Glitchless.set_properties({"mode": "squads", "rank": "gold"})  # what holds for this session
##   Glitchless.set_group("match", match_id)  # every event until set_group("match", null) carries it
##   Glitchless.set_zone("ashen_wastes")  # where the player is in an open world
##   Glitchless.set_enabled(share_on)  # the player's "Share performance data" setting
##
## Multiplayer games built on Godot's MultiplayerAPI (ENet, or WebSocket in a
## web export) also send ping, packet loss and disconnects. A dedicated server
## (a dedicated-server export, or --server) reports as the game's server, with
## its tick time and players, and never as a player's session.
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
## A player can turn it all off from the game's settings (set_enabled, SPEC
## §4d): nothing more is measured or sent, and what was waiting is dropped. The
## choice is saved in user://glitchless/enabled and read before the first frame
## of every later launch.
##
## Flags (after "--" on the command line):
##   --glitchless                  send from a debug build too
##   --glitchless-intake=URL       send to this server instead (and turn sending on)
##   --glitchless-measure=SECONDS  print frame stats as one line of JSON and quit
##   --glitchless-warmup=SECONDS   with --glitchless-measure: wait this long before measuring
##   --glitchless-out=PATH         with --glitchless-measure: write the JSON to this file too
##   --glitchless-synthetic        mark the session as a bot's (--autoplay does too)
##   --glitchless-server           report as the game's dedicated server (--server does too)
##   --glitchless-debug            print each batch as it is sent

const SDK_VERSION := "0.6.0"
const SDK := "glitchless-godot/" + SDK_VERSION

const Sketch := preload("sketch.gd")
const ErrorLogger := preload("logger.gd")
const Device := preload("device.gd")
const SteamInfo := preload("steam.gd")
const BugReport := preload("bug_report.gd")
const Properties := preload("properties.gd")
const NetInfo := preload("net.gd")

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
const RATES: Array[int] = [30, 60, 75, 90, 100, 120, 144, 165, 240]
const BUG_RECENT := 20  # game events and hitches a bug report carries
const BUG_FRAMES := 6  # frame windows a bug report carries
const ADDON_DIR := "res://addons/glitchless/"
const SAVE_DIR := "user://glitchless"
const OUTBOX_PATH := "user://glitchless/outbox.json"
const PLAYER_PATH := "user://glitchless/player_id"  # install and full mode
const LAUNCHED_PATH := "user://glitchless/launched"  # the game version that last ran here (first_launch)
const SERVER_OUTBOX_PATH := "user://glitchless/server_outbox.json"  # a dedicated server's, apart from a player build's
const ENABLED_PATH := "user://glitchless/enabled"  # "on" or "off": the player's choice (set_enabled), once the game has asked
const ID_CHARS := "abcdefghijklmnopqrstuvwxyz0123456789"
const MAX_COUNTS := 64  # count() entries a window
const MAX_COUNT_GROUP := 4  # words and booleans that split a counter
const MAX_COUNT_SUMS := 4  # numbers a counter adds up
const MAX_COUNT_N := 1000000
const STREAM_PER_S := 20  # a name tracked more often than this a second is a stream: count() it
const GROUP_KINDS: Array[String] = ["match", "party", "run"]
const NET_ALPHA := 0.05  # the round-trip sketch's accuracy (frame times use 2%)
const NET_SAMPLE_MS := 1000
const MAX_DISCONNECTS := 20  # disconnect events a session
const RECONNECT_S := 300.0  # connecting again within this long after a disconnect is a reconnect
const DISCONNECT_REASONS: Array[String] = ["timeout", "connection_lost", "kicked", "server_closed", "failed_to_connect", "other"]
const SERVER_SESSION_MS := 6 * 3600 * 1000  # a server session is cut every 6 hours
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
	"session_type": "",  # "user", "tester" or "synthetic"; "": synthetic with --autoplay, tester on TestFlight
	"session_timeout": 300.0,  # seconds in the background after which coming back is a new session
	"capture_warnings": false,
	"engine_gauges": true,  # node and object counts in ctx, where the findings look for leaks
	"measure_render_time": true,
	"rage_input": null,  # null: on except on phones, where fast tapping is normal play
	"enabled": null,  # null: off in debug builds unless --glitchless. The build's switch: the player's is set_enabled()
	"opt_in": false,  # true: off on a device until set_enabled(true), for a game that asks the player first (not a server: no player to ask)
	"debug": false,
	# true, or {"hotkey": KEY_F8, "pause": true, "screenshot": true}: players send bug reports from a form in the game
	"bug_reports": false,
	"properties": {},  # what holds for this session, in the game's words ({"mode": "squads"}): set_properties
	"hash_group_ids": true,  # match and party IDs go hashed with the service; false sends them as the game made them
	"network": true,  # ping, packet loss and disconnects from Godot's MultiplayerAPI (ENet, WebSocket)
	# "server" for a dedicated server, "player" for a game's own --server flag that means something else;
	# "": a dedicated-server export, --glitchless-server or --server is a server
	"role": "",
	"region": "",  # server mode: where this server runs, in the game's words ("eu-west")
	"max_players": 0,  # server mode: the most players it takes
	"session_per_match": false,  # server mode: a session per match, for a server that hosts one at a time
}

## The bug report form opened or closed. The game is paused meanwhile unless
## bug_reports has "pause": false; then pause and resume the game here.
signal bug_report_opened
signal bug_report_closed

var session_id := ""
var player_id := ""  ## stays empty in anonymous mode
## Whether anything is sent: init() decides whether this build sends, and it is
## false while the player has Glitchless off (set_enabled). is_enabled() reads it.
var enabled := false
var sampled := true
var level: Variant = null
var zone: Variant = null  ## where the player is in an open world: set_zone()
var role := "player"  ## "server" on a dedicated server; decided by init()
var stats := {"sent": 0, "failed": 0, "errors": 0, "hitches": 0, "deaths": 0, "last_status": "idle"}

var _opts := DEFAULTS.duplicate()
var _inited := false
var _build_sends := false  # init()'s decision: the enabled option, a debug build only with --glitchless, an intake
var _choice := ""  # what user://glitchless/enabled holds: "on", "off", or "" before the game has called set_enabled
var _player_off := false  # the player turned Glitchless off (or opt_in, with no choice yet): nothing is measured or kept
var _epoch := 0  # times Glitchless was turned off: an answer to a request sent before the last one is ignored
var _service := "unknown-game"
var _version := "0.0.0"
var _version_given := false
var _steam := {}  # the game's GodotSteam facts (steam.gd), read once Steam answers
var _env := "dev"
var _intake := ""
var _privacy := "anonymous"
var _full := false
var _positions := false
var _session_type := "user"
var _sandbox := false  # a TestFlight or development install on iOS: its purchases are Apple's free sandbox ones
var _rage_input := false
var _engine_gauges := true
var _measure_render := true
var _debug := false

var _started_at := 0  # unix ms of this session's start
var _level_started := 0  # ticks ms
var _level_open := false  # a level started and not yet completed, failed or abandoned
var _left_level: Variant = null  # the level abandoned for the game as the session ended
var _off_level: Variant = null  # the level going when the player turned Glitchless back on: its start isn't in this session
var _ctx := {}
var _recent: Array[Dictionary] = []  # the last game events, for breadcrumbs: {name, t}
var _queue: Array[Dictionary] = []
var _outbox: Array[Dictionary] = []  # batches: {id, bid, service, env, version, sid, pid, group, events}
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
var _rate_frames: Array[float] = []  # frame times under 100 ms, for the refresh rate
var _recent_median := 0.0
var _frame_id := 0
var _last_us := 0
var _untimed := 0  # frames not to time (taking a bug report's screenshot)
var _pending_long := {}
var _throttled := false
var _first_frame_ms := 0  # ticks: from engine start
var _first_frame_at := 0  # unix ms
var _first_launch: Variant = null  # the first launch of this version on this device (load event)
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
var _warned := {}  # what has been warned about, once each
var _stream := {}  # track() name -> [second, calls in it], debug builds only
var _features: Variant = null  # what the server takes, from GET /v1/health; null until it answers
var _asking_features := false
var _props := {}  # the session's properties, checked (properties.gd)
var _props_sent := {}  # what the server has: session_start's props and every props event since
var _groups := {}  # kind -> the ID every event carries
var _early_groups: Array = []  # set_group calls before init(): the service salts the hash
var _players_set := -1  # set_players(); -1: from the MultiplayerAPI

# The network (net.gd), sampled once a second while connected.
var _mp: MultiplayerAPI  # the one whose signals are connected
var _next_net := 0
var _net_up := false
var _net_up_at := 0  # ticks ms the connection to the server came up
var _net_down_at := 0  # ticks ms of the first disconnect not yet followed by a reconnect
var _net_goodbye := false  # data came with the server's drop: it closed the connection, it didn't time out
var _net_transport := ""
var _net_ws: Object  # a WebSocket client's peer, for its close code
var _net_dead_peer := 0  # the peer a disconnect was recorded for, while it still says connected
var _net_server_left := false  # peer_disconnected(1) came: the server went, the game didn't leave
var _net_pending: Variant = null  # a disconnect the signals saw, recorded at the end of the frame
var _net_disconnects := 0
var _net_left_level: Variant = null  # the level abandoned for a disconnect
var _net_last := {}  # the last window's rtt_p95 and loss_pct, for a disconnect

# A dedicated server's ticks: from Glitchless's first _physics_process to the
# next one, or to the frame's _process, so the physics step is in it too.
var _tick_at := 0
var _cpu_s := -1.0

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


# The player's choice comes first (SPEC §4d), before a frame is timed: a player
# who turned Glitchless off has nothing measured or kept from the first frame,
# and an earlier launch's outbox is deleted unread.
func _init() -> void:
	_choice = _saved_choice()
	if _choice == "off":
		_player_off = true
		_stop()


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
## version defaults to the Steam build ("steam-18231") when the game runs one
## from Steam with GodotSteam, else application/config/version. options: see DEFAULTS.
func init(service: String, version: String = "", env: String = "prod", intake: String = "", options: Dictionary = {}) -> void:
	if _inited:
		return
	_inited = true
	_opts.merge(options, true)
	_service = service.to_lower() if service != "" else "unknown-game"
	_version_given = version != ""
	_version = version if version != "" else str(ProjectSettings.get_setting("application/config/version", ""))
	if _version == "":
		_version = "0.0.0"
	_steam_facts()  # GodotSteam may be initialised only later: session_start asks again
	_env = env if env != "" else "prod"
	var flag_intake := _flag_value("--glitchless-intake")
	_intake = (flag_intake if flag_intake != "" else intake).trim_suffix("/")
	role = _decide_role()
	# A server sends nothing about players: no player ID, no positions, no device detail.
	_privacy = str(_opts.privacy) if str(_opts.privacy) in ["install", "full"] and role != "server" else "anonymous"
	_full = _privacy == "full"
	_positions = (_full if _opts.positions == null else bool(_opts.positions)) and role != "server"
	_rage_input = (not OS.has_feature("mobile") if _opts.rage_input == null else bool(_opts.rage_input)) and role != "server"
	_engine_gauges = bool(_opts.engine_gauges)
	_debug = _debug or bool(_opts.debug)
	_logger.capture_warnings = bool(_opts.capture_warnings)
	_set_measure_render(bool(_opts.measure_render_time))
	_sandbox = Device.is_sandbox(Device.distribution())
	if str(_opts.session_type) != "":
		_session_type = str(_opts.session_type)
	elif _has_flag("--autoplay") or _has_flag("--glitchless-synthetic") or _has_flag("--glitchless-measure") or Device.store_test_device():
		_session_type = "synthetic"  # a bot, a measure run (or a server's load test), or Google Play's pre-launch test phones
	elif DisplayServer.get_name() == "headless" and role != "server":
		_session_type = "synthetic"  # a bot without a screen; a dedicated server runs headless and is live
	elif _sandbox and role != "server":
		_session_type = "tester"  # a person on a TestFlight or development build, not a player from the App Store
	if _opts.enabled != null:
		_build_sends = bool(_opts.enabled)
	else:
		_build_sends = not OS.is_debug_build() or _has_flag("--glitchless") or flag_intake != ""
	_build_sends = _build_sends and _intake != ""
	if _choice == "" and bool(_opts.opt_in) and role != "server":
		_player_off = true  # the game asks the player first: off until set_enabled(true). A server has no player to ask
	if _player_off:
		_stop()  # what was kept before init() goes, and this role's outbox on the device goes unread
	enabled = _build_sends and not _player_off
	sampled = randf() < float(_opts.sample_rate)
	var bug: Variant = _opts.bug_reports
	if role != "server" and (bug is Dictionary or (bug is bool and bug)):
		_bug_opts = {"hotkey": KEY_F8, "pause": true, "screenshot": true}
		if bug is Dictionary:
			_bug_opts.merge(bug, true)
		_bug_hotkey = _keycode(_bug_opts.hotkey)
	session_id = _new_id("s_", 16)  # held in memory only; anonymous mode never writes it down
	# The first batch goes soon, so a session that crashes early is still seen.
	_next_flush = Time.get_ticks_msec() + int(minf(2.0, float(_opts.flush_interval)) * 1000.0)
	if _opts.properties is Dictionary:
		set_properties(_opts.properties)
	for g: Array in _early_groups:
		if g[3]:
			_apply_group(g[0], g[1], g[2], false)  # a run made before init()
		else:
			set_group(g[0], g[1], g[2])
	_early_groups.clear()
	if not enabled:
		_queue.clear()
		_log("off (the player turned it off)" if _player_off and _build_sends else "off (debug build without --glitchless, or no intake)")
		return
	if role == "server":
		# Frames timed before init() are a player's numbers: a server sends its ticks instead.
		_queue = _queue.filter(func(e: Dictionary) -> bool: return not e.type in ["frame_window", "hitch", "pos", "load"])
	_start_sending()


# What init() does once this build sends and the player hasn't turned it off,
# and set_enabled(true) does when they turn it back on later in the launch.
func _start_sending() -> void:
	DirAccess.make_dir_recursive_absolute(SAVE_DIR)
	if role != "server":
		_first_launch = _note_launch()
		if _privacy != "anonymous":
			player_id = _load_player_id()  # install and full mode share it (SPEC §4b)
		elif FileAccess.file_exists(PLAYER_PATH):
			DirAccess.remove_absolute(PLAYER_PATH)  # left by an install- or full-mode build: anonymous mode keeps no ID
	_load_outbox()
	if _features == null:
		_ask_features()
	if bool(_opts.network):
		_watch(get_tree().get_multiplayer())
	_log("on: %s %s %s -> %s (%s, %s, %s%s)" % [_service, _version, _env, _intake, role, _privacy, _session_type, ", " + Device.distribution() if Device.distribution() != "" else ""])


## The player's "Share performance data" setting, from the game's settings
## menu (SPEC §4d). false stops Glitchless at once: nothing more is measured or
## sent, what was waiting is dropped (the outbox on the device too), and the
## session ends without a session_end. true starts a new session in this
## launch. The choice is saved in user://glitchless/enabled and read before the
## first frame of every later launch. Safe before init(). A call that changes
## nothing does nothing, so a game can pass its own saved setting each time it
## starts. It never turns on a build that sends nothing (a debug build without
## --glitchless, no intake, "enabled": false).
func set_enabled(on: bool) -> void:
	var choice := "on" if on else "off"
	if choice != _choice:
		_save_choice(choice)  # first, so it holds even if the game stops right after
	if on != _player_off:
		return  # on while on, off while off
	if on:
		_turn_on()
	else:
		_player_off = true
		_stop()
		_log("off: the player turned it off")


## Whether Glitchless is on: this build sends (init() was given an intake, and
## neither its options nor a debug build turned it off) and the player hasn't
## turned it off. In a build that sends nothing it is false whatever the player
## chose, so a settings menu shows the game's own saved setting.
func is_enabled() -> bool:
	return enabled


# Off: the player said no, or the device starts off (their saved choice, or
# opt_in with none). Everything waiting is dropped: the queue, the open window
# with its counters, positions and network samples, hitches waiting for it,
# what a bug report would carry, the batches waiting to be sent again, and this
# role's outbox on the device, bug reports in it included. The session ends
# without a session_end or a level_abandon: from here on nothing is pushed. A
# request already on its way can't be called back, and its answer is ignored.
func _stop() -> void:
	enabled = false
	_epoch += 1
	if _in_flight >= 0:
		_http.cancel_request()
		_in_flight = -1
	_queue.clear()
	_outbox.clear()
	if FileAccess.file_exists(_outbox_path()):
		DirAccess.remove_absolute(_outbox_path())
	_win = _new_window()
	_pending_hitches.clear()
	_pending_long = {}
	_pos_buffer = []
	_history.clear()
	_recent_hitches.clear()
	_recent_windows.clear()
	# This launch's load isn't sent later: it went already, or it was measured before the player said no.
	_load_sent = true
	if _first_input_ms == 0:
		_first_input_ms = -1
	_set_measure_render(_measure_render)
	if is_bug_report_open():
		_bug_form.close()
	stats.last_status = "off"


# On again after off: measured from the next frame, and after init() a new
# session in this launch, as after a long time in the background (a new ID, its
# own session_start with the properties still set, a group event for each group).
# The level stays current, but the attempt going when the player turned it off
# (or started while it was off) isn't open in the new session: its outcome is
# dropped until the next level_start, so none arrives without its start.
func _turn_on() -> void:
	_player_off = false
	_last_us = 0
	_win = _new_window()
	_set_measure_render(_measure_render)
	_level_open = false
	_left_level = null
	_net_left_level = null
	_off_level = level
	if not _inited:
		return  # init() starts the session
	enabled = _build_sends
	if not enabled:
		return  # the build's own switch holds
	_ended = false
	_start_sending()
	_begin_session()
	_next_flush = Time.get_ticks_msec() + int(minf(2.0, float(_opts.flush_interval)) * 1000.0)
	_log("on again: session %s" % session_id)


static func _saved_choice() -> String:
	if not FileAccess.file_exists(ENABLED_PATH):
		return ""
	var saved := FileAccess.get_file_as_string(ENABLED_PATH).strip_edges()
	return saved if saved == "on" or saved == "off" else ""


# "on" or "off" and nothing else: the same on every device that made the same
# choice, so it ties nothing to anyone. Kept in every privacy mode.
func _save_choice(choice: String) -> void:
	_choice = choice
	DirAccess.make_dir_recursive_absolute(SAVE_DIR)
	var f := FileAccess.open(ENABLED_PATH, FileAccess.WRITE)
	if f:
		f.store_string(choice)
		f.close()


## Forgets the player ID kept on the device (install and full mode), for a
## game's "reset my ID" setting. This session keeps sending the ID it started
## with; the next launch makes a new one, so nothing joins the two.
func reset_install_id() -> void:
	if FileAccess.file_exists(PLAYER_PATH):
		DirAccess.remove_absolute(PLAYER_PATH)


## attrs describe this attempt in the game's words, as a track() event's do:
## {"tier": "pit_80", "party_size": 3}. The level funnel splits by them.
func level_start(level_id: Variant, attrs: Dictionary = {}) -> void:
	_close_window(false)  # so a frame window never spans two levels
	level = str(level_id)
	_level_started = Time.get_ticks_msec()
	_level_open = true
	_left_level = null
	_net_left_level = null
	_off_level = null
	var e := {"type": "level_start"}
	if not attrs.is_empty():
		e.attrs = attrs
	_push(e)
	_remember("level_start")


func level_complete(level_id: Variant = null, score: Variant = null, duration_s: float = -1.0) -> void:
	var lvl: Variant = str(level_id) if level_id != null else level
	if _off_level != null and lvl == _off_level:
		return  # its start went to the session the player turned off, or was never sent
	var secs := duration_s if duration_s >= 0.0 else (Time.get_ticks_msec() - _level_started) / 1000.0
	_level_open = false
	_push({"type": "level_complete", "level": lvl, "duration_s": snappedf(secs, 0.01), "score": score})
	_remember("level_complete")


## The player lost the level (died, ran out of time). Leaving it is level_abandon.
func level_fail(level_id: Variant = null, cause: String = "") -> void:
	var lvl: Variant = str(level_id) if level_id != null else level
	if _outcome_sent(lvl):
		return
	_level_open = false
	_push({"type": "level_fail", "level": lvl, "cause": cause if cause != "" else null})
	_remember("level_fail")


## The player left the level before it ended: went to the menu, restarted it,
## closed the game. Never counted as a fail. Going to the background or closing
## mid-level sends one by itself (SPEC §2 level_abandon).
func level_abandon(level_id: Variant = null) -> void:
	var lvl: Variant = str(level_id) if level_id != null else level
	if _outcome_sent(lvl):
		return
	_abandon(lvl, "")


func _abandon(lvl: Variant, reason: String) -> void:
	_level_open = false
	var e := {"type": "level_abandon", "level": lvl, "duration_s": snappedf((Time.get_ticks_msec() - _level_started) / 1000.0, 0.01)}
	if reason != "":
		e.reason = reason
	_push(e)
	_remember("level_abandon")


# A game often ends its level as it closes (in _exit_tree, say), after the session
# ended and Glitchless already sent the abandon: that attempt has its outcome. So
# has one a disconnect ended, until the player reconnects and plays on in it. One
# going when the player turned Glitchless back on has no start in this session.
func _outcome_sent(lvl: Variant) -> bool:
	return (_ended and _left_level != null and lvl == _left_level) or (_net_left_level != null and lvl == _net_left_level) or (_off_level != null and lvl == _off_level)


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
	_push({"type": "custom", "name": event, "attrs": sandbox_attrs(event, attrs, _sandbox)})
	_remember(event)
	if OS.is_debug_build():
		_check_stream(event)


## A stream of events, too many to track() one by one: shots, hits, kills, gold
## picked up. Nothing is queued per call: each window (flush_interval seconds,
## and up to each level_start) adds them up per name and per its words and
## booleans (up to 4), with its numbers (up to 4) summed as they are passed, and
## sends one "counts" event. Track a moment, count a stream:
##   Glitchless.count("kill", {"monster": "elite"})
##   Glitchless.count("gold", {"source": "loot", "amount": 35})
##   Glitchless.count("shot", "bow", 3)  # one word is the attribute "what"; n events at once
func count(event: String, what: Variant = null, n: int = 1) -> void:
	if _player_off or (_inited and not enabled) or event == "" or n < 1:
		return
	var attrs := {}
	if what is Dictionary:
		attrs = what
	elif what != null:
		attrs = {"what": what}
	var group := {}
	var sums := {}
	for k: Variant in attrs:
		var v: Variant = attrs[k]
		if v is bool:
			if group.size() < MAX_COUNT_GROUP:
				group[str(k)] = v
		elif v is String or v is StringName:
			if group.size() < MAX_COUNT_GROUP:
				group[str(k)] = str(v).substr(0, 64)
		elif v is int or v is float:
			if sums.size() < MAX_COUNT_SUMS:
				sums[str(k)] = v
	var counts: Dictionary = _win.counts
	var key := _count_key(event, group)
	if not counts.has(key) and counts.size() >= MAX_COUNTS:
		# A full window: a new group of a name already counted goes under (other); a new name is dropped.
		if not counts.values().any(func(c: Dictionary) -> bool: return c.name == event):
			_win.dropped += mini(n, MAX_COUNT_N)
			return
		for k: String in group:
			group[k] = "(other)"
		key = _count_key(event, group)
	var c: Dictionary = counts.get(key, {})
	if c.is_empty():
		c = {"name": event, "attrs": group, "n": 0, "first_ts": _now()}
		counts[key] = c
	c.n = int(c.n) + mini(n, MAX_COUNT_N)
	if not sums.is_empty():
		var s: Dictionary = c.get_or_add("sums", {})
		for k: String in sums:
			if s.has(k) or s.size() < MAX_COUNT_SUMS:
				s[k] = s.get(k, 0) + sums[k]


static func _count_key(event: String, group: Dictionary) -> String:
	var keys := group.keys()
	keys.sort()
	var out := event
	for k: String in keys:
		out += "\u001f%s=%d:%s" % [k, typeof(group[k]), group[k]]
	return out


# A debug build says once when a name is tracked over 20 times a second: each
# track() is an event in a queue of 2,000, which a stream would fill in a minute.
func _check_stream(event: String) -> void:
	if _warned.has("stream:" + event):
		return
	var second := floori(Time.get_ticks_msec() / 1000.0)
	var r: Array = _stream.get(event, [second, 0])
	if r[0] != second:
		r = [second, 0]
	r[1] += 1
	_stream[event] = r
	if r[1] > STREAM_PER_S:
		_warn("stream:" + event, "\"%s\" was tracked over %d times in a second. Use Glitchless.count(\"%s\", ...) for a stream of events: it sends one count a window instead of an event each time." % [event, STREAM_PER_S, event])


## What holds for this session, in the game's words: its mode, the player's
## rank tier or class, the region of the game's servers. Any dashboard panel
## can then split by it ($rank) and a page can show only some of it. Set what
## the game knows as soon as it knows it (after sign-in, at the menu, at
## matchmaking); null removes one. Values are a word (up to 64 characters), a
## boolean or a whole number: send bands ("30-39"), not exact levels. Keys that
## name a person and values shaped like an email, a link, a phone number or an
## ID are dropped (properties.gd), with a warning in a debug build. Nothing is
## kept on the device: each launch sets them again.
func set_property(key: String, value: Variant) -> void:
	set_properties({key: value})


func set_properties(props: Dictionary) -> void:
	for k: Variant in props:
		var key := str(k)
		if props[k] == null:
			_props.erase(key)
			continue
		var c := Properties.check(key, props[k])
		if c.has("why"):
			_warn("prop:" + key, "the property \"%s\" was dropped: %s." % [key, c.why])
		elif not _props.has(key) and _props.size() >= Properties.MAX_KEYS:
			_warn("props:max", "a session takes at most %d properties: \"%s\" was dropped." % [Properties.MAX_KEYS, key])
		else:
			_props[key] = c.value


## Marks every event from now on as part of one match, party or run, until the
## same kind is set again or set to null:
##   Glitchless.set_group("match", match_id, {"mode": "squads"})  # an ID the game's server made for the match
##   Glitchless.set_group("party", party_id)  # never a guild, clan or friends list
##   var run_id := Glitchless.set_group("run")  # Glitchless makes run IDs
##   Glitchless.set_group("match", null)  # it ended
## IDs are 8 to 64 of A-Z, a-z, 0-9 and _ . : -. Match and party IDs are sent
## hashed with the game's service, so they can't be looked up in the game's own
## logs, and everyone in one match still shares one (hash_group_ids: false
## sends them as they are). A run ID passed back resumes a run the game saved
## (install and full mode; anonymous mode gives it a new ID). Returns the ID sent.
func set_group(kind: String, id: Variant = "", attrs: Dictionary = {}) -> String:
	if not kind in GROUP_KINDS:
		_warn("group:" + kind, "set_group takes \"match\", \"party\" or \"run\", not \"%s\"." % kind)
		return ""
	if kind == "run" and id is String and id == "":
		var made := _new_id("r_", 12)
		if _inited:
			_apply_group(kind, made, attrs, false)
		else:
			_early_groups.append([kind, made, attrs, true])
		return made
	if not _inited:
		# The hash needs the service and a resumed run the privacy mode: both come with init().
		_early_groups.append([kind, id, attrs, false])
		return str(id) if kind == "run" and id != null else ""
	if id == null:
		if not _groups.has(kind):
			return ""
		_close_window(false)
		_groups.erase(kind)
		_push({"type": "group", "kind": kind, "id": null})
		if kind == "match" and role == "server" and bool(_opts.session_per_match):
			_end_server_session("match_end")
		return ""
	var given := str(id)
	if not is_group_id(given):
		_warn("group-id:" + kind, "a %s ID is 8 to 64 of A-Z, a-z, 0-9 and _ . : - (\"%s\" was dropped)." % [kind, given.substr(0, 80)])
		return ""
	if kind == "run":
		# A run the game saved and resumes. In anonymous mode nothing may tie two launches together.
		return _apply_group(kind, given if _privacy != "anonymous" else _new_id("r_", 12), attrs, true)
	return _apply_group(kind, hash_group_id(_service, given) if bool(_opts.hash_group_ids) else given, attrs, false)


func _apply_group(kind: String, sent: String, attrs: Dictionary, resumed: bool) -> String:
	if _groups.get(kind) == sent and attrs.is_empty():
		return sent
	_close_window(false)  # a window belongs to one match
	_groups[kind] = sent
	var e := {"type": "group", "kind": kind, "id": sent}
	if not attrs.is_empty():
		e.attrs = attrs
	if resumed:
		e.resumed = true
	_push(e)
	_remember("group:" + kind)
	return sent


static func is_group_id(id: String) -> bool:
	return RegEx.create_from_string("^[A-Za-z0-9_.:-]{8,64}$").search(id) != null


## The match or party ID as sent: h_ and the first 24 hex characters of SHA-1
## over the game's service (lowercased), ":" and the ID. Every Glitchless SDK
## hashes it the same way (SHA-1: GameMaker has no SHA-256), so a server and its
## players, on any engine, send one ID for one match.
static func hash_group_id(service: String, id: String) -> String:
	return "h_" + (service.to_lower() + ":" + id).sha1_text().substr(0, 24)


## Where the player is in an open world (an MMO region, a metroidvania room),
## apart from levels: a zone has no start or end. Every event and window carries
## it as it carries the level, and dashboards split by $zone. null clears it.
func set_zone(zone_name: Variant) -> void:
	var z: Variant = str(zone_name).strip_edges().substr(0, 64) if zone_name != null else null
	if z == "":
		z = null
	if z == zone:
		return
	# A window never spans two zones, unless the player crosses back and forth within a second.
	if Time.get_ticks_msec() - int(_win.started_ms) >= 1000:
		_close_window(false)
	zone = z


## A round trip for a game whose netcode Glitchless can't read itself (a
## WebSocket game's own ping, Steam Networking Sockets, Nakama...): call it
## about once a second while connected. loss_pct and jitter_ms are optional.
func net_sample(rtt_ms: float, loss_pct: Variant = null, jitter_ms: Variant = null) -> void:
	if not _net_up:
		_net_connected(_net_transport if _net_transport != "" else "custom")
	_net_add(maxf(rtt_ms, 0.0), loss_pct, jitter_ms, [null, null], _net_transport, false)


## The connection to the game's server dropped, for netcode Glitchless can't
## read, or to say why when it can ("kicked"): timeout, connection_lost, kicked,
## server_closed, failed_to_connect or other. With a level open, that attempt
## ends as an abandon with reason "disconnect" (never a fail). (Object already
## has a disconnect(), for signals.)
func net_disconnect(reason: String = "other") -> void:
	_net_pending = null
	if not reason in DISCONNECT_REASONS:
		reason = "other"
	var now := Time.get_ticks_msec()
	var was_up := _net_up
	_net_up = false
	if _mp != null and NetInfo.connected(_mp.multiplayer_peer):
		_net_dead_peer = _mp.multiplayer_peer.get_instance_id()  # still says connected for a moment
	if _net_down_at == 0:
		_net_down_at = now
	if _net_disconnects < MAX_DISCONNECTS:
		_net_disconnects += 1
		var last := _net_summary()
		_push({
			"type": "disconnect",
			"reason": reason,
			"connected_s": snappedf((now - _net_up_at) / 1000.0, 0.1) if was_up and _net_up_at > 0 else 0.0,
			"rtt_p95": last.get("rtt_p95"),
			"loss_pct": last.get("loss_pct"),
		})
		_remember("disconnect:" + reason)
	if _level_open:
		_net_left_level = level
		_abandon(level, "disconnect")


## Connected again after net_disconnect(), for netcode Glitchless can't read.
func net_reconnect() -> void:
	_net_connected(_net_transport if _net_transport != "" else "custom")


## The players connected to this server, for netcode other than Godot's
## MultiplayerAPI (which Glitchless counts itself). -1 goes back to counting.
func set_players(n: int) -> void:
	_players_set = n


## A purchase (an event named purchase, or any with a currency) made in a
## sandbox install says so with sandbox: true, as Apple charged nothing for it:
## its amounts are left out of revenue (SPEC §3b). A sandbox the game set itself
## stays as it is.
static func sandbox_attrs(event: String, attrs: Dictionary, sandbox: bool) -> Dictionary:
	if not sandbox or attrs.has("sandbox") or (event != "purchase" and not attrs.has("currency")):
		return attrs
	var out := attrs.duplicate()
	out["sandbox"] = true
	return out


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
## "offline" (nothing is sent from this build), "off" (the player turned
## Glitchless off: nothing is taken or kept) or "error" (it goes with a later batch).
func report_bug(note: String = "", screenshot: Variant = true) -> Dictionary:
	if _player_off:
		return {"sent": false, "reason": "off"}
	return await _send_report(_bug_snapshot(screenshot), note)


## Opens the bug report form, for a game's own "Report a bug" button. Works
## whether or not bug_reports is on (that adds the hotkey), but not while the
## player has Glitchless off.
func open_bug_report() -> void:
	if _player_off:
		return
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
		if _first_frame_ms > 0 and not _load_sent and role != "server":
			_load_sent = true
			_queue.append({"type": "load", "ts": _first_frame_at, "level": level, "ttff_ms": _first_frame_ms, "assets": null, "first_launch": _first_launch})
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
	if _player_off:
		# Nothing is measured while the player has Glitchless off; errors heard meanwhile go unread.
		_logger.take()
		_last_us = 0
		_tick_at = 0
		return
	# Wall-clock time between frames. The delta Godot passes is smoothed
	# (application/run/delta_smoothing) and scaled by Engine.time_scale, which
	# would hide the very stutters this is here to find.
	var now := Time.get_ticks_usec()
	_head_us = now
	if _tick_at > 0:
		_end_tick(now)  # this frame's last physics tick, its physics step included
		_tick_at = 0
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
	if ms >= _next_net and _inited and enabled and bool(_opts.network):
		_next_net = ms + NET_SAMPLE_MS
		_sample_net()
	if role == "server" and _inited and enabled and _now() - _started_at >= SERVER_SESSION_MS:
		_end_server_session("max_duration")
	if ms >= _next_flush:
		flush()
	if _inited and enabled and _in_flight < 0 and not _outbox.is_empty() and ms >= _retry_at:
		_send_next()


func _physics_process(_delta: float) -> void:
	if _player_off:
		return
	_physics_head_us = Time.get_ticks_usec()
	if _tick_at > 0:
		_end_tick(_physics_head_us)  # the tick before this one ran in the same frame
	_tick_at = _physics_head_us


# One physics tick, timed against Engine.physics_ticks_per_second: what a
# dedicated server's numbers are (server_window). Player builds count them too,
# but send frame windows instead.
func _end_tick(now_us: int) -> void:
	var ms := (now_us - _tick_at) / 1000.0
	var w := _win
	w.ticks += 1
	w.tick_sketch.add(ms)
	w.tick_max = maxf(w.tick_max, ms)
	if ms > 1000.0 / maxf(Engine.physics_ticks_per_second, 1.0):
		w.late += 1


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
	# The refresh rate (60 / 90 / 120 Hz, or a cap the game set) sets the frame budget. A frame can take
	# longer than the screen's interval but never less, so the fast frames tell the rate, as the browser
	# SDK reads it: a first guess after 30 frames (so the session's first window isn't judged at a made-up
	# 60 Hz), the answer at 120, then a look every 480 frames, only ever faster. _check_screen lowers it
	# when the OS says the screen slowed down (Low Power Mode).
	if dt < 100.0 and dt > 3.5:
		_rate_frames.append(dt)
		var n := _rate_frames.size()
		if n == 30 or n == 120 or n == 600:
			_set_budget(_quantile(_rate_frames, 0.2), n == 600)
		if n >= 600:
			_rate_frames = _rate_frames.slice(480)


func _snapshot(dt: float) -> Dictionary:
	return {
		"dt": dt, "calls": _f_calls, "tris": _f_tris, "render": _f_render, "gpu": _f_gpu,
		"process": _f_process, "physics": _f_physics, "pipelines": _f_pipelines,
		"nodes_added": _f_nodes_added, "scene_changed": _f_scene_changed,
	}


func _set_budget(typical_dt: float, only_faster: bool = false) -> void:
	var hz := 1000.0 / typical_dt
	var best := 60
	for r: int in RATES:
		if absf(r - hz) < absf(best - hz):
			best = r
	if only_faster and best <= _hz:
		return
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
		_first_frame_at = _now()
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
		_pending_hitches.append(_stamp({
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
		}))


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
	# Nothing measured in the game explains the frame: the time went to the GPU
	# (Godot times it only on Vulkan and Direct3D 12, not on Metal or OpenGL), to
	# presenting the frame, or to the OS.
	if out.is_empty() and f.process + f.physics + f.render + f.gpu < share:
		out.append("gpu_or_os")
	if f.dt > FROZEN_MS:
		out.append("frozen")
	return out


func _new_window() -> Dictionary:
	return {
		"started_at": _now(), "started_ms": Time.get_ticks_msec(), "frames": 0, "sketch": Sketch.new(), "max": 0.0,
		"slow": 0, "jank": 0, "hitches": 0, "frozen": 0, "calls": 0, "calls_max": 0, "tris": 0,
		"render": 0.0, "gpu": 0.0, "process": 0.0, "physics": 0.0, "ctx": {},
		"counts": {}, "dropped": 0,  # count(): name and group -> entry
		"net": {},  # the connection's samples (_net_add); empty while not connected
		"ticks": 0, "tick_sketch": Sketch.new(), "tick_max": 0.0, "late": 0,  # physics ticks (server_window)
		"players_max": 0, "peer_rtts": [], "srv_in": null, "srv_out": null,
	}


# fresh: sample the engine counts now. Not when a level starts: whatever the
# game just did to load the new level belongs to the new level.
func _close_window(fresh: bool = true) -> void:
	if fresh and _win.frames > 0:
		_sample_engine()
	var w := _win
	_win = _new_window()
	var secs := maxf((Time.get_ticks_msec() - w.started_ms) / 1000.0, 0.001)
	var net: Variant = _net_json(w.net, secs)
	if role == "server":
		# A dedicated server's windows are its ticks; its frames, hitches and positions aren't sent.
		if w.ticks > 0:
			_queue_event(_stamp(_server_window(w, secs)))
		_pending_hitches.clear()
		_pos_buffer = []
	elif w.frames > 0:
		var n: int = w.frames
		var s: Sketch = w.sketch
		var fw := {
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
		}
		if net != null:
			fw.net = net  # only while connected
		_queue_event(_stamp(fw))
		_recent_windows.append({"ts": w.started_at, "level": level, "fps": snappedf(n / secs, 0.1), "p95": _round(s.quantile(0.95), 0.01)})
		if _recent_windows.size() > 12:
			_recent_windows.pop_front()
	if not _pos_buffer.is_empty():
		_queue_event(_stamp({"type": "pos", "ts": _pos_buffer[0][0], "level": level, "pts": _pos_buffer}))
		_pos_buffer = []
	_pending_hitches.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a.duration_ms > b.duration_ms)
	for h in _pending_hitches.slice(0, MAX_HITCH_EVENTS_PER_WINDOW):
		_queue_event(h)
		_recent_hitches.append(_slim(h))
	if _recent_hitches.size() > BUG_RECENT:
		_recent_hitches = _recent_hitches.slice(_recent_hitches.size() - BUG_RECENT)
	_pending_hitches.clear()
	_close_counts(w, secs)
	_send_props_change()


# The window's count() entries as one event (SPEC §2 counts). A server without
# counters would drop it, so then nothing is sent and the game is told once.
func _close_counts(w: Dictionary, secs: float) -> void:
	if w.counts.is_empty() and w.dropped == 0:
		return
	if _lacks("counts"):
		_warn("feature:counts", "this Glitchless server doesn't take count() yet, so counters aren't sent. Update the server.", false)
		return
	_queue_event(_stamp({
		"type": "counts", "ts": w.started_at, "level": level, "duration_s": snappedf(secs, 0.01), "dropped": w.dropped,
		"counts": w.counts.values(),
	}))


# Properties that changed since session_start or the last props event: one
# event a window at most, with each key's last value and null for one removed.
func _send_props_change() -> void:
	if not _session_start_sent:
		return  # session_start carries them
	var diff := {}
	for k: String in _props:
		if not _props_sent.has(k) or typeof(_props_sent[k]) != typeof(_props[k]) or _props_sent[k] != _props[k]:
			diff[k] = _props[k]
	for k: String in _props_sent:
		if not _props.has(k):
			diff[k] = null
	if diff.is_empty():
		return
	_props_sent = _props.duplicate()
	_push({"type": "props", "props": diff})


# SPEC §2 server_window: the ticks against their budget (1000 / the physics tick
# rate), the players connected and the rate the server reached.
func _server_window(w: Dictionary, secs: float) -> Dictionary:
	var s: Sketch = w.tick_sketch
	var players := _players()
	var usage := Device.process_usage()
	var cpu: Variant = null
	if usage.has("cpu_s"):
		if _cpu_s >= 0.0:
			cpu = snappedf((usage.cpu_s - _cpu_s) / secs * 100.0, 0.1)  # of one core, as the other SDKs count it
		_cpu_s = usage.cpu_s
	var rtts: Array[float] = []
	rtts.assign(w.peer_rtts)
	return {
		"type": "server_window",
		"ts": w.started_at,
		"level": level,
		"duration_s": snappedf(secs, 0.01),
		"ticks": w.ticks,
		"tick_hz": snappedf(w.ticks / secs, 0.1),
		"budget_ms": snappedf(1000.0 / maxf(Engine.physics_ticks_per_second, 1.0), 0.01),
		"tick": s.to_json(),
		"tick_p50": _round(s.quantile(0.5), 0.01),
		"tick_p95": _round(s.quantile(0.95), 0.01),
		"tick_max": snappedf(w.tick_max, 0.01),
		"late": w.late,
		"players": players,
		"players_max": maxi(w.players_max, players),
		"net_objects": null,
		"in_kbps": _kbps(w.srv_in, secs),
		"out_kbps": _kbps(w.srv_out, secs),
		"cpu_pct": cpu,
		"mem_mb": usage.get("mem_mb"),
		"rtt_p95": _round(_quantile(rtts, 0.95), 0.1) if not rtts.is_empty() else null,
		"ctx": w.ctx,
	}


# A window's network samples as frame_window.net, or null when it was never connected.
func _net_json(n: Dictionary, secs: float) -> Variant:
	if n.is_empty():
		return null
	var s: Sketch = n.sketch
	var out := {
		"rtt": s.to_json() if s.n > 0 else null,
		"rtt_p50": _round(s.quantile(0.5), 0.1),
		"rtt_p95": _round(s.quantile(0.95), 0.1),
		"rtt_max": snappedf(s.max_v, 0.1) if s.n > 0 else null,
		"jitter_ms": snappedf(n.jitter / n.jitter_n, 0.1) if n.jitter_n > 0 else null,
		"loss_pct": snappedf(n.loss / n.loss_n, 0.01) if n.loss_n > 0 else null,
		"in_kbps": _kbps(n.rx, secs),
		"out_kbps": _kbps(n.tx, secs),
		"samples": s.n,
		"transport": n.transport,
		"link": null,  # Godot can't tell Wi-Fi from mobile data
		"host": n.host,
	}
	_net_last = {"rtt_p95": out.rtt_p95, "loss_pct": out.loss_pct}
	return out


static func _kbps(bytes: Variant, secs: float) -> Variant:
	return snappedf(float(bytes) * 8.0 / 1000.0 / secs, 0.1) if bytes != null else null


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
	# The OS reports the screen's rate, which can be higher than what the game gets (a 60 Hz panel said to be
	# 120) but drops at once when a ProMotion phone goes into Low Power Mode: then the frames' rate does too.
	var os_hz: Variant = Device.refresh_rate()
	if os_hz != null and os_hz >= 30 and os_hz < _hz:
		_set_budget(1000.0 / float(os_hz))
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


# Timing the renderer costs a little every frame, so it stops while the player has Glitchless off.
func _set_measure_render(on: bool) -> void:
	_measure_render = on
	if _vp.is_valid():  # none yet in _init()
		RenderingServer.viewport_set_measure_render_time(_vp, on and not _player_off)


# ───────────────────────────── network ─────────────────────────────

# Once a second: the MultiplayerAPI's peer (net.gd). A client samples its round
# trip to the server, a listen server's host says it hosts, and a dedicated
# server counts its players and their round trips.
func _sample_net() -> void:
	var mp := get_tree().get_multiplayer()
	if mp != _mp:
		_watch(mp)
	var peer: MultiplayerPeer = mp.multiplayer_peer if mp != null else null
	if not NetInfo.connected(peer):
		return
	var t := NetInfo.transport(peer)
	var bytes := NetInfo.take_bytes(peer)
	if role == "server":
		_win.players_max = maxi(_win.players_max, _players())
		_win.peer_rtts.append_array(NetInfo.peer_rtts(peer, mp.get_peers()))
		if bytes[0] != null:
			_win.srv_out = int(_win.srv_out if _win.srv_out != null else 0) + int(bytes[0])
			_win.srv_in = int(_win.srv_in if _win.srv_in != null else 0) + int(bytes[1])
		return
	if mp.is_server():
		_net_add(0.0, 0.0, 0.0, bytes, t, true)  # a listen server's host: no round trip of its own
		return
	if peer.get_instance_id() == _net_dead_peer:
		return  # a disconnect the game reported, before the transport noticed
	if not _net_up:
		_net_connected(t)  # connected before Glitchless was watching
	_net_ws = NetInfo.websocket(peer)
	var s := NetInfo.client_sample(peer)
	_net_add(s.rtt, s.loss_pct, s.jitter, bytes, t, false)


func _watch(mp: MultiplayerAPI) -> void:
	_mp = mp
	if mp == null:
		return
	for s: Array in [
		["connected_to_server", _on_net_connected], ["connection_failed", _on_net_failed],
		["server_disconnected", _on_net_server_gone], ["peer_disconnected", _on_net_peer_gone],
	]:
		if not mp.is_connected(s[0], s[1]):
			mp.connect(s[0], s[1])


func _net_add(rtt: Variant, loss: Variant, jitter: Variant, bytes: Array, t: String, host: bool) -> void:
	if _player_off:
		return
	var n: Dictionary = _win.net
	if n.is_empty():
		n.merge({"sketch": Sketch.new(NET_ALPHA), "loss": 0.0, "loss_n": 0, "jitter": 0.0, "jitter_n": 0, "rx": null, "tx": null})
	if rtt != null:
		(n.sketch as Sketch).add(float(rtt))
	if loss != null:
		n.loss += float(loss)
		n.loss_n += 1
	if jitter != null:
		n.jitter += float(jitter)
		n.jitter_n += 1
	if bytes[0] != null:
		n.tx = int(n.tx if n.tx != null else 0) + int(bytes[0])
		n.rx = int(n.rx if n.rx != null else 0) + int(bytes[1])
	n.transport = t
	n.host = host


# The round trip and loss a disconnect carries: this window's so far, else the last one's.
func _net_summary() -> Dictionary:
	var n: Dictionary = _win.net
	if not n.is_empty() and (n.sketch as Sketch).n > 0:
		return {"rtt_p95": _round((n.sketch as Sketch).quantile(0.95), 0.1), "loss_pct": snappedf(n.loss / n.loss_n, 0.01) if n.loss_n > 0 else null}
	return _net_last


func _on_net_connected() -> void:
	if _mp != null:
		_net_connected(NetInfo.transport(_mp.multiplayer_peer))


# Connected to the game's server. Within RECONNECT_S of a disconnect it is a
# reconnect, and a player back in the level they dropped out of plays on in it:
# the server takes the abandon back once anything else happens on it (SPEC §2).
func _net_connected(t: String) -> void:
	_net_dead_peer = 0
	if _net_up:
		return
	var now := Time.get_ticks_msec()
	_net_up = true
	_net_up_at = now
	_net_transport = t
	if _net_down_at > 0:
		var after := (now - _net_down_at) / 1000.0
		_net_down_at = 0
		if after <= RECONNECT_S:
			_push({"type": "reconnect", "after_s": snappedf(after, 0.1)})
			_remember("reconnect")
			if _net_left_level != null and _net_left_level == level:
				_level_open = true
	_net_left_level = null


# The server went (peer 1 disconnected). Read now, while the ENet host still
# counts it, whether anything came since the last sample: a server that closes
# the connection sends a goodbye that arrives with the drop, and one that went
# quiet long enough to time out (ENet's least is a second) sent nothing since.
func _on_net_peer_gone(id: int) -> void:
	if id != NetInfo.TARGET_SERVER or _mp == null or _mp.is_server() or not _net_up:
		return
	_net_server_left = true
	var bytes := NetInfo.take_bytes(_mp.multiplayer_peer)
	_net_goodbye = bytes[1] != null and bytes[1] > 0


func _on_net_server_gone() -> void:
	if not _net_up:
		return  # already recorded by net_disconnect(), or never connected
	if not _net_server_left:
		# No peer_disconnected for the server first: the game closed the connection itself. Leaving is no disconnect.
		_net_up = false
		_net_down_at = 0
		return
	_net_server_left = false
	_net_pending = ""
	_net_record.call_deferred()


func _on_net_failed() -> void:
	_net_pending = "failed_to_connect"
	_net_record.call_deferred()


# At the end of the frame, after the game's own handlers of the same signal, so
# a game that says why itself (net_disconnect("kicked")) is heard instead.
func _net_record() -> void:
	if _net_pending == null:
		return
	var reason: String = _net_pending
	if reason == "":
		var code: int = int(_net_ws.call("get_close_code")) if _net_ws != null else -1
		reason = NetInfo.lost_reason(_net_transport, _net_goodbye, code)
		_log("%s lost (%s at the drop, close code %d): %s" % [_net_transport, "data" if _net_goodbye else "nothing", code, reason])
	net_disconnect(reason)


func _players() -> int:
	if _players_set >= 0:
		return _players_set
	if _mp != null and NetInfo.connected(_mp.multiplayer_peer) and _mp.is_server():
		return _mp.get_peers().size()
	return 0


# A dedicated server, unless the game says otherwise: Godot's dedicated-server
# export, --glitchless-server, or a bare --server (Godot's docs suggest that flag
# for starting a game as its server).
func _decide_role() -> String:
	var r := str(_opts.role)
	if r == "server" or r == "player":
		return r
	if OS.has_feature("dedicated_server") or _has_flag("--glitchless-server") or "--server" in _args():
		return "server"
	return "player"


# A server session lasts as long as its process, cut every 6 hours, or one
# match with session_per_match.
func _end_server_session(reason: String) -> void:
	if not (_inited and enabled):
		return
	_push({"type": "session_end", "reason": reason, "duration_s": snappedf((_now() - _started_at) / 1000.0, 0.1)})
	_new_session()


# ───────────────────────────── measure ─────────────────────────────

func _probe_result(p: Dictionary, seconds: float) -> Dictionary:
	if _player_off:
		return {"error": "Glitchless is off: the player turned it off in the game's settings (set_enabled(false)), so no frames were measured."}
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
	if _player_off:
		return
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
		_end_level("background")
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
		_left_level = null
		_new_session()
	else:
		# Back in the same session: the level goes on, and the server takes back the
		# abandon sent on the way out once anything else happens on it.
		_level_open = _left_level != null
		_left_level = null
		track("app_resume", {"away_s": snappedf(away, 0.1)})


# Back after a long time away: a new session with a new random ID. In
# anonymous mode nothing joins it to the last one.
func _new_session() -> void:
	flush()  # the last session's events go under its own ID
	_begin_session()


# The new session's start goes with the next batch. Turning Glitchless back on
# starts here too: nothing waits to be flushed then.
func _begin_session() -> void:
	session_id = _new_id("s_", 16)
	_started_at = _now()
	_session_start_sent = false
	_recent.clear()
	_history.clear()
	_error_counts.clear()
	_net_disconnects = 0
	_props_sent = {}  # the new session_start carries the properties that still hold
	for kind: String in _groups:  # and the groups still going
		_push({"type": "group", "kind": kind, "id": _groups[kind]})


# The session ends with a level still going: the player left it (SPEC §2 level_abandon).
func _end_level(reason: String) -> void:
	if _level_open:
		_left_level = level
		_abandon(level, reason)


func _shutdown(reason: String) -> void:
	if _shut:
		return
	_shut = true
	if _inited and enabled and not _ended:
		_end_level(reason)
		_ended = true
		_push({"type": "session_end", "reason": reason, "duration_s": snappedf((_now() - _started_at) / 1000.0, 0.1)})
	if _inited and enabled:
		flush()
		_send_now(SEND_DEADLINE_MS)


func _input(event: InputEvent) -> void:
	if _player_off:
		return  # nothing is read, and the bug report hotkey is the game's again
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
	if _player_off or (_inited and not enabled):
		return
	if not e.has("ts"):
		e.ts = _now()
	if not e.has("level"):
		e.level = level
	_queue_event(_stamp(e))
	if e.type != "session_end":
		_history.append(_slim(e))
		if _history.size() > BUG_RECENT:
			_history.pop_front()


func _queue_event(e: Dictionary) -> void:
	_queue.append(e)
	if _queue.size() > MAX_QUEUE:
		_queue = _queue.slice(_queue.size() - MAX_QUEUE)


# The zone and the groups go on every event and window, as the level does.
func _stamp(e: Dictionary) -> Dictionary:
	if zone != null and not e.has("zone"):
		e.zone = zone
	for kind: String in _groups:
		if not e.has(kind):
			e[kind] = _groups[kind]
	return e


# Once each: a game's mistake in a debug build, or (debug_only false) what the
# developer of any build must hear, such as a server too old for what is sent.
func _warn(key: String, msg: String, debug_only: bool = true) -> void:
	if _warned.has(key) or (debug_only and not OS.is_debug_build()):
		return
	_warned[key] = true
	if OS.is_debug_build():
		push_warning("Glitchless: " + msg)  # raised in the addon, so never reported back as an error
	else:
		printerr("Glitchless: " + msg)


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
	var device := Device.info(_full)
	SteamInfo.add_to(device, _steam_facts())
	var e := {
		"type": "session_start",
		"ts": _started_at,
		"level": null,
		"session_type": _session_type,
		"privacy": _privacy,
		"device": device,
		"page": null,
		"nav_ms": null,
	}
	_props_sent = _props.duplicate()
	if not _props.is_empty():
		e.props = _props.duplicate()
	if role == "server":
		var region := str(_opts.region).strip_edges().substr(0, 64)
		e.server = {
			"tick_hz": Engine.physics_ticks_per_second,
			"max_players": int(_opts.max_players) if int(_opts.max_players) > 0 else null,
			"build": "dedicated" if OS.has_feature("dedicated_server") else "headless" if DisplayServer.get_name() == "headless" else null,
			"region": region if region != "" and Properties.shape(region) == "" else null,
			"host": Device.server_host(),
		}
	return e


## The game's Steam facts (steam.gd), read until GodotSteam answers: a game may
## initialise Steam after Glitchless. A game that gives no version reports its
## Steam build, so versions compare build by build. The first batch is made
## after session_start, so every batch of a session has the same version.
func _steam_facts() -> Dictionary:
	if _steam.is_empty():
		_steam = SteamInfo.read()
	if not _version_given and _steam.has("steam_build"):
		_version = "steam-%d" % _steam.steam_build
	return _steam


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
	if _player_off:
		return {"sent": false, "reason": "off"}
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
	_stamp(e)
	_remember("bug_report")
	if not _inited or not enabled or role == "server":
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
	var epoch := _epoch
	if http.request(_intake_url(), ["Content-Type: application/json"], HTTPClient.METHOD_POST, _body(b)) == OK:
		var r: Array = await http.request_completed
		code = r[1] if r[0] == HTTPRequest.RESULT_SUCCESS else 0
	http.queue_free()
	if epoch != _epoch:
		return {"sent": false, "reason": "off"}  # the player turned Glitchless off meanwhile: the answer is ignored
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


# bid is the batch's own random ID (SPEC §2 batch_id). It goes with every try of
# the batch and is saved with it, so the server stores a batch once however many
# times it is sent: after a timeout, a send cut short by going to the background,
# or a launch that sends what the last one saved. It names the batch, not the
# player or the session, so anonymous mode saves it too.
func _batch(events: Array[Dictionary]) -> Dictionary:
	var b := {
		"id": _next_batch_id, "bid": _new_id("b_", 16), "service": _service, "env": _env, "version": _version,
		"sid": session_id, "pid": player_id, "group": _started_at, "events": events,
	}
	_next_batch_id += 1
	return b


func _body(b: Dictionary) -> String:
	var body := {
		"service": b.service,
		"env": b.env,
		"version": b.version,
		"session_id": b.sid,
		"player_id": b.pid if b.pid != "" else null,  # the server uses the session ID in its place
		"sdk": SDK,
		"batch_id": b.bid,
		"events": b.events,
	}
	if role == "server":
		body.role = "server"  # intake files it under the game's companion service, <service>.server
	return JSON.stringify(body)


# What the server takes (GET /v1/health "features"). An older one drops counts,
# and must never get a dedicated server's sessions, which would land among
# players'. Asked when init() runs, and again until it answers.
func _ask_features() -> void:
	if _asking_features or _intake == "" or not is_inside_tree():
		return
	_asking_features = true
	var http := HTTPRequest.new()
	http.timeout = 10.0
	add_child(http)
	var answer: Array = []
	var epoch := _epoch
	if http.request(_intake + "/v1/health") == OK:
		answer = await http.request_completed
	http.queue_free()
	_asking_features = false
	if epoch != _epoch:
		return  # the player turned Glitchless off meanwhile: the answer is ignored
	if answer.is_empty() or answer[0] != HTTPRequest.RESULT_SUCCESS or answer[1] != 200:
		return
	var data: Variant = JSON.parse_string((answer[3] as PackedByteArray).get_string_from_utf8())
	var list: Variant = data.get("features") if data is Dictionary else null
	var features := {}
	if list is Array:
		for f: Variant in list:
			features[str(f)] = true
	elif list is Dictionary:
		for k: Variant in list:
			if list[k]:
				features[str(k)] = true
	_features = features
	_log("the server takes: %s" % ", ".join(features.keys()))
	if role == "server" and not features.has("server_mode"):
		_warn("feature:server_mode", "this Glitchless server doesn't take dedicated servers' sessions yet, so this server sends nothing. Update the server.", false)
		_build_sends = false  # for this launch: set_enabled(true) can't turn it back on
		enabled = false
		_queue.clear()
		_outbox.clear()
		if FileAccess.file_exists(_outbox_path()):
			DirAccess.remove_absolute(_outbox_path())
	elif role == "server":
		_retry_at = 0
		_send_next()


func _lacks(feature: String) -> bool:
	return _features != null and not _features.has(feature)


# A dedicated server sends nothing until the server says it takes server sessions.
func _may_send() -> bool:
	return role != "server" or (_features != null and _features.has("server_mode"))


func _intake_url() -> String:
	return "%s/v1/intake?token=%s" % [_intake, str(_opts.client_token).uri_encode()]


func _send_next() -> void:
	if _in_flight >= 0 or _outbox.is_empty() or Time.get_ticks_msec() < _retry_at:
		return
	if not _may_send():
		if _features == null and not _asking_features:
			_retry_at = Time.get_ticks_msec() + 15000  # ask again in a while
			_ask_features()
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
	if id < 0:
		return  # cancelled as the player turned Glitchless off: its answer is ignored
	_in_flight = -1
	var i := _outbox_index(id)
	var n: int = _outbox[i].events.size() if i >= 0 else 0
	if result == HTTPRequest.RESULT_SUCCESS and code >= 200 and code < 300:
		stats.sent += n
		stats.last_status = "ok"
		_backoff = 0.0
		if _features == null:
			_ask_features()  # the server is reachable now
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
	if _outbox.is_empty() or not sampled or OS.has_feature("web") or not _may_send():
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
		_save_outbox()  # at once: the OS may stop the game before the next one
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
# Install and full mode keep a stored ID anyway, so they save both IDs. Every
# mode saves each batch's own ID, so a batch the server took just before the
# game closed is not stored twice when the next launch sends it.
func _save_outbox() -> void:
	if not enabled:
		return
	var out: Array[Dictionary] = []
	for b in _outbox:
		var saved := {"bid": b.bid, "service": b.service, "env": b.env, "version": b.version, "group": b.group, "events": b.events}
		if _privacy != "anonymous":
			saved.sid = b.sid
			saved.pid = b.pid
		out.append(saved)
	if out.is_empty():
		if FileAccess.file_exists(_outbox_path()):
			DirAccess.remove_absolute(_outbox_path())
		return
	var tmp := _outbox_path() + ".tmp"
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return
	f.store_string(JSON.stringify({"v": 1, "batches": out}))
	f.close()
	DirAccess.rename_absolute(tmp, _outbox_path())


# A dedicated server keeps its own, so a player build of the same project on the
# same machine never sends a server's batches as a player's (or the other way).
func _outbox_path() -> String:
	return SERVER_OUTBOX_PATH if role == "server" else OUTBOX_PATH


func _load_outbox() -> void:
	if not FileAccess.file_exists(_outbox_path()):
		return
	var data: Variant = JSON.parse_string(FileAccess.get_file_as_string(_outbox_path()))
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
		var bid := str(saved.get("bid", ""))
		var b := {
			"id": _next_batch_id, "bid": bid if bid.begins_with("b_") else _new_id("b_", 16),
			"service": str(saved.get("service", _service)), "env": str(saved.get("env", _env)),
			"version": str(saved.get("version", _version)), "sid": sid, "pid": str(saved.get("pid", "")) if _privacy != "anonymous" else "",
			"group": group, "events": events,
		}
		_next_batch_id += 1
		_outbox.append(b)
	_log("%d saved batches from earlier launches" % _outbox.size())


# Whether this is the first launch of this game version on this device. The
# first after an install or an update starts cold (empty shader and file
# caches), which shows in the time to the first frame. The file holds only the
# version, the same on every player's device, so it ties no two sessions together.
func _note_launch() -> bool:
	var last := FileAccess.get_file_as_string(LAUNCHED_PATH).strip_edges() if FileAccess.file_exists(LAUNCHED_PATH) else ""
	if last == _version:
		return false
	var f := FileAccess.open(LAUNCHED_PATH, FileAccess.WRITE)
	if f:
		f.store_string(_version)
		f.close()
	return true


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
	return _quantile(values, 0.5)


static func _quantile(values: Array[float], q: float) -> float:
	var sorted := values.duplicate()
	sorted.sort()
	return sorted[mini(sorted.size() - 1, int(sorted.size() * q))] if not sorted.is_empty() else 0.0


static func _round(v: Variant, step: float) -> Variant:
	return snappedf(float(v), step) if v != null else null

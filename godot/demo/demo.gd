extends Node2D
## A tiny game with planted problems, so Glitchless has something to find:
##   level_1  a bonus reports a missing table row with push_error (its message
##            holds a full path on the device, which Glitchless cuts down)
##   level_2  a power-up throws 2500 sparks in one frame and sorts them with a
##            slow sort, all in one frame (a stutter); when the
##            level ends they are taken off screen but never freed, so level_3
##            carries 2500 orphan nodes (a leak)
##   level_3  a bonus calls a method on a missing node (a script error)
## Each level opens with the same four events (power-up, pickup, death, bonus),
## then plays at random. F8 opens the bug report form.
##
## Flags (after "--"):
##   --autoplay           play by itself and quit after the last level
##   --seed=N             which run to play (the same seed plays the same way)
##   --level-seconds=S    how long each level lasts (default 4)
##   --intake=URL         the Glitchless server (default http://localhost:7777)
##   --privacy=full       send in full mode instead of anonymous (or install)
##   --reset-install-id   call Glitchless.reset_install_id() once the game starts
##   --background-at=S    pretend the phone sent the game to the background S
##                        seconds in, and back after --background-for=S (default 1)
##   --close-at=S         pretend the player closed the window S seconds in, mid-level;
##                        like Starlift, the game then ends the level as "left" as it
##                        goes, after the session has ended
##   --focus-away-at=S    pretend the player pulled down Control Center (or the
##                        notification shade) S seconds in: the game loses focus and
##                        draws nothing for --focus-away-for=S (default 1.5)
##   --session-timeout=S  Glitchless's session_timeout (default 300)
##   --bug-report-at=S    send a bug report from code (Glitchless.report_bug) S seconds in
##   --bug-form-at=S      S seconds in, press F8 and Esc, then F8, type a note into the form and press Ctrl+Enter
##   --off-at=S           S seconds in, the player turns "Share performance data" off (Glitchless.set_enabled(false))
##   --on-at=S            S seconds in, the player turns it back on (Glitchless.set_enabled(true))
##   --opt-in             ask first: Glitchless is off until the player turns it on (the opt_in option)
##   --glitchless            send even though this is a debug build
## e.g. godot --path godot -- --autoplay --seed=3 --glitchless

const LEVELS := ["level_1", "level_2", "level_3"]
const OPENING := ["powerup", "pickup", "death", "bonus"]

var _rng := RandomNumberGenerator.new()
var _level := -1
var _t := 0.0
var _level_seconds := 4.0
var _autoplay := false
var _sparks: Array[Node2D] = []
var _leaked: Array[Node2D] = []  # the planted leak: off screen, never freed
var _next_event := 0.0
var _events_this_level := 0
var _background_at := -1.0
var _background_for := 1.0
var _close_at := -1.0
var _focus_away_at := -1.0
var _focus_away_for := 1.5
var _bug_report_at := -1.0
var _bug_form_at := -1.0
var _off_at := -1.0
var _on_at := -1.0
var _bonus_target = null  # untyped: in a release export a call on a typed null crashes the game outright


func _ready() -> void:
	var intake := "http://localhost:7777"
	var privacy := "anonymous"
	var timeout := 300.0
	var reset_id := false
	var opt_in := false
	for a in OS.get_cmdline_user_args():
		if a == "--autoplay":
			_autoplay = true
		elif a.begins_with("--seed="):
			_rng.seed = int(a.get_slice("=", 1))
		elif a.begins_with("--level-seconds="):
			_level_seconds = float(a.get_slice("=", 1))
		elif a.begins_with("--intake="):
			intake = a.get_slice("=", 1)
		elif a.begins_with("--privacy="):
			privacy = a.get_slice("=", 1)
		elif a == "--reset-install-id":
			reset_id = true
		elif a.begins_with("--background-at="):
			_background_at = float(a.get_slice("=", 1))
		elif a.begins_with("--background-for="):
			_background_for = float(a.get_slice("=", 1))
		elif a.begins_with("--close-at="):
			_close_at = float(a.get_slice("=", 1))
		elif a.begins_with("--focus-away-at="):
			_focus_away_at = float(a.get_slice("=", 1))
		elif a.begins_with("--focus-away-for="):
			_focus_away_for = float(a.get_slice("=", 1))
		elif a.begins_with("--session-timeout="):
			timeout = float(a.get_slice("=", 1))
		elif a.begins_with("--bug-report-at="):
			_bug_report_at = float(a.get_slice("=", 1))
		elif a.begins_with("--bug-form-at="):
			_bug_form_at = float(a.get_slice("=", 1))
		elif a.begins_with("--off-at="):
			_off_at = float(a.get_slice("=", 1))
		elif a.begins_with("--on-at="):
			_on_at = float(a.get_slice("=", 1))
		elif a == "--opt-in":
			opt_in = true
	print("user dir: ", OS.get_user_data_dir())
	Glitchless.init("glitchless-godot-demo", "", "dev", intake, {"privacy": privacy, "session_timeout": timeout, "bug_reports": true, "opt_in": opt_in})
	print("glitchless on: ", Glitchless.is_enabled())
	if reset_id:
		Glitchless.reset_install_id()
	if _background_at >= 0.0:
		_pretend_background()
	if _focus_away_at >= 0.0:
		_pretend_focus_away()
	if _close_at >= 0.0:
		_pretend_close()
	if _bug_report_at >= 0.0:
		_report_from_code()
	if _bug_form_at >= 0.0:
		_report_from_form()
	if _off_at >= 0.0:
		_switch_at(_off_at, false)
	if _on_at >= 0.0:
		_switch_at(_on_at, true)
	_next_level()


func _process(dt: float) -> void:
	_t += dt
	for s in _sparks:
		s.position += s.get_meta("v") * dt
	if _t >= _next_event:
		var opening := _events_this_level < OPENING.size()
		_next_event = _t + (0.25 if opening else _rng.randf_range(0.3, 0.8))
		_play_event(OPENING[_events_this_level] if opening else "")
		_events_this_level += 1
	if _t >= _level_seconds:
		Glitchless.level_complete(LEVELS[_level], _rng.randi_range(100, 999))
		_next_level()
	Glitchless.set_context({"sparks": _sparks.size()})


func _next_level() -> void:
	_level += 1
	_t = 0.0
	_next_event = 0.2
	_events_this_level = 0
	_clear_sparks(_level == 2)  # the planted leak: level_2's sparks are never freed
	if _level >= LEVELS.size():
		if _autoplay:
			get_tree().quit()
			return
		else:
			_level = 0
	Glitchless.level_start(LEVELS[_level])


# One thing happening in the run: a pickup, a power-up, a death or a bonus.
func _play_event(what: String) -> void:
	if what == "":
		what = ["pickup", "pickup", "pickup", "powerup", "powerup", "death", "bonus"][_rng.randi() % 7]
	if what == "pickup":
		Glitchless.track("pickup", "coin")
	elif what == "powerup":
		Glitchless.track("powerup", "sparks")
		_burst(2500 if _level == 1 else 30)
		if _level == 1:
			_sort_sparks_slowly()
	elif what == "death":
		var x := _rng.randf_range(0.0, 540.0)
		Glitchless.death(x, _rng.randf_range(0.0, 960.0), "spikes" if x < 270.0 else "fell")
		if _level == 2:
			Glitchless.level_fail(LEVELS[_level], "fell")
	else:
		Glitchless.track("bonus", LEVELS[_level])
		if _level == 2:
			_bonus_target.queue_free()  # the planted bug: there is no target on level_3
		elif _level == 0:
			push_error("bonus table missing row %d in %s" % [_rng.randi_range(1000, 9999), ProjectSettings.globalize_path("user://bonus.cfg")])


func _burst(count: int) -> void:
	for i in count:
		var s := ColorRect.new()
		s.size = Vector2(4, 4)
		s.color = Color.from_hsv(_rng.randf(), 0.8, 1.0)
		var spark := Node2D.new()
		spark.add_child(s)
		spark.position = Vector2(270, 480)
		spark.set_meta("v", Vector2.from_angle(_rng.randf() * TAU) * _rng.randf_range(50.0, 300.0))
		add_child(spark)
		_sparks.append(spark)


# What iOS and Android send when the player switches away and back.
func _pretend_background() -> void:
	await get_tree().create_timer(_background_at).timeout
	get_tree().root.propagate_notification(NOTIFICATION_APPLICATION_PAUSED)
	await get_tree().create_timer(_background_for).timeout
	get_tree().root.propagate_notification(NOTIFICATION_APPLICATION_RESUMED)


# The window's close button, or Android's back gesture: Glitchless ends the session, then the game quits.
func _pretend_close() -> void:
	await get_tree().create_timer(_close_at).timeout
	get_tree().root.propagate_notification(NOTIFICATION_WM_CLOSE_REQUEST)
	get_tree().quit()


# Starlift's way: a run torn down mid-level ends it as "left".
func _exit_tree() -> void:
	if _level >= 0 and _level < LEVELS.size():
		Glitchless.level_fail(LEVELS[_level], "left")


# What iOS sends for Control Center, Notification Center, Siri or a call, and Android
# for the notification shade: the app loses focus without going to the background,
# and draws nothing until it gets focus back (here the main thread just waits).
func _pretend_focus_away() -> void:
	await get_tree().create_timer(_focus_away_at).timeout
	get_tree().root.propagate_notification(NOTIFICATION_APPLICATION_FOCUS_OUT)
	OS.delay_msec(int(_focus_away_for * 1000.0))
	get_tree().root.propagate_notification(NOTIFICATION_APPLICATION_FOCUS_IN)


# A game's own "Report a bug" button would do this.
func _report_from_code() -> void:
	await get_tree().create_timer(_bug_report_at).timeout
	var shot: Variant = true
	if DisplayServer.get_name() == "headless":  # nothing is drawn to read back: send a picture made here
		shot = Image.create_empty(540, 960, false, Image.FORMAT_RGB8)
		shot.fill(Color(0.3, 0.3, 0.3))
	var result := await Glitchless.report_bug("the bonus on %s never paid out" % LEVELS[_level], shot)
	print("bug report from code: ", result)


# The player flipping "Share performance data" in the game's settings.
func _switch_at(seconds: float, on: bool) -> void:
	await get_tree().create_timer(seconds).timeout
	Glitchless.set_enabled(on)
	print("glitchless on: ", Glitchless.is_enabled(), " (set_enabled(%s) on %s)" % [on, LEVELS[_level] if _level < LEVELS.size() else "the way out"])


# A player pressing F8, typing a note and pressing Ctrl+Enter, as input events.
func _report_from_form() -> void:
	await get_tree().create_timer(_bug_form_at).timeout
	Glitchless.bug_report_opened.connect(func() -> void: print("bug report form opened, paused: ", get_tree().paused))
	Glitchless.bug_report_closed.connect(func() -> void: print("bug report form closed, paused: ", get_tree().paused))
	_press(KEY_F8)
	await get_tree().process_frame
	_press(KEY_ESCAPE)  # changed their mind: nothing is sent
	await get_tree().process_frame
	_press(KEY_F8)
	await get_tree().process_frame
	for c in "sparks froze the screen":
		_press(OS.find_keycode_from_string(c.to_upper()) if c != " " else KEY_SPACE, c.unicode_at(0))
	await get_tree().process_frame
	_press(KEY_ENTER, 0, true)


func _press(key: Key, unicode: int = 0, ctrl: bool = false) -> void:
	for pressed in [true, false]:
		var e := InputEventKey.new()
		e.keycode = key
		e.physical_keycode = key
		e.unicode = unicode if pressed else 0
		e.ctrl_pressed = ctrl
		e.pressed = pressed
		get_viewport().push_input(e)


# The planted stutter: a bubble sort, so far-away sparks draw first.
func _sort_sparks_slowly() -> void:
	var n := mini(_sparks.size(), 1500)
	for i in n:
		for j in n - i - 1:
			if _sparks[j].position.y > _sparks[j + 1].position.y:
				var t := _sparks[j]
				_sparks[j] = _sparks[j + 1]
				_sparks[j + 1] = t


func _clear_sparks(leak: bool) -> void:
	for s in _sparks:
		remove_child(s)
		if leak:
			_leaked.append(s)
		else:
			s.free()
	_sparks.clear()

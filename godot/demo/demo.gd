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
## then plays at random.
##
## Flags (after "--"):
##   --autoplay           play by itself and quit after the last level
##   --seed=N             which run to play (the same seed plays the same way)
##   --level-seconds=S    how long each level lasts (default 4)
##   --intake=URL         the Glitchless server (default http://localhost:7777)
##   --privacy=full       send in full mode instead of anonymous
##   --background-at=S    pretend the phone sent the game to the background S
##                        seconds in, and back after --background-for=S (default 1)
##   --session-timeout=S  Glitchless's session_timeout (default 300)
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
var _bonus_target = null  # untyped: in a release export a call on a typed null crashes the game outright


func _ready() -> void:
	var intake := "http://localhost:7777"
	var privacy := "anonymous"
	var timeout := 300.0
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
		elif a.begins_with("--background-at="):
			_background_at = float(a.get_slice("=", 1))
		elif a.begins_with("--background-for="):
			_background_for = float(a.get_slice("=", 1))
		elif a.begins_with("--session-timeout="):
			timeout = float(a.get_slice("=", 1))
	print("user dir: ", OS.get_user_data_dir())
	Glitchless.init("glitchless-godot-demo", "", "dev", intake, {"privacy": privacy, "session_timeout": timeout})
	if _background_at >= 0.0:
		_pretend_background()
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

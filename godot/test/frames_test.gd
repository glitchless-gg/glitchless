extends SceneTree
## Frame timing pieces of glitchless.gd without a running game: the refresh
## rate read off the fast frames, and the causes a hitch gets. test/e2e.mjs runs it.
##   godot --headless --path godot --script res://test/frames_test.gd

const Glitchless := preload("res://addons/glitchless/glitchless.gd")

var _failed := 0


func _init() -> void:
	# A 120 Hz phone: the first window is judged at 120 Hz once 30 frames are in, not at a made-up 60.
	var g := _fresh()
	for i in 29:
		g._frame(8.33)
	_check("the rate is 60 until 30 frames are in", g._hz == 60)
	g._frame(8.33)
	_check("after 30 frames at 8.3 ms: 120 Hz, an 8.3 ms budget", g._hz == 120 and is_equal_approx(g._budget_ms, 1000.0 / 120.0))
	g.free()

	# A busy start (shader compiles at 30 fps) between fast frames doesn't set a 33 ms budget.
	g = _fresh()
	for i in 120:
		g._frame(33.3 if i % 3 == 0 else 16.7)
	_check("a third of the frames slow: still 60 Hz", g._hz == 60)
	g.free()

	# A game the GPU holds to 40 fps on a 60 Hz screen alternates 16.7 and 33.3 ms frames: 60 Hz, the frames are slow.
	g = _fresh()
	for i in 600:
		g._frame(16.7 if i % 2 == 0 else 33.3)
	_check("40 fps on a 60 Hz screen is judged at 60 Hz", g._hz == 60)
	g.free()

	# Later looks only ever go faster: a game that settles at 120 after starting at 60 is judged at 120.
	g = _fresh()
	for i in 120:
		g._frame(16.7)
	for i in 480:
		g._frame(8.33)
	_check("60 Hz at first, 120 Hz from frame 600", g._hz == 120)
	g.free()

	# Causes. A 66.7 ms frame with 0.1 ms of scripts, 0.3 of render CPU and no GPU time, as Starlift's iPhones sent.
	g = _fresh()
	var f := {"dt": 66.7, "process": 0.1, "physics": 0.0, "render": 0.3, "gpu": 0.0, "pipelines": 0, "nodes_added": 0, "scene_changed": false}
	_check("time outside the game's measured code is gpu_or_os, not nothing", g._causes(f) == ["gpu_or_os"])
	f.process = 40.0
	_check("scripts that took the frame are script, not gpu_or_os", g._causes(f) == ["script"])
	f.process = 0.1
	f.pipelines = 2
	_check("a shader compile is the cause, not gpu_or_os", g._causes(f) == ["shader_compile"])
	f.pipelines = 0
	f.gpu = 50.0
	_check("GPU time measured (Vulkan) is render", g._causes(f) == ["render"])
	f.gpu = 0.0
	f.dt = 1610.0
	_check("a frozen frame nothing explains: gpu_or_os and frozen", g._causes(f) == ["gpu_or_os", "frozen"])
	g.free()

	print("frames tests: %d failed" % _failed)
	quit(1 if _failed else 0)


# The autoload's script, not in the tree: just what _frame needs.
func _fresh() -> Node:
	var g: Node = Glitchless.new()
	g._win = g._new_window()
	g._ring.resize(Glitchless.RING_SIZE)
	return g


func _check(name: String, ok: bool) -> void:
	print("%s %s" % ["ok" if ok else "FAIL", name])
	if not ok:
		_failed += 1

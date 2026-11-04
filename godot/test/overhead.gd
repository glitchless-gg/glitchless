extends SceneTree
## What the Glitchless autoload costs a frame, measured: its own per-frame work
## (_process, _physics_process and the tail node's two calls) called directly in
## a loop, so GDScript time only with nothing rendered; the window it closes every
## 5 seconds; a flush every 15; and the offline worst case, a save with the outbox
## at its 4,000-event cap. Nothing is sent. Not part of test/e2e.mjs: it prints
## numbers, and the README's "What it costs" quotes them.
##   godot --headless --path godot --script res://test/overhead.gd

const Glitchless := preload("res://addons/glitchless/glitchless.gd")
const FRAMES := 200000


func _init() -> void:
	_run.call_deferred()


func _run() -> void:
	await process_frame
	var g: Node = Glitchless.new()
	root.add_child(g)  # in the tree, as the autoload is
	g._retry_at = 1 << 62  # no server: nothing is sent
	g.init("overhead", "1.0.0", "prod", "http://127.0.0.1:9", {"enabled": true, "network": false})
	g._next_flush = 1 << 62  # flushed below, by hand
	g.level_start("level_1")

	var t := Time.get_ticks_usec()
	for i in FRAMES:
		pass
	var loop := Time.get_ticks_usec() - t
	var best := INF
	for run in 5:
		t = Time.get_ticks_usec()
		for i in FRAMES:
			g._physics_process(0.0)
			g._on_tail_physics()
			g._process(0.0)
			g._on_tail_process()
		best = minf(best, float(Time.get_ticks_usec() - t - loop) / FRAMES)
		g._close_window()  # a window as long as a real one, not 200,000 frames

	var closes := []
	var flushes := []
	for k in 8:
		for i in 300:
			g._process(0.0)
		g.track("pickup", "coin")
		t = Time.get_ticks_usec()
		g._close_window()
		closes.append(Time.get_ticks_usec() - t)
		t = Time.get_ticks_usec()
		g.flush()
		flushes.append(Time.get_ticks_usec() - t)
		g._outbox.clear()  # as if sent

	var events := 0
	var loops := 0
	while events < 3900:
		for i in 300:
			g._process(0.0)
		loops += 1
		for j in 19:  # a name a loop, under the 20 a second that would warn to use count()
			g.track("pickup_%d" % loops, {"item": "coin", "n": j})
		g.flush()
		events = 0
		for b: Dictionary in g._outbox:
			events += b.events.size()
	var saves := []
	for k in 3:
		t = Time.get_ticks_usec()
		g._save_outbox()
		saves.append(Time.get_ticks_usec() - t)

	print("Godot %s, %s build, %s" % [Engine.get_version_info().string, "debug" if OS.is_debug_build() else "release", OS.get_processor_name()])
	print("each frame: %.1f us" % best)
	print("window close (every 5 s): %s us" % str(closes))
	print("flush (every 15 s): %s us" % str(flushes))
	print("save with %d events waiting offline: %s us" % [events, str(saves)])
	g._shut = true  # as if closed already: no session_end is saved for the next launch to send
	g._outbox.clear()
	g._save_outbox()  # and no outbox is left behind
	g.queue_free()
	await process_frame
	quit()

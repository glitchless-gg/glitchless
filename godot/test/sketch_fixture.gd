extends SceneTree
## Writes test/fixtures/sketch.json: a few thousand frame times and the sketch
## that addons/glitchless/sketch.gd makes of them. server/test/godot-sketch.test.js
## checks that the JavaScript sketch puts every value in the same bucket and
## that the server merges the GDScript sketch like its own.
##   godot --headless --path godot --script res://test/sketch_fixture.gd

const Sketch := preload("res://addons/glitchless/sketch.gd")


func _init() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 42
	var values: Array[float] = [0.0, 0.0004, 0.001, 0.0011, 1.0, 8.3333, 16.6667, 33.3333, 50.0, 700.0, 5000.0]
	for i in 2000:
		# Mostly smooth 60 Hz frames, one in forty a stutter.
		values.append(rng.randf_range(40.0, 300.0) if i % 40 == 0 else rng.randf_range(6.0, 20.0))
	var sk := Sketch.new()
	for v in values:
		sk.add(v)
	var q := {}
	for p: float in [0.1, 0.5, 0.9, 0.95, 0.99]:
		q[str(p)] = sk.quantile(p)
	var out := {
		"engine": Engine.get_version_info().string,
		"values": values,
		"sketch": sk.to_json(),
		"quantiles": q,
		"fraction_above_19_17": sk.fraction_above(19.17),
	}
	var f := FileAccess.open("res://test/fixtures/sketch.json", FileAccess.WRITE)
	f.store_string(JSON.stringify(out, "", true, true) + "\n")  # full precision, so JavaScript reads the same numbers
	f.close()
	print("wrote test/fixtures/sketch.json: %d values, %d buckets" % [values.size(), sk.bins.size()])
	quit()

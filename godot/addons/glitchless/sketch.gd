extends RefCounted
## A small DDSketch-style quantile sketch, a port of packages/sdk/src/sketch.js.
##
## Frame times have long tails, so an average of each session's p95 means
## nothing. Each frame window sends this log-bucketed histogram instead; the
## Glitchless server merges them and reads percentiles to within 2% of the true
## value. The bucket numbers must match the JavaScript sketch exactly, or the
## server would merge buckets that mean different things:
## godot/test/sketch_test.gd and packages/sdk/test/godot-sketch.test.js check it.

const DEFAULT_ALPHA := 0.02

var a: float
var gamma: float
var ln_gamma: float
var bins := {}  # bucket index (int) -> how many samples fell in it
var n := 0
var zeros := 0
var sum := 0.0
var min_v := INF
var max_v := -INF


func _init(alpha: float = DEFAULT_ALPHA) -> void:
	a = alpha
	gamma = (1.0 + alpha) / (1.0 - alpha)
	ln_gamma = log(gamma)


func index(v: float) -> int:
	return int(ceil(log(v) / ln_gamma))


func value(i: int) -> float:
	return 2.0 * pow(gamma, i) / (gamma + 1.0)


func add(v: float, count: int = 1) -> void:
	if not (v >= 0.0):
		return
	if v < 1e-3:
		zeros += count
	else:
		var i := index(v)
		bins[i] = int(bins.get(i, 0)) + count
	n += count
	sum += v * count
	min_v = minf(min_v, v)
	max_v = maxf(max_v, v)


## Adds another sketch, or the dictionary one sends (to_json()), into this one.
func merge(other: Variant) -> void:
	var o: Dictionary = other.to_json() if other is RefCounted else other
	if o.is_empty() or int(o.get("n", 0)) == 0:
		return
	var b: Dictionary = o.get("b", {})
	for k: Variant in b:
		var i := int(k)
		bins[i] = int(bins.get(i, 0)) + int(b[k])
	n += int(o.n)
	zeros += int(o.get("z", 0))
	sum += float(o.get("s", 0.0))
	if o.get("mn") != null:
		min_v = minf(min_v, float(o.mn))
	if o.get("mx") != null:
		max_v = maxf(max_v, float(o.mx))


## The value at quantile q (0.5 is the median), or null with no samples.
func quantile(q: float) -> Variant:
	if n == 0:
		return null
	var rank := q * (n - 1)
	var acc := float(zeros)
	if acc > rank:
		return 0.0
	var keys := bins.keys()
	keys.sort()
	for k: int in keys:
		acc += bins[k]
		if acc > rank:
			return clampf(value(k), min_v, max_v)
	return max_v


## The share of samples above a threshold, such as frames over budget.
func fraction_above(threshold: float) -> float:
	if n == 0:
		return 0.0
	var cut := index(threshold)
	var above := 0
	for k: int in bins:
		if k > cut:
			above += bins[k]
	return float(above) / n


## The dictionary that goes on the wire as frame_window.ft. Bucket numbers
## become string keys, as JSON needs.
func to_json() -> Dictionary:
	var b := {}
	for k: int in bins:
		b[str(k)] = bins[k]
	return {
		"a": a,
		"b": b,
		"n": n,
		"z": zeros,
		"s": snappedf(sum, 0.1),
		"mn": snappedf(min_v, 0.01) if n > 0 else null,
		"mx": snappedf(max_v, 0.01) if n > 0 else null,
	}

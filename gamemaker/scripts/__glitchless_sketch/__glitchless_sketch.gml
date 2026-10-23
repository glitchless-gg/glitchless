// Feather disable all
/// Glitchless: a small DDSketch-style quantile sketch, a port of packages/sdk/src/sketch.js.
///
/// Frame times have long tails, so an average of each session's p95 means nothing. Each frame
/// window sends this log-bucketed histogram instead; the Glitchless server merges them and reads
/// percentiles to within 2% of the true value. The bucket numbers must match the JavaScript sketch
/// exactly, or the server would merge buckets that mean different things:
/// gamemaker/test/core.test.mjs checks this file against the JavaScript sketch, and
/// gamemaker/test/e2e.mjs checks the sketch a real GameMaker run makes.
///
/// A sketch is a plain struct; bucket indexes are its `bins` struct's keys, as strings.

#macro __GLITCHLESS_SKETCH_ALPHA 0.02

function __glitchless_sketch_new(_alpha = __GLITCHLESS_SKETCH_ALPHA) {
    var _gamma = (1 + _alpha) / (1 - _alpha);
    return { a: _alpha, gamma: _gamma, ln_gamma: ln(_gamma), bins: {}, n: 0, zeros: 0, sum: 0, mn: infinity, mx: -infinity };
}

function __glitchless_sketch_index(_sk, _v) {
    return ceil(ln(_v) / _sk.ln_gamma);
}

function __glitchless_sketch_value(_sk, _i) {
    return 2 * power(_sk.gamma, _i) / (_sk.gamma + 1);
}

function __glitchless_sketch_add(_sk, _v, _count = 1) {
    if (!(_v >= 0)) return;
    if (_v < 0.001) {
        _sk.zeros += _count;
    } else {
        var _k = string(__glitchless_sketch_index(_sk, _v));
        var _had = _sk.bins[$ _k];
        _sk.bins[$ _k] = is_undefined(_had) ? _count : _had + _count;
    }
    _sk.n += _count;
    _sk.sum += _v * _count;
    _sk.mn = min(_sk.mn, _v);
    _sk.mx = max(_sk.mx, _v);
}

/// The bucket indexes in order, as numbers.
function __glitchless_sketch_keys(_sk) {
    var _names = variable_struct_get_names(_sk.bins);
    var _keys = array_create(array_length(_names), 0);
    for (var _i = 0; _i < array_length(_names); _i++) _keys[_i] = real(_names[_i]);
    array_sort(_keys, true);
    return _keys;
}

/// The value at quantile `_q` (0.5 is the median), or undefined with no samples.
function __glitchless_sketch_quantile(_sk, _q) {
    if (_sk.n == 0) return undefined;
    var _rank = _q * (_sk.n - 1);
    var _acc = _sk.zeros;
    if (_acc > _rank) return 0;
    var _keys = __glitchless_sketch_keys(_sk);
    for (var _i = 0; _i < array_length(_keys); _i++) {
        _acc += _sk.bins[$ string(_keys[_i])];
        if (_acc > _rank) return clamp(__glitchless_sketch_value(_sk, _keys[_i]), _sk.mn, _sk.mx);
    }
    return _sk.mx;
}

/// The share of samples above a threshold, such as frames over budget.
function __glitchless_sketch_fraction_above(_sk, _threshold) {
    if (_sk.n == 0) return 0;
    var _cut = __glitchless_sketch_index(_sk, _threshold);
    var _names = variable_struct_get_names(_sk.bins);
    var _above = 0;
    for (var _i = 0; _i < array_length(_names); _i++) {
        if (real(_names[_i]) > _cut) _above += _sk.bins[$ _names[_i]];
    }
    return _above / _sk.n;
}

/// What goes on the wire as frame_window.ft: {a, b, n, z, s, mn, mx}.
function __glitchless_sketch_json(_sk) {
    var _b = {};
    var _names = variable_struct_get_names(_sk.bins);
    for (var _i = 0; _i < array_length(_names); _i++) _b[$ _names[_i]] = _sk.bins[$ _names[_i]];
    return {
        a: _sk.a,
        b: _b,
        n: _sk.n,
        z: _sk.zeros,
        s: __glitchless_round(_sk.sum, 0.1),
        mn: _sk.n > 0 ? __glitchless_round(_sk.mn, 0.01) : undefined,
        mx: _sk.n > 0 ? __glitchless_round(_sk.mx, 0.01) : undefined
    };
}

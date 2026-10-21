// A tiny DDSketch-style quantile sketch.
//
// Frame times are heavy-tailed, so averaging per-session p95s gives you a number that
// means nothing. Instead every client ships a mergeable log-bucketed histogram; the server
// merges them and reads global percentiles with a guaranteed relative error of `a` (2%).
// Same idea as Datadog distribution metrics (https://arxiv.org/abs/1908.10693).

export const DEFAULT_ALPHA = 0.02;

export class Sketch {
  constructor(alpha = DEFAULT_ALPHA) {
    this.a = alpha;
    this.gamma = (1 + alpha) / (1 - alpha);
    this.lnGamma = Math.log(this.gamma);
    this.bins = new Map();
    this.n = 0;
    this.zeros = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  index(v) {
    return Math.ceil(Math.log(v) / this.lnGamma);
  }

  value(i) {
    return (2 * Math.pow(this.gamma, i)) / (this.gamma + 1);
  }

  add(v, count = 1) {
    if (!(v >= 0)) return;
    if (v < 1e-3) this.zeros += count;
    else {
      const i = this.index(v);
      this.bins.set(i, (this.bins.get(i) || 0) + count);
    }
    this.n += count;
    this.sum += v * count;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  merge(other) {
    const o = other instanceof Sketch ? other.toJSON() : other;
    if (!o || !o.n) return this;
    for (const [k, c] of Object.entries(o.b || {})) {
      const i = Number(k);
      this.bins.set(i, (this.bins.get(i) || 0) + c);
    }
    this.n += o.n;
    this.zeros += o.z || 0;
    this.sum += o.s || 0;
    if (o.mn != null && o.mn < this.min) this.min = o.mn;
    if (o.mx != null && o.mx > this.max) this.max = o.mx;
    return this;
  }

  quantile(q) {
    if (!this.n) return null;
    const rank = q * (this.n - 1);
    let acc = this.zeros;
    if (acc > rank) return 0;
    const keys = [...this.bins.keys()].sort((x, y) => x - y);
    for (const k of keys) {
      acc += this.bins.get(k);
      if (acc > rank) return clamp(this.value(k), this.min, this.max);
    }
    return this.max;
  }

  mean() {
    return this.n ? this.sum / this.n : null;
  }

  // Fraction of samples strictly above a threshold (e.g. share of frames over budget).
  fractionAbove(threshold) {
    if (!this.n) return 0;
    const cut = this.index(threshold);
    let above = 0;
    for (const [k, c] of this.bins) if (k > cut) above += c;
    return above / this.n;
  }

  // Counts per [edges[i], edges[i+1]) bucket, for distribution charts.
  histogram(edges) {
    const counts = new Array(edges.length - 1).fill(0);
    for (const [k, c] of this.bins) {
      const v = this.value(k);
      for (let i = 0; i < edges.length - 1; i++) {
        if (v >= edges[i] && (v < edges[i + 1] || i === edges.length - 2)) {
          counts[i] += c;
          break;
        }
      }
    }
    counts[0] += this.zeros;
    return counts;
  }

  toJSON() {
    const b = {};
    for (const [k, c] of this.bins) b[k] = c;
    return {
      a: this.a,
      b,
      n: this.n,
      z: this.zeros,
      s: round(this.sum, 1),
      mn: this.n ? round(this.min, 2) : null,
      mx: this.n ? round(this.max, 2) : null,
    };
  }

  static from(json) {
    return new Sketch(json?.a || DEFAULT_ALPHA).merge(json);
  }
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function round(v, d) {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

using System;
using System.Collections.Generic;
using System.Globalization;

namespace GlitchlessSdk
{
    /// <summary>
    /// A small DDSketch-style quantile sketch, a port of packages/sdk/src/sketch.js.
    ///
    /// Frame times have long tails, so an average of each session's p95 means nothing. Each frame
    /// window sends this log-bucketed histogram instead; the Glitchless server merges them and reads
    /// percentiles to within 2% of the true value. The bucket numbers must match the JavaScript sketch
    /// exactly, or the server would merge buckets that mean different things: the EditMode test
    /// SketchTests checks it against a fixture the JavaScript sketch wrote.
    /// </summary>
    public sealed class Sketch
    {
        public const double DefaultAlpha = 0.02;

        readonly double alpha;
        readonly double gamma;
        readonly double lnGamma;
        readonly Dictionary<int, long> bins = new Dictionary<int, long>();

        public long N { get; private set; }
        public long Zeros { get; private set; }
        public double Sum { get; private set; }
        public double Min { get; private set; } = double.PositiveInfinity;
        public double Max { get; private set; } = double.NegativeInfinity;

        public Sketch(double alpha = DefaultAlpha)
        {
            this.alpha = alpha;
            gamma = (1 + alpha) / (1 - alpha);
            lnGamma = Math.Log(gamma);
        }

        public int Index(double v) => (int)Math.Ceiling(Math.Log(v) / lnGamma);

        public double Value(int i) => 2 * Math.Pow(gamma, i) / (gamma + 1);

        public void Add(double v, long count = 1)
        {
            if (!(v >= 0)) return;
            if (v < 1e-3) Zeros += count;
            else
            {
                var i = Index(v);
                bins.TryGetValue(i, out var c);
                bins[i] = c + count;
            }
            N += count;
            Sum += v * count;
            if (v < Min) Min = v;
            if (v > Max) Max = v;
        }

        /// <summary>The value at quantile q (0.5 is the median), or null with no samples.</summary>
        public double? Quantile(double q)
        {
            if (N == 0) return null;
            var rank = q * (N - 1);
            double acc = Zeros;
            if (acc > rank) return 0;
            var keys = new List<int>(bins.Keys);
            keys.Sort();
            foreach (var k in keys)
            {
                acc += bins[k];
                if (acc > rank) return Math.Min(Math.Max(Value(k), Min), Max);
            }
            return Max;
        }

        /// <summary>The share of samples above a threshold, such as frames over budget.</summary>
        public double FractionAbove(double threshold)
        {
            if (N == 0) return 0;
            var cut = Index(threshold);
            long above = 0;
            foreach (var kv in bins)
                if (kv.Key > cut) above += kv.Value;
            return (double)above / N;
        }

        /// <summary>What goes on the wire as frame_window.ft.</summary>
        public Dictionary<string, object> ToJson()
        {
            var b = new Dictionary<string, object>();
            foreach (var kv in bins) b[kv.Key.ToString(CultureInfo.InvariantCulture)] = kv.Value;
            return new Dictionary<string, object>
            {
                ["a"] = alpha,
                ["b"] = b,
                ["n"] = N,
                ["z"] = Zeros,
                ["s"] = Round(Sum, 1),
                ["mn"] = N > 0 ? (object)Round(Min, 2) : null,
                ["mx"] = N > 0 ? (object)Round(Max, 2) : null,
            };
        }

        /// <summary>Rounds the way JavaScript's Math.round does (halves go up), so both SDKs send the same.</summary>
        public static double Round(double v, int digits)
        {
            var m = Math.Pow(10, digits);
            return Math.Floor(v * m + 0.5) / m;
        }
    }
}

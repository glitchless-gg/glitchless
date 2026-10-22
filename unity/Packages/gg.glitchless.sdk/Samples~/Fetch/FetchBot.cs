using System;
using System.Collections.Generic;

namespace GlitchlessSamples.Fetch
{
    /// <summary>
    /// The autoplay bot, a port of the Phaser demo's: it picks a takeoff point for each hazard ahead,
    /// then misses it by a random amount that grows as skill drops. Same seed, same run.
    /// </summary>
    public sealed class FetchBot
    {
        const float Airtime = 0.8f; // jump speed 7.2 m/s against gravity 18 m/s²

        readonly Random rng;
        readonly float sigma;
        public readonly float Skill;
        readonly Dictionary<string, float> offsets = new Dictionary<string, float>();
        readonly List<int> deathSpots = new List<int>();

        public FetchBot(float skill, int seed)
        {
            Skill = skill;
            rng = new Random(seed);
            sigma = (6 + (1 - skill) * 70) / 100f; // metres of takeoff error
        }

        float Gauss()
        {
            var u = 1 - rng.NextDouble();
            var v = rng.NextDouble();
            return (float)(Math.Sqrt(-2 * Math.Log(u)) * Math.Cos(2 * Math.PI * v));
        }

        public void NewAttempt() => offsets.Clear();

        struct Hazard
        {
            public string Id;
            public float X, End, Takeoff;
        }

        public bool WantsJump(float x, float speed, bool grounded, FetchLevel level, IEnumerable<(int id, float x)> squirrels)
        {
            if (!grounded) return false;
            var reach = speed * Airtime;
            var list = new List<Hazard>();
            foreach (var p in level.Pits) list.Add(new Hazard { Id = "pit" + p[0], X = p[0], End = p[1], Takeoff = p[0] - (reach - (p[1] - p[0])) / 2 });
            foreach (var h in level.Hydrants) list.Add(new Hazard { Id = "hyd" + h, X = h - 0.12f, End = h + 0.12f, Takeoff = h - reach / 2 });
            foreach (var (id, sx) in squirrels)
                if (sx > x) list.Add(new Hazard { Id = "sq" + id, X = sx - 0.16f, End = sx + 0.16f, Takeoff = sx - reach * 0.45f });
            list.Sort((a, b) => a.X.CompareTo(b.X));
            var next = list.Find(h => h.End > x);
            if (next.Id == null) return false;
            if (!offsets.TryGetValue(next.Id, out var off)) offsets[next.Id] = off = Gauss() * sigma;
            // Missed the planned spot but the hazard is still ahead: jump now, late.
            return x >= next.Takeoff + off && x < next.X + 0.04f;
        }

        /// <summary>Low-skill bots give up after dying three times in the same place.</summary>
        public bool Died(float x)
        {
            var spot = (int)Math.Round(x / 1.2f);
            deathSpots.Add(spot);
            return Skill < 0.5f && deathSpots.FindAll(s => s == spot).Count >= 3;
        }
    }
}

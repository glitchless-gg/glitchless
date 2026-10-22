using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;

namespace GlitchlessSdk.Tests
{
    /// <summary>
    /// The C# sketch and fingerprint must agree with the JavaScript SDK bit for bit: the server merges
    /// sketches from every SDK and groups errors by fingerprint. Fixtures/js-fixture.json is written by
    /// unity/test/make-fixtures.mjs from packages/sdk/src.
    /// </summary>
    public class ParityTests
    {
        static Dictionary<string, object> fixture;

        static Dictionary<string, object> Fixture
        {
            get
            {
                if (fixture != null) return fixture;
                var package = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(Sketch).Assembly);
                var file = Path.Combine(package.resolvedPath, "Tests/Editor/Fixtures/js-fixture.json");
                return fixture = (Dictionary<string, object>)Json.Parse(File.ReadAllText(file));
            }
        }

        static Sketch FromFixture()
        {
            var sk = new Sketch();
            foreach (var v in (List<object>)Fixture["values"]) sk.Add((double)v);
            return sk;
        }

        [Test]
        public void SketchPutsEveryValueInTheJavaScriptBucket()
        {
            var sk = new Sketch();
            foreach (var pair in ((List<object>)Fixture["indexes"]).Cast<List<object>>())
                Assert.AreEqual((int)(double)pair[1], sk.Index((double)pair[0]), $"index of {pair[0]}");
        }

        [Test]
        public void SketchSendsWhatTheJavaScriptSketchSends()
        {
            var cs = FromFixture().ToJson();
            var js = (Dictionary<string, object>)Fixture["sketch"];
            Assert.AreEqual(js["a"], cs["a"]);
            Assert.AreEqual(js["n"], (double)(long)cs["n"]);
            Assert.AreEqual(js["z"], (double)(long)cs["z"]);
            Assert.AreEqual(js["s"], cs["s"]);
            Assert.AreEqual(js["mn"], cs["mn"]);
            Assert.AreEqual(js["mx"], cs["mx"]);
            var jb = (Dictionary<string, object>)js["b"];
            var cb = (Dictionary<string, object>)cs["b"];
            CollectionAssert.AreEquivalent(jb.Keys, cb.Keys);
            foreach (var k in jb.Keys) Assert.AreEqual(jb[k], (double)(long)cb[k], $"bucket {k}");
            // And it survives the trip through JSON the way the server reads it.
            var round = (Dictionary<string, object>)Json.Parse(Json.Serialize(cs));
            Assert.AreEqual(jb.Count, ((Dictionary<string, object>)round["b"]).Count);
        }

        [Test]
        public void QuantilesMatch()
        {
            var sk = FromFixture();
            foreach (var kv in (Dictionary<string, object>)Fixture["quantiles"])
                Assert.AreEqual((double)kv.Value, sk.Quantile(double.Parse(kv.Key, System.Globalization.CultureInfo.InvariantCulture)).Value, 1e-9, $"q{kv.Key}");
            Assert.AreEqual((double)Fixture["fraction_above_19_17"], sk.FractionAbove(19.17), 1e-12);
        }

        [Test]
        public void FingerprintsMatch()
        {
            foreach (var o in (List<object>)Fixture["fingerprints"])
            {
                var f = (Dictionary<string, object>)o;
                Assert.AreEqual(f["normalized"], Fingerprint.NormalizeMessage((string)f["message"]));
                Assert.AreEqual(f["fingerprint"], Fingerprint.Of((string)f["kind"], (string)f["message"], (string)f["fn"]), (string)f["message"]);
            }
        }

        [Test]
        public void JsonWritesAndReadsBack()
        {
            var value = new Dictionary<string, object>
            {
                ["s"] = "quote \" backslash \\ newline \n tab \t control \u0001 émoji 🐶",
                ["n"] = 16.78,
                ["i"] = 42,
                ["l"] = 1761000000000L,
                ["nan"] = double.NaN,
                ["b"] = true,
                ["null"] = null,
                ["list"] = new List<object> { 1, "two", new[] { 3, 4 } },
                ["raw"] = new Json.Raw("{\"x\":1}"),
            };
            var text = Json.Serialize(value);
            StringAssert.Contains("\"n\":16.78", text);
            StringAssert.Contains("\"l\":1761000000000", text);
            StringAssert.Contains("\"nan\":null", text);
            var back = (Dictionary<string, object>)Json.Parse(text);
            Assert.AreEqual(value["s"], back["s"]);
            Assert.AreEqual(16.78, back["n"]);
            Assert.AreEqual(1761000000000.0, back["l"]);
            Assert.IsNull(back["nan"]);
            Assert.AreEqual(1.0, ((Dictionary<string, object>)back["raw"])["x"]);
            Assert.Throws<System.FormatException>(() => Json.Parse("{\"a\":"));
        }
    }
}

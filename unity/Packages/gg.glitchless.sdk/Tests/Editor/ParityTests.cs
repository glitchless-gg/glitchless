using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;

namespace GlitchlessSdk.Tests
{
    /// <summary>
    /// The C# sketch and fingerprint must agree with the JavaScript SDK bit for bit: the server merges
    /// sketches from every SDK and groups errors by fingerprint. So must a web build's reading of its page.
    /// Fixtures/js-fixture.json is written by unity/test/make-fixtures.mjs from packages/sdk/src.
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

        // A Unity web build reads its page as the browser SDK does (WebPage.cs, device.js), so the two split by browser
        // and OS alike. The fixture's user agents include the browser SDK's quirks (Edge and Opera read as Chrome):
        // a change to either side shows up here.
        [Test]
        public void UserAgentsReadAsTheBrowserSdkReadsThem()
        {
            var agents = ((List<object>)Fixture["user_agents"]).Cast<Dictionary<string, object>>().ToList();
            Assert.Greater(agents.Count, 10);
            foreach (var a in agents)
            {
                var ua = (string)a["ua"];
                var f = WebPage.ParseUserAgent(ua, a["uad_mobile"] as bool?);
                Assert.AreEqual(a["browser"], f.Browser, $"browser of {ua}");
                Assert.AreEqual((string)a["browser_version"] == "" ? null : a["browser_version"], f.BrowserVersion, $"version of {ua}");
                Assert.AreEqual(a["os"], f.Os, $"os of {ua}");
                Assert.AreEqual(a["mobile"], f.Mobile, $"mobile for {ua}");
            }
        }

        [Test]
        public void SteamDecksInABrowserAsTheBrowserSdkSeesThem()
        {
            foreach (var d in ((List<object>)Fixture["steam_decks"]).Cast<Dictionary<string, object>>())
                Assert.AreEqual(d["steam_deck"], WebPage.IsSteamDeck((string)d["ua"], (string)d["gpu"]), $"{d["ua"]} on {d["gpu"]}");
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

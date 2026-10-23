using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEngine;

namespace GlitchlessSdk.Tests
{
    /// <summary>Bug reports (SPEC §2 bug_report): what a report carries, how it is sent, and the screenshot fitting.</summary>
    public class BugReportTests
    {
        double now;
        FakeTransport transport;
        string dir;

        [SetUp]
        public void SetUp()
        {
            now = 1000;
            transport = new FakeTransport();
            dir = Path.Combine(Path.GetTempPath(), "glitchless-tests-" + Guid.NewGuid().ToString("N"));
        }

        [TearDown]
        public void TearDown()
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }

        GlitchlessCore NewCore(GlitchlessOptions options)
        {
            var core = new GlitchlessCore
            {
                Transport = transport,
                SaveDir = dir,
                Clock = () => now,
                UnixNow = () => 1_761_000_000_000L + (long)now,
                Args = () => new string[0],
                Log = _ => { },
                Device = DeviceInfo.Collect,
                AppVersion = "1.2.3",
                IsDebugBuild = true,
            };
            core.Init(options);
            return core;
        }

        static GlitchlessOptions Options() => new GlitchlessOptions { Service = "Fetch", Intake = "http://localhost:7777/" };

        void Frames(GlitchlessCore core, int count, double dt = 16.7)
        {
            for (var i = 0; i < count; i++)
            {
                now += dt;
                core.Frame(dt, new FrameCost { Process = 2, Physics = 1, Render = 3, Gpu = -1, Calls = 40, Triangles = 9000, SetPass = 12, Batches = 30, ShaderCompiles = 0, ObjectsAdded = 0, GcAllocKb = 1.5 });
            }
        }

        static List<Dictionary<string, object>> EventsOf(string body) => ((List<object>)((Dictionary<string, object>)Json.Parse(body))["events"]).Cast<Dictionary<string, object>>().ToList();

        (bool sent, string reason)? result;
        void Done(bool sent, string reason) => result = (sent, reason);

        [Test]
        public void AReportGoesOnARequestOfItsOwnStraightAway()
        {
            var core = NewCore(Options());
            core.LevelStart("level-2");
            Frames(core, 400); // a window closes on the way
            core.Track("powerup", new Dictionary<string, object> { ["what"] = "magnet" });
            core.Death(1, 2, 0, "squirrel");
            Frames(core, 30);
            var snap = core.BugSnapshot();
            core.SendBugReport(snap, "the dog fell through the floor", "data:image/jpeg;base64,AAAA", Done);
            Assert.AreEqual((true, (string)null), result);
            var last = EventsOf(transport.Sent.Last());
            Assert.AreEqual(1, last.Count, "the report goes alone");
            var e = last[0];
            Assert.AreEqual("bug_report", e["type"]);
            Assert.AreEqual("the dog fell through the floor", e["note"]);
            Assert.AreEqual("data:image/jpeg;base64,AAAA", e["screenshot"]);
            Assert.AreEqual("level-2", e["level"]);
            Assert.AreEqual(snap["ts"], (long)(double)e["ts"]);
            Assert.IsFalse(e.ContainsKey("x"), "anonymous mode without positions sends no place");
            Assert.IsInstanceOf<Dictionary<string, object>>(e["device"]);
            var recent = ((List<object>)e["recent"]).Cast<Dictionary<string, object>>().ToList();
            CollectionAssert.AreEqual(new[] { "level_start", "custom", "death" }, recent.Select(r => r["type"]).ToList());
            Assert.AreEqual("powerup", recent[1]["name"]);
            Assert.AreEqual("magnet", ((Dictionary<string, object>)recent[1]["attrs"])["what"]);
            Assert.AreEqual("squirrel", recent[2]["cause"]);
            var frames = ((List<object>)e["frames"]).Cast<Dictionary<string, object>>().ToList();
            Assert.AreEqual(2, frames.Count, "the closed window and the one still open");
            foreach (var f in frames)
            {
                Assert.AreEqual("level-2", f["level"]);
                Assert.Greater((double)f["fps"], 50);
                Assert.Greater((double)f["p95"], 16);
            }
            Assert.IsTrue(transport.Sent.Take(transport.Sent.Count - 1).SelectMany(EventsOf).Any(x => (string)x["type"] == "session_start"), "the session's own events went first");
            Assert.AreEqual(0, core.OutboxEvents);
        }

        [Test]
        public void AReportSaysWhereThePlayerStoodWhenPositionsAreOn()
        {
            var o = Options();
            o.Positions = true;
            var core = NewCore(o);
            core.SetPosition(1.234, 5.678, -2);
            var snap = core.BugSnapshot();
            Assert.AreEqual(1.23, snap["x"]);
            Assert.AreEqual(5.68, snap["y"]);
            Assert.AreEqual(-2.0, snap["z"]);
        }

        [Test]
        public void ARecentHitchIsListedWithItsCauses()
        {
            var core = NewCore(Options());
            Frames(core, 120);
            now += 180;
            core.Frame(180, new FrameCost { Process = 150, Physics = 1, Render = 3, Gpu = -1, Calls = 40, Triangles = 9000, SetPass = 12, Batches = 30, ShaderCompiles = 0, ObjectsAdded = 0, GcAllocKb = 1 });
            Frames(core, 5);
            var hitch = ((List<Dictionary<string, object>>)core.BugSnapshot()["recent"]).Single(r => (string)r["type"] == "hitch");
            Assert.AreEqual(180.0, hitch["duration_ms"]);
            CollectionAssert.Contains((List<string>)hitch["causes"], "script");
            Assert.IsFalse(hitch.ContainsKey("ctx"), "slimmed: when, what and why only");
        }

        [Test]
        public void AReportThatCannotGoWaitsInTheOutbox()
        {
            var core = NewCore(Options());
            Frames(core, 30);
            transport.Status = 0;
            core.SendBugReport(core.BugSnapshot(), "stuck in the wall", null, Done);
            Assert.AreEqual((false, "error"), result);
            Assert.Greater(core.OutboxEvents, 0);
            StringAssert.Contains("stuck in the wall", File.ReadAllText(Path.Combine(dir, "outbox.json")), "saved, so it survives the game closing");
            transport.Status = 202;
            transport.Sent.Clear();
            now += 400_000; // past the retry wait
            core.Flush();
            Frames(core, 2);
            Assert.IsTrue(transport.Sent.SelectMany(EventsOf).Any(x => (string)x["type"] == "bug_report" && (string)x["note"] == "stuck in the wall"));
            Assert.AreEqual(0, core.OutboxEvents);
        }

        [Test]
        public void ABuildThatSendsNothingSaysOffline()
        {
            var o = Options();
            o.Intake = "";
            var core = NewCore(o);
            core.SendBugReport(core.BugSnapshot(), "hello", null, Done);
            Assert.AreEqual((false, "offline"), result);
            Assert.IsEmpty(transport.Sent);
        }

        [Test]
        public void SessionsLeftOutBySamplingStillSendReports()
        {
            var o = Options();
            o.SampleRate = 0;
            var core = NewCore(o);
            Frames(core, 30);
            core.SendBugReport(core.BugSnapshot(), "x".PadRight(3000, 'x'), null, Done);
            Assert.AreEqual((true, (string)null), result);
            var sent = transport.Sent.SelectMany(EventsOf).ToList();
            Assert.AreEqual(new[] { "bug_report" }, sent.Select(x => x["type"]).ToArray(), "only the report");
            Assert.AreEqual(GlitchlessCore.MaxNote, ((string)sent[0]["note"]).Length, "the note is cut at 2,000 characters");
        }

        [Test]
        public void EventsAreSlimmedToWhatSaysWhatHappened()
        {
            var slim = GlitchlessCore.Slim(new Dictionary<string, object>
            {
                ["type"] = "error", ["ts"] = 5L, ["level"] = "l1", ["kind"] = "exception", ["message"] = new string('m', 500),
                ["stack"] = "at a", ["fingerprint"] = "abc", ["recent"] = new List<string> { "jump" }, ["attrs"] = new Dictionary<string, object> { ["slot"] = 2 },
            });
            CollectionAssert.AreEquivalent(new[] { "ts", "type", "level", "kind", "message", "attrs" }, slim.Keys);
            Assert.AreEqual(200, ((string)slim["message"]).Length);
            var big = GlitchlessCore.Slim(new Dictionary<string, object> { ["type"] = "custom", ["ts"] = 6L, ["name"] = "buy", ["attrs"] = new Dictionary<string, object> { ["what"] = new string('y', 400) } });
            Assert.IsFalse(big.ContainsKey("attrs"), "attributes over 300 characters are left out");
        }

        // ───────────────────────────── the screenshot ─────────────────────────────

        static Color32[] Noise(int w, int h)
        {
            var rng = new System.Random(7);
            var px = new Color32[w * h];
            for (var i = 0; i < px.Length; i++) px[i] = new Color32((byte)rng.Next(256), (byte)rng.Next(256), (byte)rng.Next(256), 255);
            return px;
        }

        static Texture2D Decode(string url)
        {
            StringAssert.StartsWith("data:image/jpeg;base64,", url);
            var tex = new Texture2D(2, 2);
            Assert.IsTrue(tex.LoadImage(Convert.FromBase64String(url.Substring(url.IndexOf(',') + 1))), "a JPEG");
            return tex;
        }

        [Test]
        public void AScreenshotShrinksUntilItFits()
        {
            var url = BugScreenshot.Fit(Noise(1920, 1080), 1920, 1080);
            Assert.IsNotNull(url);
            Assert.LessOrEqual(url.Length, BugScreenshot.MaxChars);
            var tex = Decode(url);
            Assert.LessOrEqual(tex.width, 960);
            Assert.AreEqual(Math.Round(tex.width * 1080.0 / 1920), tex.height, 1, "the aspect ratio stays");
            UnityEngine.Object.DestroyImmediate(tex);

            var portrait = Decode(BugScreenshot.Fit(Noise(1080, 1920), 1080, 1920));
            Assert.LessOrEqual(portrait.height, 960, "the longer side");
            UnityEngine.Object.DestroyImmediate(portrait);
        }

        [Test]
        public void ASmallScreenshotKeepsItsSizeAndWayUp()
        {
            // Bottom half blue, top half red, in Unity's order (bottom row first).
            var px = new Color32[200 * 100];
            for (var i = 0; i < px.Length; i++) px[i] = i / 200 < 50 ? new Color32(0, 0, 255, 255) : new Color32(255, 0, 0, 255);
            var tex = Decode(BugScreenshot.Fit(px, 200, 100));
            Assert.AreEqual(200, tex.width);
            Assert.AreEqual(100, tex.height);
            Assert.Greater(tex.GetPixel(100, 90).r, 0.8f, "red stays on top");
            Assert.Greater(tex.GetPixel(100, 10).b, 0.8f, "blue stays at the bottom");
            UnityEngine.Object.DestroyImmediate(tex);
        }

        [Test]
        public void AScreenshotThatNeverFitsIsLeftOut()
        {
            Assert.IsNull(BugScreenshot.Fit(Noise(640, 360), 640, 360, 2000));
            Assert.IsNull(BugScreenshot.Fit(null, 10, 10));
            Assert.IsNull(BugScreenshot.Fit(new Color32[4], 10, 10), "fewer pixels than the size says");
        }
    }
}

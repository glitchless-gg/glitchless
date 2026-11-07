using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEngine;

namespace GlitchlessSdk.Tests
{
    /// <summary>Level maps (Glitchless.CaptureMap) without rendering: the picture's size, where the camera stands, the rows'
    /// order, and the core sending a level's map once per version from a device. MapCaptureTests renders them.</summary>
    public class MapTests
    {
        double now;
        FakeTransport transport;
        string dir;

        [SetUp]
        public void SetUp()
        {
            now = 1000;
            transport = new FakeTransport();
            dir = Path.Combine(Path.GetTempPath(), "glitchless-map-tests-" + Guid.NewGuid().ToString("N"));
        }

        [TearDown]
        public void TearDown()
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }

        GlitchlessCore NewCore(bool remember = true) => new GlitchlessCore
        {
            Transport = transport,
            SaveDir = dir,
            Clock = () => now,
            UnixNow = () => 1_761_000_000_000L + (long)now,
            Args = () => Array.Empty<string>(),
            Log = _ => { },
            AppVersion = "1.2.3",
            IsDebugBuild = true,
            RememberMaps = remember,
        };

        static GlitchlessOptions Options(string version = "1.0.0", bool positions = true) => new GlitchlessOptions { Service = "maps", Intake = "http://localhost:7777", Version = version, Positions = positions };

        const string Image = "data:image/jpeg;base64,/9j/4AAQ";

        static List<Dictionary<string, object>> Maps(IEnumerable<Dictionary<string, object>> events) => events.Where(e => (string)e["type"] == "map").ToList();

        // ───────────── the picture's size ─────────────

        // packages/sdk/src/three.js captureMap: w = width || (aspect > 4 ? 1024 : 640); h = max(48, min(640, round(w / aspect))).
        static (int, int) BrowserSize(double spanA, double spanB, int width)
        {
            var aspect = spanA / spanB;
            var w = width > 0 ? width : aspect > 4 ? 1024 : 640;
            return (w, Math.Max(48, Math.Min(640, (int)Math.Round(w / aspect, MidpointRounding.AwayFromZero))));
        }

        [TestCase(96, 18, 0)]
        [TestCase(32, 18, 0)]
        [TestCase(300, 20, 0)]
        [TestCase(50, 30, 0)]
        [TestCase(10, 10, 0)]
        [TestCase(100, 50, 800)]
        [TestCase(64, 18, 0)]
        public void AWideLevelIsTheSizeTheBrowserSdkMakesIt(double w, double h, int width)
        {
            Assert.AreEqual(BrowserSize(w, h, width), MapCapture.Size(w, h, width));
        }

        [Test]
        public void ATallLevelGetsTheHeightAndItsWidthFollows()
        {
            Assert.AreEqual((192, 1024), MapCapture.Size(18, 96, 0), "more than 4 times taller than wide: 1024 tall");
            Assert.AreEqual((320, 640), MapCapture.Size(18, 36, 0));
            Assert.AreEqual((1024, 48), MapCapture.Size(2000, 10, 0), "never under 48 pixels");
            Assert.AreEqual((1024, 512), MapCapture.Size(100, 50, 4000), "never over 1024");
        }

        // ───────────── what CaptureMap was given ─────────────

        [Test]
        public void ARectIsASideViewAndBoundsAreSeenFromAbove()
        {
            var side = MapRequest.From("room", new Rect(0, 0, 96, 18), null);
            Assert.AreEqual(MapAxis.XY, side.Axis);
            Assert.AreEqual((0.0, 0.0, 96.0, 18.0), (side.MinA, side.MinB, side.MaxA, side.MaxB));
            Assert.IsNull(side.Near, "a rect says nothing of z: the camera sees it all");

            var top = MapRequest.From("arena", new Bounds(new Vector3(25, 2, 15), new Vector3(50, 4, 30)), null);
            Assert.AreEqual(MapAxis.XZ, top.Axis);
            Assert.AreEqual((0.0, 0.0, 50.0, 30.0), (top.MinA, top.MinB, top.MaxA, top.MaxB), "x and z");
            Assert.AreEqual((0.0, 4.0), (top.Near.Value, top.Far.Value), "its height: how far down the camera sees");

            var flat = MapRequest.From("arena", new Bounds(new Vector3(0, 0, 0), new Vector3(10, 0, 10)), null);
            Assert.IsNull(flat.Near, "a box with no height sees everything below");

            var sideways = MapRequest.From("hall", new Bounds(new Vector3(50, 5, 0), new Vector3(100, 10, 6)), new MapOptions { Axis = MapAxis.XY });
            Assert.AreEqual(MapAxis.XY, sideways.Axis);
            Assert.AreEqual((0.0, 0.0, 100.0, 10.0), (sideways.MinA, sideways.MinB, sideways.MaxA, sideways.MaxB));
            Assert.AreEqual((-3.0, 3.0), (sideways.Near.Value, sideways.Far.Value), "its depth in z");

            Assert.IsFalse(MapRequest.From("room", new Rect(0, 0, 0, 18), null).Valid, "no width");
            Assert.IsFalse(MapRequest.From(null, new Rect(0, 0, 10, 10), null).Valid);
            Assert.IsFalse(MapRequest.From("room", new Rect(0, 0, float.NaN, 10), null).Valid);
        }

        // ───────────── where the camera stands ─────────────

        // The dashboard (apps/dashboard/src/heatmap.jsx toPx) puts a point at ((a - minA) / spanA) across and, from the
        // top, ((maxB - y) / spanB) for a side view or ((z - minB) / spanB) for a map from above. The camera's viewport (0
        // at the bottom) must agree, after the picture is flipped for XZ (MapCapture.Rgb).
        static Vector2 Dashboard(MapRequest r, double a, double b)
        {
            var x = (a - r.MinA) / (r.MaxA - r.MinA);
            var fromTop = r.Axis == MapAxis.XY ? (r.MaxB - b) / (r.MaxB - r.MinB) : (b - r.MinB) / (r.MaxB - r.MinB);
            return new Vector2((float)x, (float)fromTop);
        }

        static void AssertSees(Camera cam, MapRequest r, Vector3 world, double a, double b)
        {
            var v = cam.WorldToViewportPoint(world);
            var picture = new Vector2(v.x, r.Axis == MapAxis.XZ ? v.y : 1 - v.y); // from the top, once XZ's rows are flipped
            var expected = Dashboard(r, a, b);
            Assert.AreEqual(expected.x, picture.x, 1e-4, $"{world}: across");
            Assert.AreEqual(expected.y, picture.y, 1e-4, $"{world}: down");
            Assert.That(v.z, Is.InRange(cam.nearClipPlane, cam.farClipPlane), $"{world}: between the clip planes");
        }

        [Test]
        public void TheCameraSeesExactlyTheBoundsTheWayTheDashboardDrawsThem()
        {
            var go = new GameObject("map camera test");
            try
            {
                var cam = go.AddComponent<Camera>();
                var side = MapRequest.From("room", new Rect(0, 0, 96, 18), null);
                MapCapture.Place(cam, side);
                Assert.IsTrue(cam.orthographic);
                AssertSees(cam, side, new Vector3(0, 0, 0), 0, 0);
                AssertSees(cam, side, new Vector3(96, 18, 0), 96, 18);
                AssertSees(cam, side, new Vector3(11, 4, 5), 11, 4);
                AssertSees(cam, side, new Vector3(81, 14, -20), 81, 14);
                AssertSees(cam, side, new Vector3(30, 9, 500), 30, 9);

                var top = MapRequest.From("arena", new Bounds(new Vector3(25, 2, 15), new Vector3(50, 4, 30)), null);
                MapCapture.Place(cam, top);
                AssertSees(cam, top, new Vector3(0, 0, 0), 0, 0);
                AssertSees(cam, top, new Vector3(50, 4, 30), 50, 30);
                AssertSees(cam, top, new Vector3(10, 0.5f, 5), 10, 5);
                AssertSees(cam, top, new Vector3(40, 3.9f, 25), 40, 25);
                var roof = cam.WorldToViewportPoint(new Vector3(25, 8, 15));
                Assert.Less(roof.z, cam.nearClipPlane, "above the box's top: behind the camera, left out");

                var open = MapRequest.From("arena", new Rect(-100, -50, 200, 100), new MapOptions { Axis = MapAxis.XZ });
                MapCapture.Place(cam, open);
                AssertSees(cam, open, new Vector3(-100, 0, -50), -100, -50);
                AssertSees(cam, open, new Vector3(60, -200, 20), 60, 20);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        [Test]
        public void RowsStayInOrderForASideViewAndTurnOverFromAbove()
        {
            // Two rows, one pixel each, bottom row first as Unity reads them back: red, then blue.
            var rgba = new byte[] { 255, 0, 0, 255, 0, 0, 255, 255 };
            CollectionAssert.AreEqual(new byte[] { 255, 0, 0, 0, 0, 255 }, MapCapture.Rgb(rgba, 1, 2, false));
            CollectionAssert.AreEqual(new byte[] { 0, 0, 255, 255, 0, 0 }, MapCapture.Rgb(rgba, 1, 2, true));
        }

        // ───────────── sending ─────────────

        [Test]
        public void AMapGoesAsTheBrowserSdkSendsItInABatchOfItsOwn()
        {
            var core = NewCore();
            core.Init(Options());
            core.LevelStart("room-1");
            core.Track("before", null);
            var big = "data:image/jpeg;base64," + new string('A', 59_000);
            Assert.IsTrue(core.WantsMap("room-1"));
            Assert.IsTrue(core.SendMap("room-1", "xy", 0, 0, 96, 18.5, 1024, 197, big));
            core.Track("after", null);
            core.Flush();
            var map = Maps(transport.Events()).Single();
            Assert.AreEqual("room-1", map["level"]);
            Assert.AreEqual("xy", map["axis"]);
            Assert.AreEqual("{\"min\":[0,0],\"max\":[96,18.5]}", Json.Serialize(map["bounds"]));
            Assert.AreEqual("[1024,197]", Json.Serialize(map["size"]));
            Assert.AreEqual(big, map["image"]);
            var batch = transport.Sent.Single(b => b.Contains("\"type\":\"map\""));
            Assert.AreEqual(1, transport.Events(new[] { batch }).Count(), "a map is big: it goes on its own");
            CollectionAssert.IsSubsetOf(new[] { "before", "after" }, transport.Events().Where(e => (string)e["type"] == "custom").Select(e => e["name"]).ToList());
            Assert.IsFalse(((List<Dictionary<string, object>>)core.BugSnapshot()["recent"]).Any(e => (string)e["type"] == "map"), "not one of a bug report's recent events");
        }

        [Test]
        public void ALevelsMapGoesOncePerVersionFromADevice()
        {
            var first = NewCore();
            first.Init(Options("1.0.0"));
            Assert.IsTrue(first.TakeMap("room-1"));
            Assert.IsFalse(first.TakeMap("room-1"), "one capture a level a launch");
            Assert.IsTrue(first.SendMap("room-1", "xy", 0, 0, 32, 18, 640, 360, Image));
            first.Flush();
            Assert.IsFalse(first.WantsMap("room-1"));
            Assert.IsTrue(first.WantsMap("room-2"));
            Assert.AreEqual("1.0.0\nroom-1", File.ReadAllText(Path.Combine(dir, "maps")));

            var again = NewCore();
            again.Init(Options("1.0.0"));
            Assert.IsFalse(again.WantsMap("room-1"), "the next launch of the same version: sent already");
            Assert.IsFalse(again.SendMap("room-1", "xy", 0, 0, 32, 18, 640, 360, Image));
            Assert.IsTrue(again.WantsMap("room-2"));

            var next = NewCore();
            next.Init(Options("1.1.0"));
            Assert.IsTrue(next.WantsMap("room-1"), "a new version: its levels may have changed");
            next.SendMap("room-1", "xy", 0, 0, 32, 18, 640, 360, Image);
            next.Flush();
            Assert.AreEqual("1.1.0\nroom-1", File.ReadAllText(Path.Combine(dir, "maps")));
        }

        [Test]
        public void TheEditorTakesEachLevelsMapAgainEachPlay()
        {
            var core = NewCore(remember: false);
            core.Init(Options());
            core.SendMap("room-1", "xy", 0, 0, 32, 18, 640, 360, Image);
            core.Flush();
            Assert.AreEqual(1, Maps(transport.Events()).Count);
            Assert.IsFalse(File.Exists(Path.Combine(dir, "maps")));
            Assert.IsTrue(NewCore(remember: false).WantsMap("room-1"));
        }

        [Test]
        public void AMapTakenBeforeInitWaitsAndGoesOnlyIfWanted()
        {
            var core = NewCore();
            Assert.IsTrue(core.WantsMap("room-1"), "before Init nothing says no yet");
            Assert.IsTrue(core.SendMap("room-1", "xy", 0, 0, 32, 18, 640, 360, Image));
            Assert.IsTrue(core.SendMap("room-2", "xy", 0, 0, 32, 18, 640, 360, Image));
            Assert.IsEmpty(transport.Sent);
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "maps"), "1.0.0\nroom-2");
            core.Init(Options("1.0.0"));
            core.Flush();
            CollectionAssert.AreEqual(new[] { "room-1" }, Maps(transport.Events()).Select(e => e["level"]).ToList(), "room-2's went from this device already");

            var quiet = new FakeTransport();
            var off = NewCore();
            off.Transport = quiet;
            off.SendMap("room-3", "xy", 0, 0, 32, 18, 640, 360, Image);
            off.Init(Options(positions: false));
            off.Flush();
            Assert.IsEmpty(Maps(quiet.Events()), "positions off: nothing to draw on a map");
            Assert.IsFalse(off.WantsMap("room-4"));
        }

        [Test]
        public void NoMapWithGlitchlessOffOrFromAServer()
        {
            var off = NewCore();
            off.SetEnabled(false);
            Assert.IsFalse(off.WantsMap("room-1"));
            off.Init(Options());
            Assert.IsFalse(off.SendMap("room-1", "xy", 0, 0, 32, 18, 640, 360, Image));

            var server = NewCore();
            server.Init(new GlitchlessOptions { Service = "maps", Intake = "http://localhost:7777", Role = GlitchlessRole.Server, Positions = true });
            Assert.IsFalse(server.WantsMap("room-1"));

            var unsampled = NewCore();
            unsampled.Init(new GlitchlessOptions { Service = "maps", Intake = "http://localhost:7777", Positions = true, SampleRate = 0 });
            Assert.IsFalse(unsampled.WantsMap("room-1"), "a session that sends nothing takes no picture");

            var noIntake = NewCore();
            noIntake.Init(new GlitchlessOptions { Service = "maps", Positions = true });
            Assert.IsFalse(noIntake.WantsMap("room-1"));
        }

        [Test]
        public void AFailedCaptureLetsTheLevelBeTriedAgain()
        {
            var core = NewCore();
            core.Init(Options());
            Assert.IsTrue(core.TakeMap("room-1"));
            core.MapNotTaken("room-1");
            Assert.IsTrue(core.TakeMap("room-1"));
        }
    }
}

using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.TestTools;

namespace GlitchlessSdk.Tests
{
    /// <summary>
    /// Glitchless.CaptureMap rendering for real, in whichever pipeline the project has (unity/test/map.mjs runs these in
    /// the built-in pipeline and in URP with its 2D and Universal renderers): a 2D side view of sprites and a 3D level from
    /// above, each decoded and read where the dashboard (apps/dashboard/src/heatmap.jsx) puts a point, so a death drawn on a
    /// Unity map lands on what was there. Needs a graphics device: not with -nographics.
    /// </summary>
    public class MapCaptureTests
    {
        readonly List<UnityEngine.Object> made = new List<UnityEngine.Object>();

        [UnitySetUp]
        public IEnumerator SetUp()
        {
            if (!MapCapture.CanCapture) Assert.Ignore("no graphics device (-nographics): nothing to render");
            yield return null;
        }

        [TearDown]
        public void TearDown()
        {
            foreach (var o in made)
                if (o) UnityEngine.Object.Destroy(o);
            made.Clear();
        }

        static string NewLevel(string kind) => $"map-{kind}-{Guid.NewGuid():N}".Substring(0, 20);

        // A white square sprite one world unit across.
        Sprite Square()
        {
            var tex = new Texture2D(4, 4);
            tex.SetPixels(Enumerable.Repeat(Color.white, 16).ToArray());
            tex.Apply();
            made.Add(tex);
            var sprite = Sprite.Create(tex, new Rect(0, 0, 4, 4), new Vector2(0.5f, 0.5f), 4);
            made.Add(sprite);
            return sprite;
        }

        GameObject Block(Sprite sprite, Vector2 min, Vector2 size, Color color, int order = 0)
        {
            var go = new GameObject("block");
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = sprite;
            sr.color = color;
            sr.sortingOrder = order;
            go.transform.position = min + size / 2;
            go.transform.localScale = new Vector3(size.x, size.y, 1);
            made.Add(go);
            return go;
        }

        GameObject Cube(Vector3 center, Vector3 size, Color color)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            UnityEngine.Object.Destroy(go.GetComponent<Collider>());
            go.transform.position = center;
            go.transform.localScale = size;
            var mat = new Material(Shader.Find("Unlit/Color")) { color = color }; // no lights needed, in any pipeline
            go.GetComponent<Renderer>().sharedMaterial = mat;
            made.Add(go);
            made.Add(mat);
            return go;
        }

        Camera MainCamera(Color background)
        {
            var go = new GameObject("Main Camera") { tag = "MainCamera" };
            var cam = go.AddComponent<Camera>();
            cam.orthographic = true;
            cam.orthographicSize = 3; // shows a corner of the level: the map has a camera of its own
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = background;
            go.transform.position = new Vector3(5, 5, -10);
            made.Add(go);
            return cam;
        }

        // GLITCHLESS_MAP_DUMP=folder keeps each picture there as a .jpg, to look at (unity/test/map.mjs sets it).
        static Texture2D Decode(string dataUrl, string name)
        {
            StringAssert.StartsWith("data:image/jpeg;base64,", dataUrl);
            var bytes = Convert.FromBase64String(dataUrl.Substring(dataUrl.IndexOf(',') + 1));
            var dump = Environment.GetEnvironmentVariable("GLITCHLESS_MAP_DUMP");
            if (!string.IsNullOrEmpty(dump))
            {
                System.IO.Directory.CreateDirectory(dump);
                var pipeline = GraphicsSettings.currentRenderPipeline?.GetType().Name ?? "builtin";
                System.IO.File.WriteAllBytes(System.IO.Path.Combine(dump, $"{name}-{pipeline}.jpg"), bytes);
            }
            var tex = new Texture2D(2, 2);
            Assert.IsTrue(tex.LoadImage(bytes), "a JPEG Unity can read");
            return tex;
        }

        // Where the dashboard draws the world point (a, b): toPx in apps/dashboard/src/heatmap.jsx, in the picture's pixels
        // from the top, read back from Texture2D's bottom-up rows.
        static Color At(Texture2D t, string axis, double[] min, double[] max, double a, double b)
        {
            var x = (a - min[0]) / (max[0] - min[0]) * t.width;
            var fromTop = axis == "xy" ? (max[1] - b) / (max[1] - min[1]) * t.height : (b - min[1]) / (max[1] - min[1]) * t.height;
            return t.GetPixel((int)x, t.height - 1 - (int)fromTop);
        }

        static void AssertColor(Color expected, Color actual, string what)
        {
            var off = Mathf.Max(Mathf.Abs(expected.r - actual.r), Mathf.Abs(expected.g - actual.g), Mathf.Abs(expected.b - actual.b));
            Assert.Less(off, 0.25f, $"{what}: expected {expected}, the map has {actual}");
        }

        static Dictionary<string, object> QueuedMap(string level) =>
            GlitchlessRunner.Core.Queued.LastOrDefault(e => (string)e["type"] == "map" && (string)e["level"] == level);

        static double[] Numbers(object list) => ((IEnumerable<object>)list).Select(Convert.ToDouble).ToArray();

        // Calls CaptureMap and waits for its answer, counting the frames it took.
        static IEnumerator Take(string level, Func<MapOptions, MapOptions> options, Action<MapOptions> call, Action<string, int> done)
        {
            string image = null;
            var answered = false;
            var o = options(new MapOptions());
            o.Done = i =>
            {
                image = i;
                answered = true;
            };
            call(o);
            var frames = 0;
            while (!answered && frames < 120)
            {
                frames++;
                yield return null;
            }
            Assert.IsTrue(answered, "CaptureMap answered");
            done(image, frames);
        }

        [UnityTest]
        public IEnumerator ASideViewPutsEachThingWhereTheDashboardDrawsIt()
        {
            var sprite = Square();
            MainCamera(new Color(0.1f, 0.6f, 0.2f)); // the map's background, as the game's camera clears to
            var level = NewLevel("2d");
            var area = new Rect(0, 0, 96, 18); // a long 2D stage, 96 by 18 tiles
            Block(sprite, new Vector2(10, 3), new Vector2(2, 2), Color.red);
            Block(sprite, new Vector2(80, 13), new Vector2(2, 2), Color.blue);
            Block(sprite, new Vector2(48, 0), new Vector2(1, 1), Color.white); // a tile in the bottom-left of its square
            var player = Block(sprite, new Vector2(40, 8), new Vector2(3, 3), Color.magenta, 10);
            var playerRenderer = player.GetComponent<Renderer>();

            string image = null;
            var frames = 0;
            yield return Take(level, o =>
            {
                o.Exclude = new[] { player };
                return o;
            }, o => Glitchless.CaptureMap(level, area, o), (i, f) => (image, frames) = (i, f));

            Assert.IsNotNull(image, "a map was taken");
            Assert.LessOrEqual(image.Length, MapCapture.MaxChars);
            Assert.GreaterOrEqual(frames, 3, "spread over frames: the render, reading it back, the JPEG");
            Assert.IsFalse(playerRenderer.forceRenderingOff, "the player is drawn again after");
            var e = QueuedMap(level);
            Assert.IsNotNull(e, "the map event is waiting to go (before Init, kept with the rest)");
            Assert.AreEqual("xy", e["axis"]);
            var bounds = (Dictionary<string, object>)e["bounds"];
            double[] min = Numbers(bounds["min"]), max = Numbers(bounds["max"]);
            CollectionAssert.AreEqual(new[] { 0.0, 0.0 }, min);
            CollectionAssert.AreEqual(new[] { 96.0, 18.0 }, max);
            CollectionAssert.AreEqual(new[] { 1024.0, 192.0 }, Numbers(e["size"]));
            Assert.AreEqual(image, e["image"]);

            var t = Decode(image, "side-view");
            made.Add(t);
            Assert.AreEqual((1024, 192), (t.width, t.height));
            AssertColor(Color.red, At(t, "xy", min, max, 11, 4), "the red block, near the start and low");
            AssertColor(Color.blue, At(t, "xy", min, max, 81, 14), "the blue block, near the end and high");
            AssertColor(Color.white, At(t, "xy", min, max, 48.5, 0.5), "the tile on the floor");
            AssertColor(new Color(0.1f, 0.6f, 0.2f), At(t, "xy", min, max, 41.5, 9.5), "where the player stood: left out");
            AssertColor(new Color(0.1f, 0.6f, 0.2f), At(t, "xy", min, max, 60, 5), "open air: the main camera's background");
            var cost = MapCapture.LastCost;
            TestContext.WriteLine($"2D map {cost.Width}x{cost.Height} q{cost.Quality} {cost.Chars} chars: render {cost.RenderMs:0.00} ms, read back {cost.ReadMs:0.00} ms, JPEG {cost.EncodeMs:0.00} ms, {cost.Frames} frames, longest {cost.LongestMs:0.00} ms ({GraphicsSettings.currentRenderPipeline?.GetType().Name ?? "built-in"}, {SystemInfo.graphicsDeviceType})");
        }

        [UnityTest]
        public IEnumerator ALevelSeenFromAboveHasItsSmallestZAtTheTop()
        {
            var level = NewLevel("3d");
            var area = new Bounds(new Vector3(25, 2, 15), new Vector3(50, 4, 30)); // x 0-50, z 0-30, y 0-4
            var ground = new Color(0.35f, 0.35f, 0.35f);
            Cube(new Vector3(25, -0.5f, 15), new Vector3(50, 1, 30), ground);
            Cube(new Vector3(10, 0.5f, 5), new Vector3(3, 1, 3), Color.red); // low z: the top of the map
            Cube(new Vector3(40, 0.5f, 25), new Vector3(3, 1, 3), Color.blue); // high z: the bottom
            Cube(new Vector3(25, 8, 15), new Vector3(60, 1, 40), Color.yellow); // a roof above the box: left out

            string image = null;
            yield return Take(level, o =>
            {
                o.Background = Color.black;
                return o;
            }, o => Glitchless.CaptureMap(level, area, o), (i, f) => image = i);

            Assert.IsNotNull(image, "a map was taken");
            var e = QueuedMap(level);
            Assert.AreEqual("xz", e["axis"]);
            var bounds = (Dictionary<string, object>)e["bounds"];
            double[] min = Numbers(bounds["min"]), max = Numbers(bounds["max"]);
            CollectionAssert.AreEqual(new[] { 0.0, 0.0 }, min);
            CollectionAssert.AreEqual(new[] { 50.0, 30.0 }, max);
            var t = Decode(image, "from-above");
            made.Add(t);
            Assert.AreEqual((640, 384), (t.width, t.height));
            AssertColor(Color.red, At(t, "xz", min, max, 10, 5), "the red cube, at x 10 and z 5");
            AssertColor(Color.blue, At(t, "xz", min, max, 40, 25), "the blue cube, at x 40 and z 25");
            AssertColor(ground, At(t, "xz", min, max, 25, 15), "the ground, not the roof above the box");
            var cost = MapCapture.LastCost;
            TestContext.WriteLine($"3D map {cost.Width}x{cost.Height} q{cost.Quality} {cost.Chars} chars: render {cost.RenderMs:0.00} ms, read back {cost.ReadMs:0.00} ms, JPEG {cost.EncodeMs:0.00} ms, {cost.Frames} frames, longest {cost.LongestMs:0.00} ms ({GraphicsSettings.currentRenderPipeline?.GetType().Name ?? "built-in"}, {SystemInfo.graphicsDeviceType})");
        }

        [UnityTest]
        public IEnumerator ALevelsMapIsTakenOnceALaunch()
        {
            var sprite = Square();
            var level = NewLevel("once");
            Block(sprite, new Vector2(1, 1), new Vector2(2, 2), Color.red);
            string first = null, second = "not answered";
            var frames = 0;
            Glitchless.CaptureMap(level, new Rect(0, 0, 32, 18), new MapOptions { Background = Color.black, Done = i => first = i });
            Glitchless.CaptureMap(level, new Rect(0, 0, 32, 18), new MapOptions { Done = i => second = i });
            Assert.IsNull(second, "the second call answers at once: one is on its way");
            while (first == null && frames++ < 120) yield return null;
            Assert.IsNotNull(first);
            string third = "not answered";
            Glitchless.CaptureMap(level, new Rect(0, 0, 32, 18), new MapOptions { Done = i => third = i });
            Assert.IsNull(third, "taken already this launch");
            Assert.AreEqual(1, GlitchlessRunner.Core.Queued.Count(e => (string)e["type"] == "map" && (string)e["level"] == level));
        }

        [UnityTest]
        public IEnumerator TwoLevelsAreTakenOneAfterTheOther()
        {
            var sprite = Square();
            Block(sprite, new Vector2(1, 1), new Vector2(2, 2), Color.red);
            string a = null, b = null;
            int aAt = -1, bAt = -1, frame = 0;
            string la = NewLevel("a"), lb = NewLevel("b");
            Glitchless.CaptureMap(la, new Rect(0, 0, 32, 18), new MapOptions { Background = Color.black, Done = i => (a, aAt) = (i, frame) });
            Glitchless.CaptureMap(lb, new Rect(0, 0, 32, 18), new MapOptions { Background = Color.black, Done = i => (b, bAt) = (i, frame) });
            while ((a == null || b == null) && frame++ < 240) yield return null;
            Assert.IsNotNull(a);
            Assert.IsNotNull(b);
            Assert.Greater(bAt, aAt + 2, "the second starts once the first is done: never two renders in a frame");
        }
    }
}

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using UnityEngine;

namespace GlitchlessSdk.MapProbe
{
    /// <summary>
    /// The player unity/test/map.mjs builds for WebGL (SampleBuilder.BuildMapProbe, with the GLITCHLESS_MAP_PROBE define
    /// this assembly needs) to check Glitchless.CaptureMap end to end. It isn't part of the package. Two levels, each
    /// taking its map and sending a path and two deaths on things of a known colour, so the test can read the stored map
    /// where the dashboard draws each death:
    ///   probe-2d   a long 2D stage of sprites, 96 by 18 units (as a platformer's room several screens wide): a red block
    ///              centred on (11, 4), a blue one on (81, 14), the player left out of the map
    ///   probe-3d   a 3D level of cubes 50 by 30 units, seen from above: red centred on x 10, z 5, blue on x 40, z 25, and
    ///              a roof above the box the map is given, which it leaves out
    /// ?intake=URL picks the server. The SDK's debug line for each map says what each step cost; this logs every frame's
    /// time around each capture as "[map-probe] {json}", and "[map-probe] done" at the end.
    /// </summary>
    sealed class MapProbe : MonoBehaviour
    {
        public static readonly Color Sky = new Color(0.1f, 0.6f, 0.2f);
        static Material unlit;
        Sprite square;
        readonly List<GameObject> level = new List<GameObject>();

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Begin() => DontDestroyOnLoad(new GameObject("Map probe", typeof(MapProbe)));

        static string Query(string key)
        {
            var url = Application.absoluteURL ?? "";
            var q = url.IndexOf('?');
            if (q < 0) return null;
            foreach (var pair in url.Substring(q + 1).Split('&'))
            {
                var kv = pair.Split(new[] { '=' }, 2);
                if (kv.Length == 2 && kv[0] == key) return Uri.UnescapeDataString(kv[1]);
            }
            return null;
        }

        IEnumerator Start()
        {
            Application.runInBackground = true;
            Glitchless.Init(new GlitchlessOptions
            {
                Service = "map-probe",
                Intake = Query("intake") ?? "http://127.0.0.1:7777",
                Version = "1.0.0",
                Positions = true,
                Debug = true, // the SDK logs each map's cost
                SessionType = "synthetic",
                FlushIntervalSeconds = 2,
            });
            unlit = Resources.Load<Material>("MapProbeUnlit");
            var tex = new Texture2D(4, 4);
            tex.SetPixels(Enumerable.Repeat(Color.white, 16).ToArray());
            tex.Apply();
            square = Sprite.Create(tex, new Rect(0, 0, 4, 4), new Vector2(0.5f, 0.5f), 4);
            for (var i = 0; i < 30; i++) yield return null; // the first frames: loading, not the game

            yield return Stage2D();
            yield return Level3D();

            Glitchless.Flush();
            for (var i = 0; i < 4 && Glitchless.Stats.LastStatus != "ok"; i++) yield return new WaitForSecondsRealtime(1);
            yield return new WaitForSecondsRealtime(1);
            Glitchless.Flush();
            yield return new WaitForSecondsRealtime(1);
            Debug.Log($"[map-probe] done: sent {Glitchless.Stats.Sent}, last {Glitchless.Stats.LastStatus}");
        }

        IEnumerator Stage2D()
        {
            var cam = MainCamera(true);
            cam.transform.position = new Vector3(16, 9, -10); // one screen of the stage, as a following camera shows it
            cam.orthographicSize = 9;
            cam.backgroundColor = Sky;
            for (var x = 0; x < 96; x++) Block(new Vector2(x, 0), Vector2.one, Color.white); // the floor, tile by tile
            Block(new Vector2(10, 3), new Vector2(2, 2), Color.red);
            Block(new Vector2(80, 13), new Vector2(2, 2), Color.blue);
            var player = Block(new Vector2(40, 1), new Vector2(1, 2), Color.magenta, 10);
            Glitchless.LevelStart("probe-2d");
            yield return Capture("probe-2d", o => Glitchless.CaptureMap("probe-2d", new Rect(0, 0, 96, 18), o), new MapOptions { Exclude = new[] { player } }, t => new Vector3(1 + 94 * t, 1.5f, 0));
            Glitchless.Death(new Vector2(11, 4), "spikes");
            Glitchless.Death(new Vector2(81, 14), "fell");
            Glitchless.LevelComplete("probe-2d");
            Clear();
        }

        IEnumerator Level3D()
        {
            var cam = MainCamera(false);
            cam.transform.SetPositionAndRotation(new Vector3(25, 30, -15), Quaternion.Euler(50, 0, 0));
            cam.backgroundColor = new Color(0.05f, 0.05f, 0.08f);
            Cube(new Vector3(25, -0.5f, 15), new Vector3(50, 1, 30), new Color(0.35f, 0.35f, 0.35f));
            Cube(new Vector3(10, 0.5f, 5), new Vector3(3, 1, 3), Color.red);
            Cube(new Vector3(40, 0.5f, 25), new Vector3(3, 1, 3), Color.blue);
            Cube(new Vector3(25, 8, 15), new Vector3(60, 1, 40), Color.yellow); // a roof: above the box, left out
            Glitchless.LevelStart("probe-3d");
            var area = new Bounds(new Vector3(25, 2, 15), new Vector3(50, 4, 30));
            yield return Capture("probe-3d", o => Glitchless.CaptureMap("probe-3d", area, o), new MapOptions(), t => new Vector3(2 + 46 * t, 1, 2 + 26 * t));
            Glitchless.Death(new Vector3(10, 1, 5), "lava");
            Glitchless.Death(new Vector3(40, 1, 25), "trap");
            Glitchless.LevelComplete("probe-3d");
            Clear();
        }

        // Takes the map while the player walks the path (t from 0 to 1), with the frame times before, during and after.
        IEnumerator Capture(string name, Action<MapOptions> capture, MapOptions options, Func<float, Vector3> path)
        {
            var before = new List<double>();
            for (var i = 0; i < 20; i++)
            {
                Glitchless.SetPosition(path(i / 120f));
                yield return null;
                before.Add(Time.unscaledDeltaTime * 1000);
            }
            var during = new List<double>();
            string image = null;
            var done = false;
            options.Done = i =>
            {
                image = i;
                done = true;
            };
            capture(options);
            var step = 20;
            while (!done && during.Count < 300)
            {
                Glitchless.SetPosition(path(step++ / 120f));
                yield return null;
                during.Add(Time.unscaledDeltaTime * 1000);
            }
            var after = new List<double>();
            while (step <= 120)
            {
                Glitchless.SetPosition(path(step++ / 120f));
                yield return null;
                after.Add(Time.unscaledDeltaTime * 1000);
            }
            string Ms(IEnumerable<double> v) => "[" + string.Join(",", v.Select(x => x.ToString("0.0", CultureInfo.InvariantCulture))) + "]";
            Debug.Log($"[map-probe] {{\"level\":\"{name}\",\"sent\":{(image != null ? "true" : "false")},\"chars\":{image?.Length ?? 0},\"before_ms\":{Ms(before)},\"during_ms\":{Ms(during)},\"after_ms\":{Ms(after.Take(20))}}}");
        }

        Camera MainCamera(bool orthographic)
        {
            var go = new GameObject("Main Camera") { tag = "MainCamera" };
            level.Add(go);
            var cam = go.AddComponent<Camera>();
            cam.orthographic = orthographic;
            cam.clearFlags = CameraClearFlags.SolidColor;
            return cam;
        }

        GameObject Block(Vector2 min, Vector2 size, Color color, int order = 0)
        {
            var go = new GameObject("block");
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = square;
            sr.color = color;
            sr.sortingOrder = order;
            go.transform.position = min + size / 2;
            go.transform.localScale = new Vector3(size.x, size.y, 1);
            level.Add(go);
            return go;
        }

        void Cube(Vector3 center, Vector3 size, Color color)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Destroy(go.GetComponent<Collider>());
            go.transform.position = center;
            go.transform.localScale = size;
            go.GetComponent<Renderer>().material = new Material(unlit) { color = color };
            level.Add(go);
        }

        void Clear()
        {
            foreach (var go in level) Destroy(go);
            level.Clear();
        }
    }
}

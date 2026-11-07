using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;

namespace GlitchlessSdk
{
    /// <summary>The plane a level's map shows: a side view (x and y: a 2D game, a side-scroller) or the view from above
    /// (x and z: a 3D level).</summary>
    public enum MapAxis
    {
        XY,
        XZ,
    }

    /// <summary>How Glitchless.CaptureMap draws a level's picture. Everything is optional.</summary>
    public sealed class MapOptions
    {
        /// <summary>The plane: XY for a Rect, XZ (from above) for Bounds, unless set here.</summary>
        public MapAxis? Axis;
        /// <summary>The picture's width in pixels, at most 1024. 0: 640, or 1024 for a level more than 4 times wider than
        /// tall, the height following the bounds (a level taller than wide gets that height, its width following).</summary>
        public int Width;
        /// <summary>Left out of the picture: the player, a backdrop that follows the camera, effects. Their renderers and
        /// world-space canvases are turned off for that one render (Renderer.forceRenderingOff), never the GameObjects,
        /// so no script of the game hears of it.</summary>
        public GameObject[] Exclude;
        /// <summary>The layers drawn. Default: the main camera's.</summary>
        public int? Layers;
        /// <summary>What shows where nothing is drawn. Default: the main camera's background.</summary>
        public Color? Background;
        /// <summary>Called on the main thread with the picture that went (a JPEG data URL), or null when none did: this
        /// level's was taken already, Glitchless is off or has positions off, or nothing is drawn in this build (a game
        /// server, -nographics).</summary>
        public Action<string> Done;
    }

    /// <summary>One CaptureMap call: the level, its plane and the part of the world on it.</summary>
    internal sealed class MapRequest
    {
        public string Level;
        public MapAxis Axis;
        public double MinA, MinB, MaxA, MaxB; // x, and y (XY) or z (XZ), in world units
        public double? Near, Far; // the third axis' range, when Bounds gave one: z in a side view, y from above
        public MapOptions Options = new MapOptions();

        public static MapRequest From(string level, Rect area, MapOptions options) => new MapRequest
        {
            Level = level,
            Axis = options?.Axis ?? MapAxis.XY,
            MinA = area.xMin,
            MinB = area.yMin,
            MaxA = area.xMax,
            MaxB = area.yMax,
            Options = options ?? new MapOptions(),
        };

        public static MapRequest From(string level, Bounds area, MapOptions options)
        {
            var axis = options?.Axis ?? MapAxis.XZ;
            var side = axis == MapAxis.XY;
            var r = new MapRequest
            {
                Level = level,
                Axis = axis,
                MinA = area.min.x,
                MaxA = area.max.x,
                MinB = side ? area.min.y : area.min.z,
                MaxB = side ? area.max.y : area.max.z,
                Options = options ?? new MapOptions(),
            };
            // A box with depth says how far the camera sees: from its top down (a roof above it stays out), or from its front.
            double low = side ? area.min.z : area.min.y, high = side ? area.max.z : area.max.y;
            if (high > low)
            {
                r.Near = low;
                r.Far = high;
            }
            return r;
        }

        public bool Valid => !string.IsNullOrEmpty(Level) && Finite(MinA, MinB, MaxA, MaxB) && MaxA > MinA && MaxB > MinB;

        static bool Finite(params double[] vs)
        {
            foreach (var v in vs)
                if (double.IsNaN(v) || double.IsInfinity(v)) return false;
            return true;
        }
    }

    /// <summary>What the last map cost the main thread, for the README's numbers and the tests.</summary>
    public struct MapCost
    {
        public string Level;
        public int Width, Height, Quality, Chars, Frames;
        public double RenderMs, ReadMs, EncodeMs, LongestMs;
    }

    /// <summary>
    /// A level's map for its heatmaps (SPEC §2 map), as the browser SDK's captureMap takes one: an orthographic camera of
    /// its own renders the part of the world the game names into a render texture, the pixels are read back, and they
    /// become a JPEG small enough for the map event. Each step has a frame of its own (the render; reading it back,
    /// by then drawn, so the read doesn't wait on the GPU; each JPEG quality it tries), so no frame does it all, in a
    /// WebGL build too, where nothing can be read back without waiting.
    ///
    /// The picture covers the bounds exactly, with the axes as the dashboard draws them: x to the right, and y up (XY)
    /// or the smallest z at the top (XZ, as the browser SDK's top-down maps), so positions and deaths land where they
    /// were. Built-in pipeline or a scriptable one (URP, HDRP: a render request), 2D or 3D. GlitchlessRunner runs one
    /// at a time.
    /// </summary>
    internal static class MapCapture
    {
        /// <summary>Characters of data URL a map aims at (the browser SDK's 60,000); intake keeps up to 120,000.</summary>
        public const int MaxChars = 60_000;
        public const int MaxSide = 1024;
        // The browser SDK's JPEG qualities, tried in turn until the picture fits.
        static readonly int[] Qualities = { 75, 60, 45, 30 };

        /// <summary>False where nothing is drawn (a game server, batch mode with -nographics).</summary>
        public static bool CanCapture => SystemInfo.graphicsDeviceType != GraphicsDeviceType.Null;

        public static MapCost LastCost { get; private set; }

        static readonly long TicksPerMs = Stopwatch.Frequency / 1000;
        static double NowMs => (double)Stopwatch.GetTimestamp() / TicksPerMs;

        /// <summary>The picture's size in pixels, as the browser SDK makes it: 640 wide, or 1024 for a level more than 4
        /// times wider than tall, the height following the bounds. A level taller than wide gets that height and its width
        /// follows (the browser SDK's would be squashed). `width` sets the width. The longer side is at most 1024, the
        /// shorter at least 48.</summary>
        public static (int w, int h) Size(double spanA, double spanB, int width)
        {
            var aspect = spanA / spanB;
            double w, h;
            if (width > 0)
            {
                w = width;
                h = w / aspect;
            }
            else if (aspect >= 1)
            {
                w = aspect > 4 ? 1024 : 640;
                h = w / aspect;
            }
            else
            {
                h = 1 / aspect > 4 ? 1024 : 640;
                w = h * aspect;
            }
            var longest = Math.Max(w, h); // a width over 1024 makes a smaller picture of the same shape
            if (longest > MaxSide)
            {
                w *= MaxSide / longest;
                h *= MaxSide / longest;
            }
            return (Side(w), Side(h));
        }

        static int Side(double v) => Math.Max(48, Math.Min(MaxSide, (int)Math.Round(v, MidpointRounding.AwayFromZero))); // as JavaScript rounds

        /// <summary>RGBA pixels as read back (bottom row first) to the RGB rows EncodeArrayToJPG takes (bottom row first
        /// too): in the same order for a side view, upside down from above, whose camera has +z up the screen while the
        /// map has the smallest z at the top.</summary>
        public static byte[] Rgb(byte[] rgba, int w, int h, bool flip)
        {
            var rgb = new byte[w * h * 3];
            for (var y = 0; y < h; y++)
            {
                var src = (flip ? h - 1 - y : y) * w * 4;
                var dst = y * w * 3;
                for (var x = 0; x < w; x++, src += 4, dst += 3)
                {
                    rgb[dst] = rgba[src];
                    rgb[dst + 1] = rgba[src + 1];
                    rgb[dst + 2] = rgba[src + 2];
                }
            }
            return rgb;
        }

        /// <summary>Puts the camera where it sees exactly the bounds. A side view looks along +z, as a 2D game's camera does
        /// (x right, y up); from above it looks straight down (x right, +z up the screen, flipped afterwards). Without a
        /// range for the third axis it sees 10,000 units from 1,000 out, as the browser SDK's camera does.</summary>
        public static void Place(Camera cam, MapRequest r)
        {
            double spanA = r.MaxA - r.MinA, spanB = r.MaxB - r.MinB;
            float cA = (float)((r.MinA + r.MaxA) / 2), cB = (float)((r.MinB + r.MaxB) / 2);
            cam.orthographic = true;
            cam.orthographicSize = (float)(spanB / 2);
            cam.aspect = (float)(spanA / spanB);
            const float margin = 1;
            var ranged = r.Near.HasValue && r.Far.HasValue;
            var depth = ranged ? (float)(r.Far.Value - r.Near.Value) + 2 * margin : 11000f;
            cam.nearClipPlane = 0.01f;
            cam.farClipPlane = depth;
            if (r.Axis == MapAxis.XY)
            {
                var z = ranged ? (float)r.Near.Value - margin : -1000f;
                cam.transform.SetPositionAndRotation(new Vector3(cA, cB, z), Quaternion.identity);
            }
            else
            {
                var y = ranged ? (float)r.Far.Value + margin : 1000f;
                cam.transform.SetPositionAndRotation(new Vector3(cA, y, cB), Quaternion.Euler(90, 0, 0));
            }
        }

        static Camera MakeCamera(MapRequest r)
        {
            var go = new GameObject("Glitchless map") { hideFlags = HideFlags.HideAndDontSave };
            var cam = go.AddComponent<Camera>();
            var main = Camera.main;
            if (main) cam.CopyFrom(main); // the game's background, layers and sorting
            cam.enabled = false; // drawn only when asked, never as part of the game's frame
            cam.ResetProjectionMatrix();
            cam.ResetWorldToCameraMatrix();
            cam.ResetCullingMatrix();
            cam.rect = new Rect(0, 0, 1, 1);
            cam.layerCullDistances = new float[32]; // from 1,000 units out, per-layer distances would cull the level
            cam.useOcclusionCulling = false;
            cam.usePhysicalProperties = false;
            cam.allowHDR = false;
            cam.allowMSAA = false;
            cam.allowDynamicResolution = false;
            cam.depthTextureMode = DepthTextureMode.None;
            cam.targetTexture = null;
            // A camera stacked over another clears nothing: a map needs a background.
            if (!main || main.clearFlags == CameraClearFlags.Depth || main.clearFlags == CameraClearFlags.Nothing) cam.clearFlags = CameraClearFlags.SolidColor;
            if (r.Options.Background is Color bg)
            {
                cam.clearFlags = CameraClearFlags.SolidColor;
                cam.backgroundColor = bg;
            }
            if (r.Options.Layers is int layers) cam.cullingMask = layers;
            Place(cam, r);
            return cam;
        }

        // The built-in pipeline renders a camera on its own with Render(); a scriptable one (URP, HDRP) takes a render request.
        static void Render(Camera cam, RenderTexture rt)
        {
            cam.targetTexture = rt;
            if (GraphicsSettings.currentRenderPipeline != null)
            {
                var request = new RenderPipeline.StandardRequest { destination = rt };
                if (RenderPipeline.SupportsRenderRequest(cam, request))
                {
                    RenderPipeline.SubmitRenderRequest(cam, request);
                    return;
                }
            }
            cam.Render();
        }

        // What the game asked to leave out, turned off for the one render. Returns what to turn back on.
        static (List<Renderer>, List<Canvas>) Hide(GameObject[] exclude)
        {
            var renderers = new List<Renderer>();
            var canvases = new List<Canvas>();
            if (exclude == null) return (renderers, canvases);
            foreach (var go in exclude)
            {
                if (!go) continue;
                foreach (var rd in go.GetComponentsInChildren<Renderer>())
                {
                    if (rd.forceRenderingOff) continue;
                    rd.forceRenderingOff = true;
                    renderers.Add(rd);
                }
                foreach (var c in go.GetComponentsInChildren<Canvas>())
                {
                    if (!c.enabled || c.renderMode != RenderMode.WorldSpace) continue;
                    c.enabled = false;
                    canvases.Add(c);
                }
            }
            return (renderers, canvases);
        }

        static void Show((List<Renderer> renderers, List<Canvas> canvases) hidden)
        {
            foreach (var rd in hidden.renderers)
                if (rd) rd.forceRenderingOff = false;
            foreach (var c in hidden.canvases)
                if (c) c.enabled = true;
        }

        static byte[] ReadBack(RenderTexture rt, int w, int h)
        {
            var tex = new Texture2D(w, h, TextureFormat.RGBA32, false, false);
            var prev = RenderTexture.active;
            try
            {
                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, w, h), 0, 0, false);
                return tex.GetRawTextureData();
            }
            finally
            {
                RenderTexture.active = prev;
                UnityEngine.Object.Destroy(tex);
            }
        }

        static string Jpeg(byte[] rgb, int w, int h, int quality) =>
            "data:image/jpeg;base64," + Convert.ToBase64String(ImageConversion.EncodeArrayToJPG(rgb, GraphicsFormat.R8G8B8_SRGB, (uint)w, (uint)h, 0, quality));

        /// <summary>Takes one map, a step a frame, and hands it to the core. Each step's frame is left out of the frame
        /// stats (SkipNextFrame), as a bug report's screenshot is: it is Glitchless's work, not the game's.</summary>
        public static IEnumerator Take(GlitchlessCore core, MapRequest r)
        {
            yield return null; // what the game built this frame (Awake, Start) is all in place by the next
            string image = null;
            var cost = new MapCost { Level = r.Level };
            try
            {
                if (!core.WantsMap(r.Level)) yield break; // turned off, or sent meanwhile
                var (w, h) = Size(r.MaxA - r.MinA, r.MaxB - r.MinB, r.Options.Width);
                cost.Width = w;
                cost.Height = h;

                // 1. The render. The GPU draws it while this frame ends.
                var t = NowMs;
                RenderTexture rt = null;
                Camera cam = null;
                if (!Step(core, r, "render", () =>
                {
                    rt = new RenderTexture(new RenderTextureDescriptor(w, h, RenderTextureFormat.ARGB32, 24) { sRGB = QualitySettings.activeColorSpace == ColorSpace.Linear, msaaSamples = 1 });
                    rt.Create();
                    cam = MakeCamera(r);
                    var hidden = Hide(r.Options.Exclude);
                    try
                    {
                        Render(cam, rt);
                    }
                    finally
                    {
                        Show(hidden);
                        cam.targetTexture = null; // destroying a camera that still targets a texture empties the texture
                        UnityEngine.Object.Destroy(cam.gameObject);
                    }
                }))
                {
                    if (rt)
                    {
                        rt.Release();
                        UnityEngine.Object.Destroy(rt);
                    }
                    yield break;
                }
                cost.RenderMs = NowMs - t;
                cost.LongestMs = cost.RenderMs;
                cost.Frames = 1;
                core.SkipNextFrame();
                yield return null;

                // 2. Reading it back, drawn by now.
                t = NowMs;
                byte[] rgba = null;
                var read = Step(core, r, "read back", () => rgba = ReadBack(rt, w, h));
                rt.Release();
                UnityEngine.Object.Destroy(rt);
                if (!read) yield break;
                cost.ReadMs = NowMs - t;
                cost.LongestMs = Math.Max(cost.LongestMs, cost.ReadMs);
                cost.Frames++;
                core.SkipNextFrame();
                yield return null;

                // 3. The JPEG: the browser SDK's qualities one a frame, then smaller pictures, until it fits.
                byte[] rgb = null;
                var q = 0;
                while (true)
                {
                    t = NowMs;
                    var quality = q < Qualities.Length ? Qualities[q] : 45;
                    if (!Step(core, r, "JPEG", () =>
                    {
                        if (rgb == null) rgb = Rgb(rgba, w, h, r.Axis == MapAxis.XZ);
                        else if (q >= Qualities.Length)
                        {
                            // Still too big at the lowest quality: two thirds the size, at a middle quality.
                            int tw = Math.Max(48, w * 2 / 3), th = Math.Max(48, h * 2 / 3);
                            rgb = BugScreenshot.Shrink(rgb, w, h, tw, th);
                            w = tw;
                            h = th;
                        }
                        image = Jpeg(rgb, w, h, quality);
                    })) yield break;
                    var ms = NowMs - t;
                    cost.EncodeMs += ms;
                    cost.LongestMs = Math.Max(cost.LongestMs, ms);
                    cost.Frames++;
                    cost.Quality = quality;
                    core.SkipNextFrame();
                    if (image.Length <= MaxChars || (w <= 48 && h <= 48)) break;
                    image = null;
                    q++;
                    yield return null;
                }
                cost.Width = w;
                cost.Height = h;
                cost.Chars = image.Length;
                LastCost = cost;
                if (!core.SendMap(r.Level, r.Axis == MapAxis.XZ ? "xz" : "xy", r.MinA, r.MinB, r.MaxA, r.MaxB, w, h, image, cost)) image = null;
            }
            finally
            {
                if (image == null) core.MapNotTaken(r.Level);
                var done = r.Options.Done;
                if (done != null)
                {
                    try
                    {
                        done(image);
                    }
                    catch (Exception e)
                    {
                        UnityEngine.Debug.LogException(e); // the game's own callback: its error, reported as the game's
                    }
                }
            }
        }

        // A step that throws gives the map up (said once in a debug build), and the level may be tried again.
        static bool Step(GlitchlessCore core, MapRequest r, string what, Action step)
        {
            try
            {
                step();
                return true;
            }
            catch (Exception e)
            {
                core.MapFailed(r.Level, $"{what}: {e.GetType().Name}: {e.Message}");
                return false;
            }
        }
    }
}

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading;
using Unity.Profiling;
using Unity.Profiling.LowLevel.Unsafe;
using UnityEngine;
using UnityEngine.LowLevel;
using UnityEngine.Networking;
using UnityEngine.SceneManagement;
#if GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Utilities;
#endif
#if UNITY_EDITOR
using UnityEditor;
#endif

namespace GlitchlessSdk
{
    /// <summary>
    /// Feeds GlitchlessCore from Unity: frame times (Time.unscaledDeltaTime), where each frame's time
    /// went (timing markers in the player loop), draw calls and memory (profiler counters), errors
    /// (Application.logMessageReceivedThreaded), scenes, input and the app's lifecycle.
    ///
    /// It starts itself before the first scene loads, so the first frames and errors are kept; nothing
    /// is sent until Glitchless.Init(). Define GLITCHLESS_DISABLE to stop the automatic start.
    ///
    /// Flags (on the player's command line):
    ///   --glitchless-intake=URL       send to this server instead
    ///   --glitchless-measure=SECONDS  print frame stats as one line of JSON and quit
    ///   --glitchless-warmup=SECONDS   with --glitchless-measure: wait this long first
    ///   --glitchless-out=PATH         with --glitchless-measure: write the JSON to this file too
    ///   --glitchless-synthetic        mark the session as a bot's (--autoplay and batch mode do too)
    ///   --glitchless-off              send nothing
    ///   --glitchless-debug            log each batch as it is sent
    /// </summary>
    [DefaultExecutionOrder(-32000)]
    [AddComponentMenu("")]
    public sealed class GlitchlessRunner : MonoBehaviour
    {
        public static GlitchlessCore Core { get; private set; }
        static GlitchlessRunner instance;

        static readonly object LogLock = new object();
        static readonly List<(string condition, string stack, LogType type)> Logs = new List<(string, string, LogType)>();
        const int MaxPendingLogs = 100;

        static readonly long TicksPerMs = Stopwatch.Frequency / 1000;
        static double NowMs => (double)Stopwatch.GetTimestamp() / TicksPerMs;

        double fixedStart, fixedMs, updateStart, updateMs, renderStart, renderMs;
        bool hooksRan;
        int accountedFrame = -1, lastGc;
        long lastGameObjects = -1;
        bool sceneChanged;
        readonly FrameTiming[] timings = new FrameTiming[1];
        ProfilerRecorder drawCalls, triangles, setPass, batches, gcUsed, gcReserved, systemUsed, meshes, textures, materials, objects, gameObjects, gcAlloc, shaderCompile;
        float measureSeconds, measureAt;
        bool measureStarted;
        BugReportForm bugForm;
#if GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
        IDisposable inputListener;
#endif

        // Enter Play Mode without a domain reload keeps statics: start each play session clean.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            Core = null;
            instance = null;
            PlayerLoopHooks.Remove();
            lock (LogLock) Logs.Clear();
        }

#if !GLITCHLESS_DISABLE
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void Bootstrap() => EnsureRunning();
#endif

        /// <summary>The running core, made (with its GameObject) on first use.</summary>
        public static GlitchlessCore EnsureRunning()
        {
            if (Core != null || !Application.isPlaying) return Core;
            var go = new GameObject("Glitchless");
            DontDestroyOnLoad(go);
            go.AddComponent<GlitchlessRunner>(); // Awake makes Core
            return Core;
        }

        void Awake()
        {
            if (instance != null)
            {
                Destroy(gameObject);
                return;
            }
            instance = this;
            var web = Application.platform == RuntimePlatform.WebGLPlayer;
            Core = new GlitchlessCore
            {
                Transport = new UnityTransport(),
                SaveDir = web ? null : Path.Combine(Application.persistentDataPath, "glitchless"),
                // The web has no folder to keep the player ID in; PlayerPrefs is the browser's localStorage there.
                Ids = web ? new IdStorage
                {
                    Read = name => PlayerPrefs.HasKey("glitchless." + name) ? PlayerPrefs.GetString("glitchless." + name) : null,
                    Write = (name, id) => { PlayerPrefs.SetString("glitchless." + name, id); PlayerPrefs.Save(); },
                    Delete = name => { PlayerPrefs.DeleteKey("glitchless." + name); PlayerPrefs.Save(); },
                } : null,
                Device = DeviceInfo.Collect,
                Steam = SteamInfo.Read,
                Engine = SampleEngine,
                StartupMs = () => Time.realtimeSinceStartupAsDouble * 1000,
                ScreenSize = DeviceInfo.ScreenSize,
                WindowSize = DeviceInfo.WindowSize,
                AppVersion = Application.version,
                IsBatchMode = Application.isBatchMode,
                IsDebugBuild = UnityEngine.Debug.isDebugBuild,
                IsMobile = Application.isMobilePlatform,
                IsWeb = web,
            };
            Core.Scrubber.AddPath(Application.persistentDataPath, "persistent:");
            Core.Scrubber.AddPath(Application.temporaryCachePath, "cache:");
            Core.Scrubber.AddPath(Application.streamingAssetsPath, "streaming:");
            Core.Scrubber.AddPath(Application.dataPath, "data:");

            Application.logMessageReceivedThreaded += OnLog;
            Application.quitting += OnQuitting;
            SceneManager.sceneLoaded += OnSceneLoaded;
            SceneManager.sceneUnloaded += OnSceneUnloaded;
            SceneManager.activeSceneChanged += OnActiveSceneChanged;
#if UNITY_EDITOR
            EditorApplication.pauseStateChanged += OnEditorPause;
#endif
#if GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            inputListener = InputSystem.onAnyButtonPress.Call(c => Core?.OnInput(c.device is Pointer ? "pointer" : c.path));
#endif
            StartRecorders();
            lastGc = GC.CollectionCount(0);
            PlayerLoopHooks.Install();

            var m = Core.FlagValue("--glitchless-measure");
            if (m != null)
            {
                measureSeconds = float.TryParse(m, NumberStyles.Float, CultureInfo.InvariantCulture, out var s) && s > 0 ? s : 5;
                float.TryParse(Core.FlagValue("--glitchless-warmup") ?? "0", NumberStyles.Float, CultureInfo.InvariantCulture, out var w);
                measureAt = Time.realtimeSinceStartup + w;
            }
        }

        void OnDestroy()
        {
            if (instance != this) return;
            Core?.Shutdown("quit");
            Application.logMessageReceivedThreaded -= OnLog;
            Application.quitting -= OnQuitting;
            SceneManager.sceneLoaded -= OnSceneLoaded;
            SceneManager.sceneUnloaded -= OnSceneUnloaded;
            SceneManager.activeSceneChanged -= OnActiveSceneChanged;
#if UNITY_EDITOR
            EditorApplication.pauseStateChanged -= OnEditorPause;
#endif
#if GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            inputListener?.Dispose();
#endif
            PlayerLoopHooks.Remove();
            foreach (var r in new[] { drawCalls, triangles, setPass, batches, gcUsed, gcReserved, systemUsed, meshes, textures, materials, objects, gameObjects, gcAlloc, shaderCompile }) r.Dispose();
            instance = null;
            Core = null;
        }

        // ───────────────────────────── frames ─────────────────────────────

        // The player loop calls these (see PlayerLoopHooks). Each frame's time is split the way the
        // Godot SDK splits it: physics, the game's update code, and the main thread's share of rendering.
        internal static void FixedStart() { if (instance) instance.fixedStart = NowMs; }
        internal static void FixedEnd() { if (instance) instance.fixedMs += NowMs - instance.fixedStart; }
        internal static void UpdateStart() { if (instance) instance.updateStart = NowMs; }
        internal static void UpdateEnd() { if (instance) instance.updateMs = NowMs - instance.updateStart; }
        internal static void RenderStart() { if (instance) instance.renderStart = NowMs; }
        internal static void RenderEnd()
        {
            if (!instance) return;
            instance.renderMs = NowMs - instance.renderStart;
            instance.hooksRan = true;
        }

        // Runs first thing each frame, before physics: everything measured since the last call belongs to
        // the frame Time.unscaledDeltaTime just timed.
        internal static void FrameStart() { if (instance) instance.Account(); }

        void Account()
        {
            if (Core == null || Time.frameCount == accountedFrame) return;
            accountedFrame = Time.frameCount;
            var cost = FrameCost.Unknown;
            if (hooksRan)
            {
                cost.Process = updateMs;
                cost.Physics = fixedMs;
                cost.Render = renderMs;
            }
            if (drawCalls.Valid) cost.Calls = drawCalls.LastValue;
            if (triangles.Valid) cost.Triangles = triangles.LastValue;
            if (setPass.Valid) cost.SetPass = setPass.LastValue;
            if (batches.Valid) cost.Batches = batches.LastValue;
            if (shaderCompile.Valid) cost.ShaderCompiles = shaderCompile.LastValue > 0 ? 1 : 0;
            if (gcAlloc.Valid) cost.GcAllocKb = gcAlloc.LastValue / 1024.0;
            if (gameObjects.Valid)
            {
                var n = gameObjects.LastValue;
                cost.ObjectsAdded = lastGameObjects >= 0 ? Math.Max(0, n - lastGameObjects) : 0;
                lastGameObjects = n;
            }
            var gc = GC.CollectionCount(0);
            cost.GcCollections = gc - lastGc;
            lastGc = gc;
            if (FrameTimingManager.IsFeatureEnabled())
            {
                FrameTimingManager.CaptureFrameTimings();
                if (FrameTimingManager.GetLatestTimings(1, timings) > 0 && timings[0].gpuFrameTime > 0) cost.Gpu = timings[0].gpuFrameTime;
            }
            cost.SceneChanged = sceneChanged;
            sceneChanged = false;
            fixedMs = updateMs = renderMs = 0;
            DrainLogs();
            // Frame 1's delta is the engine starting up, not a frame.
            if (Time.frameCount > 1) Core.Frame(Time.unscaledDeltaTime * 1000.0, cost);
        }

        void Update()
        {
            if (Core == null) return;
            if (accountedFrame != Time.frameCount) Account(); // the player loop markers are missing: someone replaced the loop
            var bugs = Core.Options.BugReports;
            if (bugs != null && bugs.Hotkey != KeyCode.None && BugReportForm.KeyDown(bugs.Hotkey)) BugForm().Toggle();
            PollInput();
            if (measureSeconds > 0 && !measureStarted && Time.realtimeSinceStartup >= measureAt)
            {
                measureStarted = true;
                Core.Measure(measureSeconds, OnMeasured);
            }
        }

        void OnMeasured(Dictionary<string, object> result)
        {
            var line = Json.Serialize(new Dictionary<string, object> { ["glitchless_measure"] = result });
            Console.WriteLine(line);
            UnityEngine.Debug.Log(line);
            var path = Core.FlagValue("--glitchless-out");
            if (!string.IsNullOrEmpty(path))
            {
                try
                {
                    File.WriteAllText(path, line + "\n");
                }
                catch (Exception e)
                {
                    UnityEngine.Debug.LogWarning($"[glitchless] could not write {path}: {e.Message}");
                }
            }
            Core.Shutdown("measure");
#if UNITY_EDITOR
            EditorApplication.isPlaying = false;
#else
            Application.Quit();
#endif
        }

        // Profiler counters, where this Unity version, platform and build has them. Release builds have
        // the rendering and memory totals; the object counts and allocation per frame need a development
        // build or the Editor. Anything missing is sent as null.
        void StartRecorders()
        {
            drawCalls = Recorder(ProfilerCategory.Render, "Draw Calls Count");
            triangles = Recorder(ProfilerCategory.Render, "Triangles Count");
            setPass = Recorder(ProfilerCategory.Render, "SetPass Calls Count");
            batches = Recorder(ProfilerCategory.Render, "Batches Count");
            gcUsed = Recorder(ProfilerCategory.Memory, "GC Used Memory");
            gcReserved = Recorder(ProfilerCategory.Memory, "GC Reserved Memory");
            systemUsed = Recorder(ProfilerCategory.Memory, "System Used Memory");
            meshes = Recorder(ProfilerCategory.Memory, "Mesh Count");
            textures = Recorder(ProfilerCategory.Memory, "Texture Count");
            materials = Recorder(ProfilerCategory.Memory, "Material Count");
            objects = Recorder(ProfilerCategory.Memory, "Object Count");
            gameObjects = Recorder(ProfilerCategory.Memory, "Game Object Count");
            gcAlloc = Recorder(ProfilerCategory.Memory, "GC Allocated In Frame");
            shaderCompile = Recorder(ProfilerCategory.Render, "Shader.CreateGPUProgram");
        }

        static ProfilerRecorder Recorder(ProfilerCategory category, string name)
        {
            try
            {
                return Available(name) ? ProfilerRecorder.StartNew(category, name) : default;
            }
            catch (Exception)
            {
                return default;
            }
        }

        static HashSet<string> available;

        // Unity has no lookup by name, so list what this build offers once.
        static bool Available(string name)
        {
            if (available == null)
            {
                available = new HashSet<string>();
                var handles = new List<ProfilerRecorderHandle>();
                ProfilerRecorderHandle.GetAvailable(handles);
                foreach (var h in handles) available.Add(ProfilerRecorderHandle.GetDescription(h).Name);
            }
            return available.Contains(name);
        }

        Dictionary<string, object> SampleEngine()
        {
            var e = new Dictionary<string, object>();
            void Count(string key, ProfilerRecorder r)
            {
                if (r.Valid && r.LastValue > 0) e[key] = (double)r.LastValue;
            }
            void Mb(string key, ProfilerRecorder r)
            {
                if (r.Valid && r.LastValue > 0) e[key] = Sketch.Round(r.LastValue / 1048576.0, 1);
            }
            Count("meshes", meshes);
            Count("textures", textures);
            Count("materials", materials);
            Count("objects", objects);
            Count("game_objects", gameObjects);
            Mb("gc_used_mb", gcUsed);
            Mb("gc_reserved_mb", gcReserved);
            Mb("system_mb", systemUsed);
            return e;
        }

        // ───────────────────────────── bug reports ─────────────────────────────

        BugReportForm BugForm()
        {
            if (!bugForm) bugForm = gameObject.AddComponent<BugReportForm>();
            bugForm.Core = Core;
            if (Core.Options.BugReports != null) bugForm.Options = Core.Options.BugReports;
            return bugForm;
        }

        internal static bool IsBugReportOpen => instance && instance.bugForm && instance.bugForm.IsOpen;

        internal static void OpenBugReport()
        {
            if (EnsureRunning() != null) instance.BugForm().Open();
        }

        internal static void ReportBug(string note, bool screenshot, Action<bool, string> done)
        {
            if (EnsureRunning() == null)
            {
                done?.Invoke(false, "offline");
                return;
            }
            instance.StartCoroutine(instance.Report(Core.BugSnapshot(), note, screenshot, done));
        }

        IEnumerator Report(Dictionary<string, object> snap, string note, bool screenshot, Action<bool, string> done)
        {
            string shot = null;
            if (screenshot && BugScreenshot.CanCapture)
            {
                yield return new WaitForEndOfFrame(); // the frame as drawn
                var tex = BugScreenshot.Capture();
                shot = BugScreenshot.Fit(tex);
                if (tex) Destroy(tex);
                Core?.SkipNextFrame(); // reading the screen back stalls this frame: that isn't the game stuttering
            }
            if (Core == null) done?.Invoke(false, "offline");
            else Core.SendBugReport(snap, note, shot, done);
        }

        // ───────────────────────────── errors ─────────────────────────────

        // Unity calls this from whichever thread logged, so it only writes the entry down; the main thread
        // takes the list every frame. Nothing here may log: that would come straight back in.
        static void OnLog(string condition, string stack, LogType type)
        {
            if (type == LogType.Log) return;
            lock (LogLock)
            {
                if (Logs.Count < MaxPendingLogs) Logs.Add((condition, stack, type));
            }
        }

        void DrainLogs()
        {
            (string condition, string stack, LogType type)[] taken;
            lock (LogLock)
            {
                if (Logs.Count == 0) return;
                taken = Logs.ToArray();
                Logs.Clear();
            }
            var o = Core.Options;
            foreach (var (condition, stack, type) in taken)
            {
                string kind;
                switch (type)
                {
                    case LogType.Exception: kind = "exception"; break; // an exception nothing caught: the rest of that callback didn't run
                    case LogType.Error: kind = "log_error"; break; // Debug.LogError, and errors from the engine itself
                    case LogType.Assert: kind = "assert"; break;
                    default: kind = "warning"; break;
                }
                if ((kind == "log_error" || kind == "assert") && !o.CaptureLogErrors) continue;
                if (kind == "warning" && !o.CaptureWarnings) continue;
                Core.ReportError(kind, condition, stack);
            }
        }

        // ───────────────────────────── scenes ─────────────────────────────

        void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            sceneChanged = true;
            if (scene == SceneManager.GetActiveScene()) Core?.OnSceneActive(scene.name, scene.handle);
        }

        void OnActiveSceneChanged(Scene from, Scene to)
        {
            sceneChanged = true;
            if (to.IsValid()) Core?.OnSceneActive(to.name, to.handle);
        }

        void OnSceneUnloaded(Scene scene)
        {
            sceneChanged = true;
            Core?.OnSceneUnloaded(scene.handle);
        }

        // ───────────────────────────── input ─────────────────────────────

#if ENABLE_LEGACY_INPUT_MANAGER && !(GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM)
        static readonly KeyCode[] Keys =
        {
            KeyCode.Space, KeyCode.Return, KeyCode.Escape, KeyCode.UpArrow, KeyCode.DownArrow, KeyCode.LeftArrow, KeyCode.RightArrow,
            KeyCode.W, KeyCode.A, KeyCode.S, KeyCode.D, KeyCode.E, KeyCode.Q, KeyCode.F, KeyCode.R, KeyCode.LeftShift, KeyCode.Tab,
            KeyCode.JoystickButton0, KeyCode.JoystickButton1, KeyCode.JoystickButton2, KeyCode.JoystickButton3,
        };

        void PollInput()
        {
            for (var i = 0; i < Input.touchCount; i++)
            {
                if (Input.GetTouch(i).phase != TouchPhase.Began) continue;
                Core.OnInput("pointer");
                return;
            }
            if (!Input.anyKeyDown) return;
            if (Input.GetMouseButtonDown(0) || Input.GetMouseButtonDown(1) || Input.GetMouseButtonDown(2))
            {
                Core.OnInput("pointer");
                return;
            }
            foreach (var k in Keys)
            {
                if (!Input.GetKeyDown(k)) continue;
                Core.OnInput(k.ToString());
                return;
            }
            Core.OnInput("key");
        }
#else
        void PollInput() { } // the Input System reports presses through InputSystem.onAnyButtonPress (see Awake)
#endif

        // ───────────────────────────── lifecycle ─────────────────────────────

        void OnApplicationPause(bool paused)
        {
            if (Core == null) return;
            if (Application.isMobilePlatform)
            {
                if (paused) Core.OnBackground();
                else Core.OnForeground();
                return;
            }
            Core.SkipNextFrame(); // a desktop player paused for losing focus: the gap is not a frame
            if (paused && Core.Inited) Core.Flush();
        }

        void OnApplicationFocus(bool focused)
        {
            if (Core == null) return;
            if (focused) Core.SkipNextFrame();
            else if (Core.Inited) Core.Flush();
        }

        static void OnQuitting() => Core?.Shutdown("quit");

#if UNITY_EDITOR
        static void OnEditorPause(PauseState state) => Core?.SkipNextFrame();
#endif
    }

    /// <summary>
    /// Timing markers in Unity's player loop: at the start of each frame, around the physics steps,
    /// around Update to the end of LateUpdate, and around PostLateUpdate (rendering). Other systems in
    /// the loop are left as they are.
    /// </summary>
    static class PlayerLoopHooks
    {
        struct GlitchlessFrameStart { }
        struct GlitchlessFixedStart { }
        struct GlitchlessFixedEnd { }
        struct GlitchlessUpdateStart { }
        struct GlitchlessUpdateEnd { }
        struct GlitchlessRenderStart { }
        struct GlitchlessRenderEnd { }

        static readonly Type[] Ours = { typeof(GlitchlessFrameStart), typeof(GlitchlessFixedStart), typeof(GlitchlessFixedEnd), typeof(GlitchlessUpdateStart), typeof(GlitchlessUpdateEnd), typeof(GlitchlessRenderStart), typeof(GlitchlessRenderEnd) };

        public static void Install()
        {
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            Strip(ref loop);
            var phases = loop.subSystemList;
            if (phases == null) return;
            for (var i = 0; i < phases.Length; i++)
            {
                var t = phases[i].type;
                if (t == typeof(UnityEngine.PlayerLoop.Initialization)) phases[i] = Wrap(phases[i], Sys<GlitchlessFrameStart>(GlitchlessRunner.FrameStart), null);
                else if (t == typeof(UnityEngine.PlayerLoop.FixedUpdate)) phases[i] = Wrap(phases[i], Sys<GlitchlessFixedStart>(GlitchlessRunner.FixedStart), Sys<GlitchlessFixedEnd>(GlitchlessRunner.FixedEnd));
                else if (t == typeof(UnityEngine.PlayerLoop.Update)) phases[i] = Wrap(phases[i], Sys<GlitchlessUpdateStart>(GlitchlessRunner.UpdateStart), null);
                else if (t == typeof(UnityEngine.PlayerLoop.PreLateUpdate)) phases[i] = Wrap(phases[i], null, Sys<GlitchlessUpdateEnd>(GlitchlessRunner.UpdateEnd));
                else if (t == typeof(UnityEngine.PlayerLoop.PostLateUpdate)) phases[i] = Wrap(phases[i], Sys<GlitchlessRenderStart>(GlitchlessRunner.RenderStart), Sys<GlitchlessRenderEnd>(GlitchlessRunner.RenderEnd));
            }
            loop.subSystemList = phases;
            PlayerLoop.SetPlayerLoop(loop);
        }

        public static void Remove()
        {
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            if (Strip(ref loop)) PlayerLoop.SetPlayerLoop(loop);
        }

        static PlayerLoopSystem? Sys<T>(PlayerLoopSystem.UpdateFunction fn) => new PlayerLoopSystem { type = typeof(T), updateDelegate = fn };

        static PlayerLoopSystem Wrap(PlayerLoopSystem phase, PlayerLoopSystem? first, PlayerLoopSystem? last)
        {
            var list = new List<PlayerLoopSystem>(phase.subSystemList ?? Array.Empty<PlayerLoopSystem>());
            if (first.HasValue) list.Insert(0, first.Value);
            if (last.HasValue) list.Add(last.Value);
            phase.subSystemList = list.ToArray();
            return phase;
        }

        static bool Strip(ref PlayerLoopSystem system)
        {
            if (system.subSystemList == null) return false;
            var changed = false;
            var list = new List<PlayerLoopSystem>();
            foreach (var sub in system.subSystemList)
            {
                if (Array.IndexOf(Ours, sub.type) >= 0)
                {
                    changed = true;
                    continue;
                }
                var copy = sub;
                changed |= Strip(ref copy);
                list.Add(copy);
            }
            if (changed) system.subSystemList = list.ToArray();
            return changed;
        }
    }

    /// <summary>Sends batches with UnityWebRequest, which works on every platform including WebGL.</summary>
    sealed class UnityTransport : ITransport
    {
        readonly List<UnityWebRequest> live = new List<UnityWebRequest>(); // a batch, and any bug report on its own

        public void Send(string url, byte[] body, string contentType, Action<long> done)
        {
            var req = Make(url, body, contentType, 10);
            live.Add(req);
            req.SendWebRequest().completed += _ =>
            {
                var status = Status(req);
                live.Remove(req);
                req.Dispose();
                done(status);
            };
        }

        // The game is closing, so there are no more frames: wait here, up to the deadline.
        public long SendNow(string url, byte[] body, string contentType, int timeoutMs)
        {
            using (var req = Make(url, body, contentType, Math.Max(1, (timeoutMs + 999) / 1000)))
            {
                var op = req.SendWebRequest();
                var sw = Stopwatch.StartNew();
                while (!op.isDone && sw.ElapsedMilliseconds < timeoutMs) Thread.Sleep(2);
                if (!op.isDone)
                {
                    req.Abort();
                    return 0;
                }
                return Status(req);
            }
        }

        public void Abort()
        {
            foreach (var req in live.ToArray()) req.Abort();
        }

        static UnityWebRequest Make(string url, byte[] body, string contentType, int timeoutS) =>
            new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST)
            {
                uploadHandler = new UploadHandlerRaw(body) { contentType = contentType },
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = timeoutS,
            };

        static long Status(UnityWebRequest r) =>
            r.result == UnityWebRequest.Result.ConnectionError || r.result == UnityWebRequest.Result.DataProcessingError ? 0 : r.responseCode;
    }
}

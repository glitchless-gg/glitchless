using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace GlitchlessSdk
{
    /// <summary>
    /// What one frame cost, measured by GlitchlessRunner from the player loop and Unity's profiler
    /// counters. -1 means not measured on this platform or build.
    /// </summary>
    public struct FrameCost
    {
        public double Process; // Update, coroutines and LateUpdate
        public double Physics; // FixedUpdate and the physics steps
        public double Render; // the main thread's share of rendering (PostLateUpdate)
        public double Gpu;
        public long Calls;
        public long Triangles;
        public long SetPass;
        public long Batches;
        public long ShaderCompiles;
        public long ObjectsAdded;
        public int GcCollections;
        public double GcAllocKb;
        public bool SceneChanged;

        public static FrameCost Unknown => new FrameCost { Process = -1, Physics = -1, Render = -1, Gpu = -1, Calls = -1, Triangles = -1, SetPass = -1, Batches = -1, ShaderCompiles = -1, ObjectsAdded = -1, GcAllocKb = -1 };
    }

    /// <summary>Sends batches. GlitchlessRunner uses UnityWebRequest; tests use a stand-in.</summary>
    public interface ITransport
    {
        /// <summary>Starts a POST; done(status) comes later on the main thread, with 0 for a network failure.</summary>
        void Send(string url, byte[] body, string contentType, Action<long> done);
        /// <summary>Sends and waits at most timeoutMs, for when the game is closing. Returns the status, or 0.</summary>
        long SendNow(string url, byte[] body, string contentType, int timeoutMs);
        /// <summary>Gives up on the requests Send started that are still going.</summary>
        void Abort();
    }

    public sealed class GlitchlessStats
    {
        public long Sent, Failed, Errors, Hitches, Deaths;
        public string LastStatus = "idle";
    }

    /// <summary>
    /// The engine-independent part of the Unity SDK: the same events, in the same shape, as the browser
    /// SDK (packages/sdk/src/core.js) and the Godot SDK (godot/addons/glitchless/glitchless.gd), so the
    /// dashboard, findings and MCP tools take a Unity game as they are.
    /// </summary>
    public sealed class GlitchlessCore
    {
        public const string SdkVersion = "0.4.0";
        public const string Sdk = "glitchless-unity/" + SdkVersion;

        const double HitchMs = 50; // one frame over 50 ms is a stutter a player sees
        const double JankMs = 33.4; // two missed 60 Hz frames
        const double FrozenMs = 700; // Android vitals' "frozen frame"
        const int MaxErrorsPerFingerprint = 25;
        const int MaxQueue = 2000;
        const int MaxHitchEventsPerWindow = 3; // frame_window.hitches still counts every one
        const int RageInputCount = 4;
        const double RageInputWindowMs = 1000;
        const int BatchBytes = 60000;
        const int MaxOutboxEvents = 4000;
        const long MaxOutboxAgeMs = 6L * 86400 * 1000; // the server files anything over 7 days old under "now"
        public const int SendDeadlineMs = 1500; // how long closing or going to the background may wait on the network
        const int RingSize = 240;
        public const int MaxNote = 2000; // characters of a bug report's note the server keeps
        const int BugRecent = 20; // game events and hitches a bug report carries
        const int BugFrames = 6; // frame windows a bug report carries
        const string IdChars = "abcdefghijklmnopqrstuvwxyz0123456789";

        static readonly Regex NotALevel = new Regex(@"\b(boot|bootstrap|init|startup|preload(er)?|load(er|ing)?|splash|intro|title|menu|main ?menu|ui|hud|overlay|pause[d]?|game ?over|settings|options|credits|leaderboard|shop|empty)\b", RegexOptions.IgnoreCase);

        // ───────────────────────────── what the runner (or a test) provides ─────────────────────────────

        readonly Stopwatch clock = Stopwatch.StartNew();
        public Func<long> UnixNow = () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        public Func<double> Clock; // milliseconds, only ever compared with itself; default: a Stopwatch
        public ITransport Transport;
        public string SaveDir; // where the outbox and the player ID live; null writes nothing to disk
        public IdStorage Ids; // keeps the player ID elsewhere (PlayerPrefs on the web); null: files in SaveDir
        public Func<bool, Dictionary<string, object>> Device = full => new Dictionary<string, object>();
        public Func<Dictionary<string, object>> Steam = () => null; // the game's Steamworks facts (SteamInfo.Read), null until it answers
        public Func<Dictionary<string, object>> Engine; // mesh, texture, object counts and memory, where Unity has them
        public Func<double> StartupMs; // time since the app started, for time to first frame
        public Func<string[]> Args = () => Environment.GetCommandLineArgs();
        public Func<int[]> ScreenSize = () => null;
        public Func<int[]> WindowSize = () => null;
        public Func<double> ScreenHz = () => 0; // the screen's refresh rate as the OS reports it, 0 when unknown
        public Func<string> TestLabSetting = () => null; // Android's firebase.test.lab setting (DeviceInfo.FirebaseTestLab)
        public Action<string> Log = s => UnityEngine.Debug.Log(s);
        public string AppVersion = "";
        public bool IsBatchMode, IsDebugBuild, IsMobile, IsWeb;
        public Scrubber Scrubber = new Scrubber();

        // ───────────────────────────── state ─────────────────────────────

        public GlitchlessOptions Options = new GlitchlessOptions();
        public bool Inited { get; private set; }
        public bool Enabled { get; private set; }
        public bool Sampled { get; private set; } = true;
        public string SessionId { get; private set; }
        public string PlayerId { get; private set; } = "";
        public string Level { get; private set; }
        public string Service => service;
        public string Env => env;
        public string AppVersionInUse => version;
        public int FrameCount { get; private set; }
        public double BudgetMs { get; private set; } = 1000.0 / 60;
        public readonly GlitchlessStats Stats = new GlitchlessStats();
        public readonly Dictionary<string, double> Ctx = new Dictionary<string, double>();

        string service = "unknown-game", version = "0.0.0", env = "dev", intake = "", sessionType = "user";
        Dictionary<string, object> steamFacts; // read once Steamworks answers
        bool full, storesId, versionGiven, positionsOn, rageInputOn, debug, manualLevels, sceneLevels = true;
        long startedAt;
        double levelStartedAt;
        bool levelOpen; // a level started and not yet completed, failed or abandoned
        string leftLevel; // the level abandoned for the game as the session ended
        readonly List<(string name, double t)> recent = new List<(string, double)>();
        readonly List<Dictionary<string, object>> history = new List<Dictionary<string, object>>(); // the last game events, slimmed, for bug reports
        readonly List<Dictionary<string, object>> recentHitches = new List<Dictionary<string, object>>();
        readonly List<Dictionary<string, object>> recentWindows = new List<Dictionary<string, object>>(); // {ts, level, fps, p95}
        List<Dictionary<string, object>> queue = new List<Dictionary<string, object>>();
        readonly List<Batch> outbox = new List<Batch>();
        int nextBatchId = 1, inFlight = -1, sends;
        double retryAt, backoffS;
        bool sessionStartSent, loadSent, ended, shut;
        double pausedAt;
        readonly Dictionary<string, int> errorCounts = new Dictionary<string, int>();
        readonly Dictionary<string, Dictionary<string, object>> errorLog = new Dictionary<string, Dictionary<string, object>>();
        readonly List<Probe> probes = new List<Probe>();
        readonly List<Dictionary<string, object>> pendingHitches = new List<Dictionary<string, object>>();
        Window win;
        readonly double[] ring = new double[RingSize];
        int ringIdx, ringCount, hz = 60;
        static readonly int[] Rates = { 30, 60, 75, 90, 100, 120, 144, 165, 240 };
        List<double> rateFrames = new List<double>(); // frame times under 100 ms, for the refresh rate
        double recentMedian;
        (double dt, FrameCost cost)? pendingLong;
        bool throttled, skipNext;
        double firstFrameMs, firstInputAt;
        long firstFrameAt; // unix ms of the first frame, the load event's ts
        string firstFrameLevel;
        bool? firstLaunch; // the first launch of this game version on this device (the load event's first_launch)
        readonly Dictionary<string, List<double>> keyHistory = new Dictionary<string, List<double>>();
        double[] position;
        readonly List<object> posBuffer = new List<object>();
        double nextFlushAt, nextPosAt;
        Dictionary<string, object> engine = new Dictionary<string, object>();
        int levelSceneHandle, levelSceneFrame = -1;
        int[] screen, window;
        readonly System.Random random = new System.Random();

        // Bid is the batch's own random ID (SPEC §2 batch_id). It goes with every try of the batch and is saved with it,
        // so the server stores a batch once however many times it is sent: after a timeout, a send cut short by going to
        // the background or quitting, or a launch that sends what the last one saved. It names the batch, not the player
        // or the session, so anonymous mode saves it too.
        sealed class Batch
        {
            public int Id;
            public string Bid, Service, Env, Version, Sid, Pid;
            public long Group;
            public List<string> Events;
            public bool Direct; // a bug report on a request of its own
        }

        sealed class Window
        {
            public long StartedAt;
            public double StartedTicks;
            public int Frames, Slow, Jank, Hitches, Frozen, Gc, CallFrames, GpuFrames, AllocFrames, CostFrames, PhysicsFrames;
            public readonly Sketch Sketch = new Sketch();
            public double Max, Render, Gpu, Process, Physics, AllocKb;
            public long Calls, CallsMax, Tris, SetPass, Batches;
            public readonly Dictionary<string, double> Ctx = new Dictionary<string, double>();
        }

        sealed class Probe
        {
            public double EndAt, Seconds;
            public Action<Dictionary<string, object>> Done;
            public readonly Sketch Frames = new Sketch(), Render = new Sketch(), Process = new Sketch(), Physics = new Sketch(), Gpu = new Sketch();
            public int Count, Gc;
            public double Max;
            public long Calls, CallsMax, Tris, CallFrames;
            public readonly List<object> Hitches = new List<object>();
            public readonly Dictionary<string, double> CtxMax = new Dictionary<string, double>();
            public long Errors;
            public Dictionary<string, int> Fingerprints;
            public string Level;
            public Dictionary<string, object> Engine;
        }

        public GlitchlessCore()
        {
            Clock = () => clock.Elapsed.TotalMilliseconds;
            SessionId = NewId("s_", 16); // held in memory only; anonymous mode never writes it down
            startedAt = UnixNow();
            win = NewWindow();
            nextFlushAt = double.MaxValue;
        }

        double Ticks => Clock();

        // ───────────────────────────── the game's calls ─────────────────────────────

        /// <summary>Says who the game is and where to send. Until this is called nothing is sent, but frame
        /// times, errors and events are kept, so a game may call it late.</summary>
        public void Init(GlitchlessOptions options)
        {
            if (Inited) return;
            Inited = true;
            Options = options ?? new GlitchlessOptions();
            service = string.IsNullOrEmpty(Options.Service) ? "unknown-game" : Options.Service.ToLowerInvariant();
            versionGiven = !string.IsNullOrEmpty(Options.Version);
            version = versionGiven ? Options.Version : !string.IsNullOrEmpty(AppVersion) ? AppVersion : "0.0.0";
            SteamFacts(); // Steamworks may answer only later: session_start asks again
            env = !string.IsNullOrEmpty(Options.Env) ? Options.Env : IsDebugBuild ? "dev" : "prod";
            var flagIntake = FlagValue("--glitchless-intake");
            intake = (flagIntake ?? Options.Intake ?? "").TrimEnd('/');
            full = Options.Privacy == Privacy.Full;
            storesId = full || Options.Privacy == Privacy.Install; // the modes that send a stored ID
            positionsOn = Options.Positions ?? full;
            rageInputOn = Options.RageInput ?? !IsMobile;
            sceneLevels = Options.SceneLevels;
            debug = debug || Options.Debug || HasFlag("--glitchless-debug");
            sessionType = SessionTypeFor(Options.SessionType, IsBatchMode || HasFlag("--autoplay") || HasFlag("--glitchless-synthetic") || HasFlag("--glitchless-measure"), TestLabSetting);
            Enabled = (Options.Enabled ?? !HasFlag("--glitchless-off")) && intake != "";
            Sampled = random.NextDouble() < Options.SampleRate;
            // The first batch goes soon, so a session that crashes early is still seen.
            nextFlushAt = Ticks + Math.Min(2000, Options.FlushIntervalSeconds * 1000);
            if (!Enabled)
            {
                queue.Clear();
                Debug("off (no intake, or turned off)");
                return;
            }
            if (SaveDir != null) TryIo(() => Directory.CreateDirectory(SaveDir));
            firstLaunch = NoteLaunch();
            // Install and full mode share one saved ID (SPEC §4b); anonymous mode deletes one another build left.
            if (storesId) PlayerId = LoadId(PlayerIdName, "p_");
            else TryIo(() => DeleteId(PlayerIdName));
            if (SaveDir != null) LoadOutbox();
            Debug($"on: {service} {version} {env} -> {intake} ({PrivacyName}, {sessionType})");
        }

        /// <summary>The session's type: what the game set; else synthetic for a bot (batch mode, --autoplay and the flags)
        /// or a Firebase Test Lab device, whose firebase.test.lab setting is "true" (Google Play's pre-launch report plays
        /// every new build on them); else user. The setting is read only when nothing else decides.</summary>
        internal static string SessionTypeFor(string set, bool bot, Func<string> testLabSetting)
        {
            if (!string.IsNullOrEmpty(set)) return set;
            if (bot) return "synthetic";
            return testLabSetting?.Invoke() == "true" ? "synthetic" : "user";
        }

        public void LevelStart(string levelId) => StartLevel(levelId, fromScene: false);

        void StartLevel(string levelId, bool fromScene)
        {
            if (!fromScene) manualLevels = true; // the game knows its levels better than the scene names do
            CloseWindow(false); // so a frame window never spans two levels
            Level = levelId;
            levelStartedAt = Ticks;
            levelOpen = true;
            leftLevel = null;
            Push(Ev("level_start"));
            Remember("level_start");
        }

        public void LevelComplete(string levelId = null, double? score = null, double? durationS = null)
        {
            levelOpen = false;
            var e = Ev("level_complete");
            e["level"] = levelId ?? Level;
            e["duration_s"] = Sketch.Round(durationS ?? (Ticks - levelStartedAt) / 1000, 2);
            e["score"] = score;
            Push(e);
            Remember("level_complete");
        }

        /// <summary>The player lost the level (died, ran out of lives or time). Leaving it is LevelAbandon.</summary>
        public void LevelFail(string levelId = null, string cause = null)
        {
            var level = levelId ?? Level;
            if (OutcomeSent(level)) return;
            levelOpen = false;
            var e = Ev("level_fail");
            e["level"] = level;
            e["cause"] = string.IsNullOrEmpty(cause) ? null : cause;
            Push(e);
            Remember("level_fail");
        }

        /// <summary>The player left the level before it ended: went to the menu, restarted it, closed the game. Never
        /// counted as a fail. Going to the background or quitting mid-level sends one by itself (SPEC §2 level_abandon).</summary>
        public void LevelAbandon(string levelId = null)
        {
            var level = levelId ?? Level;
            if (OutcomeSent(level)) return;
            Abandon(level, null);
        }

        void Abandon(string level, string reason)
        {
            levelOpen = false;
            var e = Ev("level_abandon");
            e["level"] = level;
            e["duration_s"] = Sketch.Round((Ticks - levelStartedAt) / 1000, 2);
            if (reason != null) e["reason"] = reason;
            Push(e);
            Remember("level_abandon");
        }

        // A game often ends its level as it closes (in an OnDestroy, say), after the session ended and Glitchless already
        // sent the abandon: that attempt has its outcome.
        bool OutcomeSent(string level) => ended && leftLevel != null && level == leftLevel;

        // The session ends with a level still going: the player left it (SPEC §2 level_abandon).
        void EndLevel(string reason)
        {
            if (!levelOpen) return;
            leftLevel = Level;
            Abandon(Level, reason);
        }

        /// <summary>A death. The place is sent only when positions are on; the death and cause always are.</summary>
        public void Death(double? x, double? y, double? z, string cause)
        {
            Stats.Deaths++;
            cause = string.IsNullOrEmpty(cause) ? "unknown" : cause;
            var e = Ev("death");
            e["cause"] = cause;
            if (positionsOn && x.HasValue)
            {
                e["x"] = Sketch.Round(x.Value, 2);
                e["y"] = Sketch.Round(y ?? 0, 2);
                e["z"] = Sketch.Round(z ?? 0, 2);
            }
            Push(e);
            Remember("death:" + cause);
        }

        public void Track(string name, Dictionary<string, object> attrs)
        {
            var e = Ev("custom");
            e["name"] = name;
            e["attrs"] = attrs ?? new Dictionary<string, object>();
            Push(e);
            Remember(name);
        }

        public void SetContext(string key, double value) => Gauge(key, value);

        public void SetPosition(double x, double y, double z)
        {
            if (positionsOn) position = new[] { x, y, z };
        }

        // ───────────────────────────── scenes as levels ─────────────────────────────

        /// <summary>A scene became the active one (or was loaded as it): if it's a level, that level starts.</summary>
        public void OnSceneActive(string sceneName, int handle)
        {
            if (manualLevels || !sceneLevels) return;
            var level = LevelForScene(sceneName);
            if (level == null) return; // a menu or overlay scene made active: the level ends when its scene unloads
            // Unity reports a load as both activeSceneChanged and sceneLoaded: one level start.
            if (handle == levelSceneHandle && levelSceneFrame == FrameCount) return;
            levelSceneHandle = handle;
            levelSceneFrame = FrameCount;
            StartLevel(level, fromScene: true);
        }

        public void OnSceneUnloaded(int handle)
        {
            if (!manualLevels && handle == levelSceneHandle) LeaveLevel();
        }

        void LeaveLevel()
        {
            levelSceneHandle = 0;
            CloseWindow(false);
            Level = null; // back in a menu: frames there have no level
            levelOpen = false; // nothing to abandon if the game closes from the menu
        }

        public string LevelForScene(string sceneName)
        {
            if (string.IsNullOrEmpty(sceneName)) return null;
            if (Options.LevelForScene != null) return Options.LevelForScene(sceneName);
            var words = Regex.Replace(Regex.Replace(Regex.Replace(sceneName, "([a-z0-9])([A-Z])", "$1 $2"), "([A-Z])([A-Z][a-z])", "$1 $2"), @"[_\-.]+", " ");
            return NotALevel.IsMatch(words) ? null : sceneName;
        }

        // ───────────────────────────── frame timing ─────────────────────────────

        /// <summary>The frame that just ended took dtMs (Time.unscaledDeltaTime) and cost what `cost` says.</summary>
        public void Frame(double dtMs, FrameCost cost)
        {
            FrameCount++;
            if (skipNext)
            {
                skipNext = false; // the gap was a pause or a trip to the background, not a frame
                pendingLong = null;
            }
            else if (dtMs >= 5000) pendingLong = null;
            else if (dtMs > FrozenMs)
            {
                // A run of long frames is the OS throttling a hidden window, not the game: a single long
                // frame between normal ones is a real freeze; a run is dropped.
                if (pendingLong != null || throttled)
                {
                    pendingLong = null;
                    throttled = true;
                }
                else pendingLong = (dtMs, cost);
            }
            else
            {
                if (pendingLong != null) OnFrame(pendingLong.Value.dt, pendingLong.Value.cost);
                pendingLong = null;
                throttled = false;
                OnFrame(dtMs, cost);
            }
            // The refresh rate (60 / 90 / 120 Hz, or a cap the game set) sets the frame budget. A frame can take longer
            // than the screen's interval but never less, so the fast frames tell the rate, as the browser SDK reads it:
            // a first guess after 30 frames (so the session's first window isn't judged at a made-up 60 Hz), the answer
            // at 120, then a look every 480 frames, only ever faster. CheckScreen lowers it when the OS says the screen
            // slowed down (Low Power Mode).
            if (dtMs > 3.5 && dtMs < 100)
            {
                rateFrames.Add(dtMs);
                var n = rateFrames.Count;
                if (n == 30 || n == 120 || n == 600) SetBudget(Quantile(rateFrames, 0.2), onlyFaster: n == 600);
                if (n >= 600) rateFrames = rateFrames.GetRange(480, n - 480);
            }
            Tick();
        }

        /// <summary>The next frame's time is a gap (a pause, the Editor's pause button, focus coming back).</summary>
        public void SkipNextFrame() => skipNext = true;

        // Timers that run every frame: positions, windows, sends, measure().
        void Tick()
        {
            var now = Ticks;
            if (positionsOn && position != null && now >= nextPosAt)
            {
                nextPosAt = now + 1000 / Math.Max(Options.PositionHz, 0.1);
                posBuffer.Add(new object[] { UnixNow(), Sketch.Round(position[0], 2), Sketch.Round(position[1], 2), Sketch.Round(position[2], 2) });
            }
            if (FrameCount % 30 == 0) SampleEngine();
            if (now - win.StartedTicks >= Options.WindowSeconds * 1000) CloseWindow(true);
            if (now >= nextFlushAt) Flush(closeWindow: false);
            if (Inited && Enabled && inFlight < 0 && outbox.Count > 0 && now >= retryAt) SendNext();
            for (var i = probes.Count - 1; i >= 0; i--)
            {
                if (now < probes[i].EndAt) continue;
                var p = probes[i];
                probes.RemoveAt(i);
                p.Done?.Invoke(ProbeResult(p));
            }
        }

        void SetBudget(double typicalDt, bool onlyFaster = false)
        {
            var rate = 1000 / typicalDt;
            var best = 60;
            foreach (var r in Rates)
                if (Math.Abs(r - rate) < Math.Abs(best - rate)) best = r;
            if (onlyFaster && best <= hz) return;
            hz = best;
            BudgetMs = 1000.0 / hz;
        }

        void OnFrame(double dt, FrameCost f)
        {
            var w = win;
            w.Frames++;
            w.Sketch.Add(dt);
            if (dt > w.Max) w.Max = dt;
            if (dt > BudgetMs * 1.5) w.Slow++;
            if (dt > JankMs) w.Jank++;
            if (dt > FrozenMs) w.Frozen++;
            if (f.Process >= 0)
            {
                w.CostFrames++;
                w.Process += f.Process;
                w.Render += Math.Max(0, f.Render);
            }
            if (f.Physics >= 0)
            {
                w.PhysicsFrames++;
                w.Physics += f.Physics;
            }
            if (f.Gpu > 0)
            {
                w.GpuFrames++;
                w.Gpu += f.Gpu;
            }
            if (f.Calls >= 0)
            {
                w.CallFrames++;
                w.Calls += f.Calls;
                w.CallsMax = Math.Max(w.CallsMax, f.Calls);
                w.Tris += Math.Max(0, f.Triangles);
                w.SetPass += Math.Max(0, f.SetPass);
                w.Batches += Math.Max(0, f.Batches);
            }
            if (f.GcAllocKb >= 0)
            {
                w.AllocFrames++;
                w.AllocKb += f.GcAllocKb;
            }
            w.Gc += f.GcCollections;
            ring[ringIdx] = dt;
            ringIdx = (ringIdx + 1) % RingSize;
            ringCount = Math.Min(ringCount + 1, RingSize);
            if (firstFrameMs <= 0)
            {
                firstFrameMs = StartupMs != null ? StartupMs() : Ticks;
                firstFrameAt = UnixNow(); // the load event happened now, whenever the first batch goes
                firstFrameLevel = Level;
            }
            if (FrameCount % 16 == 0 && ringCount >= 30) recentMedian = Median(LastFrames(60));

            // A hitch is a stutter: over 50 ms and well above what this device usually does. A device that
            // is slow all the time shows in the percentiles instead.
            var hitch = dt > HitchMs && dt > 2 * recentMedian;
            List<string> causes = null;
            if (hitch)
            {
                SampleEngine(); // the counts this frame ended with go in the hitch's ctx
                causes = Causes(dt, f);
            }
            foreach (var p in probes)
            {
                p.Count++;
                p.Frames.Add(dt);
                p.Max = Math.Max(p.Max, dt);
                if (f.Process >= 0)
                {
                    p.Process.Add(f.Process);
                    p.Render.Add(Math.Max(0, f.Render));
                }
                if (f.Physics >= 0) p.Physics.Add(f.Physics);
                if (f.Gpu > 0) p.Gpu.Add(f.Gpu);
                if (f.Calls >= 0)
                {
                    p.CallFrames++;
                    p.Calls += f.Calls;
                    p.CallsMax = Math.Max(p.CallsMax, f.Calls);
                    p.Tris += Math.Max(0, f.Triangles);
                }
                p.Gc += f.GcCollections;
                if (hitch) p.Hitches.Add(new Dictionary<string, object> { ["ms"] = Sketch.Round(dt, 1), ["level"] = Level, ["draw_calls"] = f.Calls >= 0 ? (object)f.Calls : null, ["causes"] = causes, ["ctx"] = new Dictionary<string, double>(Ctx), ["recent"] = RecentWithin(1500) });
            }
            if (!hitch) return;
            w.Hitches++;
            Stats.Hitches++;
            pendingHitches.Add(new Dictionary<string, object>
            {
                ["type"] = "hitch",
                ["ts"] = UnixNow(),
                ["level"] = Level,
                ["duration_ms"] = Sketch.Round(dt, 1),
                ["frozen"] = dt > FrozenMs,
                ["draw_calls"] = f.Calls >= 0 ? (object)f.Calls : null,
                ["triangles"] = f.Triangles >= 0 ? (object)f.Triangles : null,
                ["programs"] = null,
                ["ctx"] = new Dictionary<string, double>(Ctx),
                ["recent"] = RecentWithin(1500),
                ["causes"] = causes,
                ["loaf"] = new List<object>(),
                ["process_ms"] = f.Process >= 0 ? (object)Sketch.Round(f.Process, 1) : null,
                ["physics_ms"] = f.Physics >= 0 ? (object)Sketch.Round(f.Physics, 1) : null,
                ["render_ms"] = f.Render >= 0 ? (object)Sketch.Round(f.Render, 1) : null,
                ["gpu_ms"] = f.Gpu > 0 ? (object)Sketch.Round(f.Gpu, 1) : null,
                ["gc_collections"] = f.GcCollections,
                ["gc_alloc_kb"] = f.GcAllocKb >= 0 ? (object)Sketch.Round(f.GcAllocKb, 1) : null,
                ["shader_compiles"] = f.ShaderCompiles >= 0 ? (object)f.ShaderCompiles : null,
                ["objects_added"] = f.ObjectsAdded >= 0 ? (object)f.ObjectsAdded : null,
            });
        }

        // Likely causes of one long frame, from what that frame measured.
        static List<string> Causes(double dt, FrameCost f)
        {
            var share = Math.Max(16, dt * 0.4);
            var c = new List<string>();
            if (f.GcCollections > 0) c.Add("gc");
            if (f.ShaderCompiles > 0) c.Add("shader_compile");
            if (f.SceneChanged) c.Add("scene_change");
            if (f.ObjectsAdded >= 50) c.Add("object_spawn");
            if (f.Process >= share) c.Add("script");
            if (f.Physics >= share) c.Add("physics");
            if (Math.Max(f.Render, f.Gpu) >= share) c.Add("render");
            // None of those, and what the timing points measured (Update to LateUpdate, physics, PostLateUpdate, and the
            // GPU where FrameTimingManager has it) adds up to little of the frame: the time went where they can't see, to
            // the GPU, presenting the frame, the OS, or the engine's own work between them.
            if (c.Count == 0 && f.Process >= 0 && f.Process + Math.Max(0, f.Physics) + Math.Max(0, f.Render) + Math.Max(0, f.Gpu) < share) c.Add("gpu_or_os");
            if (dt > FrozenMs) c.Add("frozen");
            return c;
        }

        Window NewWindow() => new Window { StartedAt = UnixNow(), StartedTicks = Ticks };

        /// <param name="fresh">Sample the engine counts now. Not when a level starts: whatever the game just
        /// did to load the new level belongs to the new level.</param>
        void CloseWindow(bool fresh)
        {
            if (fresh && win.Frames > 0) SampleEngine();
            var w = win;
            win = NewWindow();
            if (w.Frames > 0)
            {
                var secs = Math.Max((Ticks - w.StartedTicks) / 1000, 0.001);
                var n = w.Frames;
                var s = w.Sketch;
                QueueEvent(new Dictionary<string, object>
                {
                    ["type"] = "frame_window",
                    ["ts"] = w.StartedAt,
                    ["level"] = Level,
                    ["duration_s"] = Sketch.Round(secs, 2),
                    ["frames"] = n,
                    ["fps"] = Sketch.Round(n / secs, 1),
                    ["hz"] = hz,
                    ["budget_ms"] = Sketch.Round(BudgetMs, 2),
                    ["ft"] = s.ToJson(),
                    ["ft_p50"] = Round(s.Quantile(0.5), 2),
                    ["ft_p95"] = Round(s.Quantile(0.95), 2),
                    ["ft_p99"] = Round(s.Quantile(0.99), 2),
                    ["ft_max"] = Sketch.Round(w.Max, 1),
                    ["slow"] = w.Slow,
                    ["jank"] = w.Jank,
                    ["hitches"] = w.Hitches,
                    ["frozen"] = w.Frozen,
                    ["render_ms"] = w.CostFrames > 0 ? (object)Sketch.Round(w.Render / w.CostFrames, 2) : null,
                    ["gpu_ms"] = w.GpuFrames > 0 ? (object)Sketch.Round(w.Gpu / w.GpuFrames, 2) : null,
                    ["process_ms"] = w.CostFrames > 0 ? (object)Sketch.Round(w.Process / w.CostFrames, 2) : null,
                    ["physics_ms"] = w.PhysicsFrames > 0 ? (object)Sketch.Round(w.Physics / w.PhysicsFrames, 2) : null,
                    ["draw_calls"] = w.CallFrames > 0 ? (object)(long)Math.Round((double)w.Calls / w.CallFrames) : null,
                    ["draw_calls_max"] = w.CallFrames > 0 ? (object)w.CallsMax : null,
                    ["triangles"] = w.CallFrames > 0 ? (object)(long)Math.Round((double)w.Tris / w.CallFrames) : null,
                    ["setpass_calls"] = w.CallFrames > 0 ? (object)(long)Math.Round((double)w.SetPass / w.CallFrames) : null,
                    ["batches"] = w.CallFrames > 0 ? (object)(long)Math.Round((double)w.Batches / w.CallFrames) : null,
                    // The mesh count goes where three.js sends geometries, so the leak finding reads both.
                    ["geometries"] = Engine0("meshes"),
                    ["textures"] = Engine0("textures"),
                    ["programs"] = null,
                    ["materials"] = Engine0("materials"),
                    ["objects"] = Engine0("objects"),
                    ["game_objects"] = Engine0("game_objects"),
                    ["heap_mb"] = Engine0("gc_used_mb"),
                    ["gc_reserved_mb"] = Engine0("gc_reserved_mb"),
                    ["system_mb"] = Engine0("system_mb"),
                    ["gc_collections"] = w.Gc,
                    ["gc_alloc_kb"] = w.AllocFrames > 0 ? (object)Sketch.Round(w.AllocKb / w.AllocFrames, 2) : null,
                    ["screen"] = screen,
                    ["window"] = window,
                    ["ctx"] = new Dictionary<string, double>(w.Ctx),
                });
                recentWindows.Add(new Dictionary<string, object> { ["ts"] = w.StartedAt, ["level"] = Level, ["fps"] = Sketch.Round(n / secs, 1), ["p95"] = Round(s.Quantile(0.95), 2) });
                if (recentWindows.Count > 12) recentWindows.RemoveAt(0);
            }
            if (posBuffer.Count > 0)
            {
                QueueEvent(new Dictionary<string, object> { ["type"] = "pos", ["ts"] = ((object[])posBuffer[0])[0], ["level"] = Level, ["pts"] = new List<object>(posBuffer) });
                posBuffer.Clear();
            }
            pendingHitches.Sort((a, b) => ((double)b["duration_ms"]).CompareTo((double)a["duration_ms"]));
            for (var i = 0; i < Math.Min(MaxHitchEventsPerWindow, pendingHitches.Count); i++)
            {
                QueueEvent(pendingHitches[i]);
                recentHitches.Add(Slim(pendingHitches[i]));
            }
            if (recentHitches.Count > BugRecent) recentHitches.RemoveRange(0, recentHitches.Count - BugRecent);
            pendingHitches.Clear();
        }

        object Engine0(string key) => engine.TryGetValue(key, out var v) ? v : null;

        // Engine counts: meshes, textures, materials and objects climb level after level when something
        // leaks. With EngineGauges on they go in ctx too, where the findings compare a slow level's gauges
        // with the smoothest level's.
        Dictionary<string, object> SampleEngine()
        {
            var e = Engine?.Invoke();
            if (e != null) engine = e;
            if (Options.EngineGauges)
                foreach (var k in new[] { "game_objects", "meshes", "materials" })
                    if (engine.TryGetValue(k, out var v) && v is double d) Gauge(k, d);
            CheckScreen();
            return engine;
        }

        // The screen size changes when a folding phone opens or a window moves to another screen: a
        // breadcrumb for any stutter that follows.
        void CheckScreen()
        {
            // The OS reports the screen's rate, which can be higher than what the game gets (a 60 Hz panel said to be
            // 120) but drops at once when a ProMotion phone goes into Low Power Mode: then the frames' rate does too.
            var osHz = ScreenHz();
            if (osHz >= 30 && osHz < hz) SetBudget(1000 / osHz);
            var s = ScreenSize();
            var wsz = WindowSize();
            if (s == null) return;
            if (screen == null)
            {
                screen = s;
                window = wsz;
            }
            else if (!Same(s, screen) || !Same(wsz, window))
            {
                screen = s;
                window = wsz;
                Track("screen_change", new Dictionary<string, object> { ["screen"] = s, ["window"] = wsz });
            }
        }

        static bool Same(int[] a, int[] b) => a != null && b != null && a.Length == b.Length && a[0] == b[0] && a[1] == b[1];

        void Gauge(string key, double v)
        {
            Ctx[key] = v;
            win.Ctx[key] = win.Ctx.TryGetValue(key, out var w) ? Math.Max(w, v) : v;
            foreach (var p in probes) p.CtxMax[key] = p.CtxMax.TryGetValue(key, out var m) ? Math.Max(m, v) : v;
        }

        List<double> LastFrames(int count)
        {
            var n = Math.Min(count, ringCount);
            var out_ = new List<double>(n);
            for (var i = n; i > 0; i--) out_.Add(ring[(ringIdx - i + RingSize) % RingSize]);
            return out_;
        }

        // ───────────────────────────── measure ─────────────────────────────

        /// <summary>Frame stats over the next `seconds`, the same numbers as the browser SDK's glitchless_measure.</summary>
        public void Measure(double seconds, Action<Dictionary<string, object>> done)
        {
            var fps = new Dictionary<string, int>();
            foreach (var kv in errorLog) fps[kv.Key] = (int)kv.Value["count"];
            probes.Add(new Probe { EndAt = Ticks + seconds * 1000, Seconds = seconds, Done = done, Errors = Stats.Errors, Fingerprints = fps, Level = Level, Engine = new Dictionary<string, object>(SampleEngine()) });
        }

        Dictionary<string, object> ProbeResult(Probe p)
        {
            if (p.Count == 0) return new Dictionary<string, object> { ["error"] = "No frames were drawn: the game was paused or in the background." };
            var now = new Dictionary<string, object>(SampleEngine());
            var delta = new Dictionary<string, object>();
            foreach (var kv in now)
                delta[kv.Key] = kv.Value is double a && p.Engine.TryGetValue(kv.Key, out var b) && b is double bd ? (object)Sketch.Round(a - bd, 1) : null;
            var newErrors = new List<object>();
            foreach (var kv in errorLog)
            {
                p.Fingerprints.TryGetValue(kv.Key, out var was);
                var count = (int)kv.Value["count"];
                if (count > was) newErrors.Add(new Dictionary<string, object> { ["message"] = kv.Value["message"], ["kind"] = kv.Value["kind"], ["location"] = kv.Value["location"], ["count"] = count - was });
            }
            var renderP50 = p.Render.Quantile(0.5) ?? 0;
            return new Dictionary<string, object>
            {
                ["seconds"] = p.Seconds,
                ["level_start"] = p.Level,
                ["level_end"] = Level,
                ["frames"] = p.Count,
                ["fps"] = Sketch.Round(p.Count / p.Seconds, 1),
                ["frame_budget_ms"] = Sketch.Round(BudgetMs, 2),
                ["frame_ms"] = new Dictionary<string, object> { ["p50"] = Round(p.Frames.Quantile(0.5), 2), ["p95"] = Round(p.Frames.Quantile(0.95), 2), ["p99"] = Round(p.Frames.Quantile(0.99), 2), ["worst"] = Sketch.Round(p.Max, 1) },
                ["pct_frames_over_budget"] = Sketch.Round(p.Frames.FractionAbove(BudgetMs * 1.15) * 100, 1),
                // The main thread's share of rendering: it rises with scene cost even while vsync hides it in frame time.
                ["render_cpu_ms"] = p.Render.N > 0 ? new Dictionary<string, object> { ["p50"] = Round(p.Render.Quantile(0.5), 2), ["p95"] = Round(p.Render.Quantile(0.95), 2), ["share_of_budget_pct"] = (int)Math.Round(renderP50 / BudgetMs * 100) } : null,
                ["update_cpu_ms"] = p.Process.N > 0 ? new Dictionary<string, object> { ["p50"] = Round(p.Process.Quantile(0.5), 2), ["p95"] = Round(p.Process.Quantile(0.95), 2) } : null,
                ["physics_ms"] = p.Physics.N > 0 ? new Dictionary<string, object> { ["p50"] = Round(p.Physics.Quantile(0.5), 2), ["p95"] = Round(p.Physics.Quantile(0.95), 2) } : null,
                ["gpu_ms"] = p.Gpu.N > 0 ? new Dictionary<string, object> { ["p50"] = Round(p.Gpu.Quantile(0.5), 2), ["p95"] = Round(p.Gpu.Quantile(0.95), 2) } : null,
                ["gc_collections"] = p.Gc,
                ["hitches"] = p.Hitches.Count > 10 ? p.Hitches.GetRange(0, 10) : p.Hitches,
                ["hitch_count"] = p.Hitches.Count,
                ["draw_calls"] = p.CallFrames > 0 ? new Dictionary<string, object> { ["avg"] = (long)Math.Round((double)p.Calls / p.CallFrames), ["max"] = p.CallsMax } : null,
                ["triangles_avg"] = p.CallFrames > 0 ? (object)(long)Math.Round((double)p.Tris / p.CallFrames) : null,
                ["peak_context"] = p.CtxMax,
                ["memory"] = now,
                ["memory_delta"] = delta,
                ["new_errors"] = Stats.Errors - p.Errors,
                ["errors"] = newErrors.Count > 5 ? newErrors.GetRange(0, 5) : newErrors,
                ["sdk"] = Sdk,
            };
        }

        // ───────────────────────────── errors ─────────────────────────────

        /// <summary>An error from Unity's log, or one the game reported (manual).</summary>
        public void ReportError(string kind, string message, string stack, Dictionary<string, object> attrs = null, bool manual = false)
        {
            var frames = StackParser.Parse(stack);
            frames.RemoveAll(StackParser.IsPlumbing);
            if (!manual && frames.Count > 0 && StackParser.IsGlitchless(frames[0])) return; // raised inside Glitchless (a failed send, say): never report it, or it could feed itself
            while (frames.Count > 0 && StackParser.IsGlitchless(frames[0])) frames.RemoveAt(0);
            for (var i = 0; i < frames.Count; i++)
            {
                var f = frames[i];
                f.File = f.File == null ? null : Scrubber.Scrub(f.File);
                frames[i] = f;
            }
            message = Scrubber.Scrub(message ?? "").Trim();
            if (message.Length > 500) message = message.Substring(0, 500);
            if (message.Length == 0) message = "Unknown error";
            var topIndex = StackParser.TopIndex(frames);
            var top = topIndex >= 0 ? frames[topIndex] : (StackFrame?)null;
            var fn = top?.Fn ?? "";
            var file = top?.File;
            var fingerprint = Fingerprint.Of(kind, message, fn);
            errorCounts.TryGetValue(fingerprint, out var count);
            count++;
            errorCounts[fingerprint] = count;
            Stats.Errors++;
            var recentNames = RecentNames(6);
            Remember("error:" + (message.Length > 40 ? message.Substring(0, 40) : message));
            var location = file != null ? $"{fn} ({StackParser.BaseName(file)}:{top.Value.Line})" : fn != "" ? fn : null;
            if (errorLog.TryGetValue(fingerprint, out var logged)) logged["count"] = count;
            else errorLog[fingerprint] = new Dictionary<string, object> { ["message"] = message, ["kind"] = kind, ["location"] = location, ["count"] = count };
            if (count > MaxErrorsPerFingerprint) return;
            var e = Ev("error");
            e["kind"] = kind;
            e["message"] = message;
            e["stack"] = StackParser.Format(kind, message, frames);
            e["source"] = file != null ? StackParser.BaseName(file) : null;
            e["line"] = file != null ? (object)top.Value.Line : null;
            e["col"] = null;
            e["fn"] = fn != "" ? fn : null;
            e["fingerprint"] = fingerprint;
            e["attrs"] = attrs != null && attrs.Count > 0 ? attrs : null;
            e["recent"] = recentNames;
            Push(e);
        }

        /// <summary>The errors seen this session, grouped, for agents and the overlay.</summary>
        public IEnumerable<Dictionary<string, object>> ErrorLog => errorLog.Values;

        // ───────────────────────────── input ─────────────────────────────

        /// <summary>A key, button or touch went down. `code` names it ("Space", "pointer", "pad0").</summary>
        public void OnInput(string code)
        {
            var now = Ticks;
            if (firstInputAt <= 0 && firstFrameMs > 0)
            {
                firstInputAt = now;
                var e = Ev("load");
                e["ttp_ms"] = (long)(StartupMs != null ? StartupMs() : now);
                Push(e);
            }
            if (!rageInputOn) return;
            if (!keyHistory.TryGetValue(code, out var hist)) keyHistory[code] = hist = new List<double>();
            hist.RemoveAll(t => now - t >= RageInputWindowMs);
            hist.Add(now);
            if (hist.Count == RageInputCount) Track("rage_input", new Dictionary<string, object> { ["key"] = code, ["count"] = hist.Count });
        }

        // ───────────────────────────── lifecycle ─────────────────────────────

        /// <summary>A phone app in the background is usually never seen again: iOS and Android stop it
        /// without warning. So going to the background ends the session, and the last batch goes out now.</summary>
        public void OnBackground()
        {
            pausedAt = Ticks;
            skipNext = true;
            pendingLong = null;
            if (Inited && Enabled && !ended)
            {
                EndLevel("background");
                ended = true;
                Push(SessionEnd("background"));
            }
            if (Inited && Enabled)
            {
                Flush();
                SendNow(SendDeadlineMs);
            }
        }

        public void OnForeground()
        {
            skipNext = true;
            if (!ended) return;
            ended = false;
            var away = (Ticks - pausedAt) / 1000;
            if (away > Options.SessionTimeoutSeconds)
            {
                leftLevel = null;
                NewSession();
            }
            else
            {
                // Back in the same session: the level goes on, and the server takes back the abandon sent on the way
                // out once anything else happens on it.
                levelOpen = leftLevel != null;
                leftLevel = null;
                Track("app_resume", new Dictionary<string, object> { ["away_s"] = Sketch.Round(away, 1) });
            }
        }

        // Back after a long time away: a new session with a new random ID. In anonymous mode nothing joins it to the last one.
        void NewSession()
        {
            Flush();
            SessionId = NewId("s_", 16);
            startedAt = UnixNow();
            sessionStartSent = false;
            recent.Clear();
            history.Clear();
            errorCounts.Clear();
        }

        public void Shutdown(string reason)
        {
            if (shut) return;
            shut = true;
            if (Inited && Enabled && !ended)
            {
                EndLevel(reason);
                ended = true;
                Push(SessionEnd(reason));
            }
            if (Inited && Enabled)
            {
                Flush();
                SendNow(SendDeadlineMs);
            }
        }

        Dictionary<string, object> SessionEnd(string reason)
        {
            var e = Ev("session_end");
            e["reason"] = reason;
            e["duration_s"] = Sketch.Round((UnixNow() - startedAt) / 1000.0, 1);
            return e;
        }

        // ───────────────────────────── events ─────────────────────────────

        static Dictionary<string, object> Ev(string type) => new Dictionary<string, object> { ["type"] = type };

        void Push(Dictionary<string, object> e)
        {
            if (Inited && !Enabled) return;
            if (!e.ContainsKey("ts")) e["ts"] = UnixNow();
            if (!e.ContainsKey("level")) e["level"] = Level;
            QueueEvent(e);
            if ((string)e["type"] == "session_end") return;
            history.Add(Slim(e));
            if (history.Count > BugRecent) history.RemoveAt(0);
        }

        void QueueEvent(Dictionary<string, object> e)
        {
            queue.Add(e);
            if (queue.Count > MaxQueue) queue.RemoveRange(0, queue.Count - MaxQueue);
        }

        /// <summary>Events waiting to be sent (for tests and the overlay).</summary>
        public IReadOnlyList<Dictionary<string, object>> Queued => queue;

        void Remember(string name)
        {
            recent.Add((name, Ticks));
            if (recent.Count > 20) recent.RemoveAt(0);
        }

        List<string> RecentWithin(double ms)
        {
            var cutoff = Ticks - ms;
            var out_ = new List<string>();
            foreach (var (name, t) in recent)
                if (t >= cutoff && !out_.Contains(name)) out_.Add(name);
            return out_;
        }

        List<string> RecentNames(int count)
        {
            var out_ = new List<string>();
            for (var i = Math.Max(0, recent.Count - count); i < recent.Count; i++) out_.Add(recent[i].name);
            return out_;
        }

        Dictionary<string, object> SessionStartEvent()
        {
            var device = Device(full);
            SteamInfo.AddTo(device, SteamFacts());
            return new Dictionary<string, object>
            {
                ["type"] = "session_start",
                ["ts"] = startedAt,
                ["level"] = null,
                ["session_type"] = sessionType,
                ["privacy"] = PrivacyName,
                ["device"] = device,
                ["page"] = null,
                ["nav_ms"] = null,
            };
        }

        /// <summary>The game's Steam facts (SteamInfo), read until Steamworks answers: a game may initialise Steam after
        /// Glitchless. A game that gives no version reports its Steam build ("steam-18231"), so versions compare build by
        /// build. The first batch is made after session_start, so every batch of a session has the same version.</summary>
        Dictionary<string, object> SteamFacts()
        {
            if (steamFacts == null)
            {
                try
                {
                    steamFacts = Steam?.Invoke();
                }
                catch (Exception)
                {
                    steamFacts = null;
                }
            }
            if (steamFacts != null && !versionGiven && steamFacts.TryGetValue("steam_build", out var build) && build is long b && b > 0) version = "steam-" + b;
            return steamFacts;
        }

        // ───────────────────────────── bug reports ─────────────────────────────

        /// <summary>What the player is doing right now, for a bug report (SPEC §2 bug_report): when, the level,
        /// where they stand (when positions are on), the last game events and hitches, and the last frame windows.</summary>
        public Dictionary<string, object> BugSnapshot()
        {
            var now = UnixNow();
            var snap = new Dictionary<string, object> { ["ts"] = now, ["level"] = Level };
            if (positionsOn && position != null)
            {
                snap["x"] = Sketch.Round(position[0], 2);
                snap["y"] = Sketch.Round(position[1], 2);
                snap["z"] = Sketch.Round(position[2], 2);
            }
            // The last game events and hitches, oldest first.
            var events = new List<Dictionary<string, object>>(history);
            foreach (var h in recentHitches)
                if (now - Convert.ToInt64(h["ts"], CultureInfo.InvariantCulture) < 60000) events.Add(h);
            foreach (var h in pendingHitches) events.Add(Slim(h));
            events.Sort((a, b) => Convert.ToInt64(a["ts"], CultureInfo.InvariantCulture).CompareTo(Convert.ToInt64(b["ts"], CultureInfo.InvariantCulture)));
            snap["recent"] = events.GetRange(Math.Max(0, events.Count - BugRecent), Math.Min(events.Count, BugRecent));
            // Frame rate and p95 of the last windows, and of the one still open.
            var frames = new List<Dictionary<string, object>>(recentWindows);
            if (win.Frames > 0)
            {
                var secs = Math.Max((Ticks - win.StartedTicks) / 1000, 0.001);
                frames.Add(new Dictionary<string, object> { ["ts"] = win.StartedAt, ["level"] = Level, ["fps"] = Sketch.Round(win.Frames / secs, 1), ["p95"] = Round(win.Sketch.Quantile(0.95), 2) });
            }
            snap["frames"] = frames.GetRange(Math.Max(0, frames.Count - BugFrames), Math.Min(frames.Count, BugFrames));
            return snap;
        }

        /// <summary>Sends a bug report on a request of its own, straight away and from every session (sampling
        /// doesn't apply). It waits in the outbox meanwhile, so if the send fails, or the game closes first, it
        /// goes with a later batch. `screenshot` is a JPEG data URL or null. done(sent, reason): reason is
        /// "offline" when this build sends nothing, "error" when it will go later.</summary>
        public void SendBugReport(Dictionary<string, object> snapshot, string note, string screenshot, Action<bool, string> done)
        {
            note = note ?? "";
            var e = new Dictionary<string, object>(snapshot) { ["type"] = "bug_report", ["note"] = note.Length > MaxNote ? note.Substring(0, MaxNote) : note };
            if (screenshot != null) e["screenshot"] = screenshot;
            e["device"] = Device(full);
            Remember("bug_report");
            if (!Inited || !Enabled || Transport == null)
            {
                done?.Invoke(false, "offline");
                return;
            }
            Flush(); // the session's own events first, so the report's session is there when someone opens it
            var b = NewBatch(new List<string> { Json.Serialize(e) });
            b.Direct = true;
            outbox.Add(b);
            SaveOutbox();
            Debug("sending a bug report");
            Transport.Send(IntakeUrl, Encode(Body(b)), "text/plain", status =>
            {
                b.Direct = false;
                var sent = status >= 200 && status < 300;
                if (sent || (status >= 400 && status < 500 && status != 408 && status != 429)) // a rejected report would only be rejected again
                {
                    outbox.Remove(b);
                    SaveOutbox();
                }
                if (sent)
                {
                    Stats.Sent++;
                    done?.Invoke(true, null);
                    return;
                }
                Stats.Failed++;
                Debug($"bug report not sent ({(status == 0 ? "network error" : $"HTTP {status}")}): it goes with the next batch");
                done?.Invoke(false, "error");
            });
        }

        static readonly string[] SlimKeys = { "name", "cause", "kind", "reason", "duration_s", "score", "duration_ms", "causes", "x", "y", "z" };

        /// <summary>A game event as a bug report lists it: when, what, and the few fields that say what happened.</summary>
        internal static Dictionary<string, object> Slim(Dictionary<string, object> e)
        {
            var o = new Dictionary<string, object> { ["ts"] = e["ts"], ["type"] = e["type"], ["level"] = e.TryGetValue("level", out var l) ? l : null };
            foreach (var k in SlimKeys)
                if (e.TryGetValue(k, out var v) && v != null) o[k] = v;
            if (e.TryGetValue("message", out var m) && m is string msg) o["message"] = msg.Length > 200 ? msg.Substring(0, 200) : msg;
            if (e.TryGetValue("attrs", out var a) && a is System.Collections.ICollection attrs && attrs.Count > 0 && Json.Serialize(a).Length <= 300) o["attrs"] = a;
            return o;
        }

        // ───────────────────────────── sending ─────────────────────────────

        /// <summary>Closes the frame window (unless told not to) and sends what is waiting. Runs by itself
        /// every FlushIntervalSeconds, and when the game goes to the background or closes.</summary>
        public void Flush(bool closeWindow = true)
        {
            nextFlushAt = Ticks + Options.FlushIntervalSeconds * 1000;
            if (closeWindow) CloseWindow(true);
            if (!Inited) return; // kept until Init() says where it goes
            if (!Enabled)
            {
                queue.Clear();
                return;
            }
            if (!sessionStartSent)
            {
                queue.Insert(0, SessionStartEvent());
                sessionStartSent = true;
                if (firstFrameMs > 0 && !loadSent)
                {
                    loadSent = true;
                    queue.Add(new Dictionary<string, object> { ["type"] = "load", ["ts"] = firstFrameAt, ["level"] = firstFrameLevel, ["ttff_ms"] = (long)firstFrameMs, ["assets"] = null, ["first_launch"] = firstLaunch });
                }
            }
            if (!Sampled)
            {
                queue.Clear();
                Stats.LastStatus = "unsampled";
                return;
            }
            if (queue.Count > 0)
            {
                AddBatches(queue);
                queue = new List<Dictionary<string, object>>();
                SaveOutbox();
            }
            if (!shut) SendNext(); // while closing, SendNow() sends instead
        }

        void AddBatches(List<Dictionary<string, object>> events)
        {
            var chunk = new List<string>();
            var size = 0;
            foreach (var e in events)
            {
                var json = Json.Serialize(e);
                if (chunk.Count > 0 && size + json.Length > BatchBytes * 0.9)
                {
                    outbox.Add(NewBatch(chunk));
                    chunk = new List<string>();
                    size = 0;
                }
                chunk.Add(json);
                size += json.Length;
            }
            if (chunk.Count > 0) outbox.Add(NewBatch(chunk));
            var total = 0;
            foreach (var b in outbox) total += b.Events.Count;
            while (total > MaxOutboxEvents && outbox.Count > 1 && outbox[0].Id != inFlight)
            {
                total -= outbox[0].Events.Count;
                outbox.RemoveAt(0);
            }
        }

        Batch NewBatch(List<string> events) => new Batch { Id = nextBatchId++, Bid = NewId("b_", 16), Service = service, Env = env, Version = version, Sid = SessionId, Pid = PlayerId, Group = startedAt, Events = events };

        string Body(Batch b)
        {
            var sb = new StringBuilder(1024);
            sb.Append("{\"service\":");
            Json.Write(sb, b.Service);
            sb.Append(",\"env\":");
            Json.Write(sb, b.Env);
            sb.Append(",\"version\":");
            Json.Write(sb, b.Version);
            sb.Append(",\"session_id\":");
            Json.Write(sb, b.Sid);
            sb.Append(",\"player_id\":");
            Json.Write(sb, string.IsNullOrEmpty(b.Pid) ? null : b.Pid); // the server uses the session ID in its place
            sb.Append(",\"sdk\":\"").Append(Sdk).Append("\",\"batch_id\":");
            Json.Write(sb, b.Bid);
            sb.Append(",\"events\":[");
            for (var i = 0; i < b.Events.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(b.Events[i]);
            }
            sb.Append("]}");
            return sb.ToString();
        }

        // Batches are gzipped (about 5x smaller). Content-Type stays text/plain, which needs no CORS
        // preflight in a WebGL build; the server spots gzip by its magic bytes.
        byte[] Encode(string body)
        {
            var bytes = Encoding.UTF8.GetBytes(body);
            if (IsWeb || bytes.Length < 1024) return bytes;
            try
            {
                using (var ms = new MemoryStream())
                {
                    using (var gz = new GZipStream(ms, CompressionLevel.Fastest, true)) gz.Write(bytes, 0, bytes.Length);
                    return ms.ToArray();
                }
            }
            catch (Exception)
            {
                return bytes;
            }
        }

        string IntakeUrl => $"{intake}/v1/intake?token={Uri.EscapeDataString(Options.ClientToken ?? "")}";

        void SendNext()
        {
            if (inFlight >= 0 || outbox.Count == 0 || Ticks < retryAt || Transport == null) return;
            var b = outbox.Find(x => !x.Direct);
            if (b == null) return;
            var body = Encode(Body(b));
            Debug($"sending {b.Events.Count} events ({body.Length} bytes)");
            inFlight = b.Id;
            var id = b.Id;
            var send = ++sends;
            Transport.Send(IntakeUrl, body, "text/plain", status => OnSent(id, send, status));
        }

        void OnSent(int id, int send, long status)
        {
            // Given up on: SendNow sent it instead. The send number tells an aborted try apart from a later try of the
            // same batch that is still going.
            if (id != inFlight || send != sends) return;
            inFlight = -1;
            var i = outbox.FindIndex(x => x.Id == id);
            var n = i >= 0 ? outbox[i].Events.Count : 0;
            if (status >= 200 && status < 300)
            {
                Stats.Sent += n;
                Stats.LastStatus = "ok";
                backoffS = 0;
            }
            else if (status >= 400 && status < 500 && status != 408 && status != 429)
            {
                Stats.Failed += n; // the server turned it away; sending it again would only fail again
                Stats.LastStatus = $"rejected {status}";
            }
            else
            {
                Stats.Failed += n;
                RetryLater(status == 0 ? "network error" : $"HTTP {status}");
                return;
            }
            if (i >= 0) outbox.RemoveAt(i);
            SaveOutbox();
            SendNext();
        }

        void RetryLater(string why)
        {
            Stats.LastStatus = "error";
            backoffS = Math.Min(Math.Max(backoffS * 2, 5), 300);
            retryAt = Ticks + backoffS * 1000;
            Debug($"send failed: {why}; trying again in {backoffS:0}s");
        }

        /// <summary>Sends what is waiting before the game closes or goes to the background, blocking for
        /// at most budgetMs. Whatever isn't sent stays saved for the next launch.</summary>
        public void SendNow(int budgetMs)
        {
            if (outbox.Count == 0 || !Sampled || IsWeb || Transport == null) return;
            if (inFlight >= 0)
            {
                // It needs frames to finish; send it here instead. The server may have it already: its batch_id lets
                // the server store it once.
                Transport.Abort();
                inFlight = -1;
            }
            var deadline = Ticks + budgetMs;
            foreach (var b in outbox.ToArray())
            {
                var left = (int)(deadline - Ticks);
                if (left <= 0) break;
                var status = Transport.SendNow(IntakeUrl, Encode(Body(b)), "text/plain", left);
                if (status >= 200 && status < 300) Stats.Sent += b.Events.Count;
                else if (status == 0 || status >= 500 || status == 408 || status == 429) break;
                outbox.Remove(b);
                SaveOutbox(); // at once: the OS may stop the game before the next one
            }
            SaveOutbox();
        }

        public int OutboxEvents
        {
            get
            {
                var n = 0;
                foreach (var b in outbox) n += b.Events.Count;
                return n;
            }
        }

        // ───────────────────────────── saved batches ─────────────────────────────

        string OutboxPath => Path.Combine(SaveDir, "outbox.json");
        const string PlayerIdName = "player_id"; // install and full mode
        const string LaunchedName = "launched"; // the game version that last ran here, in every mode
        string PrivacyName => full ? "full" : storesId ? "install" : "anonymous";

        /// <summary>Forgets the player ID saved on the device. This session keeps the ID it started with.</summary>
        public void ResetInstallId() => TryIo(() => DeleteId(PlayerIdName));

        string ReadId(string name)
        {
            if (Ids != null) return Ids.Read(name);
            var path = SaveDir == null ? null : Path.Combine(SaveDir, name);
            return path != null && File.Exists(path) ? File.ReadAllText(path) : null;
        }

        void WriteId(string name, string id)
        {
            if (Ids != null) Ids.Write(name, id);
            else if (SaveDir != null) File.WriteAllText(Path.Combine(SaveDir, name), id);
        }

        void DeleteId(string name)
        {
            if (Ids != null) Ids.Delete(name);
            else if (SaveDir != null) File.Delete(Path.Combine(SaveDir, name));
        }

        // Batches that couldn't be sent are saved, so a game played offline is sent when the network is
        // back. In anonymous mode they are saved without the session ID; on the next launch each earlier
        // session's batches go under a new random ID, so nothing written to the device ties two sessions.
        // Install and full mode keep a stored ID anyway, so they save both IDs. Every mode saves each batch's
        // own ID, so a batch the server took just before the game closed is not stored twice when the next
        // launch sends it.
        void SaveOutbox()
        {
            if (!Enabled || SaveDir == null || IsWeb) return;
            TryIo(() =>
            {
                if (outbox.Count == 0)
                {
                    if (File.Exists(OutboxPath)) File.Delete(OutboxPath);
                    return;
                }
                var batches = new List<object>();
                foreach (var b in outbox)
                {
                    var events = new List<object>();
                    foreach (var e in b.Events) events.Add(new Json.Raw(e));
                    var saved = new Dictionary<string, object> { ["bid"] = b.Bid, ["service"] = b.Service, ["env"] = b.Env, ["version"] = b.Version, ["group"] = b.Group, ["events"] = events };
                    if (storesId)
                    {
                        saved["sid"] = b.Sid;
                        saved["pid"] = b.Pid;
                    }
                    batches.Add(saved);
                }
                var tmp = OutboxPath + ".tmp";
                File.WriteAllText(tmp, Json.Serialize(new Dictionary<string, object> { ["v"] = 1, ["batches"] = batches }));
                if (File.Exists(OutboxPath)) File.Delete(OutboxPath);
                File.Move(tmp, OutboxPath);
            });
        }

        void LoadOutbox()
        {
            if (IsWeb || !File.Exists(OutboxPath)) return;
            TryIo(() =>
            {
                if (!(Json.Parse(File.ReadAllText(OutboxPath)) is Dictionary<string, object> data) || !(data.TryGetValue("batches", out var list) && list is List<object> batches)) return;
                var oldest = UnixNow() - MaxOutboxAgeMs;
                var freshIds = new Dictionary<string, string>();
                foreach (var item in batches)
                {
                    if (!(item is Dictionary<string, object> saved) || !(saved.TryGetValue("events", out var ev) && ev is List<object> evs)) continue;
                    var events = new List<string>();
                    foreach (var o in evs)
                        if (o is Dictionary<string, object> e && e.TryGetValue("ts", out var ts) && ts is double t && t >= oldest) events.Add(Json.Serialize(e));
                    if (events.Count == 0) continue;
                    var group = Str(saved, "group", "");
                    var sid = Str(saved, "sid", "");
                    if (sid == "")
                    {
                        if (!freshIds.TryGetValue(group, out sid)) freshIds[group] = sid = NewId("s_", 16);
                    }
                    long.TryParse(group, NumberStyles.Integer, CultureInfo.InvariantCulture, out var groupId);
                    var bid = Str(saved, "bid", ""); // an outbox an older version saved has none: a new one
                    outbox.Add(new Batch { Id = nextBatchId++, Bid = bid.StartsWith("b_", StringComparison.Ordinal) ? bid : NewId("b_", 16), Service = Str(saved, "service", service), Env = Str(saved, "env", env), Version = Str(saved, "version", version), Sid = sid, Pid = storesId ? Str(saved, "pid", "") : "", Group = groupId, Events = events });
                }
                Debug($"{outbox.Count} saved batches from earlier launches");
            });
        }

        static string Str(Dictionary<string, object> d, string key, string fallback)
        {
            if (!d.TryGetValue(key, out var v) || v == null) return fallback;
            return v is double n ? n.ToString("R", CultureInfo.InvariantCulture) : v.ToString();
        }

        // Whether this is the first launch of this game version on this device. The first after an install or an update
        // starts cold (empty shader and file caches), which shows in the time to the first frame. The file holds only the
        // version, the same on every player's device, so it ties no two sessions together. Null with nowhere to keep it.
        bool? NoteLaunch()
        {
            if (Ids == null && SaveDir == null) return null;
            bool? first = null;
            TryIo(() =>
            {
                first = ReadId(LaunchedName)?.Trim() != version;
                if (first == true) WriteId(LaunchedName, version);
            });
            return first;
        }

        // The random ID install and full mode send as player_id, made on first launch and kept by name. With nowhere to
        // keep it, it lasts this launch.
        string LoadId(string name, string prefix)
        {
            string id = null;
            TryIo(() =>
            {
                var saved = ReadId(name)?.Trim();
                if (saved != null && saved.StartsWith(prefix, StringComparison.Ordinal)) id = saved;
            });
            if (id != null) return id;
            id = NewId(prefix, 12);
            var made = id;
            TryIo(() => WriteId(name, made));
            return id;
        }

        void TryIo(Action io)
        {
            try
            {
                io();
            }
            catch (Exception e)
            {
                Debug($"file error: {e.Message}");
            }
        }

        // ───────────────────────────── helpers ─────────────────────────────

        void Debug(string msg)
        {
            if (debug) Log("[glitchless] " + msg);
        }

        public bool HasFlag(string flag)
        {
            foreach (var a in Args() ?? Array.Empty<string>())
                if (a == flag || a.StartsWith(flag + "=", StringComparison.Ordinal)) return true;
            return false;
        }

        public string FlagValue(string flag)
        {
            foreach (var a in Args() ?? Array.Empty<string>())
                if (a.StartsWith(flag + "=", StringComparison.Ordinal)) return a.Substring(flag.Length + 1);
            return null;
        }

        static string NewId(string prefix, int length)
        {
            var bytes = new byte[length];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            var sb = new StringBuilder(prefix, prefix.Length + length);
            foreach (var b in bytes) sb.Append(IdChars[b % IdChars.Length]);
            return sb.ToString();
        }

        static double Median(List<double> values) => Quantile(values, 0.5);

        static double Quantile(List<double> values, double q)
        {
            if (values.Count == 0) return 0;
            var sorted = new List<double>(values);
            sorted.Sort();
            return sorted[Math.Min(sorted.Count - 1, (int)(sorted.Count * q))];
        }

        static object Round(double? v, int digits) => v.HasValue ? (object)Sketch.Round(v.Value, digits) : null;
    }
}

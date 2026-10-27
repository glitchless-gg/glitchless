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
        public double Busy; // the frame's work, from its first player loop phase to the end of PostLateUpdate: a server's tick time
        public int FixedSteps; // FixedUpdate steps in the frame: a server's ticks when it has no netcode

        public static FrameCost Unknown => new FrameCost { Process = -1, Physics = -1, Render = -1, Gpu = -1, Calls = -1, Triangles = -1, SetPass = -1, Batches = -1, ShaderCompiles = -1, ObjectsAdded = -1, GcAllocKb = -1, Busy = -1, FixedSteps = -1 };
    }

    /// <summary>Sends batches. GlitchlessRunner uses UnityWebRequest; tests use a stand-in.</summary>
    public interface ITransport
    {
        /// <summary>Starts a POST; done(status) comes later on the main thread, with 0 for a network failure.</summary>
        void Send(string url, byte[] body, string contentType, Action<long> done);
        /// <summary>Starts a GET (the server's /v1/health, for what it takes); done(status, body) comes later on the main thread.</summary>
        void Get(string url, Action<long, string> done);
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
        public const string SdkVersion = "0.6.0";
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
        const int MaxCounters = 64; // counter entries a window (SPEC §2 counts)
        const int MaxCountGroup = 4; // string or boolean attributes that make a counter's group
        const int MaxCountSums = 4; // numbers a counter adds up
        const long MaxCountPerCall = 1_000_000;
        const int MaxHeldCounts = 240; // counts events kept while the server hasn't said whether it takes them: 20 minutes
        const int TrackRateWarning = 20; // track() calls of one name in a second that earn the hint to count() instead
        const int MaxDisconnects = 20; // disconnect events a session
        const int MaxClientRtts = 1000; // players' round trips a server window keeps for its p95
        const long MaxServerSessionMs = 6L * 3600 * 1000; // a server session is cut every 6 hours
        static readonly string[] DisconnectReasons = { "timeout", "connection_lost", "kicked", "server_closed", "failed_to_connect", "other" };

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
        public Func<string> Distribution = () => ""; // where an iOS build was installed from (DeviceInfo.Distribution)
        public Action<string> Log = s => UnityEngine.Debug.Log(s);
        public string AppVersion = "";
        public bool IsBatchMode, IsDebugBuild, IsMobile, IsWeb;
        public bool IsServerBuild; // a Dedicated Server build (UNITY_SERVER)
        public Scrubber Scrubber = new Scrubber();
        public readonly List<INetSource> NetSources = new List<INetSource>(); // the game's netcode (Netcode.Find), read once a second
        public Func<string> Link = () => null; // wifi, cellular or null (Application.internetReachability)
        public Func<double> CpuMs = () => -1; // the process's CPU time so far, for a server's cpu_pct
        public Func<double> FixedHz = () => 50; // FixedUpdate steps a second: a server's tick rate when it has no netcode
        public Func<Dictionary<string, object>> ServerHost = () => null; // a server's OS, cores and memory (DeviceInfo.ServerHost)

        // ───────────────────────────── state ─────────────────────────────

        public GlitchlessOptions Options = new GlitchlessOptions();
        public bool Inited { get; private set; }
        /// <summary>Glitchless is on now: this build sends (Init found an intake, and neither Options.Enabled nor
        /// --glitchless-off turned it off) and the player hasn't turned it off (SetEnabled, SPEC §4d).</summary>
        public bool Enabled => buildOn && !SwitchedOff;
        /// <summary>The player has Glitchless off: SetEnabled(false), the choice an earlier launch saved, or OptIn before
        /// they said yes. Nothing is measured, kept or sent meanwhile.</summary>
        public bool SwitchedOff { get; private set; }
        public bool Sampled { get; private set; } = true;
        public string SessionId { get; private set; }
        public string PlayerId { get; private set; } = "";
        public string Level { get; private set; }
        public string Zone { get; private set; }
        /// <summary>This run is a game server (GlitchlessOptions.Role): it reports as the game's companion service.</summary>
        public bool IsServer { get; private set; }
        public string Service => service;
        public string Env => env;
        public string AppVersionInUse => version;
        public int FrameCount { get; private set; }
        public double BudgetMs { get; private set; } = 1000.0 / 60;
        public readonly GlitchlessStats Stats = new GlitchlessStats();
        public readonly Dictionary<string, double> Ctx = new Dictionary<string, double>();

        string service = "unknown-game", version = "0.0.0", env = "dev", intake = "", sessionType = "user";
        bool sandbox; // a TestFlight or development install on iOS: its purchases are Apple's free sandbox ones
        Dictionary<string, object> steamFacts; // read once Steamworks answers
        bool full, storesId, versionGiven, positionsOn, rageInputOn, debug, manualLevels, sceneLevels = true;
        bool buildOn; // Init's decision: this build sends (an intake, and not turned off by the options or a flag)
        bool sendingStarted; // the player ID, the outbox and /v1/health have been seen to, once a launch
        string choice; // the player's choice as saved on the device, "on" or "off"; null until the game calls SetEnabled
        bool choiceRead;
        long startedAt;
        double levelStartedAt;
        bool levelOpen; // a level started and not yet completed, failed or abandoned
        string leftLevel; // the level abandoned for the game as the session ended
        string offLevel; // the level whose attempt was going at off, or started while off: its outcome is dropped (SPEC §4d)
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
        readonly HashSet<string> warned = new HashSet<string>();

        // Counters (Count): one entry per name and group in the window, sent as one counts event when it closes. They wait
        // in heldCounts until the server says it takes them (GET /v1/health), so an older server is never sent half the data.
        readonly Dictionary<string, Counter> counters = new Dictionary<string, Counter>();
        readonly List<Counter> counterList = new List<Counter>();
        long countsDropped;
        readonly List<Dictionary<string, object>> heldCounts = new List<Dictionary<string, object>>();
        bool countsOff;
        readonly Dictionary<string, (double at, int n)> trackRate = new Dictionary<string, (double, int)>();
        HashSet<string> features; // what the server takes, from /v1/health; null until it answers
        bool featuresAsked, serverRefused;
        double featuresRetryAt;

        // Properties: what holds for the session. session_start carries those set before the first batch; later changes
        // go out as one props event a window, with only the keys that changed.
        readonly Dictionary<string, object> props = new Dictionary<string, object>();
        readonly Dictionary<string, object> sentProps = new Dictionary<string, object>();
        readonly HashSet<string> propKeys = new HashSet<string>(); // keys sent this session, at most 12
        Dictionary<string, object> pendingProps;
        long pendingPropsAt;

        // Groups: the match, party and run every event is marked with while they're set.
        readonly Dictionary<string, string> groups = new Dictionary<string, string>();
        readonly Dictionary<string, string> groupsBeforeInit = new Dictionary<string, string>(); // raw match and party IDs set before Init, to hash with the service
        readonly Dictionary<string, Dictionary<string, object>> groupAttrs = new Dictionary<string, Dictionary<string, object>>();
        readonly Dictionary<string, string> resumedRuns = new Dictionary<string, string>(); // a saved run ID -> this launch's (anonymous mode)

        // The network: samples once a second from the game's netcode, or from NetSample.
        double nextNetAt, connectedAt, disconnectedAt, manualNetAt, lastRtt = -1;
        bool netConnected;
        string netTransport, droppedLevel;
        int disconnects;
        NetWindow lastNet;

        // Server mode: the netcode whose ticks count, and what it says.
        INetSource serverSource;
        double serverTickHz;
        int setPlayers = -1, serverMaxPlayers;

        // Bid is the batch's own random ID (SPEC §2 batch_id). It goes with every try of the batch and is saved with it,
        // so the server stores a batch once however many times it is sent: after a timeout, a send cut short by going to
        // the background or quitting, or a launch that sends what the last one saved. It names the batch, not the player
        // or the session, so anonymous mode saves it too.
        sealed class Batch
        {
            public int Id;
            public string Bid, Service, Env, Version, Sid, Pid;
            public string Role; // "server" in server mode: sent only to a server that has it
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
            public NetWindow Net; // while connected
            // Server mode.
            public readonly Sketch Tick = new Sketch();
            public int Ticks, Late, Players = -1, PlayersMax = -1, NetObjects = -1;
            public double TickMax, CpuAt = -1;
            public string TickSource;
            public readonly List<double> ClientRtts = new List<double>();
        }

        sealed class NetWindow
        {
            public readonly Sketch Rtt = new Sketch(0.05); // the 5% sketch SPEC §2 net.rtt names
            public double JitterSum, LossSum;
            public int JitterN, LossN, Samples;
            public string Transport;
            public bool Host;
            public bool? Relay;
        }

        sealed class Counter
        {
            public string Name;
            public Dictionary<string, object> Attrs;
            public Dictionary<string, double> Sums;
            public long N, FirstTs;
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
        /// times, errors and events are kept, so a game may call it late (unless the player has Glitchless off).</summary>
        public void Init(GlitchlessOptions options)
        {
            if (Inited) return;
            Inited = true;
            LoadChoice();
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
            sandbox = DeviceInfo.IsSandbox(Distribution?.Invoke() ?? "");
            sessionType = SessionTypeFor(Options.SessionType, IsBatchMode || HasFlag("--autoplay") || HasFlag("--glitchless-synthetic") || HasFlag("--glitchless-measure"), TestLabSetting, sandbox);
            IsServer = Options.Role == GlitchlessRole.Server || (Options.Role == GlitchlessRole.Auto && (IsServerBuild || HasFlag("--glitchless-server")));
            if (IsServer) StartServerMode();
            buildOn = (Options.Enabled ?? !HasFlag("--glitchless-off")) && intake != "";
            // A game that asks first: with no choice saved, nothing is kept until the player says yes. What the automatic
            // start kept before Init knew is dropped now. A server has no player to ask, so OptIn leaves it on.
            if (choice == null && Options.OptIn && !IsServer) SwitchOff();
            Sampled = random.NextDouble() < Options.SampleRate;
            // The first batch goes soon, so a session that crashes early is still seen.
            nextFlushAt = Ticks + Math.Min(2000, Options.FlushIntervalSeconds * 1000);
            if (Options.Properties != null) SetProperties(Options.Properties);
            HashGroupsSetBeforeInit();
            if (!buildOn)
            {
                queue.Clear();
                Debug("off (no intake, or turned off)");
                return;
            }
            if (SwitchedOff)
            {
                Debug(choice == "off" ? "off: the player turned it off (Glitchless.SetEnabled), so nothing is measured or sent" : "off until the player says yes (OptIn): Glitchless.SetEnabled(true) turns it on");
                return;
            }
            StartSending();
        }

        // Once a launch, when this build first sends: at Init, or when the player turns Glitchless on after an Init that
        // found it off. Until then no player ID is read or made, and no outbox is read.
        void StartSending()
        {
            if (sendingStarted)
            {
                CheckFeatures();
                return;
            }
            sendingStarted = true;
            if (SaveDir != null) TryIo(() => Directory.CreateDirectory(SaveDir));
            firstLaunch = NoteLaunch();
            // Install and full mode share one saved ID (SPEC §4b); anonymous mode deletes one another build left. A server
            // has no player, and leaves the file alone.
            if (IsServer) PlayerId = "";
            else if (storesId) PlayerId = LoadId(PlayerIdName, "p_");
            else TryIo(() => DeleteId(PlayerIdName));
            if (SaveDir != null) LoadOutbox();
            Debug($"on: {service} {version} {env} -> {intake} ({(IsServer ? "server" : PrivacyName)}, {sessionType}{(string.IsNullOrEmpty(Distribution?.Invoke()) ? "" : ", " + Distribution())})");
            CheckFeatures();
        }

        // A server measures ticks, not frames: what was kept as frame windows before Init is dropped, and no player's
        // fields (an ID, positions, rage input) are ever sent. Batch mode is how servers run, so it doesn't make a bot.
        void StartServerMode()
        {
            full = storesId = positionsOn = rageInputOn = false;
            sessionType = SessionTypeFor(Options.SessionType, HasFlag("--autoplay") || HasFlag("--glitchless-synthetic") || HasFlag("--glitchless-measure"), null);
            queue.RemoveAll(e => e["type"] is string t && (t == "frame_window" || t == "hitch" || t == "pos" || t == "load"));
            pendingHitches.Clear();
            posBuffer.Clear();
            loadSent = true;
            win = NewWindow();
        }

        /// <summary>The session's type: what the game set; else synthetic for a bot (batch mode, --autoplay and the flags)
        /// or one of Google Play's pre-launch test phones (DeviceInfo.IsStoreTestDevice: the firebase.test.lab setting, or a
        /// GPU that draws in software); else tester for a TestFlight or development install on iOS (`sandbox`); else user.
        /// The setting is read only when nothing else decides.</summary>
        internal static string SessionTypeFor(string set, bool bot, Func<string> testLabSetting, bool sandbox = false)
        {
            if (!string.IsNullOrEmpty(set)) return set;
            if (bot) return "synthetic";
            if (testLabSetting?.Invoke() == "true") return "synthetic";
            return sandbox ? "tester" : "user";
        }

        /// <summary>A purchase (an event named purchase, or any with a currency) made in a sandbox install says so with
        /// sandbox: true, as Apple charged nothing for it: its amounts are left out of revenue (SPEC §3b). A sandbox the
        /// game set itself stays as it is, and the game's dictionary is never changed.</summary>
        internal static Dictionary<string, object> SandboxAttrs(string name, Dictionary<string, object> attrs, bool sandbox)
        {
            if (!sandbox || attrs.ContainsKey("sandbox") || (name != "purchase" && !attrs.ContainsKey("currency"))) return attrs;
            return new Dictionary<string, object>(attrs) { ["sandbox"] = true };
        }

        /// <param name="attrs">What this attempt is (difficulty, mode, party size, a build as a list), with the rules of
        /// Track's attributes. Its outcome and deaths don't repeat them: the server pairs each with the attempt it ends.</param>
        public void LevelStart(string levelId, Dictionary<string, object> attrs = null) => StartLevel(levelId, fromScene: false, attrs);

        void StartLevel(string levelId, bool fromScene, Dictionary<string, object> attrs = null)
        {
            if (!fromScene) manualLevels = true; // the game knows its levels better than the scene names do
            CloseWindow(false); // so a frame window never spans two levels
            Level = levelId;
            levelStartedAt = Ticks;
            leftLevel = null;
            droppedLevel = null;
            if (SwitchedOff)
            {
                // The level is the current one when Glitchless comes back on, but this attempt's start was never sent.
                levelOpen = false;
                offLevel = levelId;
                return;
            }
            levelOpen = true;
            offLevel = null;
            var e = Ev("level_start");
            if (attrs != null && attrs.Count > 0) e["attrs"] = new Dictionary<string, object>(attrs);
            Push(e);
            Remember("level_start");
        }

        public void LevelComplete(string levelId = null, double? score = null, double? durationS = null)
        {
            var level = levelId ?? Level;
            if (OffAttempt(level)) return;
            levelOpen = false;
            var e = Ev("level_complete");
            e["level"] = level;
            e["duration_s"] = Sketch.Round(durationS ?? (Ticks - levelStartedAt) / 1000, 2);
            e["score"] = score;
            Push(e);
            Remember("level_complete");
        }

        /// <summary>The player lost the level (died, ran out of lives or time). Leaving it is LevelAbandon.</summary>
        public void LevelFail(string levelId = null, string cause = null)
        {
            var level = levelId ?? Level;
            if (OutcomeSent(level) || OffAttempt(level)) return;
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
            if (OutcomeSent(level) || OffAttempt(level)) return;
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

        // Nothing goes while the player has Glitchless off, and after they turn it back on the attempt that was going (or
        // began while off) has no start in the new session: until the next level start, its outcome isn't sent either.
        bool OffAttempt(string level) => SwitchedOff || (offLevel != null && level == offLevel);

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
            if (SwitchedOff) return;
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
            if (SwitchedOff) return;
            var e = Ev("custom");
            e["name"] = name;
            e["attrs"] = SandboxAttrs(name, attrs ?? new Dictionary<string, object>(), sandbox);
            Push(e);
            Remember(name);
            if (IsDebugBuild || debug) CheckTrackRate(name);
        }

        // A stream of track() calls fills the 2,000-event queue within a minute, and the oldest events then go, frame
        // windows too: a debug build says once which name should be counted instead.
        void CheckTrackRate(string name)
        {
            if (name == null || warned.Contains("track:" + name)) return;
            var now = Ticks;
            trackRate.TryGetValue(name, out var r);
            r = now - r.at >= 1000 ? (now, 1) : (r.at, r.n + 1);
            trackRate[name] = r;
            if (r.n > TrackRateWarning) Warn("track:" + name, $"\"{name}\" is tracked more than {TrackRateWarning} times a second. Glitchless.Count(\"{name}\", …) adds a stream up on the device and sends it once a window, instead of an event each time");
        }

        // ───────────────────────────── counters ─────────────────────────────

        /// <summary>Counts a stream of events (shots, kills, gold picked up) on the device, sent once a window as a counts
        /// event (SPEC §2). The call's string and boolean attributes, at most 4, make its group; its numbers, at most 4, are
        /// added up as given; `n` is how many events the call stands for.</summary>
        public void Count(string name, Dictionary<string, object> attrs = null, long n = 1)
        {
            if (string.IsNullOrEmpty(name) || n <= 0 || Dropping) return;
            if (countsOff)
            {
                Warn("counts", "this Glitchless server doesn't take counters yet, so Glitchless.Count sends nothing to it: update the server");
                return;
            }
            n = Math.Min(n, MaxCountPerCall);
            Dictionary<string, object> group = null;
            Dictionary<string, double> sums = null;
            var key = name;
            if (attrs != null && attrs.Count > 0)
            {
                var keys = new List<string>(attrs.Keys);
                keys.Sort(StringComparer.Ordinal); // the first 4, in the same order every call, so a group is always one entry
                var sb = new StringBuilder(name);
                foreach (var k in keys)
                {
                    var v = attrs[k];
                    if (v is string || v is bool || v is Enum)
                    {
                        group = group ?? new Dictionary<string, object>();
                        if (group.Count >= MaxCountGroup) continue;
                        var word = v is bool b ? (object)b : Clip(v.ToString(), 64);
                        group[k] = word;
                        sb.Append('\n').Append(k).Append('=').Append(word is bool w ? (w ? "true" : "false") : (string)word);
                    }
                    else if (v is IConvertible c && GameWords.IsNumber(c))
                    {
                        sums = sums ?? new Dictionary<string, double>();
                        if (sums.Count < MaxCountSums) sums[k] = c.ToDouble(CultureInfo.InvariantCulture);
                    }
                }
                key = sb.ToString();
            }
            if (!counters.TryGetValue(key, out var entry))
            {
                if (counterList.Count >= MaxCounters)
                {
                    // Full: a new group of a name already counted goes under that name with its attributes as (other); a
                    // new name is dropped, and the window says how many events were.
                    if (!counterList.Exists(x => x.Name == name))
                    {
                        countsDropped += n;
                        return;
                    }
                    key = name + "\n(other)";
                    if (group != null)
                        foreach (var k in new List<string>(group.Keys)) group[k] = "(other)";
                }
                if (!counters.TryGetValue(key, out entry))
                {
                    entry = new Counter { Name = name, Attrs = group ?? new Dictionary<string, object>(), FirstTs = UnixNow() };
                    counters[key] = entry;
                    counterList.Add(entry);
                }
            }
            entry.N += n;
            if (sums == null) return;
            entry.Sums = entry.Sums ?? new Dictionary<string, double>();
            foreach (var kv in sums)
            {
                if (!entry.Sums.ContainsKey(kv.Key) && entry.Sums.Count >= MaxCountSums) continue;
                entry.Sums.TryGetValue(kv.Key, out var total);
                entry.Sums[kv.Key] = total + kv.Value;
            }
        }

        // The window's counters, as one counts event.
        void FlushCounts(Window w, double secs)
        {
            if (counterList.Count == 0 && countsDropped == 0) return;
            var list = new List<object>(counterList.Count);
            foreach (var c in counterList)
            {
                var o = new Dictionary<string, object> { ["name"] = c.Name, ["attrs"] = c.Attrs, ["n"] = c.N };
                if (c.Sums != null)
                {
                    var sums = new Dictionary<string, object>();
                    foreach (var kv in c.Sums) sums[kv.Key] = Sketch.Round(kv.Value, 4);
                    o["sums"] = sums;
                }
                o["first_ts"] = c.FirstTs;
                list.Add(o);
            }
            var e = new Dictionary<string, object> { ["type"] = "counts", ["ts"] = w.StartedAt, ["level"] = Level, ["duration_s"] = Sketch.Round(secs, 2), ["dropped"] = countsDropped, ["counts"] = list };
            Stamp(e);
            counters.Clear();
            counterList.Clear();
            countsDropped = 0;
            if (features == null)
            {
                heldCounts.Add(e);
                if (heldCounts.Count > MaxHeldCounts) heldCounts.RemoveAt(0);
            }
            else if (features.Contains("counts")) QueueEvent(e);
        }

        static string Clip(string s, int max) => s.Length > max ? s.Substring(0, max) : s;

        // ───────────────────────────── what the server takes ─────────────────────────────

        // GET /v1/health lists what this server takes (SPEC §3). Counters and server mode wait for the answer; with no answer
        // (offline, a 5xx) it is asked again at the next flush.
        void CheckFeatures()
        {
            if (features != null || featuresAsked || !Inited || !Enabled || Transport == null || Ticks < featuresRetryAt) return;
            featuresAsked = true;
            Transport.Get(intake + "/v1/health", (status, body) =>
            {
                featuresAsked = false;
                if (SwitchedOff) return; // turned off on its way: the answer is ignored, and asked for again once back on
                if (status >= 200 && status < 300) OnFeatures(ParseFeatures(body));
                else featuresRetryAt = Ticks + Options.FlushIntervalSeconds * 1000;
            });
        }

        /// <summary>The features a /v1/health answer lists. An older server's answer has none.</summary>
        internal static HashSet<string> ParseFeatures(string body)
        {
            var set = new HashSet<string>();
            try
            {
                if (!(Json.Parse(body ?? "") is Dictionary<string, object> d) || !d.TryGetValue("features", out var f)) return set;
                if (f is List<object> list)
                    foreach (var x in list)
                        if (x is string s) set.Add(s);
                if (f is Dictionary<string, object> flags) // { "counts": true }, as some servers may write it
                    foreach (var kv in flags)
                        if (kv.Value is bool on && on) set.Add(kv.Key);
            }
            catch (Exception)
            {
            }
            return set;
        }

        internal void OnFeatures(HashSet<string> taken)
        {
            features = taken;
            if (taken.Contains("counts"))
                foreach (var e in heldCounts) QueueEvent(e);
            else
            {
                countsOff = true;
                if (heldCounts.Count > 0) Warn("counts", "this Glitchless server doesn't take counters yet, so Glitchless.Count sends nothing to it: update the server");
            }
            heldCounts.Clear();
            if (IsServer && !taken.Contains("server_mode"))
            {
                // An older server would count a game server's sessions as players': it gets nothing at all.
                serverRefused = true;
                queue.Clear();
                Warn("server", "this Glitchless server has no server mode, so this game server sends it nothing: update the server");
            }
            Debug($"the server takes: {string.Join(", ", taken)}");
        }

        bool ServerReady => features != null && features.Contains("server_mode");

        // ───────────────────────────── properties ─────────────────────────────

        /// <summary>Sets what holds for the session: the mode, the player's rank tier or class, the region of the game's
        /// servers. null removes one. Dropped, with a warning in a debug build, when it breaks the rules in GameWords.</summary>
        public void SetProperty(string key, object value)
        {
            var why = GameWords.CheckKey(key);
            if (why != null)
            {
                Warn("prop-key:" + key, $"property \"{key}\" dropped: {why}");
                return;
            }
            if (value == null)
            {
                if (props.Remove(key)) PropChanged(key, null);
                return;
            }
            var clean = GameWords.CleanValue(value, out why);
            if (why != null)
            {
                Warn("prop-value:" + key, $"property \"{key}\" dropped: {why}");
                return;
            }
            if (props.TryGetValue(key, out var was) && Equals(was, clean)) return;
            if (!propKeys.Contains(key) && propKeys.Count >= GameWords.MaxProperties)
            {
                Warn("prop-many", $"property \"{key}\" dropped: a session has at most {GameWords.MaxProperties}");
                return;
            }
            props[key] = clean;
            propKeys.Add(key);
            PropChanged(key, clean);
        }

        public void SetProperties(Dictionary<string, object> values)
        {
            if (values == null) return;
            foreach (var kv in values) SetProperty(kv.Key, kv.Value);
        }

        /// <summary>The session's properties now (for tests and the overlay).</summary>
        public IReadOnlyDictionary<string, object> Properties => props;

        // Before the session's first batch, a change goes in session_start; after it, in the window's props event.
        void PropChanged(string key, object value)
        {
            if (!sessionStartSent) return;
            pendingProps = pendingProps ?? new Dictionary<string, object>();
            pendingProps[key] = value;
            pendingPropsAt = UnixNow();
        }

        void FlushProps()
        {
            if (pendingProps == null) return;
            var changed = new Dictionary<string, object>();
            foreach (var kv in pendingProps)
            {
                // Changed and changed back within the window: nothing to say.
                var had = sentProps.TryGetValue(kv.Key, out var was);
                if (kv.Value == null ? had : !had || !Equals(was, kv.Value)) changed[kv.Key] = kv.Value;
            }
            pendingProps = null;
            if (changed.Count == 0) return;
            foreach (var kv in changed)
            {
                if (kv.Value == null) sentProps.Remove(kv.Key);
                else sentProps[kv.Key] = kv.Value;
            }
            var e = new Dictionary<string, object> { ["type"] = "props", ["ts"] = pendingPropsAt, ["level"] = Level, ["props"] = changed };
            Stamp(e);
            QueueEvent(e);
        }

        // ───────────────────────────── groups and zones ─────────────────────────────

        /// <summary>Marks every event from here on with a match, party or run, until it's set to null. Match and party IDs
        /// come from the game's servers and are hashed before they're sent (HashGroupIds). A run ID the game saved resumes
        /// that run in install and full mode; in anonymous mode it gets a new ID, so no ID ties two launches together.
        /// Returns the run's ID, or the ID passed.</summary>
        public string SetGroup(string kind, string id, Dictionary<string, object> attrs = null)
        {
            if (!GameWords.IsGroupKind(kind))
            {
                Warn("group-kind:" + kind, $"group \"{kind}\" dropped: the kinds are match, party and run");
                return null;
            }
            if (id == null)
            {
                EndGroup(kind);
                return null;
            }
            if (!GameWords.ValidGroupId(id))
            {
                Warn("group-id:" + kind, $"{kind} ID dropped: IDs are 8 to 64 letters, digits and _ . : -");
                return null;
            }
            var resumed = false;
            string sent;
            if (kind == "run")
            {
                resumed = true;
                if (!Inited || !storesId)
                {
                    if (!resumedRuns.TryGetValue(id, out sent)) resumedRuns[id] = sent = NewId("r_", 12);
                }
                else sent = id;
            }
            else if (!Inited)
            {
                groupsBeforeInit[kind] = id; // hashed once Init says the service
                sent = id;
            }
            else sent = Options.HashGroupIds ? GameWords.HashGroupId(service, id) : id;
            if (groups.TryGetValue(kind, out var current) && current == sent && attrs == null) return kind == "run" ? sent : id;
            if (kind == "match" && IsServer && Options.SessionPerMatch && sessionStartSent && Inited && Enabled) CutSession("match_end");
            CloseWindow(false); // a window belongs to one match, party and run
            groups[kind] = sent;
            if (attrs != null) groupAttrs[kind] = new Dictionary<string, object>(attrs);
            else groupAttrs.Remove(kind);
            PushGroup(kind, resumed);
            return kind == "run" ? sent : id;
        }

        /// <summary>Starts a run with an ID the SDK makes (r_ and 12 characters), and returns it, for the game to save if
        /// the run can go on after a restart.</summary>
        public string NewRun(Dictionary<string, object> attrs = null)
        {
            var id = NewId("r_", 12);
            CloseWindow(false);
            groups["run"] = id;
            if (attrs != null) groupAttrs["run"] = new Dictionary<string, object>(attrs);
            else groupAttrs.Remove("run");
            PushGroup("run", false);
            return id;
        }

        void EndGroup(string kind)
        {
            groupsBeforeInit.Remove(kind);
            if (!groups.ContainsKey(kind)) return;
            CloseWindow(false); // the window so far was the group's
            groups.Remove(kind);
            groupAttrs.Remove(kind);
            var e = Ev("group");
            e["kind"] = kind;
            e["id"] = null;
            Push(e);
        }

        void PushGroup(string kind, bool resumed)
        {
            var e = Ev("group");
            e["kind"] = kind;
            e["id"] = groups[kind];
            if (groupAttrs.TryGetValue(kind, out var a)) e["attrs"] = a;
            if (resumed) e["resumed"] = true;
            Push(e);
        }

        /// <summary>The groups set now, as sent (for tests and the overlay).</summary>
        public IReadOnlyDictionary<string, string> Groups => groups;

        // A match or party set before Init went into events with its raw ID: hash it now that the service is known.
        void HashGroupsSetBeforeInit()
        {
            if (groupsBeforeInit.Count == 0) return;
            foreach (var kv in groupsBeforeInit)
            {
                var hashed = Options.HashGroupIds ? GameWords.HashGroupId(service, kv.Value) : kv.Value;
                if (groups.TryGetValue(kv.Key, out var cur) && cur == kv.Value) groups[kv.Key] = hashed;
                foreach (var e in queue)
                {
                    if (e.TryGetValue(kv.Key, out var v) && v as string == kv.Value) e[kv.Key] = hashed;
                    if (e["type"] as string == "group" && e["kind"] as string == kv.Key && e["id"] as string == kv.Value) e["id"] = hashed;
                }
            }
            groupsBeforeInit.Clear();
        }

        /// <summary>Where the player is in an open world (an MMO region, a metroidvania room), with no start or end: events
        /// and windows carry it the way they carry the level, and boards split by $zone. null clears it.</summary>
        public void SetZone(string zone)
        {
            zone = string.IsNullOrEmpty(zone) ? null : Clip(zone, 64);
            if (zone == Zone) return;
            CloseWindow(false); // so a window never spans two zones
            Zone = zone;
        }

        // Every event but session_start carries the zone and the groups, as it carries the level.
        void Stamp(Dictionary<string, object> e)
        {
            if (Zone != null && !e.ContainsKey("zone")) e["zone"] = Zone;
            foreach (var kind in GameWords.GroupKinds)
                if (groups.TryGetValue(kind, out var id) && !e.ContainsKey(kind)) e[kind] = id;
        }

        public void SetContext(string key, double value) => Gauge(key, value);

        public void SetPosition(double x, double y, double z)
        {
            if (positionsOn && !SwitchedOff) position = new[] { x, y, z };
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
            if (SwitchedOff)
            {
                // The player has Glitchless off: nothing is measured. A launch whose first frame went by unmeasured has
                // no load event, even if they turn it on later.
                if (firstFrameMs <= 0) loadSent = true;
                return;
            }
            if (IsServer)
            {
                ServerFrame(dtMs, cost);
                Tick();
                return;
            }
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
            if (now >= nextNetAt)
            {
                nextNetAt = now + 1000;
                SampleNet();
            }
            if (IsServer && Inited && Enabled && UnixNow() - startedAt >= MaxServerSessionMs) CutSession("max_duration");
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
            var hitchEvent = new Dictionary<string, object>
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
            };
            Stamp(hitchEvent);
            pendingHitches.Add(hitchEvent);
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

        Window NewWindow() => new Window { StartedAt = UnixNow(), StartedTicks = Ticks, CpuAt = IsServer ? CpuMs() : -1 };

        /// <param name="fresh">Sample the engine counts now. Not when a level starts: whatever the game just
        /// did to load the new level belongs to the new level.</param>
        void CloseWindow(bool fresh)
        {
            if (fresh && win.Frames > 0) SampleEngine();
            var w = win;
            win = NewWindow();
            var secs = Math.Max((Ticks - w.StartedTicks) / 1000, 0.001);
            // Connected all through a window too short for a sample (a level start closed it): it says so, with no numbers.
            if (w.Net == null && netConnected && !IsServer) w.Net = new NetWindow { Transport = netTransport };
            if (w.Net != null && w.Net.Samples > 0) lastNet = w.Net;
            if (IsServer) QueueServerWindow(w, secs);
            else if (w.Frames > 0)
            {
                var n = w.Frames;
                var s = w.Sketch;
                var fw = new Dictionary<string, object>
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
                };
                if (w.Net != null) fw["net"] = NetJson(w.Net); // windows while not connected have none
                Stamp(fw);
                QueueEvent(fw);
                recentWindows.Add(new Dictionary<string, object> { ["ts"] = w.StartedAt, ["level"] = Level, ["fps"] = Sketch.Round(n / secs, 1), ["p95"] = Round(s.Quantile(0.95), 2) });
                if (recentWindows.Count > 12) recentWindows.RemoveAt(0);
            }
            if (posBuffer.Count > 0)
            {
                var pos = new Dictionary<string, object> { ["type"] = "pos", ["ts"] = ((object[])posBuffer[0])[0], ["level"] = Level, ["pts"] = new List<object>(posBuffer) };
                Stamp(pos);
                QueueEvent(pos);
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
            FlushCounts(w, secs);
            FlushProps();
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

        // ───────────────────────────── the network ─────────────────────────────

        // Once a second: each netcode library's round trip while connected (SPEC §2 frame_window.net), and on a server its
        // players, objects and their round trips.
        void SampleNet()
        {
            if (!Options.Netcode || NetSources.Count == 0) return;
            INetSource server = null;
            NetState serverState = default;
            foreach (var s in NetSources)
            {
                if (s.Disconnected == null)
                {
                    var name = s.Name;
                    s.Disconnected = reason => NetDisconnect(reason, name);
                }
                NetState st;
                try
                {
                    st = s.Sample();
                }
                catch (Exception e)
                {
                    Debug($"{s.Name}: {e.Message}");
                    continue;
                }
                if (st.Server)
                {
                    // A run serving a match with no player of its own, reported as a player (a bot, in batch mode).
                    if (!IsServer) Warn("server-role", $"this run is a {s.Name} server with no player of its own: give it Role = GlitchlessRole.Server or --glitchless-server, so it reports as a server and not as a player");
                    if (server == null)
                    {
                        server = s;
                        serverState = st;
                    }
                    continue;
                }
                if (!st.Connected)
                {
                    if (netConnected && netTransport == s.Name) netConnected = false; // shut down by the game itself: no disconnect
                    continue;
                }
                NetConnected(s.Name);
                AddNetSample(s.Name, st.Host ? -1 : st.RttMs, st.LossPct, st.JitterMs, st.Host, st.Relay);
            }
            if (IsServer) SampleServer(server, serverState);
        }

        /// <summary>A round trip (and, when the game knows them, packet loss and jitter) from the game's own netcode, for
        /// any library Glitchless doesn't read itself. At most one a second counts.</summary>
        public void NetSample(double? rttMs, double? lossPct = null, double? jitterMs = null)
        {
            if (SwitchedOff) return;
            var now = Ticks;
            if (manualNetAt > 0 && now - manualNetAt < 1000) return;
            manualNetAt = now;
            NetConnected(netTransport ?? "manual");
            AddNetSample(netTransport ?? "manual", rttMs ?? -1, lossPct ?? -1, jitterMs ?? -1, false, null);
        }

        void NetConnected(string transport)
        {
            if (netConnected || IsServer || SwitchedOff) return;
            netConnected = true;
            netTransport = transport;
            connectedAt = Ticks;
            lastRtt = -1;
            if (disconnectedAt <= 0) return;
            var e = Ev("reconnect");
            e["after_s"] = Sketch.Round((Ticks - disconnectedAt) / 1000, 1);
            e["transport"] = transport;
            disconnectedAt = 0;
            Push(e);
            Remember("reconnect");
            // Back in the level the disconnect left: it goes on, and the server takes the abandon back (SPEC §2).
            if (droppedLevel != null && droppedLevel == Level) levelOpen = true;
            droppedLevel = null;
        }

        /// <summary>The game is connected again after a disconnect (NetDisconnect), for a library Glitchless doesn't read.</summary>
        public void NetReconnect() => NetConnected(netTransport ?? "manual");

        void AddNetSample(string transport, double rtt, double loss, double jitter, bool host, bool? relay)
        {
            if (IsServer) return;
            var n = win.Net = win.Net ?? new NetWindow();
            n.Samples++;
            n.Transport = transport;
            n.Host = host;
            if (relay.HasValue) n.Relay = relay;
            if (rtt >= 0)
            {
                n.Rtt.Add(rtt);
                if (jitter < 0 && lastRtt >= 0) jitter = Math.Abs(rtt - lastRtt); // between one second's sample and the next
                lastRtt = rtt;
            }
            if (jitter >= 0)
            {
                n.JitterSum += jitter;
                n.JitterN++;
            }
            if (loss >= 0)
            {
                n.LossSum += loss;
                n.LossN++;
            }
        }

        /// <summary>The connection to the game's server dropped. `reason` is timeout, connection_lost, kicked, server_closed,
        /// failed_to_connect or other. With a level going, it ends in a level_abandon with reason disconnect: never a fail.</summary>
        public void NetDisconnect(string reason, string transport = null)
        {
            if (IsServer || SwitchedOff) return; // a server's players come and go: that's its player count, not a disconnect
            var e = Ev("disconnect");
            e["reason"] = Array.IndexOf(DisconnectReasons, reason) >= 0 ? reason : "other";
            e["connected_s"] = netConnected ? Sketch.Round((Ticks - connectedAt) / 1000, 1) : 0;
            var recent = win.Net ?? lastNet; // the numbers of the window before it
            e["rtt_p95"] = recent != null && recent.Rtt.N > 0 ? Round(recent.Rtt.Quantile(0.95), 1) : null;
            e["loss_pct"] = recent != null && recent.LossN > 0 ? (object)Sketch.Round(recent.LossSum / recent.LossN, 2) : null;
            e["transport"] = transport ?? netTransport ?? "manual";
            netConnected = false;
            disconnectedAt = Ticks;
            lastRtt = -1;
            if (disconnects++ < MaxDisconnects) Push(e);
            Remember("disconnect");
            if (!levelOpen) return;
            droppedLevel = Level;
            Abandon(Level, "disconnect");
        }

        Dictionary<string, object> NetJson(NetWindow n)
        {
            var rtt = n.Rtt.N > 0;
            var o = new Dictionary<string, object>
            {
                ["rtt"] = rtt ? n.Rtt.ToJson() : null,
                ["rtt_p50"] = rtt ? Round(n.Rtt.Quantile(0.5), 1) : null,
                ["rtt_p95"] = rtt ? Round(n.Rtt.Quantile(0.95), 1) : null,
                ["rtt_max"] = rtt ? (object)Sketch.Round(n.Rtt.Max, 1) : null,
                ["jitter_ms"] = n.JitterN > 0 ? (object)Sketch.Round(n.JitterSum / n.JitterN, 1) : null,
                ["loss_pct"] = n.LossN > 0 ? (object)Sketch.Round(n.LossSum / n.LossN, 2) : null,
                ["in_kbps"] = null, // neither NGO nor Mirror counts bytes without their tools packages
                ["out_kbps"] = null,
                ["samples"] = n.Samples,
                ["transport"] = n.Transport,
                ["link"] = Link?.Invoke(),
                ["host"] = n.Host,
            };
            if (n.Relay.HasValue) o["relay"] = n.Relay.Value;
            return o;
        }

        // ───────────────────────────── server mode ─────────────────────────────

        /// <summary>The players connected to this server, when the game counts them itself (it wins over the netcode's count
        /// from then on).</summary>
        public void SetPlayers(int players) => setPlayers = Math.Max(0, players);

        // The ticks are NGO's network ticks, or with Mirror, which updates the server every frame, the frame, or with neither,
        // FixedUpdate's steps. A tick's time is the work of the frame it ran in, without the wait for the next frame, as an
        // Unreal server's tick is its frame: a frame over the tick's budget is a tick that ran late, and when a server falls
        // behind and runs two ticks in one long frame, both were late.
        void ServerFrame(double dt, FrameCost f)
        {
            var busy = f.Busy >= 0 ? f.Busy : dt;
            var ticks = serverSource != null ? serverSource.TakeTicks() : f.FixedSteps;
            if (ticks < 0) ticks = 1;
            var w = win;
            w.Frames++;
            if (ticks == 0) return;
            w.Tick.Add(busy, ticks);
            w.Ticks += ticks;
            if (busy > 1000 / TargetHz) w.Late += ticks;
            w.TickMax = Math.Max(w.TickMax, busy);
        }

        double TargetHz => serverTickHz > 0 ? serverTickHz : Math.Max(1, FixedHz());

        string TickSource => serverSource?.Name ?? "fixed_update";

        void SampleServer(INetSource source, NetState st)
        {
            if (source != serverSource)
            {
                serverSource?.TakeTicks();
                source?.TakeTicks(); // ticks before now are the frames' that came before
                serverSource = source;
            }
            serverTickHz = source != null && st.TickHz > 0 ? st.TickHz : 0;
            if (st.MaxPlayers > 0) serverMaxPlayers = st.MaxPlayers;
            var w = win;
            w.TickSource = TickSource;
            var players = setPlayers >= 0 ? setPlayers : source != null ? st.Players : -1;
            if (players >= 0)
            {
                w.Players = players;
                w.PlayersMax = Math.Max(w.PlayersMax, players);
            }
            if (st.NetObjects >= 0) w.NetObjects = st.NetObjects;
            if (st.ClientRtts != null)
                foreach (var r in st.ClientRtts)
                    if (r >= 0 && w.ClientRtts.Count < MaxClientRtts) w.ClientRtts.Add(r);
        }

        void QueueServerWindow(Window w, double secs)
        {
            if (w.Frames == 0) return;
            if (w.Players < 0 && setPlayers >= 0) w.Players = w.PlayersMax = setPlayers;
            var t = w.Tick;
            var cpu = CpuMs();
            var e = new Dictionary<string, object>
            {
                ["type"] = "server_window",
                ["ts"] = w.StartedAt,
                ["level"] = Level,
                ["duration_s"] = Sketch.Round(secs, 2),
                ["ticks"] = w.Ticks,
                ["tick_hz"] = Sketch.Round(w.Ticks / secs, 1), // the rate reached; session_start.server.tick_hz is the target
                ["tick"] = t.ToJson(),
                ["tick_p50"] = Round(t.Quantile(0.5), 2),
                ["tick_p95"] = Round(t.Quantile(0.95), 2),
                ["tick_max"] = Sketch.Round(w.TickMax, 1),
                ["late"] = w.Late,
                ["budget_ms"] = Sketch.Round(1000 / TargetHz, 2),
                ["tick_source"] = w.TickSource ?? TickSource,
                ["players"] = w.Players >= 0 ? (object)w.Players : null,
                ["players_max"] = w.PlayersMax >= 0 ? (object)w.PlayersMax : null,
                ["net_objects"] = w.NetObjects >= 0 ? (object)w.NetObjects : null,
                ["in_kbps"] = null,
                ["out_kbps"] = null,
                // Of one core, as top shows it: 100 is one core kept busy, more for a server's other threads.
                ["cpu_pct"] = cpu >= 0 && w.CpuAt >= 0 ? (object)Sketch.Round(Math.Max(0, cpu - w.CpuAt) / (secs * 1000) * 100, 1) : null,
                ["mem_mb"] = Engine0("system_mb"),
                ["rtt_p95"] = w.ClientRtts.Count > 0 ? (object)Sketch.Round(Quantile(w.ClientRtts, 0.95), 1) : null,
                ["ctx"] = new Dictionary<string, double>(w.Ctx),
            };
            Stamp(e);
            QueueEvent(e);
        }

        Dictionary<string, object> ServerInfo()
        {
            var max = Options.MaxPlayers > 0 ? Options.MaxPlayers : serverMaxPlayers;
            return new Dictionary<string, object>
            {
                ["tick_hz"] = Sketch.Round(TargetHz, 1),
                ["tick_source"] = TickSource,
                ["max_players"] = max > 0 ? (object)max : null,
                ["build"] = IsServerBuild ? "dedicated" : "headless",
                ["region"] = string.IsNullOrEmpty(Options.ServerRegion) ? null : Clip(Options.ServerRegion.Trim(), 64),
                ["host"] = ServerHost?.Invoke(),
            };
        }

        // A server session ends and the next begins, with the same properties and groups: every 6 hours, or at each match
        // with SessionPerMatch.
        void CutSession(string reason)
        {
            Push(SessionEnd(reason));
            NewSession();
        }

        // ───────────────────────────── measure ─────────────────────────────

        /// <summary>Frame stats over the next `seconds`, the same numbers as the browser SDK's glitchless_measure.</summary>
        public void Measure(double seconds, Action<Dictionary<string, object>> done)
        {
            if (SwitchedOff)
            {
                done?.Invoke(OffResult());
                return;
            }
            var fps = new Dictionary<string, int>();
            foreach (var kv in errorLog) fps[kv.Key] = (int)kv.Value["count"];
            probes.Add(new Probe { EndAt = Ticks + seconds * 1000, Seconds = seconds, Done = done, Errors = Stats.Errors, Fingerprints = fps, Level = Level, Engine = new Dictionary<string, object>(SampleEngine()) });
        }

        // What measure() says while the player has Glitchless off: there are no frames, and why.
        static Dictionary<string, object> OffResult() => new Dictionary<string, object> { ["error"] = "No frames were measured: Glitchless is off on this device, because the player turned it off in the game's settings (or, with OptIn, hasn't said yes yet)." };

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
            if (SwitchedOff) return;
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
            if (SwitchedOff)
            {
                if (firstInputAt <= 0) firstInputAt = now; // the launch's first input, gone by unmeasured
                return;
            }
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
                KeepHeldCounts();
                SendNow(SendDeadlineMs);
            }
        }

        // The server never said whether it takes counters (offline, say): they go with the batches saved for later, rather
        // than be lost. An older server drops them.
        void KeepHeldCounts()
        {
            if (features != null || heldCounts.Count == 0) return;
            foreach (var e in heldCounts) QueueEvent(e);
            heldCounts.Clear();
            var closing = shut;
            shut = true; // add them to the outbox without starting a send: SendNow sends
            Flush(closeWindow: false);
            shut = closing;
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
            StartSession();
        }

        void StartSession()
        {
            SessionId = NewId("s_", 16);
            startedAt = UnixNow();
            sessionStartSent = false;
            recent.Clear();
            history.Clear();
            errorCounts.Clear();
            // What held for the last session holds for this one: its properties go in the new session_start, and its
            // groups are said again.
            pendingProps = null;
            propKeys.Clear();
            foreach (var k in props.Keys) propKeys.Add(k);
            disconnects = 0;
            foreach (var kind in GameWords.GroupKinds)
                if (groups.ContainsKey(kind)) PushGroup(kind, false);
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
                KeepHeldCounts();
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

        // ───────────────────────────── the player's switch ─────────────────────────────

        const string ChoiceName = "enabled"; // "on" or "off", kept by name like the player ID, in every privacy mode

        /// <summary>Reads the player's saved choice (SPEC §4d). The automatic start calls it before anything is measured,
        /// so a player who turned Glitchless off has nothing kept from the first frame, and an outbox an earlier launch
        /// left is deleted unread; Init and SetEnabled read it when nothing has yet.</summary>
        public void LoadChoice()
        {
            if (choiceRead) return;
            choiceRead = true;
            TryIo(() =>
            {
                var saved = ReadId(ChoiceName)?.Trim();
                choice = saved == "on" || saved == "off" ? saved : null;
            });
            if (choice == "off") SwitchOff();
        }

        /// <summary>The player's own switch, for a "Share performance data" toggle in the game's settings (SPEC §4d). Off
        /// saves the choice first, then stops measuring and sending at once and drops everything waiting, on the device
        /// too; the session ends with nothing more said. On, after off, starts a new session. The choice is saved on the
        /// device and read before anything else at the next launch. A call that changes nothing does nothing, and a build
        /// that sends nothing (Options.Enabled, --glitchless-off, no intake) stays off.</summary>
        public void SetEnabled(bool on)
        {
            LoadChoice();
            var word = on ? "on" : "off";
            if (choice != word)
            {
                choice = word;
                SaveChoice(word); // before anything else, so the choice holds whatever happens next
            }
            if (on == !SwitchedOff) return;
            if (on) SwitchOn();
            else SwitchOff();
            Debug(on ? "on again, in a new session" : "off: the player turned it off");
        }

        // Nothing more is measured or sent, and everything waiting goes: the queue, the open window with its counters and
        // positions, hitches waiting for their causes, counts waiting for /v1/health, batches waiting to go again, and the
        // outbox on the device, bug reports in it included. The session ends without a session_end and a level going
        // without a level_abandon: the server sees the session go quiet, as when a game is killed. What the game said
        // (the level, properties, groups, zone, gauges) stays for a later session, and the player ID stays on the device.
        void SwitchOff()
        {
            SwitchedOff = true;
            queue.Clear();
            outbox.Clear();
            inFlight = -1; // the answer to a request on its way now is ignored: its batch is gone
            retryAt = backoffS = 0;
            heldCounts.Clear();
            counters.Clear();
            counterList.Clear();
            countsDropped = 0;
            pendingHitches.Clear();
            pendingLong = null;
            posBuffer.Clear();
            position = null;
            win = NewWindow();
            recent.Clear();
            history.Clear();
            recentHitches.Clear();
            recentWindows.Clear();
            errorCounts.Clear();
            errorLog.Clear();
            pendingProps = null;
            sessionStartSent = false;
            ended = false;
            leftLevel = null;
            if (levelOpen) offLevel = Level;
            levelOpen = false;
            droppedLevel = null;
            netConnected = false;
            disconnectedAt = 0;
            lastNet = null;
            lastRtt = -1;
            loadSent |= firstFrameMs > 0; // measured and not sent yet: it isn't sent later
            Stats.LastStatus = "off";
            DeleteOutbox();
            var going = probes.ToArray();
            probes.Clear();
            foreach (var p in going) p.Done?.Invoke(OffResult());
        }

        // Back on: a new session in the same launch, as after a long time in the background, with its own session_start
        // (the properties still set) and a group event for each group still set, measured from the next frame. The level
        // stays the current one, but the attempt that was going at off isn't open in it (OffAttempt). No load goes again.
        void SwitchOn()
        {
            SwitchedOff = false;
            win = NewWindow();
            skipNext = true; // the frame the switch flipped in was only partly measured
            pendingLong = null;
            Stats.LastStatus = "idle";
            StartSession();
            if (!Inited) return; // kept until Init, as at launch
            nextFlushAt = Ticks + Math.Min(2000, Options.FlushIntervalSeconds * 1000);
            if (buildOn) StartSending();
        }

        void SaveChoice(string word) => TryIo(() =>
        {
            if (Ids == null && SaveDir != null) Directory.CreateDirectory(SaveDir);
            WriteId(ChoiceName, word);
        });

        // ───────────────────────────── events ─────────────────────────────

        static Dictionary<string, object> Ev(string type) => new Dictionary<string, object> { ["type"] = type };

        // Nothing is kept: the player has Glitchless off, or Init found that this build sends nothing.
        bool Dropping => SwitchedOff || (Inited && !buildOn);

        void Push(Dictionary<string, object> e)
        {
            if (Dropping) return;
            if (!e.ContainsKey("ts")) e["ts"] = UnixNow();
            if (!e.ContainsKey("level")) e["level"] = Level;
            Stamp(e);
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
            var e = new Dictionary<string, object>
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
            // The properties set so far; later changes go out as props events.
            sentProps.Clear();
            foreach (var kv in props) sentProps[kv.Key] = kv.Value;
            if (props.Count > 0) e["props"] = new Dictionary<string, object>(props);
            if (IsServer) e["server"] = ServerInfo();
            return e;
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
        /// "off" when the player has Glitchless off, "offline" when this build sends nothing, "error" when it will go
        /// later.</summary>
        public void SendBugReport(Dictionary<string, object> snapshot, string note, string screenshot, Action<bool, string> done)
        {
            if (SwitchedOff)
            {
                done?.Invoke(false, "off");
                return;
            }
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
                if (SwitchedOff)
                {
                    done?.Invoke(false, "off"); // dropped with everything else waiting when the player turned Glitchless off
                    return;
                }
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
            if (!Enabled || serverRefused)
            {
                queue.Clear();
                return;
            }
            CheckFeatures();
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

        Batch NewBatch(List<string> events) => new Batch { Id = nextBatchId++, Bid = NewId("b_", 16), Service = service, Env = env, Version = version, Sid = SessionId, Pid = PlayerId, Role = IsServer ? "server" : null, Group = startedAt, Events = events };

        // A server's batches wait until the server says it has server mode: an older one would count them as players'.
        bool CanSend(Batch b) => b.Role == null || ServerReady;

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
            if (b.Role != null)
            {
                sb.Append(",\"role\":"); // intake files it under the game's companion service, <service>.server
                Json.Write(sb, b.Role);
            }
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
            var b = outbox.Find(x => !x.Direct && CanSend(x));
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
                if (!CanSend(b)) continue; // saved for a launch whose server answers
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
                    if (b.Role != null) saved["role"] = b.Role;
                    batches.Add(saved);
                }
                var tmp = OutboxPath + ".tmp";
                File.WriteAllText(tmp, Json.Serialize(new Dictionary<string, object> { ["v"] = 1, ["batches"] = batches }));
                if (File.Exists(OutboxPath)) File.Delete(OutboxPath);
                File.Move(tmp, OutboxPath);
            });
        }

        // The player turned Glitchless off: the batches saved for later go unsent, and unread at start.
        void DeleteOutbox()
        {
            if (SaveDir == null || IsWeb) return;
            TryIo(() =>
            {
                if (File.Exists(OutboxPath)) File.Delete(OutboxPath);
                if (File.Exists(OutboxPath + ".tmp")) File.Delete(OutboxPath + ".tmp");
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
                    outbox.Add(new Batch { Id = nextBatchId++, Bid = bid.StartsWith("b_", StringComparison.Ordinal) ? bid : NewId("b_", 16), Service = Str(saved, "service", service), Env = Str(saved, "env", env), Version = Str(saved, "version", version), Sid = sid, Pid = storesId ? Str(saved, "pid", "") : "", Role = saved.TryGetValue("role", out var role) ? role as string : null, Group = groupId, Events = events });
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

        // Something the game asked for was dropped: said once, in a debug build (the Editor included).
        void Warn(string key, string msg)
        {
            if (warned.Add(key) && (IsDebugBuild || debug)) Log("[glitchless] " + msg);
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

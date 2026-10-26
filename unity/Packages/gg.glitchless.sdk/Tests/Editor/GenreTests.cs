using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;

namespace GlitchlessSdk.Tests
{
    /// <summary>A netcode library as the core reads it, set by the test.</summary>
    sealed class FakeNetcode : INetSource
    {
        public string Name { get; set; } = "fake";
        public NetState State = NetState.None;
        public int TicksPerCall = -1;
        public Action<string> Disconnected { get; set; }
        public NetState Sample() => State;
        public int TakeTicks() => TicksPerCall;
    }

    /// <summary>Mirror's static API, as far as MirrorSource reads it.</summary>
    public static class FakeMirror
    {
        public enum ConnectState { None, Connecting, Connected, Disconnecting, Disconnected }

        public static class NetworkClient
        {
            public static ConnectState connectState;
            public static bool active => connectState == ConnectState.Connecting || connectState == ConnectState.Connected;
            public static bool isConnected => connectState == ConnectState.Connected;
            public static Action OnDisconnectedEvent;
        }

        public class NetworkConnectionToClient
        {
            public double rtt;
        }

        public static class NetworkServer
        {
            public static bool active;
            public static Dictionary<int, NetworkConnectionToClient> connections = new Dictionary<int, NetworkConnectionToClient>();
            public static Dictionary<uint, object> spawned = new Dictionary<uint, object>();
            public static int tickRate = 60;
        }

        public static class NetworkTime
        {
            public static double rtt;
            public static double rttVariance;
        }

        public class NetworkManager
        {
            public static NetworkManager singleton;
            public int maxConnections = 100;
        }
    }

    /// <summary>
    /// The genre additions (docs/design/genre-coverage.md A5 to A9): counters, properties, groups and level attributes,
    /// zones, network quality and disconnects, and server mode, checked in the shapes SPEC §2 gives them.
    /// </summary>
    public class GenreTests
    {
        double now;
        FakeTransport transport;
        string dir;
        List<string> logs;

        [SetUp]
        public void SetUp()
        {
            now = 1000;
            transport = new FakeTransport();
            logs = new List<string>();
            dir = Path.Combine(Path.GetTempPath(), "glitchless-genre-" + Guid.NewGuid().ToString("N"));
        }

        [TearDown]
        public void TearDown()
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }

        GlitchlessCore NewCore(params string[] args) => new GlitchlessCore
        {
            Transport = transport,
            SaveDir = dir,
            Clock = () => now,
            UnixNow = () => 1_761_000_000_000L + (long)now,
            Args = () => args,
            Log = logs.Add,
            Device = full => new Dictionary<string, object> { ["browser"] = "Unity", ["os"] = "Linux" },
            AppVersion = "1.2.3",
            IsDebugBuild = true,
            Link = () => "wifi",
            ServerHost = () => new Dictionary<string, object> { ["os"] = "Linux 6.1", ["cores"] = 8, ["memory_gb"] = 16 },
        };

        static GlitchlessOptions Options(Privacy privacy = Privacy.Anonymous) => new GlitchlessOptions { Service = "zoomies", Intake = "http://localhost:7777/", Privacy = privacy };

        static FrameCost Cost(double busy = 4, int fixedSteps = 1) => new FrameCost { Process = 2, Physics = 1, Render = 1, Gpu = -1, Calls = 10, Triangles = 100, SetPass = 2, Batches = 3, ShaderCompiles = 0, ObjectsAdded = 0, GcAllocKb = 0, Busy = busy, FixedSteps = fixedSteps };

        void Frames(GlitchlessCore core, int count, double dt = 16.7, FrameCost? cost = null)
        {
            for (var i = 0; i < count; i++)
            {
                now += dt;
                core.Frame(dt, cost ?? Cost());
            }
        }

        List<Dictionary<string, object>> Sent(string type) => transport.Events().Where(e => (string)e["type"] == type).ToList();

        static Dictionary<string, object> D(object o) => (Dictionary<string, object>)o;

        static Dictionary<string, object> A(params (string k, object v)[] kv) => kv.ToDictionary(p => p.k, p => p.v);

        // ───────────────────────────── A5 counters ─────────────────────────────

        [Test]
        public void CountersAreAddedUpOnTheDeviceAndSentOnceAWindow()
        {
            var core = NewCore();
            core.Init(Options());
            core.LevelStart("nmd_ghoa");
            var windowStart = 1_761_000_000_000L + (long)now;
            for (var i = 0; i < 37; i++) core.Count("kill", A(("monster", "elite")));
            core.Count("gold", A(("source", "loot"), ("amount", 35)));
            core.Count("gold", A(("source", "loot"), ("amount", 1785.5)));
            core.Count("tap", null, 12);
            Frames(core, 30);
            core.Flush();
            Assert.IsEmpty(Sent("custom").Where(e => (string)e["name"] == "kill"), "a counter queues no event per call");
            var counts = Sent("counts").Single();
            Assert.AreEqual(windowStart, (long)(double)counts["ts"], "stamped with the window's start");
            Assert.AreEqual("nmd_ghoa", counts["level"]);
            Assert.Greater((double)counts["duration_s"], 0.4);
            Assert.AreEqual(0.0, counts["dropped"]);
            var entries = ((List<object>)counts["counts"]).Cast<Dictionary<string, object>>().ToList();
            var kill = entries.Single(e => (string)e["name"] == "kill");
            Assert.AreEqual(37.0, kill["n"]);
            Assert.AreEqual("elite", D(kill["attrs"])["monster"]);
            Assert.IsFalse(kill.ContainsKey("sums"));
            Assert.AreEqual(windowStart, (long)(double)kill["first_ts"]);
            var gold = entries.Single(e => (string)e["name"] == "gold");
            Assert.AreEqual(2.0, gold["n"]);
            Assert.AreEqual(1820.5, D(gold["sums"])["amount"], "numbers are added up as given");
            Assert.AreEqual(12.0, entries.Single(e => (string)e["name"] == "tap")["n"], "n is how many events the call stands for");
            Assert.IsEmpty(D(entries.Single(e => (string)e["name"] == "tap")["attrs"]));
        }

        [Test]
        public void ALevelStartClosesTheCountersWindowSoCountsKeepTheirLevel()
        {
            var core = NewCore();
            core.Init(Options());
            core.LevelStart("one");
            core.Count("kill");
            Frames(core, 5);
            core.LevelStart("two");
            core.Count("kill", null, 3);
            Frames(core, 5);
            core.Flush();
            var byLevel = Sent("counts").ToDictionary(e => (string)e["level"], e => ((List<object>)e["counts"]).Cast<Dictionary<string, object>>().Single()["n"]);
            Assert.AreEqual(1.0, byLevel["one"]);
            Assert.AreEqual(3.0, byLevel["two"]);
        }

        [Test]
        public void AGroupIsAtMostFourWordsAndAtMostFourNumbersAreAddedUp()
        {
            var core = NewCore();
            core.Init(Options());
            core.Count("hit", A(("e", "5"), ("d", "4"), ("c", "3"), ("b", true), ("a", "1"), ("w", 1), ("x", 2), ("y", 3), ("z", 4), ("zz", 5), ("list", new[] { "x" })));
            core.Flush();
            var hit = ((List<object>)Sent("counts").Single()["counts"]).Cast<Dictionary<string, object>>().Single();
            CollectionAssert.AreEquivalent(new[] { "a", "b", "c", "d" }, D(hit["attrs"]).Keys, "the first four, by name");
            Assert.AreEqual(true, D(hit["attrs"])["b"]);
            CollectionAssert.AreEquivalent(new[] { "w", "x", "y", "z" }, D(hit["sums"]).Keys);
        }

        [Test]
        public void AFullWindowPutsNewGroupsUnderOtherAndDropsNewNames()
        {
            var core = NewCore();
            core.Init(Options());
            for (var i = 0; i < 64; i++) core.Count("n" + i, A(("kind", "a")));
            core.Count("n0", A(("kind", "b")));
            core.Count("n0", A(("kind", "c")), 2);
            core.Count("brand_new", null, 5);
            core.Flush();
            var counts = Sent("counts").Single();
            var entries = ((List<object>)counts["counts"]).Cast<Dictionary<string, object>>().ToList();
            Assert.AreEqual(65, entries.Count);
            var other = entries.Single(e => (string)e["name"] == "n0" && (string)D(e["attrs"])["kind"] == "(other)");
            Assert.AreEqual(3.0, other["n"]);
            Assert.AreEqual(5.0, counts["dropped"], "the dropped events, not calls");
        }

        [Test]
        public void CountersWaitForTheServerAndAnOlderServerGetsNone()
        {
            transport.HoldHealth = true;
            var core = NewCore();
            core.Init(Options());
            StringAssert.EndsWith("/v1/health", transport.Gets.Single());
            core.Count("kill", null, 4);
            core.Flush();
            Assert.IsEmpty(Sent("counts"), "held until the server says it takes them");
            Assert.IsNotEmpty(Sent("session_start"), "everything else goes");
            transport.Health = "{\"ok\":true,\"store\":\"file\"}"; // an older server: no features
            transport.AnswerHealth();
            core.Count("kill");
            core.Flush();
            Assert.IsEmpty(Sent("counts"));
            Assert.AreEqual(1, logs.Count(l => l.Contains("doesn't take counters")), "one warning");
            core.Count("kill");
            Assert.AreEqual(1, logs.Count(l => l.Contains("doesn't take counters")));
        }

        [Test]
        public void HeldCountersGoOutOnceTheServerSaysItTakesThem()
        {
            transport.HoldHealth = true;
            var core = NewCore();
            core.Init(Options());
            core.Count("kill", null, 4);
            core.Flush();
            transport.AnswerHealth();
            core.Flush();
            Assert.AreEqual(4.0, ((List<object>)Sent("counts").Single()["counts"]).Cast<Dictionary<string, object>>().Single()["n"]);
        }

        [Test]
        public void WithNoAnswerTheServerIsAskedAgainAndHeldCountersAreSavedOnQuit()
        {
            transport.HealthStatus = 0; // offline
            var core = NewCore();
            core.Init(Options());
            core.Count("kill", null, 2);
            Frames(core, 10);
            core.Flush();
            now += 16000;
            core.Flush();
            Assert.AreEqual(2, transport.Gets.Count, "asked again at the next flush");
            core.Shutdown("quit");
            Assert.AreEqual(2.0, ((List<object>)transport.Events(transport.SentNow).Single(e => (string)e["type"] == "counts")["counts"]).Cast<Dictionary<string, object>>().Single()["n"]);
        }

        [Test]
        public void TrackingOneNameManyTimesASecondSaysToCountItOnce()
        {
            var core = NewCore();
            core.Init(Options());
            for (var i = 0; i < 25; i++) core.Track("shot", null);
            for (var i = 0; i < 25; i++) core.Track("shot", null);
            var hints = logs.Where(l => l.Contains("Glitchless.Count(\"shot\"")).ToList();
            Assert.AreEqual(1, hints.Count);
            Assert.IsFalse(logs.Any(l => l.Contains("\"jump\"")));
        }

        // ───────────────────────────── A6 properties ─────────────────────────────

        [Test]
        public void PropertiesGoInSessionStartThenAsOnePropsEventAWindowWithOnlyWhatChanged()
        {
            var core = NewCore();
            var o = Options();
            o.Properties = new Dictionary<string, object> { ["mode"] = "squads", ["region"] = "eu-west" };
            core.SetProperty("input", "controller"); // before Init counts too
            core.Init(o);
            core.SetProperty("rank", "gold");
            core.Flush();
            var start = Sent("session_start").Single();
            Assert.AreEqual("anonymous", start["privacy"], "properties go in every mode");
            CollectionAssert.AreEquivalent(new Dictionary<string, object> { ["mode"] = "squads", ["region"] = "eu-west", ["input"] = "controller", ["rank"] = "gold" }, D(start["props"]));
            Assert.IsEmpty(Sent("props"));

            core.SetProperty("rank", "platinum");
            core.SetProperty("rank", "platinum"); // no change
            core.SetProperty("input", null); // removed
            core.SetProperty("arena", "a7");
            core.SetProperty("arena", null); // set and removed in one window: nothing to say
            core.SetProperty("region", "na");
            core.SetProperty("region", "eu-west"); // changed back
            Frames(core, 10);
            core.Flush();
            var props = Sent("props").Single();
            CollectionAssert.AreEquivalent(new Dictionary<string, object> { ["rank"] = "platinum", ["input"] = null }, D(props["props"]));
            Frames(core, 10);
            core.Flush();
            Assert.AreEqual(1, Sent("props").Count, "a window with no change sends none");
        }

        [Test]
        public void PropertiesThatWouldSayWhoThePlayerIsAreDropped()
        {
            var core = NewCore();
            core.Init(Options());
            core.SetProperty("email", "rank"); // a key that names a person
            core.SetProperty("user_id", "gold");
            core.SetProperty("Rank", "gold"); // keys are lowercase
            core.SetProperty("version", "2"); // a built-in split
            core.SetProperty("platform", "ps5");
            core.SetProperty("a", "sam@example.com");
            core.SetProperty("b", "https://example.com/u/sam");
            core.SetProperty("c", "555 123 4567");
            core.SetProperty("d", "player 76561197960287930");
            core.SetProperty("e", "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
            core.SetProperty("f", "8f2c91d04ab7e3f1aa");
            core.SetProperty("g", "Kd1mPmuh0A6Ck2TjdOXz0g");
            core.SetProperty("h", 3.5); // fractions: bands instead
            core.SetProperty("i", 2_000_000);
            core.SetProperty("j", new object());
            Assert.IsEmpty(core.Properties);
            Assert.IsTrue(logs.Any(l => l.Contains("\"email\" dropped")), "a debug build says why");
            core.SetProperty("level_band", "30-39");
            core.SetProperty("tier", "grandmaster_tier");
            core.SetProperty("event", "WinterFestival2026");
            core.SetProperty("ranked", true);
            core.SetProperty("season", 9);
            core.SetProperty("prestige", 2.0);
            core.SetProperty("class", Privacy.Install); // an enum goes as its name
            core.SetProperty("note", "  " + new string('x', 70) + "  ");
            Assert.AreEqual("30-39", core.Properties["level_band"]);
            Assert.AreEqual("grandmaster_tier", core.Properties["tier"]);
            Assert.AreEqual("WinterFestival2026", core.Properties["event"]);
            Assert.AreEqual(true, core.Properties["ranked"]);
            Assert.AreEqual(9L, core.Properties["season"]);
            Assert.AreEqual(2L, core.Properties["prestige"]);
            Assert.AreEqual("Install", core.Properties["class"]);
            Assert.AreEqual(64, ((string)core.Properties["note"]).Length, "trimmed, then cut to 64");
        }

        [Test]
        public void ASessionHasAtMostTwelvePropertyKeys()
        {
            var core = NewCore();
            core.Init(Options());
            for (var i = 0; i < 12; i++) core.SetProperty("k" + i, "v");
            core.SetProperty("k12", "v");
            Assert.AreEqual(12, core.Properties.Count);
            core.SetProperty("k0", null);
            core.SetProperty("k12", "v");
            Assert.IsFalse(core.Properties.ContainsKey("k12"), "keys already sent this session still count");
            core.SetProperty("k1", "changed");
            Assert.AreEqual("changed", core.Properties["k1"]);
        }

        [Test]
        public void ANewSessionAfterTimeAwayStartsWithTheSameProperties()
        {
            var core = NewCore();
            core.IsMobile = true;
            core.Init(Options());
            core.SetProperty("rank", "gold");
            core.Flush();
            core.OnBackground();
            now += 400_000;
            core.OnForeground();
            core.Flush();
            var starts = transport.Events(transport.Sent.Concat(transport.SentNow)).Where(e => (string)e["type"] == "session_start").ToList();
            Assert.AreEqual(2, starts.Count);
            Assert.AreEqual("gold", D(starts[1]["props"])["rank"]);
        }

        [Test]
        public void TheRulesOnTheirOwn()
        {
            Assert.IsNull(GameWords.CheckKey("rank"));
            Assert.IsNull(GameWords.CheckKey("level_band"));
            Assert.IsNotNull(GameWords.CheckKey("1rank"));
            Assert.IsNotNull(GameWords.CheckKey(new string('a', 33)));
            Assert.IsNotNull(GameWords.CheckKey("steam_branch"));
            Assert.IsNotNull(GameWords.CheckKey("zone"));
            Assert.IsNotNull(GameWords.CheckKey("gender"));
            Assert.IsTrue(GameWords.LooksPersonal("+44 20 7946 0958"));
            Assert.IsTrue(GameWords.LooksPersonal("www.example.com"));
            Assert.IsFalse(GameWords.LooksPersonal("diamond"));
            Assert.IsFalse(GameWords.LooksPersonal("arena_10"));
            Assert.IsFalse(GameWords.LooksPersonal("3000-3499"));
            Assert.IsNull(GameWords.CleanValue("   ", out var why));
            Assert.IsNotNull(why);
        }

        // ───────────────────────────── A7 groups, level attributes, zones ─────────────────────────────

        [Test]
        public void MatchIdsAreHashedWithTheServiceAndEveryEventCarriesTheGroup()
        {
            Assert.AreEqual("h_d8a6ac978165726ac21a722b", GameWords.HashGroupId("zoomies", "m_8f2c91d04ab7"), "the test vector every SDK checks");
            var core = NewCore();
            core.Init(Options());
            Frames(core, 5);
            Assert.AreEqual("m_8f2c91d04ab7", core.SetGroup("match", "m_8f2c91d04ab7", A(("mode", "squads"), ("players", 100))));
            core.LevelStart("island");
            core.Track("landed", A(("zone", "docks")));
            Frames(core, 5);
            core.SetGroup("match", null);
            core.Track("menu", null);
            Frames(core, 5);
            core.Flush();
            var groups = Sent("group");
            Assert.AreEqual(2, groups.Count);
            Assert.AreEqual("match", groups[0]["kind"]);
            Assert.AreEqual("h_d8a6ac978165726ac21a722b", groups[0]["id"]);
            Assert.AreEqual(100.0, D(groups[0]["attrs"])["players"]);
            Assert.IsNull(groups[1]["id"], "null when it ends");
            const string hashed = "h_d8a6ac978165726ac21a722b";
            Assert.AreEqual(hashed, Sent("level_start").Single()["match"]);
            Assert.AreEqual(hashed, Sent("custom").Single(e => (string)e["name"] == "landed")["match"]);
            Assert.IsFalse(Sent("custom").Single(e => (string)e["name"] == "menu").ContainsKey("match"));
            var windows = Sent("frame_window");
            Assert.AreEqual(3, windows.Count, "setting and ending a group closes the window, as a level start does");
            CollectionAssert.AreEqual(new object[] { null, hashed, null }, windows.Select(w => w.TryGetValue("match", out var m) ? m : null));
            Assert.IsFalse(transport.Sent.Any(s => s.Contains("m_8f2c91d04ab7")), "the raw ID never leaves");
        }

        [Test]
        public void HashGroupIdsOffSendsThemAsTheyAre()
        {
            var core = NewCore();
            var o = Options();
            o.HashGroupIds = false;
            core.Init(o);
            core.SetGroup("party", "party_7f3a");
            core.Flush();
            Assert.AreEqual("party_7f3a", Sent("group").Single()["id"]);
        }

        [Test]
        public void AGroupSetBeforeInitIsHashedOnceTheServiceIsKnown()
        {
            var core = NewCore();
            core.SetGroup("match", "m_8f2c91d04ab7");
            core.Track("early", null);
            core.Init(Options());
            core.Flush();
            Assert.AreEqual("h_d8a6ac978165726ac21a722b", Sent("group").Single()["id"]);
            Assert.AreEqual("h_d8a6ac978165726ac21a722b", Sent("custom").Single()["match"]);
            Assert.AreEqual("h_d8a6ac978165726ac21a722b", core.Groups["match"]);
        }

        [Test]
        public void GroupsWithABadKindOrIdAreDropped()
        {
            var core = NewCore();
            core.Init(Options());
            Assert.IsNull(core.SetGroup("guild", "guild_12345678"));
            Assert.IsNull(core.SetGroup("match", "short"));
            Assert.IsNull(core.SetGroup("match", "has spaces in it"));
            Assert.IsNull(core.SetGroup("match", new string('a', 65)));
            core.Flush();
            Assert.IsEmpty(Sent("group"));
        }

        [Test]
        public void RunsAreTheSdksAndResumeAcrossLaunchesOnlyInInstallAndFullMode()
        {
            var core = NewCore();
            core.Init(Options());
            var run = core.NewRun();
            StringAssert.IsMatch("^r_[a-z0-9]{12}$", run);
            var resumed = core.SetGroup("run", "r_savedrun123");
            Assert.AreNotEqual("r_savedrun123", resumed, "anonymous mode: no ID ties two launches");
            Assert.AreEqual(resumed, core.SetGroup("run", "r_savedrun123"), "the same saved run maps to the same ID this launch");
            core.Flush();
            var groups = Sent("group");
            Assert.AreEqual(run, groups[0]["id"]);
            Assert.IsFalse(groups[0].ContainsKey("resumed"));
            Assert.AreEqual(true, groups[1]["resumed"]);

            transport = new FakeTransport();
            var install = NewCore();
            install.Init(Options(Privacy.Install));
            Assert.AreEqual("r_savedrun123", install.SetGroup("run", "r_savedrun123"));
            install.Flush();
            Assert.AreEqual("r_savedrun123", Sent("group").Single()["id"]);
        }

        [Test]
        public void LevelStartCarriesWhatTheAttemptIs()
        {
            var core = NewCore();
            core.Init(Options());
            core.LevelStart("nmd_ghoa", A(("tier", "pit_80"), ("party_size", 3), ("build", new List<object> { "blood_surge", "corpse_explosion" })));
            core.LevelStart("plain");
            core.LevelFail("plain", "timer");
            core.Flush();
            var starts = Sent("level_start");
            var attrs = D(starts[0]["attrs"]);
            Assert.AreEqual("pit_80", attrs["tier"]);
            Assert.AreEqual(3.0, attrs["party_size"]);
            CollectionAssert.AreEqual(new[] { "blood_surge", "corpse_explosion" }, (List<object>)attrs["build"]);
            Assert.IsFalse(starts[1].ContainsKey("attrs"));
            Assert.IsFalse(Sent("level_fail").Single().ContainsKey("attrs"), "the outcome doesn't repeat them");
        }

        [Test]
        public void ZonesStampEventsAndWindowsTheWayTheLevelDoes()
        {
            var core = NewCore();
            core.Init(Options());
            core.LevelStart("azeroth");
            Frames(core, 5);
            core.SetZone("westfall");
            core.Track("quest", A(("id", "defias")));
            core.Death(null, null, null, "murloc");
            core.Count("xp", A(("amount", 1200)));
            Frames(core, 5);
            core.SetZone("westfall"); // the same zone: nothing changes
            Frames(core, 5);
            core.SetZone(null);
            Frames(core, 5);
            core.Flush();
            var windows = Sent("frame_window");
            CollectionAssert.AreEqual(new object[] { null, "westfall", null }, windows.Select(w => w.TryGetValue("zone", out var z) ? z : null));
            Assert.AreEqual("westfall", Sent("custom").Single()["zone"]);
            Assert.AreEqual("westfall", Sent("death").Single()["zone"]);
            Assert.AreEqual("westfall", Sent("counts").Single()["zone"]);
            Assert.AreEqual("azeroth", Sent("death").Single()["level"], "a zone isn't a level");
        }

        // ───────────────────────────── A8 network ─────────────────────────────

        [Test]
        public void RoundTripsGoInTheFrameWindowWhileConnected()
        {
            var net = new FakeNetcode { Name = "ngo" };
            var core = NewCore();
            core.NetSources.Add(net);
            core.Init(Options());
            // Frames of 250 ms, so each second is four frames and one sample.
            Frames(core, 4, 250); // not connected: no net
            core.Flush();
            net.State = new NetState { Connected = true, RttMs = 40, LossPct = -1, JitterMs = -1, Relay = true, Players = -1, NetObjects = -1 };
            Frames(core, 4, 250);
            net.State.RttMs = 50;
            Frames(core, 4, 250);
            net.State.RttMs = 70;
            Frames(core, 4, 250);
            core.Flush();
            var windows = Sent("frame_window");
            Assert.IsFalse(windows[0].ContainsKey("net"), "windows while not connected have none");
            var n = D(windows.Last()["net"]);
            Assert.AreEqual(3.0, n["samples"], "one sample a second");
            Assert.AreEqual(0.05, D(n["rtt"])["a"], "the 5% sketch");
            Assert.AreEqual(3.0, D(n["rtt"])["n"]);
            Assert.AreEqual(70.0, n["rtt_max"]);
            Assert.That((double)n["rtt_p50"], Is.EqualTo(50).Within(2.5));
            Assert.AreEqual(15.0, n["jitter_ms"], "from one second's round trip to the next");
            Assert.IsNull(n["loss_pct"], "NGO gives round trips only");
            Assert.AreEqual("ngo", n["transport"]);
            Assert.AreEqual("wifi", n["link"]);
            Assert.AreEqual(false, n["host"]);
            Assert.AreEqual(true, n["relay"]);
            Assert.IsNull(n["in_kbps"]);
        }

        [Test]
        public void AWindowTooShortForASampleStillSaysItWasConnected()
        {
            var net = new FakeNetcode { Name = "ngo", State = new NetState { Connected = true, RttMs = 40, LossPct = -1, JitterMs = -1, Players = -1, NetObjects = -1 } };
            var core = NewCore();
            core.NetSources.Add(net);
            core.Init(Options());
            Frames(core, 70); // connected, one sample at least
            core.LevelStart("arena"); // closes the window
            Frames(core, 10); // 167 ms: no sample
            core.LevelStart("arena-2");
            net.State = NetState.None;
            core.NetDisconnect("timeout");
            Frames(core, 10);
            core.Flush();
            var windows = Sent("frame_window");
            Assert.Greater((double)D(windows[0]["net"])["samples"], 0);
            var shortOne = D(windows[1]["net"]);
            Assert.AreEqual(0.0, shortOne["samples"], "connected, with nothing sampled: the server still counts the time");
            Assert.IsNull(shortOne["rtt"]);
            Assert.AreEqual("ngo", shortOne["transport"]);
            Assert.IsFalse(windows[2].ContainsKey("net"), "not connected after the disconnect");
            Assert.AreEqual(40.0, Sent("disconnect").Single()["rtt_p95"], "the last window that sampled anything");
        }

        [Test]
        public void TheServersFeaturesAreAListOrAnObjectOfFlags()
        {
            CollectionAssert.AreEquivalent(new[] { "counts", "net" }, GlitchlessCore.ParseFeatures("{\"ok\":true,\"features\":[\"counts\",\"net\",3]}"));
            CollectionAssert.AreEquivalent(new[] { "counts" }, GlitchlessCore.ParseFeatures("{\"features\":{\"counts\":true,\"server_mode\":false}}"));
            Assert.IsEmpty(GlitchlessCore.ParseFeatures("{\"ok\":true}"));
            Assert.IsEmpty(GlitchlessCore.ParseFeatures("<html>not json</html>"));
            Assert.IsEmpty(GlitchlessCore.ParseFeatures(null));
        }

        [Test]
        public void AHostHasNoRoundTripOfItsOwn()
        {
            var net = new FakeNetcode { State = new NetState { Connected = true, Host = true, RttMs = 0, LossPct = -1, JitterMs = -1, Players = -1, NetObjects = -1 } };
            var core = NewCore();
            core.NetSources.Add(net);
            core.Init(Options());
            Frames(core, 130);
            core.Flush();
            var n = D(Sent("frame_window").Last()["net"]);
            Assert.AreEqual(true, n["host"]);
            Assert.IsNull(n["rtt"]);
            Assert.IsNull(n["rtt_p95"]);
        }

        [Test]
        public void ADisconnectEndsTheLevelAsAnAbandonAndAReconnectTakesItBack()
        {
            var net = new FakeNetcode { Name = "ngo", State = new NetState { Connected = true, RttMs = 80, LossPct = -1, JitterMs = -1, Players = -1, NetObjects = -1 } };
            var core = NewCore();
            core.NetSources.Add(net);
            core.Init(Options());
            core.LevelStart("rift");
            Frames(core, 300); // the first window, at 80 ms
            net.State.RttMs = 240;
            Frames(core, 120); // the next, at 240
            net.State = NetState.None;
            net.Disconnected("timeout");
            Frames(core, 61);
            net.State = new NetState { Connected = true, RttMs = 90, LossPct = -1, JitterMs = -1, Players = -1, NetObjects = -1 };
            Frames(core, 540);
            core.Shutdown("quit");
            var all = transport.Events(transport.Sent.Concat(transport.SentNow)).ToList();
            var d = all.Single(e => (string)e["type"] == "disconnect");
            Assert.AreEqual("timeout", d["reason"]);
            Assert.That((double)d["connected_s"], Is.EqualTo(7.0).Within(0.1));
            Assert.That((double)d["rtt_p95"], Is.EqualTo(240).Within(12), "the numbers of the window it came in");
            Assert.IsNull(d["loss_pct"]);
            Assert.AreEqual("ngo", d["transport"]);
            var r = all.Single(e => (string)e["type"] == "reconnect");
            Assert.That((double)r["after_s"], Is.InRange(1.0, 2.1), "found at the next sample");
            var ends = all.Where(e => (string)e["type"] == "level_abandon").Select(e => (string)e["reason"]).ToList();
            CollectionAssert.AreEqual(new[] { "disconnect", "quit" }, ends, "the level went on after the reconnect, so quitting abandons it again");
            Assert.IsTrue(all.IndexOf(d) < all.FindIndex(e => (string)e["type"] == "level_abandon"));
        }

        [Test]
        public void TheGameCanSendItsOwnRoundTripsAndDisconnects()
        {
            var core = NewCore();
            core.Init(Options());
            core.NetSample(80, 1.5);
            core.NetSample(9999, 50); // within the same second: ignored
            now += 1000;
            core.NetSample(100, 2.5, 4);
            core.NetDisconnect("weird");
            core.NetReconnect();
            for (var i = 0; i < 25; i++) core.NetDisconnect("kicked");
            core.Flush();
            var disconnects = Sent("disconnect");
            Assert.AreEqual("other", disconnects[0]["reason"], "an unknown reason is other");
            Assert.AreEqual("manual", disconnects[0]["transport"]);
            Assert.AreEqual(20, disconnects.Count, "at most 20 a session");
            Assert.AreEqual(1, Sent("reconnect").Count);
            Assert.IsEmpty(Sent("level_abandon"), "no level was going");
        }

        [Test]
        public void ManualSamplesGiveLossAndJitter()
        {
            var core = NewCore();
            core.Init(Options());
            core.OnSceneActive("Arena", 1);
            Frames(core, 2);
            core.NetSample(80, 1.5);
            now += 1000;
            core.NetSample(100, 2.5, 4);
            Frames(core, 2);
            core.Flush();
            var n = D(Sent("frame_window").Single()["net"]);
            Assert.AreEqual(2.0, n["loss_pct"]);
            Assert.AreEqual(4.0, n["jitter_ms"]);
            Assert.AreEqual(2.0, n["samples"]);
            Assert.AreEqual("manual", n["transport"]);
        }

        [Test]
        public void TheLinkIsWifiOrCellularWhereTheDeviceSays()
        {
            Assert.AreEqual("wifi", DeviceInfo.LinkFor(UnityEngine.NetworkReachability.ReachableViaLocalAreaNetwork, mobile: true));
            Assert.IsNull(DeviceInfo.LinkFor(UnityEngine.NetworkReachability.ReachableViaLocalAreaNetwork, mobile: false), "a desktop's network may be Wi-Fi or a cable");
            Assert.AreEqual("cellular", DeviceInfo.LinkFor(UnityEngine.NetworkReachability.ReachableViaCarrierDataNetwork, mobile: true));
            Assert.IsNull(DeviceInfo.LinkFor(UnityEngine.NetworkReachability.NotReachable, mobile: true));
        }

        [Test]
        public void NgoDisconnectReasons()
        {
            Assert.AreEqual("failed_to_connect", NgoSource.Reason(false, "ClosedByRemote", "Not approved"), "never connected");
            Assert.AreEqual("server_closed", NgoSource.Reason(true, "ClosedByRemote", "Disconnected due to server shutting down."));
            Assert.AreEqual("kicked", NgoSource.Reason(true, "ClosedByRemote", "cheating"));
            Assert.AreEqual("kicked", NgoSource.Reason(true, "ClosedByRemote", "[Disconnect Event][Client-1][TransportClientId-0][ClosedByRemote] "));
            Assert.AreEqual("timeout", NgoSource.Reason(true, "ProtocolTimeout", "[Disconnect Event][Client-1][TransportClientId-0][ProtocolTimeout] "));
            Assert.AreEqual("failed_to_connect", NgoSource.Reason(true, "MaxConnectionAttempts", null));
            Assert.AreEqual("connection_lost", NgoSource.Reason(true, "ProtocolError", ""));
            Assert.AreEqual("other", NgoSource.Reason(true, "Disconnected", ""));
        }

        [Test]
        public void MirrorIsReadByReflection()
        {
            var mirror = new MirrorSource(name => typeof(FakeMirror).GetNestedType(name));
            string reason = null;
            mirror.Disconnected = r => reason = r;
            FakeMirror.NetworkServer.active = false;
            FakeMirror.NetworkClient.connectState = FakeMirror.ConnectState.Connected;
            FakeMirror.NetworkTime.rtt = 0.045;
            FakeMirror.NetworkTime.rttVariance = 0.000025;
            FakeMirror.NetworkManager.singleton = new FakeMirror.NetworkManager { maxConnections = 40 };
            try
            {
                var st = mirror.Sample();
                Assert.IsTrue(st.Connected);
                Assert.IsFalse(st.Server);
                Assert.That(st.RttMs, Is.EqualTo(45).Within(1e-9));
                Assert.That(st.JitterMs, Is.EqualTo(5).Within(1e-9));
                Assert.AreEqual(40, st.MaxPlayers);
                Assert.AreEqual(-1, mirror.TakeTicks(), "Mirror's server updates every frame");

                FakeMirror.NetworkClient.OnDisconnectedEvent();
                Assert.AreEqual("connection_lost", reason);
                // Mirror's NetworkManager sets the event with = when it starts a client: the next sample adds it back.
                FakeMirror.NetworkClient.OnDisconnectedEvent = () => { };
                mirror.Sample();
                reason = null;
                FakeMirror.NetworkClient.connectState = FakeMirror.ConnectState.Disconnecting;
                FakeMirror.NetworkClient.OnDisconnectedEvent();
                Assert.IsNull(reason, "the game left on purpose");
                FakeMirror.NetworkClient.connectState = FakeMirror.ConnectState.Connecting;
                FakeMirror.NetworkClient.OnDisconnectedEvent();
                Assert.AreEqual("failed_to_connect", reason);

                FakeMirror.NetworkClient.connectState = FakeMirror.ConnectState.None;
                FakeMirror.NetworkServer.active = true;
                FakeMirror.NetworkServer.connections = new Dictionary<int, FakeMirror.NetworkConnectionToClient> { [1] = new FakeMirror.NetworkConnectionToClient { rtt = 0.03 }, [2] = new FakeMirror.NetworkConnectionToClient { rtt = 0.05 } };
                FakeMirror.NetworkServer.spawned = new Dictionary<uint, object> { [1] = null, [2] = null, [3] = null };
                var server = mirror.Sample();
                Assert.IsTrue(server.Server);
                Assert.AreEqual(2, server.Players);
                Assert.AreEqual(3, server.NetObjects);
                Assert.AreEqual(60, server.TickHz);
                CollectionAssert.AreEqual(new[] { 30.0, 50.0 }, server.ClientRtts.Select(x => Math.Round(x, 6)));
            }
            finally
            {
                FakeMirror.NetworkClient.OnDisconnectedEvent = null;
                FakeMirror.NetworkClient.connectState = FakeMirror.ConnectState.None;
                FakeMirror.NetworkServer.active = false;
                FakeMirror.NetworkManager.singleton = null;
            }
        }

        // ───────────────────────────── A9 server mode ─────────────────────────────

        GlitchlessCore Server(FakeNetcode net = null, Action<GlitchlessOptions> set = null, params string[] args)
        {
            var core = NewCore(args);
            core.IsBatchMode = true; // as servers run
            if (net != null) core.NetSources.Add(net);
            var o = Options();
            o.Role = GlitchlessRole.Server;
            o.ServerRegion = "eu-west";
            set?.Invoke(o);
            core.Init(o);
            return core;
        }

        static FakeNetcode NgoServer() => new FakeNetcode
        {
            Name = "ngo",
            TicksPerCall = 1,
            State = new NetState { Server = true, Players = 12, NetObjects = 340, TickHz = 30, MaxPlayers = -1, RttMs = -1, LossPct = -1, JitterMs = -1, ClientRtts = new List<double> { 40, 60, 200 } },
        };

        [Test]
        public void AServerSendsServerWindowsAsTheGamesCompanionAndNeverCountsAsAPlayer()
        {
            var core = Server(NgoServer(), o => o.Privacy = Privacy.Install);
            core.CpuMs = () => now * 0.5; // half of one core
            Assert.IsTrue(core.IsServer);
            core.LevelStart("island");
            core.Track("match_start", null);
            Frames(core, 300, 16.7, Cost(busy: 8));
            Frames(core, 1, 16.7, Cost(busy: 50)); // one tick over its 33 ms budget
            Frames(core, 5, 16.7, Cost(busy: 8));
            core.Flush();
            var envelope = (Dictionary<string, object>)Json.Parse(transport.Sent[0]);
            Assert.AreEqual("server", envelope["role"]);
            Assert.AreEqual("zoomies", envelope["service"], "the game's own name: intake files it under zoomies.server");
            Assert.IsNull(envelope["player_id"], "a server has no player, whatever the privacy mode");
            var start = Sent("session_start").Single();
            Assert.AreEqual("user", start["session_type"], "batch mode is how servers run, not a bot");
            var server = D(start["server"]);
            Assert.AreEqual(30.0, server["tick_hz"]);
            Assert.AreEqual("ngo", server["tick_source"]);
            Assert.AreEqual("headless", server["build"]);
            Assert.AreEqual("eu-west", server["region"]);
            Assert.AreEqual(8.0, D(server["host"])["cores"]);
            Assert.IsNull(server["max_players"]);
            foreach (var t in new[] { "frame_window", "hitch", "load", "pos" }) Assert.IsEmpty(Sent(t), $"no {t} from a server");
            var w = Sent("server_window").Last();
            Assert.AreEqual("island", w["level"]);
            Assert.AreEqual(12.0, w["players"]);
            Assert.AreEqual(12.0, w["players_max"]);
            Assert.AreEqual(340.0, w["net_objects"]);
            Assert.AreEqual(1.0, w["late"]);
            Assert.AreEqual(33.33, w["budget_ms"]);
            Assert.AreEqual(50.0, w["tick_max"]);
            Assert.That((double)w["tick_p50"], Is.EqualTo(8).Within(0.2));
            Assert.AreEqual("ngo", w["tick_source"]);
            Assert.AreEqual(0.02, D(w["tick"])["a"]);
            Assert.AreEqual(w["ticks"], D(w["tick"])["n"]);
            Assert.That((double)w["tick_hz"], Is.EqualTo(59.9).Within(1), "the rate reached: one tick a frame here");
            Assert.That((double)w["rtt_p95"], Is.EqualTo(200).Within(0.1));
            Assert.IsTrue(Sent("server_window").All(x => x.ContainsKey("cpu_pct") && x.ContainsKey("mem_mb")));
            Assert.That((double)w["cpu_pct"], Is.EqualTo(50).Within(1), "percent of one core, as top shows it");
            Assert.AreEqual(1, Sent("custom").Count, "events go as from a player's session");
        }

        [Test]
        public void WithoutNetcodeAServersTicksAreFixedUpdatesSteps()
        {
            var core = Server();
            core.FixedHz = () => 50;
            Frames(core, 100, 20, Cost(busy: 10, fixedSteps: 2));
            Frames(core, 1, 20, Cost(busy: 60, fixedSteps: 1));
            Frames(core, 160, 20, Cost(busy: 10, fixedSteps: 2)); // the first window closes at 5 s
            core.SetPlayers(7);
            Frames(core, 260, 20, Cost(busy: 10, fixedSteps: 2));
            core.Flush();
            var windows = Sent("server_window");
            var first = windows.First();
            Assert.AreEqual("fixed_update", first["tick_source"]);
            Assert.AreEqual(20.0, first["budget_ms"]);
            Assert.That((double)first["tick_p50"], Is.EqualTo(10).Within(0.2), "the work of the frame each tick ran in");
            Assert.AreEqual(1.0, first["late"], "the 60 ms frame, over FixedUpdate's 20 ms");
            Assert.IsNull(first["players"]);
            Assert.AreEqual(7.0, windows.Last()["players"]);
            Assert.AreEqual("fixed_update", D(Sent("session_start").Single()["server"])["tick_source"]);
        }

        [Test]
        public void AServerSendsNothingToAServerWithoutServerMode()
        {
            transport.Health = "{\"ok\":true,\"features\":[\"counts\"]}";
            var core = Server(NgoServer());
            Frames(core, 400);
            core.Flush();
            core.Shutdown("quit");
            Assert.IsEmpty(transport.Sent);
            Assert.IsEmpty(transport.SentNow);
            Assert.AreEqual(1, logs.Count(l => l.Contains("no server mode")));
        }

        [Test]
        public void AServerWaitsForTheServerToSayItHasServerMode()
        {
            transport.HoldHealth = true;
            var core = Server(NgoServer());
            Frames(core, 400);
            core.Flush();
            Assert.IsEmpty(transport.Sent, "nothing until the answer");
            transport.AnswerHealth();
            core.Flush();
            Assert.IsNotEmpty(Sent("session_start"));
            Assert.IsNotEmpty(Sent("server_window"));
        }

        [Test]
        public void ServerModeFromTheBuildOrTheFlag()
        {
            var flag = NewCore("--glitchless-server");
            flag.Init(Options());
            Assert.IsTrue(flag.IsServer);
            var build = NewCore();
            build.IsServerBuild = true;
            build.Init(Options());
            Assert.IsTrue(build.IsServer);
            build.Flush();
            Assert.AreEqual("dedicated", D(Sent("session_start").Single()["server"])["build"]);
            var player = NewCore();
            player.IsServerBuild = true;
            var o = Options();
            o.Role = GlitchlessRole.Player;
            player.Init(o);
            Assert.IsFalse(player.IsServer);
            Assert.IsFalse(NewCoreInited().IsServer);
        }

        GlitchlessCore NewCoreInited()
        {
            var c = NewCore();
            c.Init(Options());
            return c;
        }

        [Test]
        public void AServerSessionIsCutEverySixHoursOrAtEachMatchWhenAsked()
        {
            var core = Server(NgoServer(), o => o.SessionPerMatch = true);
            core.SetProperty("map_pool", "ranked");
            Frames(core, 10);
            core.Flush();
            core.SetGroup("match", "match_00000001");
            Frames(core, 10);
            core.Flush();
            now += 6 * 3600 * 1000.0;
            Frames(core, 1);
            core.Flush();
            var bodies = transport.Sent.Select(b => (Dictionary<string, object>)Json.Parse(b)).ToList();
            var sessions = bodies.Select(b => (string)b["session_id"]).Distinct().ToList();
            Assert.AreEqual(3, sessions.Count);
            CollectionAssert.AreEqual(new[] { "match_end", "max_duration" }, Sent("session_end").Select(e => (string)e["reason"]));
            var starts = Sent("session_start");
            Assert.AreEqual(3, starts.Count);
            Assert.IsTrue(starts.All(s => (string)D(s["props"])["map_pool"] == "ranked"), "the properties hold for each");
            Assert.AreEqual(2, Sent("group").Count, "the match is said again in the session the cut starts");
        }
    }
}

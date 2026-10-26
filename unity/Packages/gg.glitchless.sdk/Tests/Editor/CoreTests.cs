using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using NUnit.Framework;

namespace GlitchlessSdk.Tests
{
    /// <summary>A transport that answers with whatever status the test sets, and keeps what was sent.</summary>
    sealed class FakeTransport : ITransport
    {
        public long Status = 202;
        public readonly List<string> Sent = new List<string>();
        public readonly List<string> SentNow = new List<string>();
        public readonly List<byte[]> Raw = new List<byte[]>();
        public int Aborts;
        public bool Hold; // keep the answers back: each request is still going until the test calls its Pending answer
        public readonly List<Action<long>> Pending = new List<Action<long>>();
        public Action<string> BeforeSendNow;
        // What GET /v1/health answers: this server takes everything, unless a test says otherwise. HealthStatus 0 is offline;
        // HoldHealth keeps the answer back until the test calls it.
        public long HealthStatus = 200;
        public string Health = "{\"ok\":true,\"features\":[\"counts\",\"props\",\"groups\",\"net\",\"server_mode\"]}";
        public bool HoldHealth;
        public Action AnswerHealth;
        public readonly List<string> Gets = new List<string>();

        public void Send(string url, byte[] body, string contentType, Action<long> done)
        {
            Raw.Add(body);
            Sent.Add(Text(body));
            if (Hold) Pending.Add(done);
            else done(Status);
        }

        public void Get(string url, Action<long, string> done)
        {
            Gets.Add(url);
            if (HoldHealth) AnswerHealth = () => done(HealthStatus, HealthStatus == 200 ? Health : null);
            else done(HealthStatus, HealthStatus == 200 ? Health : null);
        }

        public long SendNow(string url, byte[] body, string contentType, int timeoutMs)
        {
            var text = Text(body);
            BeforeSendNow?.Invoke(text);
            SentNow.Add(text);
            return Status;
        }

        public static string BatchId(string body) => (string)((Dictionary<string, object>)Json.Parse(body))["batch_id"];

        public void Abort() => Aborts++;

        public static string Text(byte[] body)
        {
            if (body.Length < 2 || body[0] != 0x1f || body[1] != 0x8b) return Encoding.UTF8.GetString(body);
            using (var gz = new GZipStream(new MemoryStream(body), CompressionMode.Decompress))
            using (var r = new StreamReader(gz)) return r.ReadToEnd();
        }

        public IEnumerable<Dictionary<string, object>> Events(IEnumerable<string> bodies = null) =>
            (bodies ?? Sent).SelectMany(b => ((List<object>)((Dictionary<string, object>)Json.Parse(b))["events"]).Cast<Dictionary<string, object>>());
    }

    public class CoreTests
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

        GlitchlessCore NewCore(params string[] args) => new GlitchlessCore
        {
            Transport = transport,
            SaveDir = dir,
            Clock = () => now,
            UnixNow = () => 1_761_000_000_000L + (long)now,
            Args = () => args,
            Log = _ => { },
            Device = DeviceInfo.Collect,
            AppVersion = "1.2.3",
            IsDebugBuild = true,
        };

        static GlitchlessOptions Options(Privacy privacy = Privacy.Anonymous) => new GlitchlessOptions { Service = "Fetch", Intake = "http://localhost:7777/", Privacy = privacy };

        // Plays frames of dt ms each, moving the clock along with them.
        void Frames(GlitchlessCore core, int count, double dt = 16.7, FrameCost? cost = null)
        {
            for (var i = 0; i < count; i++)
            {
                now += dt;
                core.Frame(dt, cost ?? Cost());
            }
        }

        static FrameCost Cost(double process = 2, double physics = 1, double render = 3, long calls = 40) => new FrameCost { Process = process, Physics = physics, Render = render, Gpu = -1, Calls = calls, Triangles = 9000, SetPass = 12, Batches = 30, ShaderCompiles = 0, ObjectsAdded = 0, GcAllocKb = 1.5 };

        [Test]
        public void KeepsEverythingUntilInitThenSendsSessionStartFirst()
        {
            var core = NewCore();
            core.OnSceneActive("Level1", 1);
            Frames(core, 30);
            core.ReportError("exception", "NullReferenceException: Object reference not set to an instance of an object", "Player.Update () (at Assets/Player.cs:42)");
            Assert.IsEmpty(transport.Sent, "nothing goes before Init");
            core.Init(Options());
            core.Flush();
            var events = transport.Events().ToList();
            Assert.AreEqual("session_start", events[0]["type"]);
            CollectionAssert.IsSubsetOf(new[] { "level_start", "error", "frame_window", "load" }, events.Select(e => e["type"]).ToList());
            var envelope = (Dictionary<string, object>)Json.Parse(transport.Sent[0]);
            Assert.AreEqual("fetch", envelope["service"], "service is lowercased");
            Assert.AreEqual("1.2.3", envelope["version"], "version falls back to Application.version");
            Assert.AreEqual("dev", envelope["env"], "env is dev in the Editor and development builds");
            Assert.AreEqual(GlitchlessCore.Sdk, envelope["sdk"]);
            Assert.IsNull(envelope["player_id"], "anonymous mode has no player ID");
            StringAssert.StartsWith("s_", (string)envelope["session_id"]);
            StringAssert.IsMatch("^b_[a-z0-9]{16}$", (string)envelope["batch_id"]);
        }

        [Test]
        public void AnonymousDeviceInfoIsCoarse()
        {
            var core = NewCore();
            core.Init(Options());
            core.Flush();
            var device = (Dictionary<string, object>)transport.Events().First(e => (string)e["type"] == "session_start")["device"];
            Assert.AreEqual("Unity", device["browser"]);
            foreach (var key in new[] { "model", "os_version", "gpu", "gpu_vendor", "cores", "memory_gb" }) Assert.IsFalse(device.ContainsKey(key), key);
            CollectionAssert.IsSubsetOf(new[] { "os", "mobile", "device_tier", "gpu_tier", "renderer", "driver", "screen", "refresh_hz" }, device.Keys.ToList());
            var start = transport.Events().First(e => (string)e["type"] == "session_start");
            Assert.AreEqual("anonymous", start["privacy"]);
        }

        [Test]
        public void ScenesAreLevelsExceptMenusAndOverlays()
        {
            var core = NewCore();
            core.Init(Options());
            core.OnSceneActive("Boot", 1);
            core.OnSceneActive("MainMenu", 2);
            Assert.IsNull(core.Level);
            core.OnSceneActive("Level1", 3);
            core.OnSceneActive("Level1", 3); // sceneLoaded and activeSceneChanged in the same frame: one start
            core.OnSceneActive("UIScene", 4); // an overlay made active doesn't end the level
            Assert.AreEqual("Level1", core.Level);
            core.OnSceneUnloaded(3);
            Assert.IsNull(core.Level);
            core.OnSceneActive("GameOverScreen", 5);
            core.OnSceneActive("SampleScene", 6);
            Assert.AreEqual("SampleScene", core.Level);
            core.LevelStart("world-1"); // the game's own levels win from here on
            core.OnSceneActive("Level2", 7);
            Assert.AreEqual("world-1", core.Level);
            core.Flush();
            var starts = transport.Events().Where(e => (string)e["type"] == "level_start").Select(e => e["level"]).ToList();
            CollectionAssert.AreEqual(new[] { "Level1", "SampleScene", "world-1" }, starts);
        }

        [Test]
        public void LevelForSceneOption()
        {
            var core = NewCore();
            var o = Options();
            o.LevelForScene = name => name.StartsWith("Stage") ? "stage-" + name.Substring(5) : null;
            core.Init(o);
            core.OnSceneActive("Level1", 1);
            Assert.IsNull(core.Level);
            core.OnSceneActive("Stage4", 2);
            Assert.AreEqual("stage-4", core.Level);
        }

        [Test]
        public void HitchesCarryTheirCauses()
        {
            var core = NewCore();
            core.Init(Options());
            core.OnSceneActive("Level1", 1);
            core.SetContext("enemies", 12);
            Frames(core, 60);
            core.Track("powerup", new Dictionary<string, object> { ["kind"] = "magnet" });
            var slow = Cost(process: 70, render: 4);
            slow.GcCollections = 1;
            slow.ObjectsAdded = 300;
            now += 120;
            core.Frame(120, slow);
            Frames(core, 10);
            core.Flush();
            var hitch = transport.Events().Single(e => (string)e["type"] == "hitch");
            Assert.AreEqual(120.0, hitch["duration_ms"]);
            CollectionAssert.AreEquivalent(new[] { "gc", "object_spawn", "script" }, ((List<object>)hitch["causes"]).Cast<string>());
            Assert.AreEqual(70.0, hitch["process_ms"]);
            Assert.AreEqual(12.0, ((Dictionary<string, object>)hitch["ctx"])["enemies"]);
            CollectionAssert.Contains((List<object>)hitch["recent"], "powerup");
            var fw = transport.Events().First(e => (string)e["type"] == "frame_window");
            Assert.AreEqual("Level1", fw["level"]);
            Assert.AreEqual(40.0, fw["draw_calls"]);
            Assert.IsNotNull(fw["process_ms"]);
            Assert.IsNotNull(fw["physics_ms"]);
            Assert.IsNotNull(fw["render_ms"]);
            Assert.AreEqual(1.0, fw["gc_collections"]);
            var ft = (Dictionary<string, object>)fw["ft"];
            Assert.AreEqual(fw["frames"], ft["n"]);
        }

        [Test]
        public void ALongFrameIsAFreezeButARunOfThemIsThrottling()
        {
            var core = NewCore();
            core.Init(Options());
            Frames(core, 40);
            Frames(core, 1, 900); // one long frame between normal ones: a real freeze
            Frames(core, 5);
            Frames(core, 4, 1000); // a hidden window ticking once a second
            Frames(core, 5);
            core.SkipNextFrame(); // the game was paused: the gap is not a frame
            Frames(core, 1, 3000);
            core.Flush();
            var fws = transport.Events().Where(e => (string)e["type"] == "frame_window").ToList();
            Assert.AreEqual(1.0, fws.Sum(e => (double)e["frozen"]));
            Assert.AreEqual(51.0, fws.Sum(e => (double)e["frames"]));
        }

        [Test]
        public void ErrorsAreGroupedScrubbedAndCapped()
        {
            var core = NewCore();
            core.Scrubber.AddPath("/home/dev/.config/unity3d/Co/Game", "persistent:");
            core.Init(Options());
            const string stack = "Enemy.Think () (at Assets/Scripts/Enemy.cs:88)\nEnemy.Update () (at Assets/Scripts/Enemy.cs:20)\n";
            for (var i = 0; i < 30; i++) core.ReportError("exception", "IOException: /home/dev/.config/unity3d/Co/Game/save.json is locked", stack);
            core.ReportError("log_error", "send failed", "GlitchlessSdk.GlitchlessCore.SendNext () (at Packages/gg.glitchless.sdk/Runtime/GlitchlessCore.cs:1)");
            core.ReportError("log_error", "Something broke", "UnityEngine.Debug:LogError (object)\nShop:Buy (int) (at Assets/Shop.cs:7)\n");
            core.Flush();
            var errors = transport.Events().Where(e => (string)e["type"] == "error").ToList();
            Assert.AreEqual(26, errors.Count, "25 of a kind, then one more kind; Glitchless's own error is dropped");
            var e0 = errors[0];
            Assert.AreEqual("IOException: persistent:/save.json is locked", e0["message"]);
            Assert.AreEqual("Enemy.Think", e0["fn"]);
            Assert.AreEqual("Enemy.cs", e0["source"]);
            Assert.AreEqual(88.0, e0["line"]);
            Assert.AreEqual(Fingerprint.Of("exception", (string)e0["message"], "Enemy.Think"), e0["fingerprint"]);
            StringAssert.StartsWith("exception: IOException", (string)e0["stack"]);
            Assert.AreEqual("Shop.Buy", errors[25]["fn"], "Unity's Class:Method frames, past Debug.LogError");
            Assert.AreEqual(31, core.Stats.Errors);
        }

        [Test]
        public void BatchesAreGzippedAndRetriedWithBackoff()
        {
            var core = NewCore();
            core.Init(Options());
            for (var i = 0; i < 40; i++) core.Track("bone_collected", new Dictionary<string, object> { ["n"] = i });
            transport.Status = 503;
            core.Flush();
            Assert.AreEqual(1, transport.Sent.Count);
            Assert.AreEqual(0x1f, transport.Raw[0][0], "gzipped");
            Assert.AreEqual("error", core.Stats.LastStatus);
            Frames(core, 10); // within the 5 s backoff: no new attempt
            Assert.AreEqual(1, transport.Sent.Count);
            transport.Status = 202;
            Frames(core, 1, 5000 - 100);
            Frames(core, 2);
            Assert.AreEqual(2, transport.Sent.Count, "sent again after the backoff");
            Assert.AreEqual("ok", core.Stats.LastStatus);
            Assert.AreEqual(0, core.OutboxEvents);
        }

        [Test]
        public void ABatchTheServerRejectsIsDropped()
        {
            var core = NewCore();
            core.Init(Options());
            transport.Status = 400;
            core.Track("x", null);
            core.Flush();
            Assert.AreEqual(0, core.OutboxEvents);
            StringAssert.StartsWith("rejected", core.Stats.LastStatus);
        }

        [Test]
        public void OfflineBatchesAreSavedWithoutIdsInAnonymousMode()
        {
            var first = NewCore();
            first.Init(Options());
            transport.Status = 0; // no network
            first.Track("bone_collected", null);
            first.Shutdown("quit");
            var file = File.ReadAllText(Path.Combine(dir, "outbox.json"));
            StringAssert.Contains("bone_collected", file);
            StringAssert.DoesNotContain(first.SessionId, file);
            StringAssert.DoesNotContain("\"sid\"", file);
            Assert.IsFalse(File.Exists(Path.Combine(dir, "player_id")));
            var tried = FakeTransport.BatchId(transport.SentNow[0]);
            StringAssert.Contains($"\"bid\":\"{tried}\"", file, "the batch's own ID is saved, in anonymous mode too: it names the batch, not the player");

            transport.Status = 202;
            var second = NewCore();
            second.Init(Options());
            second.Flush();
            var bodies = transport.Sent.Select(b => (Dictionary<string, object>)Json.Parse(b)).ToList();
            var replayed = bodies.First(b => ((List<object>)b["events"]).Cast<Dictionary<string, object>>().Any(e => (string)e["type"] == "custom"));
            Assert.AreNotEqual(first.SessionId, replayed["session_id"], "the earlier session goes under a new random ID");
            Assert.AreNotEqual(second.SessionId, replayed["session_id"], "and not this launch's");
            Assert.AreEqual(tried, replayed["batch_id"], "under the batch ID the first launch tried, so the server can tell a repeat");
            Assert.IsFalse(File.Exists(Path.Combine(dir, "outbox.json")), "deleted once everything is sent");
        }

        [Test]
        public void FullModeKeepsAPlayerId()
        {
            var first = NewCore();
            first.Init(Options(Privacy.Full));
            StringAssert.StartsWith("p_", first.PlayerId);
            first.Death(1.234, 5.678, 0, "fell");
            first.Flush();
            var death = transport.Events().Single(e => (string)e["type"] == "death");
            Assert.AreEqual(1.23, death["x"]);
            Assert.AreEqual(first.PlayerId, ((Dictionary<string, object>)Json.Parse(transport.Sent[0]))["player_id"]);
            var second = NewCore();
            second.Init(Options(Privacy.Full));
            Assert.AreEqual(first.PlayerId, second.PlayerId);
            var anon = NewCore();
            anon.Init(Options());
            Assert.IsFalse(File.Exists(Path.Combine(dir, "player_id")), "anonymous mode deletes an ID a full-mode build left");
        }

        [Test]
        public void InstallModeKeepsThePlayerIdAndSendsWhatAnonymousModeSends()
        {
            var first = NewCore();
            first.Init(Options(Privacy.Install));
            StringAssert.IsMatch("^p_[a-z0-9]{12}$", first.PlayerId);
            Assert.AreEqual(first.PlayerId, File.ReadAllText(Path.Combine(dir, "player_id")));
            first.SetPosition(1, 2, 3);
            first.Death(1.234, 5.678, 0, "fell");
            first.Flush();
            var envelope = (Dictionary<string, object>)Json.Parse(transport.Sent[0]);
            Assert.AreEqual(first.PlayerId, envelope["player_id"]);
            var start = transport.Events().First(e => (string)e["type"] == "session_start");
            Assert.AreEqual("install", start["privacy"]);
            CollectionAssert.AreEquivalent(DeviceInfo.Collect(false).Keys, ((Dictionary<string, object>)start["device"]).Keys, "the device as anonymous mode sends it");
            Assert.IsFalse(transport.Events().Single(e => (string)e["type"] == "death").ContainsKey("x"), "no positions");
            var second = NewCore();
            second.Init(Options(Privacy.Install));
            Assert.AreEqual(first.PlayerId, second.PlayerId, "the next launch sends the same ID");
            var full = NewCore();
            full.Init(Options(Privacy.Full));
            Assert.AreEqual(first.PlayerId, full.PlayerId, "full mode keeps the same ID");
            var anon = NewCore();
            anon.Init(Options());
            Assert.IsFalse(File.Exists(Path.Combine(dir, "player_id")), "anonymous mode deletes it");
        }

        [Test]
        public void ResetInstallIdForgetsItFromTheNextLaunch()
        {
            var first = NewCore();
            first.Init(Options(Privacy.Install));
            var id = first.PlayerId;
            first.ResetInstallId();
            Assert.AreEqual(id, first.PlayerId, "this session keeps its ID");
            Assert.IsFalse(File.Exists(Path.Combine(dir, "player_id")));
            var next = NewCore();
            next.Init(Options(Privacy.Install));
            StringAssert.StartsWith("p_", next.PlayerId);
            Assert.AreNotEqual(id, next.PlayerId);
        }

        [Test]
        public void InstallModeOfflineBatchesKeepTheirIds()
        {
            var first = NewCore();
            first.Init(Options(Privacy.Install));
            transport.Status = 0;
            first.Track("bone_collected", null);
            first.Shutdown("quit");
            StringAssert.Contains(first.PlayerId, File.ReadAllText(Path.Combine(dir, "outbox.json")));
            transport.Status = 202;
            var second = NewCore();
            second.Init(Options(Privacy.Install));
            second.Flush();
            var replayed = transport.Sent.Select(b => (Dictionary<string, object>)Json.Parse(b)).First(b => ((List<object>)b["events"]).Cast<Dictionary<string, object>>().Any(e => (string)e["type"] == "custom"));
            Assert.AreEqual(first.SessionId, replayed["session_id"]);
            Assert.AreEqual(first.PlayerId, replayed["player_id"]);
        }

        [Test]
        public void IdStorageKeepsTheIdWhereThereIsNoFolder()
        {
            var prefs = new Dictionary<string, string>();
            GlitchlessCore Web() => new GlitchlessCore
            {
                Transport = transport,
                SaveDir = null,
                Ids = new IdStorage { Read = n => prefs.TryGetValue(n, out var v) ? v : null, Write = (n, v) => prefs[n] = v, Delete = n => prefs.Remove(n) },
                Clock = () => now,
                Args = () => new string[0],
                Log = _ => { },
                IsWeb = true,
            };
            var first = Web();
            first.Init(Options(Privacy.Install));
            Assert.AreEqual(first.PlayerId, prefs["player_id"]);
            var second = Web();
            second.Init(Options(Privacy.Install));
            Assert.AreEqual(first.PlayerId, second.PlayerId);
            Web().Init(Options());
            CollectionAssert.AreEquivalent(new[] { "launched" }, prefs.Keys, "anonymous mode deletes the ID; the version that last ran stays");
        }

        [Test]
        public void SteamDeckFromSteamTheBoardOrSteamOs()
        {
            const string steamos = "NAME=\"SteamOS\"\nID=steamos\nID_LIKE=arch\nVARIANT_ID=steamdeck\nVERSION_ID=3.7.13\n";
            const string ubuntu = "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\nID_LIKE=debian\n";
            Assert.IsTrue(DeviceInfo.IsSteamDeck(null, "Valve\n", "Jupiter\n", steamos), "SteamOS on the LCD model");
            Assert.IsTrue(DeviceInfo.IsSteamDeck(null, "Valve\n", "Galileo\n", "ID=bazzite\n"), "the OLED model under another distro");
            Assert.IsTrue(DeviceInfo.IsSteamDeck("1", null, null, null), "a Windows build under Proton");
            Assert.IsTrue(DeviceInfo.IsSteamDeck(null, null, null, "ID=\"steamos\"\n"), "SteamOS on its own");
            Assert.IsFalse(DeviceInfo.IsSteamDeck("", "ASUSTeK COMPUTER INC.\n", "ROG STRIX B650E-F\n", ubuntu), "an Ubuntu desktop");
            Assert.IsFalse(DeviceInfo.IsSteamDeck(null, "Valve\n", "Fremont\n", ubuntu), "other Valve hardware");
            Assert.IsFalse(DeviceInfo.IsSteamDeck("0", null, null, null));
            Assert.IsFalse(DeviceInfo.IsSteamDeck(null, null, null, null));
            Assert.IsTrue(DeviceInfo.IsSteamOs(null, "Valve\n", "Jupiter\n", steamos), "a Deck on SteamOS reports SteamOS");
            Assert.IsTrue(DeviceInfo.IsSteamOs("1", null, null, null), "so does a Windows build Steam started on a Deck");
            Assert.IsFalse(DeviceInfo.IsSteamOs(null, "Valve\n", "Galileo\n", "ID=bazzite\n"), "a Deck under Bazzite stays Linux");
            Assert.IsFalse(DeviceInfo.IsSteamOs(null, null, null, ubuntu));
            Assert.IsFalse(DeviceInfo.SteamDeck, "the Editor on this Mac is not a Deck");
            var device = DeviceInfo.Collect(false);
            Assert.AreEqual(false, device["steam_deck"], "a boolean, as the Unreal plugin sends it");
            Assert.AreNotEqual("SteamOS", device["os"]);
        }

        [Test]
        public void TheLoadEventSaysWhetherThisIsAVersionsFirstLaunch()
        {
            bool? FirstLaunch(string version)
            {
                transport.Sent.Clear();
                var core = NewCore();
                var o = Options();
                o.Version = version;
                core.Init(o);
                Frames(core, 3);
                core.Flush();
                return (bool?)transport.Events().Single(e => (string)e["type"] == "load")["first_launch"];
            }
            Assert.AreEqual(true, FirstLaunch("1.0.0"), "after an install");
            Assert.AreEqual(false, FirstLaunch("1.0.0"));
            Assert.AreEqual(true, FirstLaunch("1.1.0"), "after an update");
            Assert.AreEqual("1.1.0", File.ReadAllText(Path.Combine(dir, "launched")), "the version and nothing else, in anonymous mode too");
        }

        [Test]
        public void DeathsHaveNoPlaceUnlessPositionsAreOn()
        {
            var core = NewCore();
            core.Init(Options());
            core.SetPosition(1, 2, 3);
            Frames(core, 30);
            core.Death(3, 4, 0, "squirrel");
            core.Flush();
            var death = transport.Events().Single(e => (string)e["type"] == "death");
            Assert.IsFalse(death.ContainsKey("x"));
            Assert.AreEqual("squirrel", death["cause"]);
            Assert.IsFalse(transport.Events().Any(e => (string)e["type"] == "pos"));
        }

        [Test]
        public void GoingToTheBackgroundEndsTheSessionAndSendsAtOnce()
        {
            var core = NewCore();
            core.Init(Options());
            Frames(core, 30);
            var first = core.SessionId;
            transport.Status = 503; // the timer's send fails, so SendNow has something to send
            core.Flush();
            transport.Status = 202;
            core.OnBackground();
            Assert.IsTrue(transport.Events(transport.SentNow).Any(e => (string)e["type"] == "session_end" && (string)e["reason"] == "background"));
            now += 10_000;
            core.OnForeground();
            Assert.AreEqual(first, core.SessionId, "a short trip away resumes the session");
            core.OnBackground();
            now += 400_000;
            core.OnForeground();
            Assert.AreNotEqual(first, core.SessionId, "a long one starts a new session");
        }

        [Test]
        public void MeasureReportsTheNextSeconds()
        {
            var core = NewCore();
            core.Init(Options());
            Frames(core, 130);
            Dictionary<string, object> result = null;
            core.Measure(1, r => result = r);
            Frames(core, 59);
            Assert.IsNull(result);
            Frames(core, 2);
            Assert.IsNotNull(result);
            Assert.AreEqual(60, result["frames"]);
            Assert.AreEqual(16.67, result["frame_budget_ms"]);
            Assert.AreEqual(40L, ((Dictionary<string, object>)result["draw_calls"])["avg"]);
            Assert.AreEqual(GlitchlessCore.Sdk, result["sdk"]);
            StringAssert.Contains("\"frame_ms\"", Json.Serialize(result));
        }

        [Test]
        public void RageInputAndTimeToFirstInput()
        {
            var core = NewCore();
            core.Init(Options());
            Frames(core, 3);
            for (var i = 0; i < 4; i++)
            {
                now += 100;
                core.OnInput("Space");
            }
            core.Flush();
            Assert.AreEqual(1, transport.Events().Count(e => (string)e["type"] == "load" && e.ContainsKey("ttp_ms")));
            var rage = transport.Events().Single(e => (string)e["type"] == "custom" && (string)e["name"] == "rage_input");
            Assert.AreEqual("Space", ((Dictionary<string, object>)rage["attrs"])["key"]);
        }

        [Test]
        public void FlagsOverrideTheIntakeAndMarkBots()
        {
            var core = NewCore("Game", "--autoplay", "--glitchless-intake=http://127.0.0.1:9999");
            core.Init(Options());
            core.Flush();
            var start = transport.Events().First();
            Assert.AreEqual("synthetic", start["session_type"]);
            var off = NewCore("--glitchless-off");
            off.Init(Options());
            Assert.IsFalse(off.Enabled);
        }
    }

    public class FrameAndSessionTests
    {
        double now;
        FakeTransport transport;

        [SetUp]
        public void SetUp()
        {
            now = 1000;
            transport = new FakeTransport();
        }

        GlitchlessCore NewCore() => new GlitchlessCore
        {
            Transport = transport,
            Clock = () => now,
            UnixNow = () => 1_761_000_000_000L + (long)now,
            Args = () => new string[0],
            Log = _ => { },
        };

        static GlitchlessOptions Options(string sessionType = "") => new GlitchlessOptions { Service = "Fetch", Intake = "http://localhost:7777/", SessionType = sessionType };

        void Frames(GlitchlessCore core, int count, double dt = 16.7, FrameCost? cost = null)
        {
            for (var i = 0; i < count; i++)
            {
                now += dt;
                core.Frame(dt, cost ?? Cost(2, 1, 3));
            }
        }

        static FrameCost Cost(double process, double physics, double render, double gpu = -1) => new FrameCost { Process = process, Physics = physics, Render = render, Gpu = gpu, Calls = 40, Triangles = 9000, SetPass = 12, Batches = 30, ShaderCompiles = 0, ObjectsAdded = 0, GcAllocKb = 1.5 };

        [Test]
        public void FirebaseTestLabDevicesAreSynthetic()
        {
            Assert.AreEqual("synthetic", GlitchlessCore.SessionTypeFor("", false, () => "true"), "Google Play's pre-launch report");
            Assert.AreEqual("user", GlitchlessCore.SessionTypeFor("", false, () => null));
            Assert.AreEqual("user", GlitchlessCore.SessionTypeFor("", false, () => "false"));
            Assert.AreEqual("user", GlitchlessCore.SessionTypeFor("user", false, () => "true"), "a type the game set wins");
            Assert.AreEqual("synthetic", GlitchlessCore.SessionTypeFor(null, true, () => throw new Exception("not read when a bot flag decides")));
            Assert.IsNull(DeviceInfo.FirebaseTestLab(), "nothing to read in the Editor, and nothing thrown");
            // Google's pre-launch phones don't set the setting: a software GPU on Android tells them too.
            Assert.IsTrue(DeviceInfo.IsStoreTestDevice(true, null, "Google SwiftShader"), "a pre-launch virtual phone");
            Assert.IsTrue(DeviceInfo.IsStoreTestDevice(true, null, "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"));
            Assert.IsTrue(DeviceInfo.IsStoreTestDevice(true, "true", "Adreno (TM) 610"), "the setting alone");
            Assert.IsFalse(DeviceInfo.IsStoreTestDevice(true, null, "Adreno (TM) 610"), "a player's phone");
            Assert.IsFalse(DeviceInfo.IsStoreTestDevice(true, null, "Mali-G57 MC2"));
            Assert.IsFalse(DeviceInfo.IsStoreTestDevice(false, null, "llvmpipe (LLVM 15.0.7, 256 bits)"), "a desktop drawing in software isn't a store test device");
            Assert.IsFalse(DeviceInfo.IsStoreTestDevice(true, null, null));

            var core = NewCore();
            core.TestLabSetting = () => "true";
            core.Init(Options());
            core.Flush();
            Assert.AreEqual("synthetic", transport.Events().First()["session_type"]);
            var set = NewCore();
            set.TestLabSetting = () => "true";
            set.Init(Options("user"));
            set.Flush();
            Assert.AreEqual("user", transport.Events().Last(e => (string)e["type"] == "session_start")["session_type"]);
        }

        [Test]
        public void WhereAnIosBuildCameFromIsReadFromItsReceiptAndProfile()
        {
            const string phone = "/private/var/mobile/Containers/Data/Application/BE5EB9FD-3704-488D-96E8-ADB805300ED7";
            const string mac = "/Users/dev/Library/Containers/AB12/Data";
            Assert.AreEqual("app_store", DeviceInfo.IosDistribution(phone, true, false, false));
            Assert.AreEqual("testflight", DeviceInfo.IosDistribution(phone, false, false, false), "Apple writes a receipt with every App Store install");
            Assert.AreEqual("testflight", DeviceInfo.IosDistribution(phone.Substring("/private".Length), false, false, false));
            Assert.AreEqual("testflight", DeviceInfo.IosDistribution(phone, false, true, false), "a sandbox receipt, after a TestFlight purchase");
            Assert.AreEqual("development", DeviceInfo.IosDistribution(phone, false, true, true), "a provisioning profile in the bundle");
            Assert.AreEqual("development", DeviceInfo.IosDistribution("/Users/dev/Library/Developer/CoreSimulator/Devices/1F2E/data/Containers/Data/Application/AB12", false, false, false), "the Simulator");
            Assert.AreEqual("", DeviceInfo.IosDistribution(mac, false, false, false), "an iPad app on a Mac without a receipt can't tell");
            Assert.AreEqual("", DeviceInfo.IosDistribution(null, false, false, false));
            Assert.AreEqual("app_store", DeviceInfo.IosDistribution(mac, true, false, false));
            Assert.AreEqual("testflight", DeviceInfo.IosDistribution(mac, false, true, false));
            Assert.IsTrue(DeviceInfo.IsSandbox("testflight") && DeviceInfo.IsSandbox("development"));
            Assert.IsFalse(DeviceInfo.IsSandbox("app_store") || DeviceInfo.IsSandbox(""));
            Assert.AreEqual("", DeviceInfo.Distribution, "nothing to tell in the Editor");
            Assert.IsFalse(DeviceInfo.Collect(false).ContainsKey("distribution"));
        }

        [Test]
        public void TestFlightSessionsAreTestersAndTheirPurchasesSayTheyreSandboxOnes()
        {
            var core = NewCore();
            core.Distribution = () => "testflight";
            core.Init(Options());
            var buy = new Dictionary<string, object> { ["amount"] = 4.99, ["currency"] = "USD", ["item"] = "full_version" };
            core.Track("purchase", buy);
            core.Track("unlock", new Dictionary<string, object> { ["price"] = 2, ["currency"] = "EUR" });
            core.Track("level_pick", new Dictionary<string, object> { ["what"] = "forge" });
            core.Track("purchase", new Dictionary<string, object> { ["sandbox"] = false });
            core.Flush();
            Assert.AreEqual("tester", transport.Events().First()["session_type"]);
            var custom = transport.Events().Where(e => (string)e["type"] == "custom").Select(e => (Dictionary<string, object>)e["attrs"]).ToList();
            Assert.AreEqual(true, custom[0]["sandbox"]);
            Assert.AreEqual(true, custom[1]["sandbox"], "any event with a currency");
            Assert.IsFalse(custom[2].ContainsKey("sandbox"));
            Assert.AreEqual(false, custom[3]["sandbox"], "a sandbox the game set stays");
            Assert.IsFalse(buy.ContainsKey("sandbox"), "the game's own dictionary isn't changed");

            var store = NewCore();
            store.Distribution = () => "app_store";
            store.Init(Options());
            store.Track("purchase", new Dictionary<string, object> { ["amount"] = 4.99, ["currency"] = "USD" });
            store.Flush();
            var events = transport.Events().ToList();
            Assert.AreEqual("user", events.Last(e => (string)e["type"] == "session_start")["session_type"]);
            Assert.IsFalse(((Dictionary<string, object>)events.Last(e => (string)e["type"] == "custom")["attrs"]).ContainsKey("sandbox"));

            Assert.AreEqual("user", GlitchlessCore.SessionTypeFor("user", false, () => null, true), "a type the game set wins");
            Assert.AreEqual("synthetic", GlitchlessCore.SessionTypeFor("", true, () => null, true), "a bot on a TestFlight build is a bot");
            Assert.AreEqual("tester", GlitchlessCore.SessionTypeFor("", false, () => null, true));
        }

        [Test]
        public void AHitchTheTimedPartsDontExplainIsGpuOrOs()
        {
            var core = NewCore();
            core.Init(Options());
            Frames(core, 60);
            void Hitch(double ms, FrameCost cost)
            {
                now += ms;
                core.Frame(ms, cost);
                Frames(core, 10);
            }
            Hitch(120, Cost(3, 1, 4)); // 8 ms of 120 timed: presenting, the GPU or the OS (Metal without GPU times)
            Hitch(110, Cost(3, 1, 4, gpu: 30)); // a GPU time that still leaves most of the frame out
            Hitch(100, Cost(20, 15, 15)); // nothing stands out, but the timed parts fill the frame
            core.Flush();
            Hitch(90, FrameCost.Unknown); // the timing points didn't run: nothing to say
            Hitch(80, new FrameCost { Process = 3, Physics = 1, Render = 4, Gpu = -1, Calls = 40, GcCollections = 1, GcAllocKb = 900 }); // a GC is a cause of its own
            Hitch(900, Cost(3, 1, 4)); // a frozen frame the game code doesn't explain either
            core.Flush();
            var causes = transport.Events().Where(e => (string)e["type"] == "hitch").ToDictionary(e => (double)e["duration_ms"], e => string.Join(",", ((List<object>)e["causes"]).Cast<string>()));
            Assert.AreEqual("gpu_or_os", causes[120.0]);
            Assert.AreEqual("gpu_or_os", causes[110.0]);
            Assert.AreEqual("", causes[100.0]);
            Assert.AreEqual("", causes[90.0]);
            Assert.AreEqual("gc", causes[80.0]);
            Assert.AreEqual("gpu_or_os,frozen", causes[900.0]);
        }

        [Test]
        public void TheLoadEventIsStampedAtTheFirstFrame()
        {
            var core = NewCore();
            Frames(core, 5);
            var firstFrame = 1_761_000_000_000L + (long)(1000 + 16.7);
            now += 20_000; // the game calls Init late, and its first batch goes 2 s after that
            core.Init(Options());
            now += 2_000;
            core.Flush();
            var load = transport.Events().Single(e => (string)e["type"] == "load");
            Assert.AreEqual((double)firstFrame, load["ts"]);
            Assert.AreEqual(1016.0, load["ttff_ms"]);
        }

        [Test]
        public void TheFirstWindowsGoOutWithTheMeasuredRateNotSixty()
        {
            var core = NewCore();
            core.Init(Options());
            Frames(core, 29, 33.3);
            Assert.AreEqual(1000.0 / 60, core.BudgetMs, 0.001, "60 Hz until 30 frames are in");
            Frames(core, 11, 33.3);
            core.LevelStart("level-1"); // closes the first window early, 40 frames in
            core.Flush();
            var fw = transport.Events().First(e => (string)e["type"] == "frame_window");
            Assert.AreEqual(30.0, fw["hz"]);
            Assert.AreEqual(33.33, fw["budget_ms"]);
        }

        [Test]
        public void TheRateIsReadFromTheFastFrames()
        {
            var fast = NewCore();
            fast.Init(Options());
            Frames(fast, 10, 60); // a busy start: loading, shader compiles
            Frames(fast, 20, 8.33);
            Assert.AreEqual(1000.0 / 120, fast.BudgetMs, 0.001, "a frame can take longer than the screen's interval, never less");

            var bound = NewCore(); // a GPU-bound game at 40 fps on a 60 Hz screen: frames of one and two intervals
            bound.Init(Options());
            for (var i = 0; i < 60; i++)
            {
                Frames(bound, 1, 16.7);
                Frames(bound, 1, 33.3);
            }
            Assert.AreEqual(1000.0 / 60, bound.BudgetMs, 0.001, "judged at the screen's 60 Hz, not at 30");

            var promotion = NewCore();
            promotion.Init(Options());
            Frames(promotion, 120, 8.33);
            Assert.AreEqual(1000.0 / 120, promotion.BudgetMs, 0.001);
            promotion.ScreenHz = () => 60; // Low Power Mode: the OS says the screen slowed down, and the frames follow
            Frames(promotion, 30, 16.7);
            Assert.AreEqual(1000.0 / 60, promotion.BudgetMs, 0.001);
            Frames(promotion, 600, 16.7);
            Assert.AreEqual(1000.0 / 60, promotion.BudgetMs, 0.001, "the later looks only ever go faster");
        }
    }

    public class BatchIdTests
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

        GlitchlessCore NewCore() => new GlitchlessCore
        {
            Transport = transport,
            SaveDir = dir,
            Clock = () => now,
            UnixNow = () => 1_761_000_000_000L + (long)now,
            Args = () => new string[0],
            Log = _ => { },
            AppVersion = "1.2.3",
        };

        static GlitchlessOptions Options() => new GlitchlessOptions { Service = "Fetch", Intake = "http://localhost:7777/" };

        string OutboxFile => Path.Combine(dir, "outbox.json");

        [Test]
        public void EveryBatchHasItsOwnIdAndARetrySendsItAsItWas()
        {
            var core = NewCore();
            core.Init(Options());
            core.Track("bone_collected", null);
            transport.Status = 0; // timed out: the server may have it, but the game never saw the answer
            core.Flush();
            var first = transport.Sent[0];
            StringAssert.IsMatch("^b_[a-z0-9]{16}$", FakeTransport.BatchId(first));
            core.Track("powerup", null);
            core.Flush(); // a second batch, cut while the first waits for its retry
            Assert.AreEqual(1, transport.Sent.Count, "nothing goes during the backoff");
            transport.Status = 202;
            now += 5000;
            core.Frame(16.7, FrameCost.Unknown);
            Assert.AreEqual(3, transport.Sent.Count);
            Assert.AreEqual(first, transport.Sent[1], "the same batch with the same ID, never merged into a new one");
            Assert.AreNotEqual(FakeTransport.BatchId(first), FakeTransport.BatchId(transport.Sent[2]));
            Assert.AreEqual(0, core.OutboxEvents);
        }

        [Test]
        public void QuittingWithABatchInFlightSendsItAgainUnderItsId()
        {
            var core = NewCore();
            core.Init(Options());
            transport.Hold = true; // the server has the first batch, but its answer hasn't come back
            core.Track("bone_collected", null);
            core.Flush();
            Assert.AreEqual(1, transport.Pending.Count);
            core.Track("powerup", null);
            core.Shutdown("quit");
            Assert.AreEqual(1, transport.Aborts, "the request in flight is given up on");
            Assert.AreEqual(FakeTransport.BatchId(transport.Sent[0]), FakeTransport.BatchId(transport.SentNow[0]), "and sent again with its ID");
            Assert.AreEqual(2, transport.SentNow.Select(FakeTransport.BatchId).Distinct().Count());
            transport.Pending[0](0); // the aborted request ends
            Assert.AreEqual(0, core.OutboxEvents);
            Assert.IsFalse(File.Exists(OutboxFile));
        }

        [Test]
        public void TheAnswerToAnAbortedTryIsNotTakenForTheNextTry()
        {
            var core = NewCore();
            core.Init(Options());
            transport.Hold = true;
            core.Track("bone_collected", null);
            core.Flush();
            transport.Status = 0; // to the background with no network: nothing goes then
            core.OnBackground();
            Assert.AreEqual(1, transport.Aborts);
            now += 10_000;
            core.OnForeground();
            core.Frame(16.7, FrameCost.Unknown); // the first batch is tried again
            Assert.AreEqual(2, transport.Pending.Count);
            Assert.AreEqual(FakeTransport.BatchId(transport.Sent[0]), FakeTransport.BatchId(transport.Sent[1]));
            transport.Pending[0](0); // only now does the aborted first try end
            Assert.AreNotEqual("error", core.Stats.LastStatus, "that is not the second try failing");
            var waiting = core.OutboxEvents;
            transport.Pending[1](202);
            Assert.Less(core.OutboxEvents, waiting, "the second try's answer clears the batch");
        }

        [Test]
        public void SendingOnQuitSavesTheOutboxAfterEachBatchTheServerTakes()
        {
            var core = NewCore();
            core.Init(Options());
            transport.Status = 503;
            core.Track("bone_collected", null);
            core.Flush(); // the first batch waits for its retry
            core.Track("powerup", null);
            core.Flush(); // and a second one behind it
            var first = FakeTransport.BatchId(transport.Sent[0]);
            transport.Status = 202;
            var onDisk = new List<string>();
            transport.BeforeSendNow = _ => onDisk.Add(File.Exists(OutboxFile) ? File.ReadAllText(OutboxFile) : "");
            core.Shutdown("quit");
            Assert.AreEqual(3, transport.SentNow.Count, "the two waiting, and the one with the session's end");
            StringAssert.Contains(first, onDisk[0]);
            StringAssert.DoesNotContain(first, onDisk[1], "gone from the file before the next batch goes: the OS may stop the game any moment");
            Assert.IsFalse(File.Exists(OutboxFile));
        }

        [Test]
        public void ABatchSavedWithoutAnIdGetsOne()
        {
            Directory.CreateDirectory(dir);
            var ts = 1_761_000_000_000L + (long)now;
            File.WriteAllText(OutboxFile, "{\"v\":1,\"batches\":[{\"service\":\"fetch\",\"env\":\"dev\",\"version\":\"1.2.0\",\"group\":" + ts + ",\"events\":[{\"type\":\"custom\",\"ts\":" + ts + ",\"level\":null,\"name\":\"bone_collected\",\"attrs\":{}}]}]}");
            var core = NewCore();
            core.Init(Options());
            core.Flush();
            var replayed = transport.Sent.First(b => b.Contains("bone_collected"));
            StringAssert.IsMatch("^b_[a-z0-9]{16}$", FakeTransport.BatchId(replayed), "an outbox an older version saved");
        }
    }

    public class LevelAbandonTests
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

        GlitchlessCore NewCore() => new GlitchlessCore
        {
            Transport = transport,
            SaveDir = dir,
            Clock = () => now,
            UnixNow = () => 1_761_000_000_000L + (long)now,
            Args = () => new string[0],
            Log = _ => { },
        };

        static GlitchlessOptions Options() => new GlitchlessOptions { Service = "Fetch", Intake = "http://localhost:7777/" };

        void Frames(GlitchlessCore core, int count)
        {
            for (var i = 0; i < count; i++)
            {
                now += 16.7;
                core.Frame(16.7, FrameCost.Unknown);
            }
        }

        // Every level outcome and session end that went out, in order, as "type level reason".
        List<string> Outcomes() => transport.Events(transport.Sent.Concat(transport.SentNow))
            .Where(e => (string)e["type"] == "level_complete" || (string)e["type"] == "level_fail" || (string)e["type"] == "level_abandon" || (string)e["type"] == "session_end")
            .Select(e => $"{e["type"]} {e["level"] ?? "-"} {(e.TryGetValue("reason", out var r) ? r : e.TryGetValue("cause", out var c) ? c : "")}".Trim())
            .ToList();

        [Test]
        public void LeavingALevelIsAnAbandonNotAFail()
        {
            var core = NewCore();
            core.Init(Options());
            core.LevelStart("level-2");
            Frames(core, 60); // about a second
            core.LevelAbandon(); // the player went to the menu
            core.LevelStart("level-2");
            core.LevelFail("level-2", "fell");
            core.Flush();
            var abandon = transport.Events().Single(e => (string)e["type"] == "level_abandon");
            Assert.AreEqual("level-2", abandon["level"]);
            Assert.AreEqual(1.0, (double)abandon["duration_s"], 0.01, "seconds since its level_start");
            Assert.IsFalse(abandon.ContainsKey("reason"), "no reason when the game sends it");
            CollectionAssert.AreEqual(new[] { "level_abandon level-2", "level_fail level-2 fell" }, Outcomes());
        }

        [Test]
        public void QuittingMidLevelSendsTheAbandonBeforeTheEndAndDropsALateFail()
        {
            var core = NewCore();
            core.Init(Options());
            core.LevelStart("level-1");
            core.LevelComplete("level-1", 10);
            core.LevelStart("level-2");
            Frames(core, 30);
            core.Shutdown("quit");
            core.LevelFail("level-2", "left"); // the game ends its level as it is torn down, after the session ended
            core.LevelAbandon("level-2");
            CollectionAssert.AreEqual(new[] { "level_complete level-1", "level_abandon level-2 quit", "session_end level-2 quit" }, Outcomes());
            Assert.IsFalse(core.Queued.Any(e => (string)e["type"] == "level_fail" || (string)e["type"] == "level_abandon"), "the late fail and abandon are dropped");
        }

        [Test]
        public void QuittingFromTheMenuAbandonsNothing()
        {
            var core = NewCore();
            core.Init(Options());
            core.OnSceneActive("Level1", 1); // a scene level starts
            Frames(core, 30);
            core.OnSceneUnloaded(1); // and its scene unloads: back in the menu
            core.Shutdown("quit");
            CollectionAssert.AreEqual(new[] { "session_end - quit" }, Outcomes());
        }

        [Test]
        public void GoingToTheBackgroundMidLevelAbandonsItAndComingBackReopensIt()
        {
            var core = NewCore();
            core.Init(Options());
            core.LevelStart("level-3");
            Frames(core, 30);
            core.OnBackground();
            core.LevelFail("level-3", "left"); // dropped: the session has ended and the level has its abandon
            now += 10_000;
            core.OnForeground(); // back in the same session: the level goes on
            Frames(core, 30);
            core.OnBackground(); // so it is abandoned again
            now += 400_000;
            core.OnForeground(); // a new session: the level is forgotten
            Frames(core, 30);
            core.OnBackground();
            CollectionAssert.AreEqual(new[]
            {
                "level_abandon level-3 background", "session_end level-3 background",
                "level_abandon level-3 background", "session_end level-3 background",
                "session_end level-3 background",
            }, Outcomes());
        }
    }

    public class StackTests
    {
        [Test]
        public void ReadsUnityAndDotNetStacks()
        {
            var unity = StackParser.Parse("Player.Update () (at Assets/Scripts/Player.cs:42)\n");
            Assert.AreEqual("Player.Update", unity[0].Fn);
            Assert.AreEqual("Assets/Scripts/Player.cs", unity[0].File);
            Assert.AreEqual(42, unity[0].Line);

            var log = StackParser.Parse("UnityEngine.Debug:LogError (object)\nGame:Update () (at Assets/Game.cs:10)\n");
            Assert.IsTrue(StackParser.IsPlumbing(log[0]));
            Assert.AreEqual("Game.Update", log[1].Fn);

            var dotnet = StackParser.Parse("  at Shop.Buy (System.Int32 id) [0x0001b] in /src/Game/Shop.cs:17 \n  at Shop.Update () [0x00000] in <filename unknown>:0 ");
            Assert.AreEqual("Shop.Buy", dotnet[0].Fn);
            Assert.AreEqual("/src/Game/Shop.cs", dotnet[0].File);
            Assert.AreEqual(17, dotnet[0].Line);
            Assert.AreEqual("Shop.Update", dotnet[1].Fn);

            var il2cpp = StackParser.Parse("Player.Update () (at <00000000000000000000000000000000>:0)");
            Assert.AreEqual("Player.Update", il2cpp[0].Fn);
            Assert.IsNull(il2cpp[0].File, "no file without line numbers");
        }

        [Test]
        public void ScrubsNamesAndInstallIds()
        {
            var s = new Scrubber();
            Assert.AreEqual("/home/~/game/save.json", s.Scrub("/home/sam/game/save.json"));
            Assert.AreEqual(@"C:\Users\~\AppData\LocalLow\Co", s.Scrub(@"C:\Users\Sam\AppData\LocalLow\Co"));
            Assert.AreEqual("/var/mobile/Containers/Data/Application/<id>/Documents", s.Scrub("/var/mobile/Containers/Data/Application/0B7C1A2E-1111-4A2B-9C3D-0123456789AB/Documents"));
        }

        [Test]
        public void DeviceTiers()
        {
            Assert.AreEqual("low", DeviceInfo.DeviceTier(4, 8));
            Assert.AreEqual("mid", DeviceInfo.DeviceTier(6, 4));
            Assert.AreEqual("high", DeviceInfo.DeviceTier(8, 8));
            Assert.AreEqual("unknown", DeviceInfo.DeviceTier(8, -1));
            Assert.AreEqual("high", DeviceInfo.GpuTier("Apple M3 Max"));
            Assert.AreEqual("low", DeviceInfo.GpuTier("Intel(R) UHD Graphics 620"));
            Assert.AreEqual("mid", DeviceInfo.GpuTier("NVIDIA GeForce GTX 960"));
        }
    }
}

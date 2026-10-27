using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;

namespace GlitchlessSdk.Tests
{
    /// <summary>
    /// The player's off switch (SPEC §4d): Glitchless.SetEnabled for a "Share performance data" toggle, the choice saved
    /// on the device and read before anything else, and OptIn for a game that asks first.
    /// </summary>
    public class OffSwitchTests
    {
        double now;
        FakeTransport transport;
        string dir;

        [SetUp]
        public void SetUp()
        {
            now = 1000;
            transport = new FakeTransport();
            dir = Path.Combine(Path.GetTempPath(), "glitchless-off-" + Guid.NewGuid().ToString("N"));
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
            Device = full => new Dictionary<string, object> { ["browser"] = "Unity", ["os"] = "Linux" },
            AppVersion = "1.2.3",
            IsDebugBuild = true,
        };

        static GlitchlessOptions Options(Privacy privacy = Privacy.Anonymous) => new GlitchlessOptions { Service = "zoomies", Intake = "http://localhost:7777/", Privacy = privacy };

        void Frames(GlitchlessCore core, int count, double dt = 16.7)
        {
            for (var i = 0; i < count; i++)
            {
                now += dt;
                core.Frame(dt, new FrameCost { Process = 2, Physics = 1, Render = 3, Gpu = -1, Calls = 40, Triangles = 9000, SetPass = 12, Batches = 30, ShaderCompiles = 0, ObjectsAdded = 0, GcAllocKb = 1.5 });
            }
        }

        string ChoiceFile => Path.Combine(dir, "enabled");
        string OutboxFile => Path.Combine(dir, "outbox.json");
        string Saved => File.Exists(ChoiceFile) ? File.ReadAllText(ChoiceFile) : null;

        // Every event that went out (in the background and on closing), with the session its batch was sent under.
        List<(string sid, Dictionary<string, object> e)> Sent() => transport.Sent.Concat(transport.SentNow)
            .SelectMany(b =>
            {
                var envelope = (Dictionary<string, object>)Json.Parse(b);
                return ((List<object>)envelope["events"]).Cast<Dictionary<string, object>>().Select(e => ((string)envelope["session_id"], e));
            }).ToList();

        List<string> Types(string sid = null) => Sent().Where(x => sid == null || x.sid == sid).Select(x => (string)x.e["type"]).ToList();

        // An outbox an earlier launch left: one batch with a session_start and a crash in it.
        void LeaveAnOutbox()
        {
            Directory.CreateDirectory(dir);
            var ts = 1_761_000_000_000L + (long)now;
            File.WriteAllText(OutboxFile, "{\"v\":1,\"batches\":[{\"bid\":\"b_aaaaaaaaaaaaaaaa\",\"service\":\"zoomies\",\"env\":\"dev\",\"version\":\"1.2.0\",\"group\":" + ts + ",\"events\":[{\"type\":\"error\",\"ts\":" + ts + ",\"level\":null,\"kind\":\"exception\",\"message\":\"NullReferenceException: crash\"}]},{\"service\":\"zoomies\",\"env\":\"dev\",\"version\":\"1.2.0\",\"group\":" + ts + ",\"events\":[{\"type\":\"bug_report\",\"ts\":" + ts + ",\"note\":\"stuck in the wall\"}]}]}");
        }

        [Test]
        public void TurningItOffDropsEverythingWaitingAndSendsNothingMore()
        {
            var core = NewCore();
            core.Init(Options());
            core.LevelStart("level-2");
            Frames(core, 120);
            transport.Status = 503; // the first batch waits for its retry, in memory and on the device
            core.Flush();
            Assert.IsTrue(File.Exists(OutboxFile));
            core.Track("powerup", new Dictionary<string, object> { ["what"] = "magnet" });
            core.Count("kill", new Dictionary<string, object> { ["monster"] = "elite" });
            core.ReportError("exception", "KeyNotFoundException: frisbee", "FetchGame.CatchToy () (at Assets/FetchGame.cs:12)");
            Frames(core, 400); // a window closes with a hitch waiting for its causes
            now += 200;
            core.Frame(200, FrameCost.Unknown);
            var sentBefore = transport.Sent.Count;
            var getsBefore = transport.Gets.Count;
            transport.Status = 202;

            core.SetEnabled(false);
            Assert.AreEqual("off", Saved, "the choice is saved on the device");
            Assert.IsFalse(core.Enabled);
            Assert.IsTrue(core.SwitchedOff);
            Assert.IsEmpty(core.Queued, "the queue is dropped");
            Assert.AreEqual(0, core.OutboxEvents, "and the batches waiting to go again");
            Assert.IsFalse(File.Exists(OutboxFile), "and the outbox on the device");

            Frames(core, 600);
            core.Track("powerup", null);
            core.Count("kill");
            core.Death(1, 2, 3, "fell");
            core.ReportError("exception", "NullReferenceException: later", "Player.Update () (at Assets/Player.cs:42)");
            core.SetPosition(1, 2, 3);
            core.NetSample(40);
            core.OnInput("Space");
            core.LevelFail("level-2", "fell");
            core.LevelAbandon();
            core.Flush();
            core.OnBackground();
            now += 400_000;
            core.OnForeground();
            Frames(core, 60);
            core.Shutdown("quit");
            Assert.AreEqual(sentBefore, transport.Sent.Count, "nothing more is sent");
            Assert.IsEmpty(transport.SentNow, "not on the way out either");
            Assert.AreEqual(getsBefore, transport.Gets.Count, "and no /v1/health");
            Assert.IsEmpty(core.Queued);
            Assert.AreEqual(0, core.OutboxEvents);
            Assert.IsFalse(File.Exists(OutboxFile));
            CollectionAssert.DoesNotContain(Types(), "session_end", "the session ends with nothing said");
            CollectionAssert.DoesNotContain(Types(), "level_abandon", "and so does the level that was going");
            Assert.AreEqual(0, core.Stats.Deaths);
            Assert.IsEmpty(core.ErrorLog, "errors are not kept");
            Assert.AreEqual("level-2", core.Level, "the level stays the current one");
        }

        [Test]
        public void TheAnswerToARequestOnItsWayIsIgnored()
        {
            var core = NewCore();
            core.Init(Options());
            Frames(core, 60);
            transport.Hold = true;
            core.Flush();
            Assert.AreEqual(1, transport.Pending.Count);
            var sent = core.Stats.Sent;
            core.SetEnabled(false);
            Assert.AreEqual(0, transport.Aborts, "a request on its way can't be called back");
            transport.Pending[0](503);
            Frames(core, 400);
            Assert.AreEqual(1, transport.Sent.Count, "a failed answer brings no retry");
            Assert.AreEqual(sent, core.Stats.Sent);
            Assert.AreEqual(0, core.OutboxEvents);
            Assert.IsFalse(File.Exists(OutboxFile), "and nothing is saved");
        }

        [Test]
        public void TurningItBackOnStartsANewSessionWithWhatTheGameSet()
        {
            var core = NewCore();
            core.Init(Options(Privacy.Install));
            core.SetProperty("mode", "ranked");
            core.SetGroup("match", "lobby_12345678");
            core.SetZone("north_shore");
            core.SetContext("enemies", 12);
            core.LevelStart("level-2");
            Frames(core, 120);
            core.Flush();
            var first = core.SessionId;
            var pid = core.PlayerId;
            StringAssert.StartsWith("p_", pid);

            core.SetEnabled(false);
            Assert.IsTrue(File.Exists(Path.Combine(dir, "player_id")), "the player ID stays on the device");
            core.SetProperty("rank", "gold"); // what the game says while off is kept, unsent
            Frames(core, 60);
            core.SetEnabled(true);
            Assert.AreEqual("on", Saved);
            Assert.IsTrue(core.Enabled);
            Assert.AreNotEqual(first, core.SessionId, "a new session");
            Frames(core, 400);
            core.Flush();

            var second = core.SessionId;
            var mine = Sent().Where(x => x.sid == second).Select(x => x.e).ToList();
            Assert.AreEqual("session_start", mine[0]["type"], "its own session_start comes first");
            var props = (Dictionary<string, object>)mine[0]["props"];
            Assert.AreEqual("ranked", props["mode"]);
            Assert.AreEqual("gold", props["rank"], "with the properties set while off");
            var group = mine.Single(e => (string)e["type"] == "group");
            Assert.AreEqual(GameWords.HashGroupId("zoomies", "lobby_12345678"), group["id"], "the match is said again");
            CollectionAssert.DoesNotContain(mine.Select(e => (string)e["type"]).ToList(), "load", "a load isn't sent again");
            var windows = mine.Where(e => (string)e["type"] == "frame_window").ToList();
            Assert.IsNotEmpty(windows, "measured from the next frame");
            Assert.IsTrue(windows.All(w => (string)w["level"] == "level-2" && (string)w["zone"] == "north_shore"), "the level and zone stay");
            var batches = transport.Sent.Select(b => (Dictionary<string, object>)Json.Parse(b)).Where(b => (string)b["session_id"] == second).ToList();
            Assert.IsTrue(batches.All(b => (string)b["player_id"] == pid), "the same player");
            Assert.AreEqual(1, Types(first).Count(t => t == "session_start"));
            CollectionAssert.DoesNotContain(Types(first), "session_end");
        }

        [Test]
        public void TheAttemptGoingAtOffHasNoOutcomeAfterOn()
        {
            var core = NewCore();
            core.Init(Options());
            core.LevelStart("level-2");
            Frames(core, 60);
            core.Flush();
            core.SetEnabled(false);
            core.SetEnabled(true);
            Frames(core, 60);
            core.LevelComplete("level-2", 10);
            core.LevelFail();
            core.LevelAbandon("level-2");
            core.Track("after", null);
            core.LevelStart("level-2"); // the next attempt has its start, and so its outcome
            core.LevelFail("level-2", "fell");
            core.LevelStart("level-3");
            core.Flush();
            core.SetEnabled(false);
            core.LevelStart("level-4"); // started while off: its start never went, so neither does its outcome
            core.SetEnabled(true);
            core.LevelComplete("level-4", 3);
            core.Shutdown("quit");
            var ends = Sent().Where(x => (string)x.e["type"] == "level_start" || (string)x.e["type"] == "level_complete" || (string)x.e["type"] == "level_fail" || (string)x.e["type"] == "level_abandon" || (string)x.e["type"] == "session_end")
                .Select(x => $"{x.e["type"]} {x.e["level"]}").ToList();
            CollectionAssert.AreEqual(new[] { "level_start level-2", "level_start level-2", "level_fail level-2", "level_start level-3", "session_end level-4" }, ends, "no outcome for level-2 or level-3 at off, nor level-4, and no abandon on quitting");
            Assert.AreEqual("level-2", Sent().Single(x => (string)x.e["type"] == "custom").e["level"], "events carry the level");
        }

        [Test]
        public void ACallThatChangesNothingDoesNothing()
        {
            var core = NewCore();
            core.Init(Options());
            Frames(core, 60);
            var session = core.SessionId;
            var queued = core.Queued.Count;
            core.SetEnabled(true); // the game passes its saved setting as it starts
            Assert.AreEqual(session, core.SessionId);
            Assert.AreEqual(queued, core.Queued.Count);
            Assert.AreEqual("on", Saved, "saved once the game has called it");
            core.SetEnabled(false);
            Frames(core, 60);
            core.SetEnabled(false);
            Assert.IsTrue(core.SwitchedOff);
            core.SetEnabled(true);
            var back = core.SessionId;
            core.SetEnabled(true);
            Assert.AreEqual(back, core.SessionId, "on while on starts nothing");
            core.Flush();
            Assert.AreEqual(1, Types(back).Count(t => t == "session_start"));
        }

        [Test]
        public void NothingIsSavedUntilTheGameCallsIt()
        {
            var core = NewCore();
            core.LoadChoice();
            core.Init(Options());
            Frames(core, 60);
            core.Flush();
            Assert.IsNull(Saved);
            Assert.IsTrue(core.Enabled);
        }

        [Test]
        public void AChoiceSavedOffIsReadBeforeAnythingIsKept()
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(ChoiceFile, "off");
            LeaveAnOutbox();
            var core = NewCore();
            core.LoadChoice(); // the automatic start, before the first scene loads
            Assert.IsFalse(File.Exists(OutboxFile), "the last launch's outbox is deleted unread, a crash and a bug report in it");
            core.OnSceneActive("Level1", 1);
            Frames(core, 120);
            core.ReportError("exception", "NullReferenceException: early", "Boot.Awake () (at Assets/Boot.cs:3)");
            core.Track("menu_opened", null);
            core.OnInput("Space");
            Assert.IsEmpty(core.Queued, "no early frames, errors or events are kept");
            core.Init(Options());
            Assert.IsFalse(core.Enabled);
            Frames(core, 400);
            core.Flush();
            core.Shutdown("quit");
            Assert.IsEmpty(transport.Sent);
            Assert.IsEmpty(transport.SentNow);
            Assert.IsEmpty(transport.Gets, "not even a health check");
            Assert.IsFalse(File.Exists(Path.Combine(dir, "launched")), "nothing else is written");

            // Turned on later in the same launch: it sends from then on, with no load (its first frame went by unmeasured).
            core = NewCore();
            core.LoadChoice();
            Frames(core, 30);
            core.Init(Options());
            core.SetEnabled(true);
            Frames(core, 60);
            core.Flush();
            Assert.AreEqual("session_start", Types()[0]);
            CollectionAssert.DoesNotContain(Types(), "load");
            Assert.AreEqual(1, transport.Gets.Count, "the health check goes once it is on");
        }

        [Test]
        public void AtInitAChoiceSavedOffDeletesTheOutboxUnread()
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(ChoiceFile, "off\n");
            LeaveAnOutbox();
            var core = NewCore(); // no automatic start (GLITCHLESS_DISABLE): Init is the first thing
            Frames(core, 30);
            core.Init(Options());
            Assert.IsFalse(File.Exists(OutboxFile));
            Assert.IsEmpty(core.Queued, "what was kept before Init knew is dropped");
            core.Flush();
            Assert.IsEmpty(transport.Sent);
            Assert.IsEmpty(transport.Gets);
        }

        [Test]
        public void TurnedOnBeforeTheFirstFrameTheLoadStillGoes()
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(ChoiceFile, "off");
            var core = NewCore();
            core.LoadChoice();
            core.SetEnabled(true); // the game's own setting, in its first Awake
            core.Init(Options());
            Frames(core, 60);
            core.Flush();
            CollectionAssert.Contains(Types(), "load");
        }

        [Test]
        public void OptInStartsOffUntilThePlayerSaysYes()
        {
            var core = NewCore();
            core.LoadChoice();
            Frames(core, 60); // the automatic start can't know about OptIn before Init: it keeps these
            core.Track("boot", null);
            Assert.IsNotEmpty(core.Queued);
            var o = Options();
            o.OptIn = true;
            core.Init(o);
            Assert.IsTrue(core.SwitchedOff);
            Assert.IsFalse(core.Enabled);
            Assert.IsEmpty(core.Queued, "Init drops what the automatic start kept");
            Frames(core, 400);
            core.Flush();
            Assert.IsEmpty(transport.Sent);
            Assert.IsEmpty(transport.Gets);
            Assert.IsNull(Saved, "no choice is saved until the player makes one");

            core.SetEnabled(true); // the player said yes
            Assert.AreEqual("on", Saved);
            Frames(core, 60);
            core.Flush();
            Assert.AreEqual("session_start", Types()[0]);

            // The next launch: the saved choice wins over OptIn.
            transport = new FakeTransport();
            var next = NewCore();
            next.LoadChoice();
            next.Init(o);
            Assert.IsTrue(next.Enabled);
            Frames(next, 60);
            next.Flush();
            Assert.AreEqual("session_start", Types()[0]);
            CollectionAssert.Contains(Types(), "load");
        }

        [Test]
        public void ASavedChoiceWinsOverOptIn()
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(ChoiceFile, "off");
            var core = NewCore();
            core.Init(Options());
            Assert.IsTrue(core.SwitchedOff);
            File.WriteAllText(ChoiceFile, "on");
            var o = Options();
            o.OptIn = true;
            var asks = NewCore();
            asks.Init(o);
            Assert.IsTrue(asks.Enabled);
        }

        [Test]
        public void ABuildTurnedOffStaysOffWhateverThePlayerChooses()
        {
            var flag = NewCore("--glitchless-off");
            flag.Init(Options());
            flag.SetEnabled(true);
            Assert.IsFalse(flag.Enabled, "--glitchless-off holds");
            Assert.AreEqual("on", Saved, "the choice is still saved");
            Frames(flag, 400);
            flag.Flush();
            var o = Options();
            o.Enabled = false;
            var option = NewCore();
            option.Init(o);
            option.SetEnabled(false);
            option.SetEnabled(true);
            Assert.IsFalse(option.Enabled, "Options.Enabled = false holds");
            Frames(option, 400);
            option.Flush();
            option.Shutdown("quit");
            Assert.IsEmpty(transport.Sent);
            Assert.IsEmpty(transport.Gets);
            var none = NewCore();
            none.SetEnabled(true);
            Assert.IsFalse(none.Enabled, "false before Init");
        }

        [Test]
        public void ABugReportAnswersOff()
        {
            var core = NewCore();
            core.Init(Options());
            Frames(core, 60);
            (bool, string)? result = null;
            transport.Hold = true;
            core.SendBugReport(core.BugSnapshot(), "the dog fell through the floor", null, (sent, reason) => result = (sent, reason));
            core.SetEnabled(false); // while it is on its way
            transport.Pending.Last()(503);
            Assert.AreEqual((false, "off"), result, "it doesn't wait for a later batch");
            Assert.IsFalse(File.Exists(OutboxFile));
            var count = transport.Sent.Count;
            core.SendBugReport(core.BugSnapshot(), "and again", null, (sent, reason) => result = (sent, reason));
            Assert.AreEqual((false, "off"), result);
            Assert.AreEqual(count, transport.Sent.Count);
        }

        [Test]
        public void MeasureSaysGlitchlessIsOff()
        {
            var core = NewCore();
            core.Init(Options());
            Frames(core, 60);
            Dictionary<string, object> result = null;
            core.Measure(2, r => result = r);
            Frames(core, 30);
            core.SetEnabled(false); // a measure going ends at once
            StringAssert.Contains("Glitchless is off", (string)result["error"]);
            result = null;
            core.Measure(2, r => result = r);
            StringAssert.Contains("Glitchless is off", (string)result["error"], "no frames to measure");
            Assert.IsFalse(result.ContainsKey("frames"));
        }

        [Test]
        public void OptInLeavesAServerOn()
        {
            var core = NewCore();
            core.IsBatchMode = true;
            var o = Options();
            o.Role = GlitchlessRole.Server;
            o.OptIn = true; // shared with the game's player builds: a server has no player to ask
            core.Init(o);
            Assert.IsTrue(core.Enabled);
            Assert.IsFalse(core.SwitchedOff);
            Assert.IsNull(Saved, "and nothing is saved for it");
        }

        [Test]
        public void AServerFollowsTheSameSwitch()
        {
            var core = NewCore();
            core.IsBatchMode = true;
            var o = Options();
            o.Role = GlitchlessRole.Server;
            core.Init(o);
            Frames(core, 120);
            core.Flush();
            var first = core.SessionId;
            transport.Status = 503;
            Frames(core, 120);
            core.Flush();
            core.SetEnabled(false);
            Assert.AreEqual("off", Saved);
            Assert.IsFalse(File.Exists(OutboxFile), "a server's outbox goes too");
            var count = transport.Sent.Count;
            transport.Status = 202;
            Frames(core, 600);
            core.Flush();
            Assert.AreEqual(count, transport.Sent.Count);
            core.SetEnabled(true);
            Frames(core, 400);
            core.Shutdown("quit");
            var second = core.SessionId;
            Assert.AreNotEqual(first, second);
            var start = Sent().First(x => x.sid == second).e;
            Assert.AreEqual("session_start", start["type"]);
            Assert.IsTrue(start.ContainsKey("server"));
            CollectionAssert.Contains(Types(second), "server_window");
            CollectionAssert.DoesNotContain(Types(first), "session_end");
        }

        [Test]
        public void OnTheWebTheChoiceIsKeptWhereThePlayerIdIs()
        {
            var store = new Dictionary<string, string>();
            var ids = new IdStorage { Read = n => store.TryGetValue(n, out var v) ? v : null, Write = (n, v) => store[n] = v, Delete = n => store.Remove(n) };
            var core = NewCore();
            core.SaveDir = null;
            core.IsWeb = true;
            core.Ids = ids;
            core.Init(Options());
            core.SetEnabled(false);
            Assert.AreEqual("off", store["enabled"]);
            var next = NewCore();
            next.SaveDir = null;
            next.IsWeb = true;
            next.Ids = ids;
            next.LoadChoice();
            Assert.IsTrue(next.SwitchedOff);
            Assert.IsFalse(Directory.Exists(dir), "nothing written to a folder");
        }
    }
}

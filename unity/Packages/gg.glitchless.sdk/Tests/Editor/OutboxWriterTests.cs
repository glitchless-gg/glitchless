using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using NUnit.Framework;

namespace GlitchlessSdk.Tests
{
    /// <summary>
    /// The outbox file is written on a thread-pool thread in a game (SaveInBackground, which the runner sets), so no
    /// frame waits on the disk: one writer at a time, the newest file waiting for it; quitting and the background write
    /// at once; and neither a write at once nor the off switch can be undone by older parts a writer still holds.
    /// BeforeWrite holds the writer, so each test sees a write on its way.
    /// </summary>
    public class OutboxWriterTests
    {
        double now;
        FakeTransport transport;
        string dir;
        ManualResetEventSlim gate;
        SemaphoreSlim entered;

        [SetUp]
        public void SetUp()
        {
            now = 1000;
            transport = new FakeTransport { Status = 0 }; // offline: every batch stays in the outbox
            dir = Path.Combine(Path.GetTempPath(), "glitchless-writer-" + Guid.NewGuid().ToString("N"));
            gate = new ManualResetEventSlim(false);
            entered = new SemaphoreSlim(0);
        }

        [TearDown]
        public void TearDown()
        {
            gate.Set();
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }

        GlitchlessCore NewCore() => new GlitchlessCore
        {
            Transport = transport,
            SaveDir = dir,
            SaveInBackground = true,
            Clock = () => now,
            UnixNow = () => 1_761_000_000_000L + (long)now,
            Args = () => new string[0],
            Log = _ => { },
            Device = full => new Dictionary<string, object> { ["browser"] = "Unity", ["os"] = "Linux" },
            AppVersion = "1.2.3",
            IsDebugBuild = true,
        };

        static GlitchlessOptions Options() => new GlitchlessOptions { Service = "fetch", Intake = "http://localhost:7777/" };

        string OutboxFile => Path.Combine(dir, "outbox.json");

        // The next write waits on the writer's thread until the test opens the gate.
        void HoldTheWriter(GlitchlessCore core) => core.BeforeWrite = () =>
        {
            entered.Release();
            gate.Wait(10000);
        };

        void WriterHeld() => Assert.IsTrue(entered.Wait(10000), "the writer started");

        static List<Dictionary<string, object>> SavedBatches(string text) =>
            ((List<object>)((Dictionary<string, object>)Json.Parse(text))["batches"]).Cast<Dictionary<string, object>>().ToList();

        [Test]
        public void AFlushHandsTheFileToTheWriterAndTheNewestWaits()
        {
            var core = NewCore();
            core.Init(Options());
            HoldTheWriter(core);
            core.Track("pickup", new Dictionary<string, object> { ["item"] = "coin" });
            core.Flush();
            WriterHeld();
            Assert.IsTrue(core.SaveOnItsWay, "a flush hands the write to the writer");
            Assert.IsFalse(File.Exists(OutboxFile), "and returns before the file is written");
            core.Track("pickup", new Dictionary<string, object> { ["item"] = "gem" });
            core.Flush();
            StringAssert.Contains("gem", core.SaveWaiting, "a save while one is on its way waits, as the newest file");
            core.BeforeWrite = null;
            gate.Set();
            core.WaitForSave();
            var text = File.ReadAllText(OutboxFile);
            StringAssert.Contains("coin", text);
            StringAssert.Contains("gem", text, "the writer writes the newest file next");
            var batches = SavedBatches(text);
            Assert.AreEqual(core.OutboxEvents, batches.Sum(b => ((List<object>)b["events"]).Count), "every batch saved with all its events");
            Assert.IsTrue(batches.All(b => ((string)b["bid"]).StartsWith("b_")), "each with its own batch ID");
            Assert.IsFalse(File.Exists(OutboxFile + ".tmp"), "the temporary file was renamed");
        }

        [Test]
        public void TurningItOffDropsAWriteOnItsWay()
        {
            var core = NewCore();
            core.Init(Options());
            core.Track("pickup", new Dictionary<string, object> { ["item"] = "coin" });
            core.Flush();
            core.WaitForSave();
            Assert.IsTrue(File.Exists(OutboxFile));
            HoldTheWriter(core);
            core.Track("pickup", new Dictionary<string, object> { ["item"] = "key" });
            core.Flush();
            WriterHeld();
            core.SetEnabled(false);
            Assert.IsFalse(File.Exists(OutboxFile), "turning it off removes the file at once");
            gate.Set();
            core.WaitForSave();
            Assert.IsFalse(File.Exists(OutboxFile), "and the write that was on its way doesn't put it back");
            Assert.IsFalse(File.Exists(OutboxFile + ".tmp"));
        }

        [Test]
        public void QuittingWritesAtOnceAndAnOlderWriteCannotUndoIt()
        {
            var core = NewCore();
            core.Init(Options());
            HoldTheWriter(core);
            core.Track("pickup", new Dictionary<string, object> { ["item"] = "coin" });
            core.Flush();
            WriterHeld(); // holding a file without the session's end
            core.Shutdown("quit");
            var text = File.ReadAllText(OutboxFile);
            StringAssert.Contains("\"session_end\"", text, "quitting writes the outbox at once, before it returns");
            gate.Set();
            core.WaitForSave();
            Assert.AreEqual(text, File.ReadAllText(OutboxFile), "the older file the writer held is dropped");
        }

        [Test]
        public void TheBackgroundWritesAtOnce()
        {
            var core = NewCore();
            core.Init(Options());
            var onWriter = false;
            core.BeforeWrite = () => onWriter = true;
            core.Track("pickup", new Dictionary<string, object> { ["item"] = "coin" });
            core.OnBackground();
            Assert.IsFalse(core.SaveOnItsWay, "no writer: the OS may stop the game before one finishes");
            StringAssert.Contains("\"reason\":\"background\"", File.ReadAllText(OutboxFile), "written before OnBackground returns");
            Assert.IsFalse(onWriter);
            core.OnForeground();
            core.Track("pickup", new Dictionary<string, object> { ["item"] = "gem" });
            core.Flush();
            core.WaitForSave();
            Assert.IsTrue(onWriter, "back in the foreground, saves go to the writer again");
            StringAssert.Contains("gem", File.ReadAllText(OutboxFile));
        }
    }
}

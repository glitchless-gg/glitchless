using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

namespace GlitchlessSdk.Tests
{
    /// <summary>The runner in Play mode: it starts itself, times real frames, hears Unity's log and follows scenes.</summary>
    public class RunnerTests
    {
        sealed class Thrower : MonoBehaviour
        {
            public int Left = 3;

            void Update()
            {
                if (Left-- <= 0) return;
                Dictionary<string, int> powerups = new Dictionary<string, int>();
                Debug.Log(powerups["frisbee"]); // KeyNotFoundException, uncaught
            }
        }

        static IEnumerable<Dictionary<string, object>> Queued(string type) => GlitchlessRunner.Core.Queued.Where(e => (string)e["type"] == type);

        [UnityTest]
        public IEnumerator StartsBeforeTheFirstSceneAndTimesFrames()
        {
            Assert.IsNotNull(GlitchlessRunner.Core, "started by itself");
            Assert.IsNotNull(GameObject.Find("Glitchless"));
            var core = GlitchlessRunner.Core;
            var start = core.FrameCount;
            for (var i = 0; i < 20; i++) yield return null;
            Assert.GreaterOrEqual(core.FrameCount - start, 19);
            core.Flush(); // not inited: closes the window, keeps the events
            var fw = Queued("frame_window").Last();
            Assert.Greater((int)fw["frames"], 0);
            Assert.IsNotNull(fw["process_ms"], "the player loop markers ran");
            Assert.IsNotNull(fw["render_ms"]);
            Assert.IsNotNull(fw["draw_calls"], "profiler counters are there in the Editor");
        }

        [UnityTest]
        public IEnumerator UncaughtExceptionsAreReported()
        {
            LogAssert.ignoreFailingMessages = true;
            var before = GlitchlessRunner.Core.Stats.Errors;
            var go = new GameObject("thrower", typeof(Thrower));
            for (var i = 0; i < 6; i++) yield return null;
            UnityEngine.Object.Destroy(go);
            LogAssert.ignoreFailingMessages = false;
            Assert.AreEqual(3, GlitchlessRunner.Core.Stats.Errors - before);
            var e = Queued("error").Last();
            Assert.AreEqual("exception", e["kind"]);
            StringAssert.StartsWith("KeyNotFoundException", (string)e["message"]);
            StringAssert.EndsWith("Thrower.Update", (string)e["fn"]);
            Assert.AreEqual("RunnerTests.cs", e["source"]);
        }

        [UnityTest]
        public IEnumerator ScenesBecomeLevels()
        {
            var name = "level-7-" + Guid.NewGuid().ToString("N").Substring(0, 4);
            var level = SceneManager.CreateScene(name);
            SceneManager.SetActiveScene(level);
            yield return null;
            Assert.AreEqual(name, GlitchlessRunner.Core.Level);
            var menu = SceneManager.CreateScene("PauseMenu");
            SceneManager.SetActiveScene(menu);
            yield return null;
            Assert.AreEqual(name, GlitchlessRunner.Core.Level, "a menu made active doesn't end the level");
            yield return SceneManager.UnloadSceneAsync(level);
            Assert.IsNull(GlitchlessRunner.Core.Level, "the level ends when its scene unloads");
            yield return SceneManager.UnloadSceneAsync(menu);
            Assert.IsTrue(Queued("level_start").Any(e => (string)e["level"] == name)); // an unloaded Scene has no name, so keep it
        }

        [UnityTest]
        public IEnumerator TheBugReportFormPausesTheGameWhileItIsOpen()
        {
            int opened = 0, closed = 0;
            GlitchlessRunner.Core.Options.BugReports = new BugReportOptions { OnOpen = () => opened++, OnClose = () => closed++ };
            try
            {
                Time.timeScale = 1;
                Glitchless.OpenBugReport();
                for (var i = 0; i < 3; i++) yield return null; // the screenshot is taken at the end of the frame
                Assert.IsTrue(Glitchless.IsBugReportOpen);
                Assert.AreEqual(0, Time.timeScale, "the game is paused");
                Assert.AreEqual(1, opened);
                GameObject.Find("Glitchless").GetComponent<BugReportForm>().Close();
                Assert.IsFalse(Glitchless.IsBugReportOpen);
                Assert.AreEqual(1, Time.timeScale, "and runs again");
                Assert.AreEqual(1, closed);
            }
            finally
            {
                GlitchlessRunner.Core.Options.BugReports = null;
                Time.timeScale = 1;
            }
        }

        [UnityTest]
        public IEnumerator TheFormTakesTypingSendsOnCtrlEnterAndClosesOnEsc()
        {
            var go = new GameObject("form test");
            var form = go.AddComponent<BugReportForm>();
            form.Core = GlitchlessRunner.Core;
            form.Options = new BugReportOptions { PauseGame = false, Screenshot = false };
            try
            {
                form.Open();
                yield return null;
                Assert.AreEqual("Form", form.Status);
                Event Char(char c) => new Event { type = EventType.KeyDown, character = c };
                foreach (var c in "stuck!") form.OnKey(Char(c));
                form.OnKey(Event.KeyboardEvent("backspace"));
                form.OnKey(new Event { type = EventType.KeyDown, keyCode = KeyCode.Return, character = '\n' });
                form.OnKey(Char('x'));
                form.OnKey(new Event { type = EventType.KeyDown, keyCode = KeyCode.F8 }); // the runner's hotkey: never typed
                form.OnKey(Char('\t'));
                Assert.AreEqual("stuck\nx", form.Note);
                form.OnKey(Event.KeyboardEvent("^return"));
                Assert.AreEqual("Offline", form.Status, "Ctrl+Enter sent it; without Init nothing goes");
                Assert.IsTrue(form.IsOpen, "the result shows for a moment");
                form.OnKey(Event.KeyboardEvent("escape"));
                Assert.IsFalse(form.IsOpen);
            }
            finally
            {
                UnityEngine.Object.Destroy(go);
            }
        }

        [UnityTest]
        public IEnumerator ABugReportBeforeInitSaysOffline()
        {
            (bool sent, string reason)? result = null;
            Glitchless.ReportBug("before init", done: (sent, reason) => result = (sent, reason));
            for (var i = 0; i < 3 && result == null; i++) yield return null;
            Assert.AreEqual((false, "offline"), result);
        }

        [UnityTest]
        public IEnumerator TurnedOffTheFormStaysShutAndAReportAnswersOff()
        {
            // A folder of its own: persistentDataPath is the one the e2e test's player (and other runs) use.
            var core = GlitchlessRunner.Core;
            var saveDir = core.SaveDir;
            core.SaveDir = Path.Combine(Path.GetTempPath(), "glitchless-runner-" + Guid.NewGuid().ToString("N"));
            var file = Path.Combine(core.SaveDir, "enabled");
            try
            {
                Glitchless.SetEnabled(false); // the player's "Share performance data" toggle
                Assert.IsFalse(Glitchless.Enabled);
                Assert.AreEqual("off", File.ReadAllText(file), "saved where the next launch reads it first");
                Glitchless.OpenBugReport();
                yield return null;
                Assert.IsFalse(Glitchless.IsBugReportOpen, "the form doesn't open");
                (bool sent, string reason)? result = null;
                Glitchless.ReportBug("while off", done: (sent, reason) => result = (sent, reason));
                Assert.AreEqual((false, "off"), result, "answered at once, with no screenshot taken");
                Dictionary<string, object> measured = null;
                Glitchless.Measure(0.2f, r => measured = r);
                StringAssert.Contains("Glitchless is off", (string)measured["error"]);
                var frames = core.FrameCount;
                for (var i = 0; i < 5; i++) yield return null;
                core.Flush();
                Assert.Greater(core.FrameCount, frames);
                Assert.IsEmpty(core.Queued, "frames go by unmeasured");
            }
            finally
            {
                Glitchless.SetEnabled(true);
                Directory.Delete(core.SaveDir, true);
                core.SaveDir = saveDir;
            }
        }

        [UnityTest]
        public IEnumerator MeasureCountsRealFrames()
        {
            Dictionary<string, object> result = null;
            Glitchless.Measure(0.5f, r => result = r);
            var t = Time.realtimeSinceStartup;
            while (result == null && Time.realtimeSinceStartup - t < 5) yield return null;
            Assert.IsNotNull(result);
            Assert.Greater((int)result["frames"], 0);
            Assert.IsNotNull(result["update_cpu_ms"]);
            StringAssert.Contains("\"frame_ms\"", Json.Serialize(result));
        }
    }
}

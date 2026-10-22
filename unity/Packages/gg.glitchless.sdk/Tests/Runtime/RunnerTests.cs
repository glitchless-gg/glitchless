using System;
using System.Collections;
using System.Collections.Generic;
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

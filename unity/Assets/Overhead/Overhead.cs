using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using UnityEngine;

namespace GlitchlessSdk.Overhead
{
    /// <summary>
    /// What Glitchless costs a Unity game's main thread, measured in a player build, for the package README's "What it
    /// costs". It isn't part of the package: unity/test/overhead.mjs builds a player with only this in it (an empty
    /// scene, the GLITCHLESS_OVERHEAD define this assembly needs) and runs it. It measures:
    ///   - the runner's own work each frame (its player loop markers, accounting the frame with the profiler counters
    ///     and the core's sketches, its Update) called in a loop, so the SDK's time only, with nothing else in the frame;
    ///   - closing the frame window, every 5 seconds;
    ///   - a flush, every 15 seconds (the events become a batch, saved, and its send started), and the send's answer;
    ///   - the offline worst case: a flush and a save with the outbox near its 4,000-event cap, and the same save
    ///     written at once, as on quitting (what the writer's thread-pool thread spends on it otherwise).
    /// Nothing leaves the machine: a stand-in transport holds every send. The outbox goes to a folder of its own.
    /// </summary>
    sealed class Overhead : MonoBehaviour
    {
        const int Frames = 50000;

        /// <summary>Keeps every send waiting until Answer, as a request on its way does.</summary>
        sealed class Held : ITransport
        {
            readonly List<Action<long>> pending = new List<Action<long>>();
            public void Send(string url, byte[] body, string contentType, Action<long> done) => pending.Add(done);
            public void Get(string url, Action<long, string> done) => done(0, null); // offline: counts wait, which costs nothing here
            public long SendNow(string url, byte[] body, string contentType, int timeoutMs) => 0;
            public void Abort() => pending.Clear();

            public void Answer(long status)
            {
                var going = pending.ToArray();
                pending.Clear();
                foreach (var done in going) done(status);
            }
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Begin() => new GameObject("Overhead").AddComponent<Overhead>();

        static double Us(long ticks) => ticks * 1e6 / Stopwatch.Frequency;

        IEnumerator Start()
        {
            for (var i = 0; i < 10; i++) yield return null; // the runner is up and has timed a few real frames
            var core = GlitchlessRunner.Core;
            var runner = FindAnyObjectByType<GlitchlessRunner>();
            var update = (Action)Delegate.CreateDelegate(typeof(Action), runner, typeof(GlitchlessRunner).GetMethod("Update", BindingFlags.Instance | BindingFlags.NonPublic));
            var dir = Path.Combine(Path.GetTempPath(), "glitchless-overhead-" + Process.GetCurrentProcess().Id);
            core.SaveDir = dir;
            var held = new Held();
            core.Transport = held;
            core.Init(new GlitchlessOptions
            {
                Service = "overhead",
                Version = "1.0.0",
                Env = "prod",
                Intake = "http://127.0.0.1:9",
                ClientToken = "gl_pub_overhead",
                WindowSeconds = 1e6f, // windows and flushes by hand, below
                FlushIntervalSeconds = 1e6f,
            });
            core.LevelStart("level_1");
            core.Flush(); // session_start and load go, and nextFlushAt moves out of the way
            held.Answer(202);

            void Frame()
            {
                GlitchlessRunner.FrameStart(); // accounts the last frame: counters, sketches, timers
                GlitchlessRunner.FixedStart();
                GlitchlessRunner.FixedEnd();
                GlitchlessRunner.UpdateStart();
                update();
                GlitchlessRunner.UpdateEnd();
                GlitchlessRunner.RenderStart();
                GlitchlessRunner.RenderEnd();
                runner.accountedFrame = -1; // so the next call accounts again, as a new frame would
            }

            var sw = Stopwatch.StartNew();
            for (var i = 0; i < Frames; i++) { }
            var loop = sw.ElapsedTicks;
            var best = double.MaxValue;
            for (var run = 0; run < 5; run++)
            {
                sw.Restart();
                for (var i = 0; i < Frames; i++) Frame();
                best = Math.Min(best, Us(sw.ElapsedTicks - loop) / Frames);
                core.CloseWindow(true); // a window as long as a real one, not 50,000 frames
                yield return null;
            }

            // Each timing, in microseconds, marked when Unity's garbage collector ran in it: a collection finished, or the
            // heap shrank (the incremental collector does some of its work inside allocations, without finishing one).
            var gcBefore = 0;
            long heapBefore = 0;
            void Begin()
            {
                gcBefore = GC.CollectionCount(0);
                heapBefore = GC.GetTotalMemory(false);
                sw.Restart();
            }
            string End()
            {
                var us = Us(sw.ElapsedTicks);
                var gc = GC.CollectionCount(0) != gcBefore || GC.GetTotalMemory(false) < heapBefore;
                return us.ToString("0", CultureInfo.InvariantCulture) + (gc ? " (gc)" : "");
            }

            var closes = new List<string>();
            var flushes = new List<string>();
            var answers = new List<string>();
            for (var k = 0; k < 8; k++)
            {
                for (var i = 0; i < 300; i++) Frame();
                core.Track("pickup", new Dictionary<string, object> { ["item"] = "coin" });
                Begin();
                core.CloseWindow(true);
                closes.Add(End());
                Begin();
                core.Flush(); // a batch, saved, and its send started
                flushes.Add(End());
                Begin();
                held.Answer(202); // sent: it leaves the outbox, saved again
                answers.Add(End());
                yield return null;
            }

            // Offline: nothing is answered, so batches pile up to the cap, as on a phone with no signal.
            var loops = 0;
            while (core.OutboxEvents < 3900)
            {
                for (var i = 0; i < 300; i++) Frame();
                loops++;
                for (var j = 0; j < 19; j++) // a name a loop, under the 20 a second that would warn to use Count()
                    core.Track($"pickup_{loops}", new Dictionary<string, object> { ["item"] = "coin", ["n"] = j });
                core.Flush();
                if (loops % 10 == 0) yield return null;
            }
            var offlineFlushes = new List<string>();
            for (var k = 0; k < 5; k++)
            {
                for (var i = 0; i < 300; i++) Frame();
                for (var j = 0; j < 19; j++) core.Track($"pickup_more_{k}", new Dictionary<string, object> { ["item"] = "coin", ["n"] = j });
                core.WaitForSave();
                Begin();
                core.Flush();
                offlineFlushes.Add(End());
                yield return null;
            }
            var saves = new List<string>();
            for (var k = 0; k < 8; k++)
            {
                core.WaitForSave();
                Begin();
                core.SaveOutbox();
                saves.Add(End());
                yield return null;
            }
            // The same save written at once, as on quitting: what the writer's thread spends on it otherwise.
            core.WaitForSave();
            core.SaveInBackground = false;
            var writes = new List<string>();
            for (var k = 0; k < 5; k++)
            {
                Begin();
                core.SaveOutbox();
                writes.Add(End());
                yield return null;
            }
            core.SaveInBackground = true;

            // A control with nothing of Glitchless's in it: a few dozen microseconds of strings and lists, timed as the rest
            // are. A slow one here is the engine or the OS, not the SDK.
            var control = new List<double>();
            for (var k = 0; k < 400; k++)
            {
                sw.Restart();
                var sb = new System.Text.StringBuilder();
                var parts = new List<string>();
                for (var j = 0; j < 60; j++)
                {
                    parts.Add(new string((char)('a' + j % 26), 120));
                    sb.Append(parts[j]).Append(',');
                }
                if (sb.ToString().Length == 0) UnityEngine.Debug.Log("never");
                control.Add(Us(sw.ElapsedTicks));
                if (k % 20 == 0) yield return null;
            }
            control.Sort();
            var slow = control.FindAll(x => x > 1000);
            var file = Path.Combine(dir, "outbox.json");
            var bytes = File.Exists(file) ? new FileInfo(file).Length : 0;

            string List(List<string> xs) => "[" + string.Join(", ", xs) + "]";
            var lines = new[]
            {
                $"Unity {Application.unityVersion}, {(UnityEngine.Debug.isDebugBuild ? "development" : "release")} build, {SystemInfo.processorType}",
                $"each frame: {best.ToString("0.0", CultureInfo.InvariantCulture)} us",
                $"window close (every 5 s): {List(closes)} us",
                $"flush and its send started (every 15 s): {List(flushes)} us",
                $"the send's answer: {List(answers)} us",
                $"flush with {core.OutboxEvents} events waiting offline: {List(offlineFlushes)} us",
                $"save with {core.OutboxEvents} events waiting offline ({bytes / 1024} KB): {List(saves)} us",
                $"the same save written at once, as on quitting (the writer thread's work otherwise): {List(writes)} us",
                $"control, nothing of Glitchless's (400 times): median {control[200]:0} us, {slow.Count} over 1 ms{(slow.Count > 0 ? $" (the slowest {control[399] / 1000:0.0} ms)" : "")}",
            };
            foreach (var l in lines)
            {
                Console.WriteLine("[overhead] " + l);
                UnityEngine.Debug.Log("[overhead] " + l);
            }
            var outPath = core.FlagValue("--glitchless-out");
            if (!string.IsNullOrEmpty(outPath)) File.WriteAllText(outPath, string.Join("\n", lines) + "\n");
            core.SetEnabled(false); // nothing saved for a next launch, and the outbox folder goes
            try
            {
                Directory.Delete(dir, true);
            }
            catch (Exception)
            {
            }
            Application.Quit();
        }
    }
}

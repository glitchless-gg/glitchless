using System;
using System.Collections.Generic;
using UnityEngine;

namespace GlitchlessSdk
{
    /// <summary>
    /// Glitchless for Unity: frame times and stutter with their likely causes, errors, levels, deaths and
    /// where players quit, sent to a Glitchless server in the same shape as the browser and Godot SDKs.
    ///
    ///   using GlitchlessSdk;
    ///   Glitchless.Init(new GlitchlessOptions { Service = "my-game", Intake = "https://api.glitchless.gg", ClientToken = "gl_pub_…" });
    ///   Glitchless.LevelAbandon(); // the player went to the menu or restarted mid-level: not a fail
    ///   Glitchless.Death(player.position, "fell");
    ///   Glitchless.Track("powerup", "magnet");
    ///   Glitchless.SetContext("enemies", enemies.Count);
    ///   Glitchless.ReportBug(note); // or BugReports = new BugReportOptions() in the options: F8 opens a form
    ///
    /// Scenes are levels on their own (see GlitchlessOptions.SceneLevels). Every call is safe before Init,
    /// and does nothing outside Play mode.
    /// </summary>
    public static class Glitchless
    {
        public const string SdkVersion = GlitchlessCore.SdkVersion;

        static GlitchlessCore Core => GlitchlessRunner.EnsureRunning();

        /// <summary>Says who the game is and where to send. Call it once, as early as you can (the Awake of your first scene).</summary>
        public static void Init(GlitchlessOptions options) => Core?.Init(options);

        public static void Init(string service, string intake, string clientToken = "gl_pub_dev") =>
            Init(new GlitchlessOptions { Service = service, Intake = intake, ClientToken = clientToken });

        /// <summary>A level starts (a restart counts too). Calling this turns automatic scene levels off.</summary>
        public static void LevelStart(string level) => Core?.LevelStart(level);

        public static void LevelComplete(string level = null, double? score = null, double? durationSeconds = null) => Core?.LevelComplete(level, score, durationSeconds);

        /// <summary>The player lost the level: died, ran out of lives or time. `cause` is a short word: "fell", "timeout".
        /// Leaving the level is LevelAbandon, never a fail.</summary>
        public static void LevelFail(string level = null, string cause = null) => Core?.LevelFail(level, cause);

        /// <summary>The player left the level before it ended: went to the menu, restarted it. The funnel counts abandons
        /// apart from fails, and they are never rage quits. Going to the background or quitting mid-level sends one by
        /// itself, and a LevelFail or LevelAbandon for that level after the session has ended (from an OnDestroy as the
        /// game closes, say) is dropped.</summary>
        public static void LevelAbandon(string level = null) => Core?.LevelAbandon(level);

        /// <summary>A death at a place in the game world. The place is sent only when positions are on (Full mode, or Positions = true).</summary>
        public static void Death(Vector3 position, string cause = "unknown") => Core?.Death(position.x, position.y, position.z, cause);

        public static void Death(Vector2 position, string cause = "unknown") => Core?.Death(position.x, position.y, 0, cause);

        public static void Death(string cause = "unknown") => Core?.Death(null, null, null, cause);

        /// <summary>A game event: pickups, purchases, checkpoints. Use the game's own words, never anything the player typed.</summary>
        public static void Track(string name) => Core?.Track(name, null);

        /// <summary>A game event with one word or number about it ("magnet", 3), or a dictionary of attributes.</summary>
        public static void Track(string name, object what)
        {
            var attrs = what as Dictionary<string, object> ?? (what == null ? null : new Dictionary<string, object> { ["what"] = what });
            Core?.Track(name, attrs);
        }

        /// <summary>A number that describes what is going on (enemies, particles, bullets). The largest value in
        /// each frame window is sent, and the current ones go with each hitch, so the findings can say what was
        /// high when frames stuttered. Call it every frame or whenever the number changes.</summary>
        public static void SetContext(string key, double value) => Core?.SetContext(key, value);

        public static void SetContext(Dictionary<string, double> gauges)
        {
            var c = Core;
            if (c == null || gauges == null) return;
            foreach (var kv in gauges) c.SetContext(kv.Key, kv.Value);
        }

        /// <summary>The player's place, sampled at PositionHz for heatmaps. Ignored unless positions are on.</summary>
        public static void SetPosition(Vector3 position) => Core?.SetPosition(position.x, position.y, position.z);

        public static void SetPosition(Vector2 position) => Core?.SetPosition(position.x, position.y, 0);

        /// <summary>Reports an exception the game caught itself.</summary>
        public static void Error(Exception exception, Dictionary<string, object> attrs = null)
        {
            if (exception == null) return;
            Core?.ReportError("manual", $"{exception.GetType().Name}: {exception.Message}", exception.StackTrace ?? Environment.StackTrace, attrs, manual: true);
        }

        /// <summary>Reports a problem the game noticed itself.</summary>
        public static void Error(string message, Dictionary<string, object> attrs = null) => Core?.ReportError("manual", message, Environment.StackTrace, attrs, manual: true);

        /// <summary>A player's bug report from the game's own UI: what they typed, a screenshot of the game (taken at
        /// the end of this frame), where they are and what just happened. It goes on its own straight away, from
        /// every session. done(sent, reason): reason is "offline" when this build sends nothing, "error" when the
        /// report waits for a later batch. The note is the player's own words: see PRIVACY.md.</summary>
        public static void ReportBug(string note, bool screenshot = true, Action<bool, string> done = null) => GlitchlessRunner.ReportBug(note, screenshot, done);

        /// <summary>Opens the bug report form, for a game's own "Report a bug" button. GlitchlessOptions.BugReports
        /// adds a hotkey for it.</summary>
        public static void OpenBugReport() => GlitchlessRunner.OpenBugReport();

        /// <summary>The bug report form is open: input the game reads straight from UnityEngine.Input or a device
        /// should be ignored meanwhile.</summary>
        public static bool IsBugReportOpen => GlitchlessRunner.IsBugReportOpen;

        /// <summary>Frame stats over the next `seconds`: the same numbers as the browser SDK's glitchless_measure.
        /// Json.Serialize(result) turns them into JSON.</summary>
        public static void Measure(float seconds, Action<Dictionary<string, object>> done) => Core?.Measure(seconds, done);

        /// <summary>Closes the current frame window and sends what is waiting. Runs by itself every few seconds.</summary>
        public static void Flush() => Core?.Flush();
        /// <summary>Forgets the player ID saved on the device (Install and Full mode), for a "reset my ID" setting. This
        /// session keeps sending the ID it started with; the next launch makes a new one, so nothing joins the two.</summary>
        public static void ResetInstallId() => Core?.ResetInstallId();

        public static string SessionId => Core?.SessionId;
        public static bool Enabled => Core?.Enabled ?? false;
        public static GlitchlessStats Stats => Core?.Stats;
        public static string Level => Core?.Level;
    }
}

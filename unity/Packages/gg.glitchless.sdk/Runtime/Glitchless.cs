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
    ///   Glitchless.Count("kill", "elite"); // a stream, added up on the device
    ///   Glitchless.SetProperty("rank", "diamond"); // what holds for the session
    ///   Glitchless.SetGroup("match", lobby.Id); // every event from here on belongs to this match
    ///   Glitchless.ReportBug(note); // or BugReports = new BugReportOptions() in the options: F8 opens a form
    ///
    /// Scenes are levels on their own (see GlitchlessOptions.SceneLevels). Netcode for GameObjects and Mirror are
    /// read for ping and disconnects, and a Dedicated Server build reports as a server. Every call is safe before
    /// Init, and does nothing outside Play mode.
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

        /// <summary>A level starts, with what this attempt is: <c>new Dictionary&lt;string, object&gt; { ["tier"] = "pit_80",
        /// ["party_size"] = 3 }</c>. The levels panel splits clears and fails by them. Attributes as Track's: strings,
        /// numbers, booleans and lists, at most 12.</summary>
        public static void LevelStart(string level, Dictionary<string, object> attrs) => Core?.LevelStart(level, attrs);

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

        /// <summary>Counts a stream of events (shots, hits, kills, gold picked up) on the device instead of sending each
        /// one: one counts event a window carries every name and group. Track a moment, count a stream.
        /// <c>Glitchless.Count("kill", new Dictionary&lt;string, object&gt; { ["monster"] = "elite" })</c>;
        /// <c>Glitchless.Count("gold", new Dictionary&lt;string, object&gt; { ["source"] = "loot", ["amount"] = 35 })</c>.
        /// Strings and booleans (at most 4) make the group; numbers (at most 4) are added up; `n` is how many events the
        /// call stands for. One word or number becomes the attribute `what`, as with Track.</summary>
        public static void Count(string name, object what = null, int n = 1)
        {
            var attrs = what as Dictionary<string, object> ?? (what == null ? null : new Dictionary<string, object> { ["what"] = what });
            Core?.Count(name, attrs, n);
        }

        /// <summary>Says what holds for this session, in the game's words: the mode, the player's rank tier or class, the
        /// region of the game's servers. Boards split and filter by it ($rank). A string (up to 64 characters), a boolean
        /// or a whole number; null removes it. Never who the player is: keys such as email or user_id, and values that
        /// look like an ID, an email address or a link, are dropped. At most 12 a session. Bands, not exact numbers
        /// ("30-39").</summary>
        public static void SetProperty(string key, object value) => Core?.SetProperty(key, value);

        public static void SetProperties(Dictionary<string, object> properties) => Core?.SetProperties(properties);

        /// <summary>Marks every event from here on with the match, party or run it belongs to. `id` comes from the game's
        /// servers, shared by everyone in that match or party (8 to 64 letters, digits and _ . : -; a lobby or session ID
        /// works), and is hashed before it is sent unless HashGroupIds is off. Never a player's account, guild or friends
        /// list. null ends the group. For "run", a run ID the game saved resumes that run in install and full mode; in
        /// anonymous mode it gets a new one. Returns the run's ID, or the ID passed.</summary>
        public static string SetGroup(string kind, string id, Dictionary<string, object> attrs = null) => Core?.SetGroup(kind, id, attrs);

        /// <summary>SetGroup("run") starts a run with a new ID the SDK makes, and returns it, for the game to save when a
        /// run can go on after a restart.</summary>
        public static string SetGroup(string kind)
        {
            if (kind == "run") return Core?.NewRun();
            return Core?.SetGroup(kind, null); // a match or party needs its ID: this ends it
        }

        /// <summary>Where the player is in an open world (an MMO region, a metroidvania room), with no start or end. Events
        /// and frame windows carry it as they carry the level; boards split by $zone. null clears it.</summary>
        public static void SetZone(string zone) => Core?.SetZone(zone);

        /// <summary>A round trip from the game's own netcode, for a library Glitchless doesn't read itself (it reads Netcode
        /// for GameObjects and Mirror): Steam Networking Sockets, Photon, Fish-Net, a game's own. Loss and jitter where the
        /// game knows them; with NGO or Mirror, pass only those. At most one a second counts.</summary>
        public static void NetSample(double? rttMs, double? lossPct = null, double? jitterMs = null) => Core?.NetSample(rttMs, lossPct, jitterMs);

        /// <summary>The connection to the game's server dropped, for a library Glitchless doesn't read: timeout,
        /// connection_lost, kicked, server_closed, failed_to_connect or other. A level going ends with a level_abandon
        /// whose reason is disconnect, never a fail.</summary>
        public static void Disconnect(string reason = "other") => Core?.NetDisconnect(reason);

        /// <summary>Connected again after Disconnect. A level the disconnect left goes on.</summary>
        public static void Reconnect() => Core?.NetReconnect();

        /// <summary>A game server: the players connected now, when the game counts them itself (NGO's and Mirror's
        /// connections are counted without it).</summary>
        public static void SetPlayers(int players) => Core?.SetPlayers(players);

        /// <summary>This run is a game server (GlitchlessOptions.Role, a Dedicated Server build, or --glitchless-server).</summary>
        public static bool IsServer => Core?.IsServer ?? false;

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

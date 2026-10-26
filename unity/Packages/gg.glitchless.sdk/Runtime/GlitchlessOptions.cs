using System;
using System.Collections.Generic;

namespace GlitchlessSdk
{
    public enum GlitchlessRole
    {
        /// <summary>The default: a Dedicated Server build (UNITY_SERVER) or a player run with --glitchless-server is a
        /// server, anything else a player.</summary>
        Auto = 0,
        Player = 1,
        /// <summary>A game server: it reports as the game's companion service, `&lt;game&gt;.server`, with its tick time and
        /// players connected, and never counts as a player (SPEC §5b).</summary>
        Server = 2,
    }

    public enum Privacy
    {
        /// <summary>The default: no player ID, coarse device facts, no positions unless Positions is set.</summary>
        Anonymous = 0,
        /// <summary>Adds a random player ID saved on the device, detailed device fields and positions.</summary>
        Full = 1,
        /// <summary>Anonymous mode plus the random player ID saved on the device (the one Full uses), so returning players
        /// can be counted (retention). Glitchless.ResetInstallId() forgets it.</summary>
        Install = 2,
    }

    /// <summary>Everything Glitchless.Init() takes. PRIVACY.md says what each setting changes in what is sent.</summary>
    public class GlitchlessOptions
    {
        /// <summary>The game's id in Glitchless, lowercase and stable, for example "my-game".</summary>
        public string Service = "unknown-game";
        /// <summary>The game's version; empty uses the Steam build ("steam-18231") when the game runs one from Steam
        /// with Steamworks, else Application.version. Bump it on every release.</summary>
        public string Version = "";
        /// <summary>Empty: "dev" in the Editor and development builds, "prod" in release builds.</summary>
        public string Env = "";
        /// <summary>The Glitchless server, for example https://api.glitchless.gg or http://localhost:7777.</summary>
        public string Intake = "";
        /// <summary>The public client token. It can only send data, so it may ship inside the game.</summary>
        public string ClientToken = "gl_pub_dev";
        public Privacy Privacy = Privacy.Anonymous;
        /// <summary>Death places and movement samples. Null: on in Full mode only (not Install).</summary>
        public bool? Positions;
        /// <summary>The share of sessions to record, 0 to 1.</summary>
        public double SampleRate = 1;
        /// <summary>Frame stats are summed up per window: the dashboard's time resolution.</summary>
        public float WindowSeconds = 5;
        /// <summary>How often batches are sent, on a window boundary. The first goes after 2 s.</summary>
        public float FlushIntervalSeconds = 15;
        public float PositionHz = 4;
        /// <summary>"user", "tester" or "synthetic" (bots). Empty: synthetic in batch mode or with --autoplay, tester on
        /// a TestFlight or development install on iOS.</summary>
        public string SessionType = "";
        /// <summary>Seconds in the background after which coming back starts a new session.</summary>
        public float SessionTimeoutSeconds = 300;
        /// <summary>Report each active scene as a level (level_start on load). A Glitchless.LevelStart() call turns this off.</summary>
        public bool SceneLevels = true;
        /// <summary>Scene name → level name, or null when the scene isn't a level. Null: every scene except
        /// those that read as a menu, loader, overlay or end screen (Boot, MainMenu, Loading, HUD, GameOver…).</summary>
        public Func<string, string> LevelForScene;
        /// <summary>Report Debug.LogError, Debug.LogAssertion and engine errors, not only exceptions.</summary>
        public bool CaptureLogErrors = true;
        public bool CaptureWarnings = false;
        /// <summary>Mesh, texture and object counts in ctx, where the findings look for leaks.</summary>
        public bool EngineGauges = true;
        /// <summary>The same key four times in a second. Null: on except on phones, where fast tapping is play.</summary>
        public bool? RageInput;
        /// <summary>Null: on whenever there is an intake URL.</summary>
        public bool? Enabled;
        /// <summary>Log each batch as it is sent.</summary>
        public bool Debug = false;
        /// <summary>Players send bug reports from a form in the game: new BugReportOptions() adds a hotkey (F8) that
        /// opens it. Null: no hotkey (Glitchless.ReportBug() and Glitchless.OpenBugReport() still work).</summary>
        public BugReportOptions BugReports;
        /// <summary>What holds for the session, in the game's words: the mode, the player's rank tier or class, the
        /// region of the game's servers. Sent with the session in every mode; Glitchless.SetProperties changes them
        /// later. Keys like email or user_id and values that look like an ID, an email address or a link are dropped
        /// (PRIVACY.md, Properties).</summary>
        public Dictionary<string, object> Properties;
        /// <summary>Match and party IDs (Glitchless.SetGroup) are hashed with the service as the salt before they are
        /// sent, so they can't be looked up in the game's own match logs. False sends them as they are, to match them
        /// against your own server's logs.</summary>
        public bool HashGroupIds = true;
        /// <summary>Read round trips and disconnects from the game's netcode (Netcode for GameObjects, Mirror), found
        /// at run time.</summary>
        public bool Netcode = true;
        /// <summary>Player or server. Auto: a Dedicated Server build or --glitchless-server is a server.</summary>
        public GlitchlessRole Role = GlitchlessRole.Auto;
        /// <summary>Server mode: where the server runs, in the game's own words ("eu-west"). Never its address.</summary>
        public string ServerRegion = "";
        /// <summary>Server mode: the most players a server takes. 0: Mirror's maxConnections when the game uses Mirror.</summary>
        public int MaxPlayers;
        /// <summary>Server mode: each match (Glitchless.SetGroup("match", id)) starts a session of its own, for a server
        /// that hosts one match at a time. Otherwise a server session lasts as long as the process, cut every 6 hours.</summary>
        public bool SessionPerMatch;
    }

    /// <summary>Somewhere to keep the player ID by name ("player_id"), for a platform without a folder of its own: the
    /// runner uses PlayerPrefs on the web.</summary>
    public sealed class IdStorage
    {
        public Func<string, string> Read;
        public Action<string, string> Write;
        public Action<string> Delete;
    }
}

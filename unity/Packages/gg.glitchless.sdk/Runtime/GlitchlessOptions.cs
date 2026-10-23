using System;

namespace GlitchlessSdk
{
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
        /// <summary>The game's version; empty uses Application.version. Bump it on every release.</summary>
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
        /// <summary>"user" or "synthetic" (bots). Empty: synthetic in batch mode or with --autoplay.</summary>
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

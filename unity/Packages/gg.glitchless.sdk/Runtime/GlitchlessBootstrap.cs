using UnityEngine;

namespace GlitchlessSdk
{
    /// <summary>
    /// Set Glitchless up without code: add this to a GameObject in your first scene and fill in the
    /// service, intake URL and client token. It calls Glitchless.Init() in Awake, before other scripts.
    /// </summary>
    [DefaultExecutionOrder(-10000)]
    [AddComponentMenu("Glitchless/Glitchless Bootstrap")]
    public sealed class GlitchlessBootstrap : MonoBehaviour
    {
        [Tooltip("The game's id in Glitchless, lowercase and stable, for example my-game.")]
        public string service = "my-game";
        [Tooltip("The Glitchless server, for example https://api.glitchless.gg or http://localhost:7777.")]
        public string intake = "http://localhost:7777";
        [Tooltip("The public client token. It can only send data, so it may ship inside the game.")]
        public string clientToken = "gl_pub_dev";
        [Tooltip("Empty: dev in the Editor and development builds, prod in release builds.")]
        public string env = "";
        [Tooltip("Adds a random player ID saved on the device, detailed device fields and positions. Your privacy policy must say so.")]
        public bool fullPrivacy;
        [Tooltip("Adds a random player ID saved on the device, so returning players (retention) can be counted; nothing else changes. Your privacy policy must say so. Full privacy wins when both are on.")]
        public bool installId;
        [Tooltip("Death places and movement samples for heatmaps, in anonymous mode too.")]
        public bool positions;
        [Tooltip("Report each scene as a level.")]
        public bool sceneLevels = true;
        [Tooltip("Ask first: on a device where the player hasn't chosen yet, Glitchless measures and sends nothing until the game calls Glitchless.SetEnabled(true) because they said yes.")]
        public bool optIn;

        void Awake()
        {
            Glitchless.Init(new GlitchlessOptions
            {
                Service = service,
                Intake = intake,
                ClientToken = clientToken,
                Env = env,
                Privacy = fullPrivacy ? Privacy.Full : installId ? Privacy.Install : Privacy.Anonymous,
                Positions = positions ? true : (bool?)null,
                SceneLevels = sceneLevels,
                OptIn = optIn,
            });
        }
    }
}

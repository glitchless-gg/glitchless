using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;

namespace GlitchlessSdk
{
    /// <summary>
    /// Steam facts for session_start, when the game already uses Steamworks (SPEC §4c): the Steam build and beta
    /// branch it runs, the Steam hardware (Steam Deck, Steam Machine, Steam Frame), Proton, Big Picture, the first
    /// controller's Steam Input type, Family Sharing, a timed trial and the game's Steam language.
    ///
    /// Steamworks.NET and Facepunch.Steamworks are found by reflection, so the SDK depends on neither, and only what
    /// the game has set up is read: nothing until Steamworks is initialised (SteamAPI.Init, or SteamClient.Init), and no
    /// controllers until the game has started Steam Input. A wrapper without a call leaves that fact out. No Steam ID,
    /// owner or name is ever read. PRIVACY.md lists every field; keep the two in step.
    /// </summary>
    public static class SteamInfo
    {
        const BindingFlags Static = BindingFlags.Public | BindingFlags.Static;

        /// <summary>The facts of the wrapper the game loaded, or null: no wrapper, or Steamworks not initialised yet.</summary>
        public static Dictionary<string, object> Read()
        {
            try
            {
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    if (asm.IsDynamic || asm.GetType("Steamworks.SteamApps", false) == null) continue;
                    var facts = ReadFrom(name => asm.GetType("Steamworks." + name, false), SteamManagerReady);
                    if (facts != null) return facts;
                }
            }
            catch (Exception)
            {
                // An assembly that won't list its types: no Steam facts this time.
            }
            return null;
        }

        /// <summary>The facts the types `type` finds answer ("SteamApps", "SteamUtils", "SteamInput", "SteamClient", as both
        /// wrappers name them). `ready` says whether Steamworks.NET's sample SteamManager has initialised Steam (null:
        /// the game has no SteamManager). Tests pass fakes here.</summary>
        public static Dictionary<string, object> ReadFrom(Func<string, Type> type, Func<bool?> ready = null)
        {
            var apps = type("SteamApps");
            if (apps == null) return null;
            if (apps.GetMethod("GetAppBuildId", Static) != null) return ReadSteamworksNet(apps, type("SteamUtils"), type("SteamInput"), ready);
            if (apps.GetProperty("BuildId", Static) != null) return ReadFacepunch(apps, type("SteamUtils"), type("SteamInput"), type("SteamClient"));
            return null;
        }

        // Steamworks.NET: ISteamApps and ISteamUtils as static methods, which throw InvalidOperationException before
        // SteamAPI.Init. Its SteamManager sample says first, when the game has one.
        static Dictionary<string, object> ReadSteamworksNet(Type apps, Type utils, Type input, Func<bool?> ready)
        {
            if (ready?.Invoke() == false) return null;
            if (!TryCall(apps, "GetAppBuildId", null, out var buildId)) return null; // not initialised
            var facts = new Dictionary<string, object>();
            AddBuild(facts, buildId);
            var beta = new object[] { null, 256 };
            if (TryCall(apps, "GetCurrentBetaName", beta, out var onBeta) && onBeta is bool b)
                facts["steam_branch"] = b && beta[0] is string name && name != "" ? name : "public";
            AddHardware(facts, utils, "IsRunningOnSteamHardware", "IsSteamRunningOnSteamDeck");
            AddFlag(facts, "proton", utils, "IsRunningUnderProton");
            AddFlag(facts, "big_picture", utils, "IsSteamInBigPictureMode");
            AddFlag(facts, "family_shared", apps, "BIsSubscribedFromFamilySharing");
            AddFlag(facts, "timed_trial", apps, "BIsTimedTrial", new object[] { null, null });
            // GetConnectedControllers(InputHandle_t[]): 0 until the game has called SteamInput.Init.
            var connected = input?.GetMethod("GetConnectedControllers", Static);
            var handles = connected?.GetParameters();
            if (handles != null && handles.Length == 1 && handles[0].ParameterType.IsArray)
            {
                var list = Array.CreateInstance(handles[0].ParameterType.GetElementType(), 16); // STEAM_INPUT_MAX_COUNT
                if (TryCall(input, "GetConnectedControllers", new object[] { list }, out var n) && n is int count && count > 0 && TryCall(input, "GetInputTypeForHandle", new[] { list.GetValue(0) }, out var kind))
                    facts["steam_controller"] = ControllerName(kind);
            }
            if (TryCall(apps, "GetCurrentGameLanguage", null, out var language)) AddWord(facts, "steam_language", language, 32);
            return facts;
        }

        // Facepunch.Steamworks: properties, valid once SteamClient.Init has run (SteamClient.IsValid).
        static Dictionary<string, object> ReadFacepunch(Type apps, Type utils, Type input, Type client)
        {
            if (!(TryCall(client, "IsValid", null, out var valid) && valid is bool ok && ok)) return null;
            var facts = new Dictionary<string, object>();
            if (TryCall(apps, "BuildId", null, out var buildId)) AddBuild(facts, buildId);
            // null on the default branch, which Steam calls "public".
            if (TryCall(apps, "CurrentBetaName", null, out var beta)) facts["steam_branch"] = beta is string name && name != "" ? name : "public";
            AddHardware(facts, utils, "IsRunningOnSteamHardware", "IsRunningOnSteamDeck", "IsSteamRunningOnSteamDeck");
            AddFlag(facts, "proton", utils, "IsRunningUnderProton");
            AddFlag(facts, "big_picture", utils, "IsSteamInBigPictureMode");
            AddFlag(facts, "family_shared", apps, "IsSubscribedFromFamilySharing");
            AddFlag(facts, "timed_trial", apps, "IsTimedTrial", new object[] { null, null });
            if (TryCall(input, "Controllers", null, out var controllers) && controllers is IEnumerable all)
            {
                foreach (var c in all)
                {
                    var kind = c?.GetType().GetProperty("InputType")?.GetValue(c);
                    if (kind != null) facts["steam_controller"] = ControllerName(kind);
                    break;
                }
            }
            if (TryCall(apps, "GameLanguage", null, out var language)) AddWord(facts, "steam_language", language, 32);
            return facts;
        }

        /// <summary>Steamworks.NET's SteamManager.Initialized, when the game has that sample script: false until it
        /// has initialised Steam. Null when there is none.</summary>
        static bool? SteamManagerReady()
        {
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (asm.IsDynamic) continue;
                var p = asm.GetType("SteamManager", false)?.GetProperty("Initialized", Static);
                if (p != null && p.PropertyType == typeof(bool)) return (bool)p.GetValue(null);
            }
            return null;
        }

        /// <summary>A static property's value, or a static method's result (out arguments filled in `args`). False when the
        /// type has neither or the call throws.</summary>
        static bool TryCall(Type t, string name, object[] args, out object result)
        {
            result = null;
            if (t == null) return false;
            try
            {
                if (args == null)
                {
                    var p = t.GetProperty(name, Static);
                    if (p != null)
                    {
                        result = p.GetValue(null);
                        return true;
                    }
                }
                foreach (var m in t.GetMethods(Static))
                {
                    if (m.Name != name || m.GetParameters().Length != (args?.Length ?? 0)) continue;
                    result = m.Invoke(null, args);
                    return true;
                }
            }
            catch (Exception)
            {
                // Not initialised, gone, or a wrapper that differs: leave it out.
            }
            return false;
        }

        // GetAppBuildId is 0 outside a build downloaded from Steam.
        static void AddBuild(Dictionary<string, object> facts, object value)
        {
            try
            {
                var build = Convert.ToInt64(value);
                if (build > 0) facts["steam_build"] = build;
            }
            catch (Exception)
            {
            }
        }

        static void AddFlag(Dictionary<string, object> facts, string key, Type t, string name, object[] args = null)
        {
            if (TryCall(t, name, args, out var v) && v is bool b) facts[key] = b;
        }

        static void AddWord(Dictionary<string, object> facts, string key, object value, int max)
        {
            if (value is string s && s.Trim() != "") facts[key] = s.Trim().Length > max ? s.Trim().Substring(0, max) : s.Trim();
        }

        // IsRunningOnSteamHardware (SDK 1.65) names the hardware; before it, wrappers only tell a Steam Deck.
        static void AddHardware(Dictionary<string, object> facts, Type utils, string hardware, params string[] deck)
        {
            if (TryCall(utils, hardware, null, out var kind) && kind != null)
            {
                facts["steam_hardware"] = HardwareName(kind);
                return;
            }
            foreach (var name in deck)
            {
                if (!TryCall(utils, name, null, out var v) || !(v is bool isDeck)) continue;
                facts["steam_hardware"] = isDeck ? "deck" : "none";
                return;
            }
        }

        static readonly string[] Hardware = { "none", "deck", "machine", "frame" };

        /// <summary>ESteamHardwareType → "none", "deck", "machine" or "frame".</summary>
        public static string HardwareName(object kind)
        {
            try
            {
                var i = Convert.ToInt32(kind);
                return i >= 0 && i < Hardware.Length ? Hardware[i] : "none";
            }
            catch (Exception)
            {
                return "none";
            }
        }

        static readonly string[] Controllers =
        {
            "unknown", "steam_controller", "xbox_360", "xbox_one", "generic_xinput", "ps4", "apple_mfi", "android", "switch_joycon_pair",
            "switch_joycon_single", "switch_pro", "mobile_touch", "ps3", "ps5", "steam_deck", "steamos_handheld", "switch2_pro",
            "steam_controller_2026", "steam_frame_controllers",
        };

        /// <summary>ESteamInputType (both wrappers keep Steamworks' numbers) → the name every Glitchless SDK sends.</summary>
        public static string ControllerName(object kind)
        {
            try
            {
                var i = Convert.ToInt32(kind);
                return i >= 0 && i < Controllers.Length ? Controllers[i] : "other";
            }
            catch (Exception)
            {
                return "other";
            }
        }

        /// <summary>Adds the facts to a session_start device: Steam hardware refines DeviceInfo's own Steam Deck guess.</summary>
        public static void AddTo(Dictionary<string, object> device, Dictionary<string, object> facts)
        {
            if (device == null || facts == null) return;
            foreach (var kv in facts) device[kv.Key] = kv.Value;
            if (facts.TryGetValue("steam_hardware", out var hw) && (hw as string) == "deck")
            {
                device["steam_deck"] = true;
                device["gpu_tier"] = "low";
            }
        }
    }
}

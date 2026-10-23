using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.Rendering;

namespace GlitchlessSdk
{
    /// <summary>
    /// What Glitchless says about the device in session_start.
    ///
    /// Anonymous mode sends only coarse facts that many thousands of devices share: the OS name, a
    /// low / mid / high tier, the render pipeline and graphics API, the screen size and refresh rate.
    /// Every mode says whether it is a Steam Deck (steam_deck), and a Deck on SteamOS is os "SteamOS".
    /// Full mode adds the model, OS version, GPU name, core count and memory. Never sent in either mode:
    /// SystemInfo.deviceUniqueIdentifier and SystemInfo.deviceName (often the owner's name).
    /// PRIVACY.md lists every field; keep the two in step.
    /// </summary>
    public static class DeviceInfo
    {
        public static Dictionary<string, object> Collect(bool full)
        {
            var mobile = Application.isMobilePlatform;
            var cores = SystemInfo.processorCount;
            var memGb = SystemInfo.systemMemorySize > 0 ? SystemInfo.systemMemorySize / 1024.0 : -1;
            var tier = DeviceTier(cores, memGb);
            var deck = SteamDeck;
            var d = new Dictionary<string, object>
            {
                ["browser"] = "Unity", // the runtime, in the field the dashboard groups by
                ["browser_version"] = Application.unityVersion,
                ["os"] = SteamOs ? "SteamOS" : OsName(),
                ["mobile"] = mobile,
                ["device_tier"] = tier,
                // Every phone GPU is "low" next to a desktop one, so on phones the GPU tier is the device tier. A Steam
                // Deck's is "low" too, as the Unreal plugin has it.
                ["gpu_tier"] = mobile ? tier : deck ? "low" : GpuTier(SystemInfo.graphicsDeviceName),
                ["renderer"] = RenderPipeline(),
                ["driver"] = SystemInfo.graphicsDeviceType.ToString(),
                ["screen"] = ScreenSize(),
                ["dpr"] = null,
                ["refresh_hz"] = RefreshRate(),
            };
            d["steam_deck"] = deck;
            if (full)
            {
                d["model"] = SystemInfo.deviceModel;
                d["os_version"] = SystemInfo.operatingSystem;
                d["gpu"] = SystemInfo.graphicsDeviceName;
                d["gpu_vendor"] = SystemInfo.graphicsDeviceVendor;
                d["cores"] = cores;
                d["memory_gb"] = memGb > 0 ? (object)Mathf.RoundToInt((float)memGb) : null;
            }
            return d;
        }

        public static string OsName()
        {
            switch (Application.platform)
            {
                case RuntimePlatform.IPhonePlayer: return "iOS";
                case RuntimePlatform.Android: return "Android";
                case RuntimePlatform.WebGLPlayer: return "Web";
                case RuntimePlatform.OSXPlayer: case RuntimePlatform.OSXEditor: case RuntimePlatform.OSXServer: return "macOS";
                case RuntimePlatform.WindowsPlayer: case RuntimePlatform.WindowsEditor: case RuntimePlatform.WindowsServer: return "Windows";
                case RuntimePlatform.LinuxPlayer: case RuntimePlatform.LinuxEditor: case RuntimePlatform.LinuxServer: return "Linux";
                case RuntimePlatform.tvOS: return "tvOS";
                case RuntimePlatform.PS4: case RuntimePlatform.PS5: return "PlayStation";
                case RuntimePlatform.Switch: return "Switch";
                case RuntimePlatform.GameCoreXboxOne: case RuntimePlatform.GameCoreXboxSeries: return "Xbox";
                default: return SystemInfo.operatingSystemFamily.ToString();
            }
        }

        static (string env, string vendor, string board, string osRelease)? facts; // read once a launch

        static (string env, string vendor, string board, string osRelease) Facts => facts ??= (Environment.GetEnvironmentVariable("SteamDeck"), Dmi("board_vendor"), Dmi("board_name"), Small(Root + "/etc/os-release"));

        public static bool SteamDeck => IsSteamDeck(Facts.env, Facts.vendor, Facts.board, Facts.osRelease);

        /// <summary>A Deck running SteamOS, or one Steam started (a Windows build under Proton runs on SteamOS too): "SteamOS"
        /// in place of Linux or Windows, as the Unreal plugin says.</summary>
        public static bool SteamOs => IsSteamOs(Facts.env, Facts.vendor, Facts.board, Facts.osRelease);

        public static bool IsSteamOs(string env, string boardVendor, string boardName, string osRelease) =>
            IsSteamDeck(env, boardVendor, boardName, osRelease) && (OsReleaseId(osRelease) == "steamos" || !string.IsNullOrEmpty(env));

        /// <summary>A Steam Deck: Steam says so (SteamDeck=1, under Steam and Proton), the board is Valve's Jupiter (LCD)
        /// or Galileo (OLED), or the OS is SteamOS (ID=steamos in os-release). The same rule as the browser SDK's, Godot's
        /// and Unreal's.</summary>
        public static bool IsSteamDeck(string env, string boardVendor, string boardName, string osRelease)
        {
            if ((env ?? "").Trim() == "1") return true;
            var board = (boardName ?? "").Trim().ToLowerInvariant();
            if ((boardVendor ?? "").Trim().ToLowerInvariant() == "valve" && (board == "jupiter" || board == "galileo")) return true;
            return OsReleaseId(osRelease) == "steamos";
        }

        static string OsReleaseId(string osRelease)
        {
            foreach (var raw in (osRelease ?? "").Split('\n'))
            {
                var line = raw.Trim();
                if (line.StartsWith("ID=", StringComparison.Ordinal)) return line.Substring(3).Trim('"').ToLowerInvariant();
            }
            return "";
        }

        // A Linux build reads /sys and /etc; a Windows build under Proton reads the same files through Wine's Z: drive.
        static string Root => Application.platform == RuntimePlatform.WindowsPlayer ? "Z:" : "";

        static string Dmi(string name) => Small(Root + "/sys/class/dmi/id/" + name);

        static string Small(string path)
        {
            var p = Application.platform;
            if (p != RuntimePlatform.LinuxPlayer && p != RuntimePlatform.WindowsPlayer) return null;
            try
            {
                return File.Exists(path) ? File.ReadAllText(path) : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>low / mid / high from cores and memory: coarse enough that it can't tell one device from another of its kind.</summary>
        public static string DeviceTier(int cores, double memGb)
        {
            if (memGb <= 0) return "unknown";
            if (memGb < 3 || cores <= 4) return "low";
            if (memGb >= 6 && cores >= 6) return "high";
            return "mid";
        }

        static readonly (Regex, string)[] Tiers =
        {
            (new Regex("swiftshader|llvmpipe|software|basic render"), "software"),
            (new Regex(@"apple m\d+ (pro|max|ultra)|rtx|radeon rx|radeon pro|quadro|geforce gtx 1[06-9]|arc a7"), "high"),
            (new Regex(@"adreno|mali|powervr|apple a\d+|apple gpu$"), "low"),
            (new Regex(@"intel.*(hd|uhd) graphics|intel\(r\) (hd|uhd)"), "low"),
            (new Regex(@"apple m\d+|apple gpu|iris|arc|radeon|geforce|nvidia"), "mid"),
        };

        /// <summary>The browser SDK's GPU tiers (packages/sdk/src/device.js), for desktops.</summary>
        public static string GpuTier(string name)
        {
            var s = (name ?? "").ToLowerInvariant();
            foreach (var (re, tier) in Tiers)
                if (re.IsMatch(s)) return tier;
            return "unknown";
        }

        public static string RenderPipeline()
        {
            var rp = GraphicsSettings.currentRenderPipeline;
            if (rp == null) return "built-in";
            var type = rp.GetType().Name;
            if (type.Contains("Universal")) return "urp";
            if (type.Contains("HDRender") || type.Contains("HighDefinition")) return "hdrp";
            return type;
        }

        /// <summary>The screen the game is on, in pixels: a folding phone's open and closed states differ.</summary>
        public static int[] ScreenSize()
        {
            var r = Screen.currentResolution;
            return new[] { r.width, r.height };
        }

        public static int[] WindowSize() => new[] { Screen.width, Screen.height };

        public static object RefreshRate()
        {
            var hz = Screen.currentResolution.refreshRateRatio.value;
            return hz > 0 ? (object)(int)System.Math.Round(hz) : null;
        }
    }
}

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using UnityEngine;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace GlitchlessSdk
{
    /// <summary>
    /// The page a WebGL build runs in, through Plugins/WebGL/Glitchless.jslib. Unity names itself where the browser
    /// would, so without this every Unity web player was browser "Unity", OS "Web". DeviceInfo takes the browser, its
    /// major version, the OS, whether it is a phone, the pixel ratio and the screen from here instead, read exactly as
    /// the browser SDK reads them (packages/sdk/src/device.js): a Unity web game and a Three.js game split by browser
    /// and OS alike, and ParityTests holds the two to the same answers. Address is session_start's page, where the game
    /// was played (an itch.io frame, a Reddit post, its own site), as the browser SDK sends it. GlitchlessRunner sends
    /// the last batches through Beacon as the page hides or goes (Listen). Outside a WebGL player, Read is null and
    /// nothing here calls the page.
    /// </summary>
    public static class WebPage
    {
        /// <summary>What a WebGL build's page says about the device, in the browser SDK's words.</summary>
        public sealed class Facts
        {
            public string Browser = "Other"; // Chrome, Safari, Firefox, Edge, Opera or Other
            public string BrowserVersion; // the major version, or null
            public string Os = "Other"; // iOS, Android, macOS, Windows, ChromeOS, Linux or Other
            public bool Mobile;
            public object Dpr; // devicePixelRatio to 2 places, or null
            public int[] Screen; // the screen in CSS pixels, as the browser SDK sends it, or null
            public bool SteamDeck;
            public string Url; // the page's origin and path, never its query string or fragment
            public string Referrer; // the origin of the page that led here, or null

            /// <summary>session_start's page, as the browser SDK sends it: {url, referrer}. The server keeps only the two
            /// hosts, for the board's $site and the itch.io funnel (SPEC §3b). Null when the page gave no address.</summary>
            public Dictionary<string, object> Address => Url == null ? null : new Dictionary<string, object> { ["url"] = Url, ["referrer"] = Referrer };
        }

        public delegate void PageCallback(int what);

        /// <summary>What Listen calls back with: the page was hidden, shown again, is going away (pagehide), or came back
        /// from the browser's back-forward cache.</summary>
        public const int Hidden = 0, Shown = 1, Leaving = 2, Restored = 3;

        // device.js's BROWSERS: each browser's own token, the first rule that matches winning, not the leftmost token
        // (Edge and Opera also say Chrome/, every browser on iOS says Safari/). Other Chromium browsers are Chrome.
        static readonly (Regex token, string name)[] Browsers =
        {
            (new Regex("Edg(?:e|A|iOS)?/([0-9]+)"), "Edge"),
            (new Regex("OPR/([0-9]+)"), "Opera"),
            (new Regex("(?:Firefox|FxiOS)/([0-9]+)"), "Firefox"),
            (new Regex("(?:Chrome|CriOS)/([0-9]+)"), "Chrome"),
            (new Regex("Version/([0-9]+)"), "Safari"),
            (new Regex("Safari/([0-9]+)"), "Safari"),
        };
        static readonly Regex Apple = new Regex("iPhone|iPad|iPod");
        static readonly Regex Phone = new Regex("Mobi|Android|iPhone|iPad");
        static readonly Regex DeckAgent = new Regex("steam ?deck", RegexOptions.IgnoreCase);
        static readonly Regex DeckGpu = new Regex(@"\bvangogh\b|custom gpu 0(405|932)\b", RegexOptions.IgnoreCase);

        /// <summary>The browser SDK's parseUserAgent (device.js), rule for rule: the browser and its major version, the OS,
        /// and whether it is a phone (userAgentData's answer where the browser gives one, else the user agent's).</summary>
        public static Facts ParseUserAgent(string ua, bool? uadMobile)
        {
            ua = ua ?? "";
            var f = new Facts();
            foreach (var (token, name) in Browsers)
            {
                var m = token.Match(ua);
                if (!m.Success) continue;
                f.Browser = name;
                f.BrowserVersion = m.Groups[1].Value;
                break;
            }
            if (Apple.IsMatch(ua)) f.Os = "iOS";
            else if (ua.Contains("Android")) f.Os = "Android";
            else if (ua.Contains("Mac OS X") || ua.Contains("Macintosh")) f.Os = "macOS";
            else if (ua.Contains("Windows")) f.Os = "Windows";
            else if (ua.Contains("CrOS")) f.Os = "ChromeOS";
            else if (ua.Contains("Linux")) f.Os = "Linux";
            f.Mobile = uadMobile ?? Phone.IsMatch(ua);
            return f;
        }

        /// <summary>A Steam Deck, as far as a browser can tell: a user agent that names it, or AMD's Van Gogh GPU, made for
        /// the Deck. The browser SDK's isSteamDeck (device.js); browsers that hide the GPU say nothing.</summary>
        public static bool IsSteamDeck(string ua, string gpu) => DeckAgent.IsMatch(ua ?? "") || DeckGpu.IsMatch(gpu ?? "");

        /// <summary>The page's facts from what the jslib read ({ua, mobile, dpr, screen, url, referrer}); gpu is the GPU name
        /// Unity reports, for the Steam Deck rule. Null when there is nothing to read.</summary>
        public static Facts FromJson(string json, string gpu)
        {
            if (string.IsNullOrEmpty(json)) return null;
            Dictionary<string, object> page;
            try
            {
                page = Json.Parse(json) as Dictionary<string, object>;
            }
            catch (Exception)
            {
                return null;
            }
            if (page == null) return null;
            var ua = page.TryGetValue("ua", out var u) ? u as string : null;
            var f = ParseUserAgent(ua, page.TryGetValue("mobile", out var mo) && mo is bool b ? b : (bool?)null);
            if (page.TryGetValue("dpr", out var d) && d is double dpr && dpr > 0) f.Dpr = Math.Floor(dpr * 100 + 0.5) / 100; // JavaScript's Math.round, as device.js rounds it
            if (page.TryGetValue("screen", out var s) && s is List<object> wh && wh.Count == 2 && wh[0] is double w && wh[1] is double h && w > 0 && h > 0)
                f.Screen = new[] { (int)w, (int)h };
            f.SteamDeck = IsSteamDeck(ua, gpu);
            f.Url = PageUrl(page.TryGetValue("url", out var url) ? url as string : null);
            f.Referrer = OriginOf(page.TryGetValue("referrer", out var r) ? r as string : null);
            return f;
        }

        /// <summary>A page's address without its query string or fragment, which can carry a player's tokens: the jslib
        /// sends origin and path already, and this holds to it. Null for none.</summary>
        public static string PageUrl(string url)
        {
            if (string.IsNullOrEmpty(url)) return null;
            var cut = url.IndexOfAny(new[] { '?', '#' });
            return cut < 0 ? url : url.Substring(0, cut);
        }

        static readonly Regex Origin = new Regex(@"^(https?)://(?:[^@/?#]*@)?([^/?#]+)", RegexOptions.IgnoreCase);

        /// <summary>The origin of an address, as the browser's URL(address).origin says it (core.js originOf):
        /// "https://maker.itch.io" for "https://maker.itch.io/game?x=1", "null" for a file or another address with no
        /// origin of its own, and null for none. The jslib sends the referrer's origin already, and this holds to it.</summary>
        public static string OriginOf(string url)
        {
            if (string.IsNullOrEmpty(url)) return null;
            var m = Origin.Match(url);
            if (!m.Success) return "null";
            var scheme = m.Groups[1].Value.ToLowerInvariant();
            var host = m.Groups[2].Value.ToLowerInvariant();
            if ((scheme == "http" && host.EndsWith(":80")) || (scheme == "https" && host.EndsWith(":443"))) host = host.Substring(0, host.LastIndexOf(':'));
            return scheme + "://" + host;
        }

        /// <summary>Whether this is a WebGL player, where the page can be asked.</summary>
        public static bool InPage
        {
            get
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                return Application.platform == RuntimePlatform.WebGLPlayer;
#else
                return false;
#endif
            }
        }

        /// <summary>The page's facts now, in a WebGL player; null anywhere else, or when the page can't be read.</summary>
        public static Facts Read()
        {
            if (!InPage) return null;
#if UNITY_WEBGL && !UNITY_EDITOR
            try
            {
                return FromJson(GlitchlessPageFacts(), SystemInfo.graphicsDeviceName);
            }
            catch (Exception)
            {
                return null;
            }
#else
            return null;
#endif
        }

        /// <summary>Queues a POST with navigator.sendBeacon, which the browser sends even after the page has gone. False
        /// outside a WebGL player, or when the browser turns it down (it takes about 64 KB at a time).</summary>
        public static bool Beacon(string url, byte[] body)
        {
            if (!InPage || body == null || body.Length == 0) return false;
#if UNITY_WEBGL && !UNITY_EDITOR
            try
            {
                return GlitchlessPageBeacon(url, body, body.Length) == 1;
            }
            catch (Exception)
            {
                return false;
            }
#else
            return false;
#endif
        }

        static Action<int> listener;

        /// <summary>Calls onPage with Hidden, Shown, Leaving or Restored as the page does. Once a launch; a later call only
        /// changes who is told.</summary>
        public static void Listen(Action<int> onPage)
        {
            if (!InPage) return;
            var first = listener == null;
            listener = onPage;
#if UNITY_WEBGL && !UNITY_EDITOR
            if (first) GlitchlessPageListen(OnPage);
#endif
        }

        [AOT.MonoPInvokeCallback(typeof(PageCallback))]
        static void OnPage(int what)
        {
            try
            {
                listener?.Invoke(what);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[glitchless] page event {what}: {e.Message}");
            }
        }

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern string GlitchlessPageFacts();
        [DllImport("__Internal")] static extern int GlitchlessPageBeacon(string url, byte[] body, int length);
        [DllImport("__Internal")] static extern void GlitchlessPageListen(PageCallback callback);
#endif
    }
}

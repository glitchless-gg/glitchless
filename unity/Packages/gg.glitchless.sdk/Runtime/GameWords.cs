using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace GlitchlessSdk
{
    /// <summary>
    /// The checks on what a game says about a session (properties, SPEC §2 `props`) and on the IDs it marks a match,
    /// party or run with (groups, `group`). Properties are the game's words about the session, never about the person:
    /// keys that name a person or an account are dropped, and so are values shaped like an email address, a phone
    /// number, an ID or a link. Intake checks again, for older and other SDKs. PRIVACY.md describes both; keep the
    /// three in step.
    /// </summary>
    public static class GameWords
    {
        public const int MaxProperties = 12; // keys a session
        public const int MaxValue = 64; // characters of a string value
        public const long MaxNumber = 1_000_000;

        static readonly Regex Key = new Regex("^[a-z][a-z0-9_]{0,31}$");

        // The built-in splits and filters a property can't shadow, and the Steam facts (SPEC §4c).
        static readonly HashSet<string> Reserved = new HashSet<string>
        {
            "version", "level", "zone", "env", "platform", "browser", "device_tier", "session_type", "privacy", "role", "link", "type",
            "players", "sessions", "hours", "match", "party", "run",
            "steam_build", "steam_branch", "steam_hardware", "steam_deck", "proton", "big_picture", "steam_controller", "family_shared", "timed_trial", "steam_language",
        };

        // Keys that would make a property a person's identity.
        static readonly HashSet<string> Identifying = new HashSet<string>
        {
            "name", "username", "user", "email", "phone", "user_id", "account", "account_id", "player_id", "steam_id", "epic_id", "psn_id",
            "xbox_id", "ip", "address", "device_id", "idfa", "gaid", "ad_id", "location", "lat", "lon", "city", "birthday", "age", "gender",
        };

        static readonly Regex Email = new Regex(@"[^\s@]+@[^\s@]+\.[^\s@]+");
        static readonly Regex Url = new Regex(@"^[a-z][a-z0-9+.\-]*://|^www\.", RegexOptions.IgnoreCase);
        static readonly Regex Digits = new Regex(@"\d{7,}");
        static readonly Regex Phone = new Regex(@"\+?\(?\d[\d\s().\-]{5,}\d");
        static readonly Regex Band = new Regex(@"^\d{1,6} ?- ?\d{1,6}$"); // "3000-3499": a range, not a phone number
        static readonly Regex Uuid = new Regex(@"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", RegexOptions.IgnoreCase);
        static readonly Regex Hex = new Regex(@"^(?=.*\d)[0-9a-fA-F]{16,}$");
        static readonly Regex Base64 = new Regex(@"^[A-Za-z0-9+/_\-]{16,}={0,2}$");
        static readonly Regex Id = new Regex("^[A-Za-z0-9_.:-]{8,64}$");

        /// <summary>Why a property key can't be used, or null when it can.</summary>
        public static string CheckKey(string key)
        {
            if (key == null || !Key.IsMatch(key)) return "keys are lowercase words of letters, digits and _, up to 32 characters";
            if (Reserved.Contains(key)) return "it is a built-in split";
            if (Identifying.Contains(key)) return "it would say who the player is";
            return null;
        }

        /// <summary>The value as it is sent (a string trimmed to 64 characters, a boolean, or a whole number from
        /// -1,000,000 to 1,000,000; an enum as its name), or null with `why` set when it is dropped.</summary>
        public static object CleanValue(object value, out string why)
        {
            why = null;
            switch (value)
            {
                case null:
                    why = "null removes a property";
                    return null;
                case bool b:
                    return b;
                case string s:
                    return CleanWord(s, out why);
                case Enum e:
                    return CleanWord(e.ToString(), out why);
                case IConvertible c when IsNumber(c):
                    var d = c.ToDouble(CultureInfo.InvariantCulture);
                    if (double.IsNaN(d) || d != Math.Floor(d)) why = "numbers are whole numbers: send a band (\"30-39\") instead";
                    else if (Math.Abs(d) > MaxNumber) why = "numbers are between -1,000,000 and 1,000,000";
                    return why == null ? (object)(long)d : null;
                default:
                    why = "values are strings, booleans or whole numbers";
                    return null;
            }
        }

        static string CleanWord(string s, out string why)
        {
            why = null;
            s = s.Trim();
            if (s.Length > MaxValue) s = s.Substring(0, MaxValue);
            if (s.Length == 0) why = "it is empty";
            else if (LooksPersonal(s)) why = "it looks like an email address, a phone number, an ID or a link";
            return why == null ? s : null;
        }

        /// <summary>A value shaped like something that identifies a person or a device: an email address, a link, a phone
        /// number or any run of 7 digits, a UUID, or 16 or more characters of hex or base64 with no spaces.</summary>
        public static bool LooksPersonal(string s)
        {
            if (Email.IsMatch(s) || Url.IsMatch(s) || Digits.IsMatch(s) || Uuid.IsMatch(s) || Hex.IsMatch(s)) return true;
            if (Phone.IsMatch(s) && CountDigits(s) >= 7 && !Band.IsMatch(s)) return true;
            // Base64's letters are a word's letters too ("grandmaster_tier"), so only a string that changes between
            // upper case, lower case and digits as often as random text does reads as one.
            return Base64.IsMatch(s) && Changes(s) * 3 >= s.Length;
        }

        static int CountDigits(string s)
        {
            var n = 0;
            foreach (var c in s)
                if (c >= '0' && c <= '9') n++;
            return n;
        }

        static int Changes(string s)
        {
            int Kind(char c) => char.IsUpper(c) ? 0 : char.IsLower(c) ? 1 : char.IsDigit(c) ? 2 : 3;
            var n = 0;
            for (var i = 1; i < s.Length; i++)
                if (Kind(s[i]) != Kind(s[i - 1])) n++;
            return n;
        }

        internal static bool IsNumber(IConvertible c)
        {
            switch (c.GetTypeCode())
            {
                case TypeCode.Byte: case TypeCode.SByte: case TypeCode.Int16: case TypeCode.UInt16:
                case TypeCode.Int32: case TypeCode.UInt32: case TypeCode.Int64: case TypeCode.UInt64:
                case TypeCode.Single: case TypeCode.Double: case TypeCode.Decimal:
                    return true;
                default:
                    return false;
            }
        }

        // ───────────────────────────── groups ─────────────────────────────

        public static readonly string[] GroupKinds = { "match", "party", "run" };

        public static bool IsGroupKind(string kind) => Array.IndexOf(GroupKinds, kind) >= 0;

        /// <summary>8 to 64 characters of letters, digits and _ . : -, as every SDK and intake check them.</summary>
        public static bool ValidGroupId(string id) => id != null && Id.IsMatch(id);

        /// <summary>A match or party ID as it is sent by default: "h_" and the first 24 hex characters of SHA-1 over the
        /// service, a colon and the ID. Every Glitchless SDK hashes the same way, so a match played from a Unity client and
        /// a Godot or Unreal server keeps one ID. The salt is the game's own name, so the IDs can't be looked up in other
        /// games' logs, and a game's own logs only by someone who hashes them the same way.</summary>
        public static string HashGroupId(string service, string id)
        {
            byte[] hash;
            using (var sha = SHA1.Create()) hash = sha.ComputeHash(Encoding.UTF8.GetBytes(service + ":" + id));
            var sb = new StringBuilder("h_", 26);
            for (var i = 0; i < 12; i++) sb.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture));
            return sb.ToString();
        }
    }
}

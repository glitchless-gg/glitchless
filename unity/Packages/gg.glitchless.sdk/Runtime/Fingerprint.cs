using System.Text.RegularExpressions;

namespace GlitchlessSdk
{
    /// <summary>
    /// The browser SDK's error grouping key (packages/sdk/src/fingerprint.js): the kind, the message
    /// with long numbers and addresses blanked out, and the function it came from, hashed with 32-bit
    /// FNV-1a over UTF-16 code units, as JavaScript strings are.
    /// </summary>
    public static class Fingerprint
    {
        static readonly Regex Uncaught = new Regex(@"^Uncaught\s+");
        static readonly Regex LongNumbers = new Regex(@"[0-9]{3,}"); // JavaScript's \d: ASCII digits only
        static readonly Regex Hex = new Regex(@"0x[0-9a-f]+", RegexOptions.IgnoreCase);

        public static string NormalizeMessage(string message)
        {
            var s = Uncaught.Replace(message ?? "", "");
            s = LongNumbers.Replace(s, "N");
            s = Hex.Replace(s, "X");
            return s.Length > 200 ? s.Substring(0, 200) : s;
        }

        public static string Of(string kind, string message, string fn) => Hash($"{kind}|{NormalizeMessage(message)}|{fn ?? ""}");

        public static string Hash(string s)
        {
            uint h = 0x811c9dc5;
            foreach (var c in s)
            {
                h ^= c;
                h *= 0x01000193;
            }
            return h.ToString("x8");
        }
    }
}

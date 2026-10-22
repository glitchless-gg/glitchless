using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace GlitchlessSdk
{
    /// <summary>One frame of a stack trace.</summary>
    public struct StackFrame
    {
        public string Fn;
        public string File;
        public int Line;
    }

    /// <summary>
    /// Reads the stack traces Unity hands to Application.logMessageReceived, and .NET ones from
    /// Exception.StackTrace:
    ///   Player.Update () (at Assets/Scripts/Player.cs:42)
    ///   UnityEngine.Debug:LogError (object)
    ///   at Player.Update () [0x0001b] in /src/Player.cs:42
    ///   Player.Update () (at &lt;00000000000000000000000000000000&gt;:0)     (IL2CPP without line numbers)
    /// </summary>
    public static class StackParser
    {
        // Frames that are Unity's logging, not the game's code.
        static readonly string[] Plumbing = { "UnityEngine.Debug.", "UnityEngine.Logger.", "UnityEngine.DebugLogHandler.", "UnityEngine.Assertions.", "UnityEngine.MonoBehaviour.print", "System.Environment.", "System.Diagnostics.StackTrace." };

        public static List<StackFrame> Parse(string stack)
        {
            var frames = new List<StackFrame>();
            if (string.IsNullOrEmpty(stack)) return frames;
            foreach (var raw in stack.Split('\n'))
            {
                var line = raw.Trim();
                if (line.Length == 0) continue;
                if (line.StartsWith("at ", StringComparison.Ordinal)) line = line.Substring(3);
                var fnPart = line;
                string location = null;
                var at = line.IndexOf(" (at ", StringComparison.Ordinal);
                if (at >= 0)
                {
                    fnPart = line.Substring(0, at);
                    location = line.Substring(at + 5).TrimEnd(')');
                }
                else
                {
                    var inAt = line.IndexOf(" in ", StringComparison.Ordinal);
                    if (inAt >= 0)
                    {
                        fnPart = line.Substring(0, inAt);
                        location = line.Substring(inAt + 4).Trim();
                    }
                }
                var bracket = fnPart.IndexOf(" [0x", StringComparison.Ordinal);
                if (bracket >= 0) fnPart = fnPart.Substring(0, bracket);
                var paren = fnPart.IndexOf('(');
                var fn = (paren > 0 ? fnPart.Substring(0, paren) : fnPart).Trim().Replace(':', '.');
                if (fn.Length == 0 || fn.StartsWith("---", StringComparison.Ordinal)) continue; // "--- End of inner exception stack trace ---"
                var frame = new StackFrame { Fn = fn };
                if (location != null)
                {
                    var colon = location.LastIndexOf(':');
                    if (colon > 0)
                    {
                        var file = location.Substring(0, colon);
                        int.TryParse(location.Substring(colon + 1).Replace("line", "").Trim(), out var n);
                        if (!file.StartsWith("<", StringComparison.Ordinal))
                        {
                            frame.File = file;
                            frame.Line = n;
                        }
                    }
                }
                frames.Add(frame);
            }
            return frames;
        }

        public static bool IsPlumbing(StackFrame f)
        {
            foreach (var p in Plumbing)
                if (f.Fn.StartsWith(p, StringComparison.Ordinal)) return true;
            return false;
        }

        public static bool IsGlitchless(StackFrame f) => f.Fn.StartsWith("GlitchlessSdk.", StringComparison.Ordinal) && !f.Fn.StartsWith("GlitchlessSdk.Tests.", StringComparison.Ordinal);

        /// <summary>The frame to name as the error's place: the first in the game's own code (it has a source
        /// file), else the first outside .NET and Unity, else the first.</summary>
        public static int TopIndex(List<StackFrame> frames)
        {
            for (var i = 0; i < frames.Count; i++)
                if (frames[i].File != null) return i;
            for (var i = 0; i < frames.Count; i++)
                if (!frames[i].Fn.StartsWith("System.", StringComparison.Ordinal) && !frames[i].Fn.StartsWith("UnityEngine.", StringComparison.Ordinal) && !frames[i].Fn.StartsWith("Unity.", StringComparison.Ordinal)) return i;
            return frames.Count > 0 ? 0 : -1;
        }

        public static string BaseName(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;
            var i = Math.Max(path.LastIndexOf('/'), path.LastIndexOf('\\'));
            return i >= 0 ? path.Substring(i + 1) : path;
        }

        /// <summary>The stack as Glitchless sends it, the same shape as the Godot SDK's: "kind: message" then "    at fn (file:line)".</summary>
        public static string Format(string kind, string message, List<StackFrame> frames)
        {
            var sb = new StringBuilder();
            sb.Append(kind).Append(": ").Append(message);
            var n = 0;
            foreach (var f in frames)
            {
                if (++n > 20) break;
                sb.Append("\n    at ").Append(f.Fn);
                if (f.File != null) sb.Append(" (").Append(f.File).Append(':').Append(f.Line).Append(')');
            }
            var s = sb.ToString();
            return s.Length > 4000 ? s.Substring(0, 4000) : s;
        }
    }

    /// <summary>
    /// Error text can hold paths on the device, and a path can hold the computer's user name or, on
    /// iPhone, an ID made for this install of the app. Both go, in both privacy modes.
    /// </summary>
    public sealed class Scrubber
    {
        readonly List<(string, string)> paths = new List<(string, string)>();
        static readonly (Regex, string)[] Rules =
        {
            (new Regex(@"(/Users|/home)/[^/\s'""]+"), "$1/~"), // a macOS or Linux user name
            (new Regex(@"([A-Za-z]:[\\/]Users[\\/])[^\\/\s'""]+"), "$1~"), // a Windows one
            (new Regex(@"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"), "<id>"), // iOS app container IDs
        };

        /// <summary>Folders to shorten to a name, such as Application.persistentDataPath → "persistent:".</summary>
        public void AddPath(string path, string name)
        {
            if (!string.IsNullOrEmpty(path) && path.Length > 1) paths.Add((path.TrimEnd('/', '\\'), name));
        }

        public string Scrub(string text)
        {
            if (string.IsNullOrEmpty(text)) return text ?? "";
            var s = text;
            foreach (var (path, name) in paths) s = s.Replace(path, name);
            foreach (var (re, with) in Rules) s = re.Replace(s, with);
            return s;
        }
    }
}

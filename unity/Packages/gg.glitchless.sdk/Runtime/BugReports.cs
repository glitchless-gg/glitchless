using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;
#if GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace GlitchlessSdk
{
    /// <summary>
    /// Players send bug reports from inside the game (SPEC §2 bug_report): a hotkey opens a short form with a
    /// screenshot of the game, the player types what went wrong, and Glitchless sends it with where they were and
    /// what just happened. Set GlitchlessOptions.BugReports to turn the hotkey on; Glitchless.ReportBug() and
    /// Glitchless.OpenBugReport() work either way.
    /// </summary>
    public sealed class BugReportOptions
    {
        /// <summary>The key that opens and closes the form. KeyCode.None: no hotkey (Glitchless.OpenBugReport() still opens it).</summary>
        public KeyCode Hotkey = KeyCode.F8;
        /// <summary>While the form is open, Time.timeScale is 0 and the Input System's enabled actions are off, so the
        /// game neither moves nor acts on what the player types. Input read straight from UnityEngine.Input or a
        /// device can't be held back: check Glitchless.IsBugReportOpen there. False if the game pauses itself in OnOpen.</summary>
        public bool PauseGame = true;
        /// <summary>Send a screenshot of the game with each report.</summary>
        public bool Screenshot = true;
        /// <summary>The form opened: pause the game here if PauseGame is off.</summary>
        public Action OnOpen;
        /// <summary>The form closed: resume the game here if PauseGame is off.</summary>
        public Action OnClose;
    }

    /// <summary>A bug report's screenshot: the screen as Unity drew it, as a JPEG data URL small enough for the server.</summary>
    public static class BugScreenshot
    {
        /// <summary>Characters of data URL the server keeps; a larger one loses the picture, not the report.</summary>
        public const int MaxChars = 200_000;
        // Tried in order until the JPEG fits: the longer side in pixels, quality.
        static readonly (int size, int quality)[] Sizes = { (960, 70), (800, 60), (640, 60), (480, 50), (320, 50) };

        /// <summary>False where nothing is drawn (batch mode with -nographics).</summary>
        public static bool CanCapture => SystemInfo.graphicsDeviceType != GraphicsDeviceType.Null;

        /// <summary>The screen, read at the end of a frame (after WaitForEndOfFrame), or null.</summary>
        public static Texture2D Capture()
        {
            if (!CanCapture) return null;
            try
            {
                return ScreenCapture.CaptureScreenshotAsTexture();
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static string Fit(Texture2D texture, int maxChars = MaxChars) => texture == null ? null : Fit(texture.GetPixels32(), texture.width, texture.height, maxChars);

        /// <summary>A JPEG data URL of at most maxChars characters, or null when even the smallest size doesn't fit.
        /// Shrinks the picture (its longer side) and lowers the quality until it fits, as the browser SDK does.
        /// `pixels` are in Unity's order, bottom row first.</summary>
        public static string Fit(Color32[] pixels, int width, int height, int maxChars = MaxChars)
        {
            if (pixels == null || width <= 0 || height <= 0 || pixels.Length < width * height) return null;
            var rgb = new byte[width * height * 3];
            for (var i = 0; i < width * height; i++)
            {
                rgb[i * 3] = pixels[i].r;
                rgb[i * 3 + 1] = pixels[i].g;
                rgb[i * 3 + 2] = pixels[i].b;
            }
            int w = width, h = height, longest = Math.Max(width, height);
            foreach (var (size, quality) in Sizes)
            {
                var scale = Math.Min(1.0, (double)size / longest);
                int tw = Math.Max(1, (int)Math.Round(width * scale)), th = Math.Max(1, (int)Math.Round(height * scale));
                if (tw != w || th != h)
                {
                    rgb = Shrink(rgb, w, h, tw, th);
                    w = tw;
                    h = th;
                }
                var jpg = ImageConversion.EncodeArrayToJPG(rgb, GraphicsFormat.R8G8B8_SRGB, (uint)w, (uint)h, 0, quality);
                var url = "data:image/jpeg;base64," + Convert.ToBase64String(jpg);
                if (url.Length <= maxChars) return url;
            }
            return null;
        }

        // Each pixel of the smaller picture is the average of the ones it covers.
        static byte[] Shrink(byte[] src, int w, int h, int tw, int th)
        {
            var dst = new byte[tw * th * 3];
            for (var y = 0; y < th; y++)
            {
                int y0 = y * h / th, y1 = Math.Max(y0 + 1, (y + 1) * h / th);
                for (var x = 0; x < tw; x++)
                {
                    int x0 = x * w / tw, x1 = Math.Max(x0 + 1, (x + 1) * w / tw);
                    int r = 0, g = 0, b = 0, n = 0;
                    for (var yy = y0; yy < y1; yy++)
                    {
                        for (int i = (yy * w + x0) * 3, end = (yy * w + x1) * 3; i < end; i += 3)
                        {
                            r += src[i];
                            g += src[i + 1];
                            b += src[i + 2];
                            n++;
                        }
                    }
                    var o = (y * tw + x) * 3;
                    dst[o] = (byte)(r / n);
                    dst[o + 1] = (byte)(g / n);
                    dst[o + 2] = (byte)(b / n);
                }
            }
            return dst;
        }
    }

    /// <summary>
    /// The bug report form: the screenshot, a box for the player's note, Send and Cancel. It is drawn with IMGUI,
    /// so the game needs no Canvas or EventSystem, and reads keys the way uGUI's input field does (Event.PopEvent),
    /// so typing works with the Input Manager and with the Input System alike. Esc cancels, Ctrl+Enter (Cmd+Enter)
    /// sends; on a phone the system keyboard opens. The screenshot is taken before the form is drawn.
    /// </summary>
    [AddComponentMenu("")]
    sealed class BugReportForm : MonoBehaviour
    {
        enum State { Taking, Form, Sending, Sent, Offline, Failed }

        static readonly Color Back = new Color(0.03f, 0.05f, 0.09f, 0.55f);
        static readonly Color Panel = new Color32(0x14, 0x21, 0x3d, 255);
        static readonly Color Field = new Color32(0x0e, 0x18, 0x2e, 255);
        static readonly Color Edge = new Color32(0x2a, 0x3c, 0x63, 255);
        static readonly Color Accent = new Color32(0x2e, 0xe6, 0xa6, 255);
        static readonly Color Text = new Color32(0xee, 0xf3, 0xfb, 255);
        static readonly Color Muted = new Color32(0x8f, 0xa1, 0xc4, 255);

        internal GlitchlessCore Core;
        internal BugReportOptions Options = new BugReportOptions { Hotkey = KeyCode.None };
        public bool IsOpen { get; private set; }

        State state;
        string note = "", shot;
        Dictionary<string, object> snap;
        Texture2D preview;
        float closeAt = -1;
        int token;
        float timeScale = 1;
        CursorLockMode lockMode;
        bool cursorVisible = true;
        TouchScreenKeyboard keyboard;
        Rect sendRect, cancelRect, noteRect;
        readonly Event evt = new Event();
#if GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
        List<InputAction> held;
#endif

        void Awake()
        {
            useGUILayout = false;
            enabled = false; // Update and OnGUI run only while it's open
        }

        void OnDestroy()
        {
            if (preview) Destroy(preview);
            foreach (var t in textures) Destroy(t);
        }

        public void Toggle()
        {
            if (IsOpen) Close();
            else Open();
        }

        public void Open()
        {
            if (IsOpen || Core == null) return;
            IsOpen = true;
            enabled = true;
            state = State.Taking;
            note = "";
            closeAt = -1;
            snap = Core.BugSnapshot();
            StartCoroutine(Take(++token));
        }

        IEnumerator Take(int t)
        {
            if (Options.Screenshot && BugScreenshot.CanCapture)
            {
                yield return new WaitForEndOfFrame(); // the frame the player saw, before the form is drawn
                if (t != token) yield break;
                preview = BugScreenshot.Capture();
                shot = BugScreenshot.Fit(preview);
                Core.SkipNextFrame(); // reading the screen back stalls this frame: that isn't the game stuttering
            }
            if (t != token) yield break;
            state = State.Form;
            if (Options.PauseGame)
            {
                timeScale = Time.timeScale;
                Time.timeScale = 0;
                HoldInput(true);
            }
            lockMode = Cursor.lockState;
            cursorVisible = Cursor.visible;
            Cursor.lockState = CursorLockMode.None;
            Cursor.visible = true;
            if (TouchScreenKeyboard.isSupported) keyboard = TouchScreenKeyboard.Open("", TouchScreenKeyboardType.Default, false, true);
            while (Event.PopEvent(evt)) { } // keys pressed before the form opened aren't part of the note
            Call(Options.OnOpen, "OnOpen");
        }

        public void Close()
        {
            if (!IsOpen) return;
            IsOpen = false;
            enabled = false;
            token++;
            var shown = state != State.Taking;
            snap = null;
            shot = null;
            if (preview) Destroy(preview);
            preview = null;
            if (keyboard != null) keyboard.active = false;
            keyboard = null;
            if (!shown) return;
            if (Options.PauseGame)
            {
                Time.timeScale = timeScale;
                HoldInput(false);
            }
            Cursor.lockState = lockMode;
            Cursor.visible = cursorVisible;
            Call(Options.OnClose, "OnClose");
        }

        void Send()
        {
            if (state != State.Form) return;
            state = State.Sending;
            var t = token;
            Core.SendBugReport(snap, note.TrimEnd(), shot, (sent, reason) =>
            {
                if (t != token) return; // closed meanwhile
                state = sent ? State.Sent : reason == "offline" ? State.Offline : State.Failed;
                closeAt = Time.unscaledTime + (sent ? 1.2f : 2.5f);
            });
        }

        void Update()
        {
            if (state == State.Taking) return;
            if (closeAt >= 0 && Time.unscaledTime >= closeAt)
            {
                Close();
                return;
            }
            if (keyboard != null && state == State.Form && keyboard.status != TouchScreenKeyboard.Status.Canceled) note = Cap(keyboard.text ?? "");
            while (IsOpen && Event.PopEvent(evt))
                if (evt.type == EventType.KeyDown) OnKey(evt);
            if (IsOpen && PointerDown(out var at)) Click(new Vector2(at.x, Screen.height - at.y));
        }

        internal string Note => note;
        internal string Status => state.ToString();

        // One key from the event queue (tests feed it events too).
        internal void OnKey(Event e)
        {
            var mod = e.control || e.command;
            switch (e.keyCode)
            {
                case KeyCode.Escape:
                    Close();
                    return;
                case KeyCode.Return:
                case KeyCode.KeypadEnter:
                    if (!mod) break;
                    Send();
                    return;
                case KeyCode.Backspace:
                    if (state == State.Form && note.Length > 0) note = note.Substring(0, note.Length - 1);
                    return;
                case KeyCode.V:
                    if (!mod) break;
                    Type(GUIUtility.systemCopyBuffer);
                    return;
            }
            if (e.keyCode != KeyCode.None && e.keyCode == Options.Hotkey) return; // the runner opens and closes the form
            var c = e.character;
            if (c == '\r' || c == (char)3) c = '\n';
            if (c == '\n' ? !mod : c != 0 && !char.IsControl(c)) Type(c.ToString());
        }

        void Type(string s)
        {
            if (state == State.Form && !string.IsNullOrEmpty(s)) note = Cap(note + s);
        }

        static string Cap(string s) => s.Length > GlitchlessCore.MaxNote ? s.Substring(0, GlitchlessCore.MaxNote) : s;

        void Click(Vector2 at)
        {
            if (sendRect.Contains(at)) Send();
            else if (cancelRect.Contains(at)) Close();
            else if (noteRect.Contains(at) && TouchScreenKeyboard.isSupported && (keyboard == null || !keyboard.active))
                keyboard = TouchScreenKeyboard.Open(note, TouchScreenKeyboardType.Default, false, true);
        }

        static void Call(Action action, string name)
        {
            try
            {
                action?.Invoke();
            }
            catch (Exception e)
            {
                UnityEngine.Debug.LogException(e);
                UnityEngine.Debug.LogWarning($"[glitchless] BugReports.{name} threw");
            }
        }

        // The game's Input System actions are off while the form is open, then on again.
        void HoldInput(bool hold)
        {
#if GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            if (hold)
            {
                held = InputSystem.ListEnabledActions();
                foreach (var a in held) a.Disable();
                return;
            }
            if (held == null) return;
            foreach (var a in held)
            {
                try
                {
                    a.Enable();
                }
                catch (Exception)
                {
                    // the game disposed of it meanwhile
                }
            }
            held = null;
#endif
        }

        // ───────────────────────────── input ─────────────────────────────

        /// <summary>The key went down this frame, read from the Input System when the game uses it, else the Input Manager.</summary>
        internal static bool KeyDown(KeyCode key)
        {
#if GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            var k = Keyboard.current;
            var mapped = InputKey(key);
            if (k != null && mapped != Key.None) return k[mapped].wasPressedThisFrame;
#endif
#if ENABLE_LEGACY_INPUT_MANAGER
            return Input.GetKeyDown(key);
#else
            return false;
#endif
        }

#if GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
        // KeyCode and the Input System's Key mostly share names.
        static Key InputKey(KeyCode key)
        {
            var name = key.ToString();
            if (key >= KeyCode.Alpha0 && key <= KeyCode.Alpha9) name = "Digit" + (key - KeyCode.Alpha0);
            else if (key >= KeyCode.Keypad0 && key <= KeyCode.Keypad9) name = "Numpad" + (key - KeyCode.Keypad0);
            else if (key == KeyCode.Return) name = "Enter";
            else if (key == KeyCode.KeypadEnter) name = "NumpadEnter";
            return Enum.TryParse<Key>(name, true, out var k) ? k : Key.None;
        }
#endif

        // A click or tap that started this frame, in screen pixels from the bottom left.
        static bool PointerDown(out Vector2 at)
        {
#if GLITCHLESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            var p = Pointer.current;
            if (p != null && p.press.wasPressedThisFrame)
            {
                at = p.position.ReadValue();
                return true;
            }
#endif
#if ENABLE_LEGACY_INPUT_MANAGER
            if (Input.GetMouseButtonDown(0))
            {
                at = Input.mousePosition;
                return true;
            }
#endif
            at = default;
            return false;
        }

        // ───────────────────────────── drawing ─────────────────────────────

        readonly List<Texture2D> textures = new List<Texture2D>();
        float stylesFor = -1;
        GUIStyle panel, field, noteBox, noteFocus, button, sendButton, title, body, muted, small, smallLeft, smallCenter, centered;

        void OnGUI()
        {
            if (state == State.Taking || Event.current.type != EventType.Repaint) return;
            GUI.depth = -10000; // over the game's own OnGUI
            var s = Mathf.Clamp(Mathf.Min(Screen.width, Screen.height) / 540f, 1f, 4f);
            Styles(s);
            var view = new Rect(0, 0, Screen.width, Screen.height);
            var tint = GUI.color;
            GUI.color = Back;
            GUI.DrawTexture(view, Texture2D.whiteTexture);
            GUI.color = tint;

            float pad = 14 * s, gap = 10 * s, w = Mathf.Min(380 * s, Screen.width - 32 * s), inner = w - 2 * pad;
            var form = state == State.Form || state == State.Sending;
            float shotH = Mathf.Round(inner * 9 / 16), noteH = 92 * s, rowH = 30 * s, footH = small.CalcHeight(new GUIContent(Footnote), inner);
            var h = pad + 20 * s + gap + (form ? shotH + gap + noteH + gap + rowH + 8 * s + footH : 64 * s) + pad;
            var box = new Rect(Mathf.Round((Screen.width - w) / 2), Mathf.Round((Screen.height - h) / 2), w, h);
            GUI.Box(box, GUIContent.none, panel);
            var y = box.y + pad;
            GUI.Label(new Rect(box.x + pad, y, inner, 20 * s), "Report a bug", title);
            y += 20 * s + gap;
            if (!form)
            {
                var done = state == State.Sent ? "Thanks! Your report was sent." : state == State.Offline ? "Not sent: this build has no Glitchless intake." : "Couldn't send it now. It will be sent with the game's next batch.";
                GUI.Label(new Rect(box.x + pad, y, inner, 64 * s), done, centered);
                sendRect = cancelRect = noteRect = Rect.zero;
                return;
            }

            var shotRect = new Rect(box.x + pad, y, inner, shotH);
            GUI.Box(shotRect, GUIContent.none, field);
            if (preview) GUI.DrawTexture(shotRect, preview, ScaleMode.ScaleToFit);
            else GUI.Label(shotRect, Options.Screenshot ? "No screenshot: nothing is drawn in this build." : "Screenshots are off for this game.", smallCenter);
            y += shotH + gap;

            noteRect = new Rect(box.x + pad, y, inner, noteH);
            GUI.Box(noteRect, GUIContent.none, state == State.Form ? noteFocus : noteBox);
            var text = noteRect;
            text.xMin += 9 * s;
            text.xMax -= 9 * s;
            text.yMin += 7 * s;
            text.yMax -= 7 * s;
            var caret = state == State.Form && (int)(Time.unscaledTime * 2) % 2 == 0 ? "|" : "";
            var content = new GUIContent(note.Length > 0 ? note + caret : caret);
            var textH = body.CalcHeight(content, text.width);
            GUI.BeginGroup(text);
            if (note.Length == 0) GUI.Label(new Rect(0, 0, text.width, text.height), "What went wrong? What did you expect?", muted);
            GUI.Label(new Rect(0, Mathf.Min(0, text.height - textH), text.width, textH), content, body); // the end of a long note stays in view
            GUI.EndGroup();
            y += noteH + gap;

            float sendW = 76 * s, cancelW = 70 * s;
            sendRect = new Rect(box.xMax - pad - sendW, y, sendW, rowH);
            cancelRect = new Rect(sendRect.x - 8 * s - cancelW, y, cancelW, rowH);
            if (!Application.isMobilePlatform) GUI.Label(new Rect(box.x + pad, y, cancelRect.x - box.x - pad - 8 * s, rowH), "Ctrl+Enter sends · Esc cancels", smallLeft);
            GUI.Box(cancelRect, "Cancel", button);
            var sending = state == State.Sending;
            if (sending) GUI.color = new Color(1, 1, 1, 0.6f);
            GUI.Box(sendRect, sending ? "Sending…" : "Send", sendButton);
            GUI.color = tint;
            y += rowH + 8 * s;
            GUI.Label(new Rect(box.x + pad, y, inner, footH), Footnote, small);
        }

        const string Footnote = "Sends your note, the screenshot and where you are in the game to its developers.";

        void Styles(float s)
        {
            if (Mathf.Approximately(stylesFor, s) && panel != null) return;
            stylesFor = s;
            foreach (var t in textures) Destroy(t);
            textures.Clear();
            var r = Mathf.RoundToInt(6 * s);
            panel = Boxed(Rounded(Panel, Color.Lerp(Panel, Accent, 0.35f), Mathf.RoundToInt(12 * s)), Mathf.RoundToInt(12 * s));
            field = Boxed(Rounded(Field, Field, r), r);
            noteBox = Boxed(Rounded(Field, Edge, r), r);
            noteFocus = Boxed(Rounded(Field, Accent, r), r);
            button = Boxed(Rounded(Panel, Edge, r), r);
            sendButton = Boxed(Rounded(Accent, Accent, r), r);
            foreach (var b in new[] { button, sendButton })
            {
                b.alignment = TextAnchor.MiddleCenter;
                b.fontSize = Mathf.RoundToInt(12.5f * s);
                b.fontStyle = FontStyle.Bold;
            }
            button.normal.textColor = Text;
            sendButton.normal.textColor = Panel;
            title = Label(15 * s, Text);
            title.fontStyle = FontStyle.Bold;
            body = Label(13 * s, Text);
            muted = Label(13 * s, Muted);
            small = Label(11 * s, Muted);
            smallLeft = new GUIStyle(small) { alignment = TextAnchor.MiddleLeft };
            smallCenter = new GUIStyle(small) { alignment = TextAnchor.MiddleCenter };
            centered = Label(14 * s, Text);
            centered.alignment = TextAnchor.MiddleCenter;
            centered.fontStyle = FontStyle.Bold;
        }

        static GUIStyle Label(float size, Color color) => new GUIStyle(GUI.skin.label)
        {
            fontSize = Mathf.RoundToInt(size),
            wordWrap = true,
            padding = new RectOffset(0, 0, 0, 0),
            margin = new RectOffset(0, 0, 0, 0),
            normal = { textColor = color },
        };

        static GUIStyle Boxed(Texture2D background, int radius) => new GUIStyle
        {
            normal = { background = background },
            border = new RectOffset(radius + 2, radius + 2, radius + 2, radius + 2),
        };

        // A rounded rectangle with a one-pixel edge, drawn nine-sliced by GUIStyle.border.
        Texture2D Rounded(Color fill, Color edge, int radius)
        {
            var size = radius * 2 + 6;
            var t = new Texture2D(size, size, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave, wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };
            var px = new Color[size * size];
            var half = size / 2f;
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    // Distance to the rectangle's rounded outline, below zero inside.
                    float qx = Mathf.Abs(x + 0.5f - half) - (half - radius), qy = Mathf.Abs(y + 0.5f - half) - (half - radius);
                    var d = new Vector2(Mathf.Max(qx, 0), Mathf.Max(qy, 0)).magnitude + Mathf.Min(Mathf.Max(qx, qy), 0) - radius;
                    var c = Color.Lerp(edge, fill, Mathf.Clamp01(-0.5f - d));
                    c.a *= Mathf.Clamp01(0.5f - d);
                    px[y * size + x] = c;
                }
            }
            t.SetPixels(px);
            t.Apply(false, true);
            textures.Add(t);
            return t;
        }
    }
}

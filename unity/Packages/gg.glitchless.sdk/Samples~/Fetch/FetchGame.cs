using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using GlitchlessSdk;
using UnityEngine;
using UnityEngine.SceneManagement;
#if UNITY_EDITOR
using UnityEditor;
#endif

namespace GlitchlessSamples.Fetch
{
    /// <summary>
    /// Fetch!: a small runner that shows Glitchless at work. A purple pup runs right on its own; jump over
    /// pits, fire hydrants and squirrels to reach the flag at the end of three levels. Everything is built
    /// from primitives at runtime, and each level is its own scene (SceneManager.CreateScene), so Glitchless
    /// reports levels with no extra code.
    ///
    /// It has four planted bugs for Glitchless to find, each marked GLITCHLESS-DEMO. Don't fix them.
    ///
    /// Command line (a built player): --autoplay --seed=7 --skill=0.9 --level=2 --privacy=full --quit-after=60
    /// </summary>
    public sealed class FetchGame : MonoBehaviour
    {
        [Header("Glitchless")]
        public string service = "fetch-unity";
        public string intake = "http://localhost:7777";
        public string clientToken = "gl_pub_dev";

        [Header("Play")]
        public bool autoplay;
        [Range(0, 1)] public float skill = 0.8f;
        public int seed = 7;
        [Range(1, 3)] public int startLevel = 1;

        const float Speed = 2.6f;
        const float ZoomiesSpeed = 3.9f;
        const float JumpVy = 7.2f;
        const float Gravity = 18f;
        const int Lives = 3;
        const float CoyoteS = 0.09f;
        const float BufferS = 0.11f;

        // GLITCHLESS-DEMO: no entry for "frisbee", so catching one throws (see CatchToy).
        static readonly Dictionary<string, float> PowerupSeconds = new Dictionary<string, float> { ["tennis_ball"] = 3 };

        FetchLevel level;
        int levelIndex;
        Scene levelScene;
        Transform dog;
        Vector2 pos, vel;
        bool grounded, dead, busy, finished;
        float lastGrounded = -1, jumpAt = -1, boostUntil, respawnUntil, checkpoint, levelStartedAt;
        int lives, score, confetti, attempt;
        string banner, lastBurst;
        float quitAfter;
        FetchBot bot;
        Camera cam;
        Material baseMaterial;
        readonly Dictionary<Color, Material> shared = new Dictionary<Color, Material>();
        readonly List<Transform> squirrels = new List<Transform>();
        readonly List<float[]> squirrelPatrol = new List<float[]>();
        readonly List<GameObject> bones = new List<GameObject>(), balls = new List<GameObject>(), frisbees = new List<GameObject>();

        void Awake()
        {
            ReadArgs(out var full);
            Application.targetFrameRate = 60;
            Time.fixedDeltaTime = 1 / 60f;
            Glitchless.Init(new GlitchlessOptions
            {
                Service = service,
                Intake = intake,
                ClientToken = clientToken,
                Privacy = full ? Privacy.Full : Privacy.Anonymous,
                Positions = true, // anonymous, plus death places and movement for the heatmap
                SessionType = autoplay ? "synthetic" : "",
            });
            if (autoplay) bot = new FetchBot(skill, seed);

            var probe = GameObject.CreatePrimitive(PrimitiveType.Cube); // borrow the pipeline's default material
            baseMaterial = probe.GetComponent<Renderer>().sharedMaterial;
            Destroy(probe);
            cam = new GameObject("Camera").AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.56f, 0.79f, 0.9f);
            cam.fieldOfView = 40;
            var sun = new GameObject("Sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.transform.rotation = Quaternion.Euler(40, -30, 0);
            StartCoroutine(LoadLevel(Mathf.Clamp(startLevel, 1, FetchLevel.All.Length) - 1));
        }

        void ReadArgs(out bool full)
        {
            full = false;
            foreach (var a in Environment.GetCommandLineArgs())
            {
                if (a == "--autoplay") autoplay = true;
                else if (a.StartsWith("--seed=")) int.TryParse(a.Substring(7), out seed);
                else if (a.StartsWith("--skill=")) float.TryParse(a.Substring(8), NumberStyles.Float, CultureInfo.InvariantCulture, out skill);
                else if (a.StartsWith("--level=")) int.TryParse(a.Substring(8), out startLevel);
                else if (a == "--privacy=full") full = true;
                else if (a.StartsWith("--quit-after=")) float.TryParse(a.Substring(13), NumberStyles.Float, CultureInfo.InvariantCulture, out quitAfter);
            }
        }

        // ───────────────────────────── levels ─────────────────────────────

        IEnumerator LoadLevel(int index)
        {
            busy = true;
            if (levelScene.IsValid())
            {
                // GLITCHLESS-DEMO: mesh leak. Unloading the level destroys its GameObjects, but the meshes and
                // materials made for its ground tiles (see BuildGround) are never destroyed, so every level
                // load leaves another set behind.
                var old = levelScene;
                levelScene = default;
                yield return SceneManager.UnloadSceneAsync(old);
            }
            levelIndex = index;
            level = FetchLevel.All[index];
            levelScene = SceneManager.CreateScene(level.Id); // a new active scene: Glitchless sends level_start
            SceneManager.SetActiveScene(levelScene);
            Build();
            lives = Lives;
            attempt++;
            dead = false;
            boostUntil = respawnUntil = 0;
            checkpoint = 1.2f;
            pos = new Vector2(checkpoint, 0);
            vel = Vector2.zero;
            levelStartedAt = Time.time;
            banner = null;
            bot?.NewAttempt();
            busy = false;
        }

        void Build()
        {
            squirrels.Clear();
            squirrelPatrol.Clear();
            bones.Clear();
            balls.Clear();
            frisbees.Clear();
            BuildGround();
            foreach (var x in level.Hydrants) Prop(PrimitiveType.Cylinder, new Vector3(x, 0.2f, 0), new Vector3(0.24f, 0.2f, 0.24f), new Color(0.9f, 0.22f, 0.27f));
            foreach (var s in level.Squirrels)
            {
                squirrels.Add(Prop(PrimitiveType.Sphere, new Vector3(s[0], 0.15f, 0), new Vector3(0.32f, 0.28f, 0.3f), new Color(0.61f, 0.42f, 0.24f)).transform);
                squirrelPatrol.Add(new[] { s[0], s[1], -0.8f });
            }
            foreach (var b in level.Bones) bones.Add(Prop(PrimitiveType.Capsule, new Vector3(b[0], b[1], 0), new Vector3(0.1f, 0.13f, 0.1f), new Color(1f, 0.96f, 0.84f), Quaternion.Euler(0, 0, 90)));
            foreach (var x in level.Balls) balls.Add(Prop(PrimitiveType.Sphere, new Vector3(x, 0.3f, 0), Vector3.one * 0.2f, new Color(0.84f, 0.94f, 0.29f)));
            foreach (var f in level.Frisbees) frisbees.Add(Prop(PrimitiveType.Cylinder, new Vector3(f[0], f[1], 0), new Vector3(0.32f, 0.03f, 0.32f), new Color(1f, 0.48f, 0.71f)));
            Prop(PrimitiveType.Cube, new Vector3(level.Goal, 0.45f, 0), new Vector3(0.05f, 0.9f, 0.05f), Color.white);
            Prop(PrimitiveType.Cube, new Vector3(level.Goal + 0.12f, 0.8f, 0), new Vector3(0.24f, 0.2f, 0.03f), new Color(0.18f, 0.77f, 0.71f));
            var body = Prop(PrimitiveType.Cube, Vector3.zero, new Vector3(0.4f, 0.24f, 0.28f), new Color(0.48f, 0.36f, 1f));
            dog = body.transform;
            Prop(PrimitiveType.Cube, Vector3.zero, new Vector3(0.45f, 0.6f, 0.8f), new Color(0.48f, 0.36f, 1f)).transform.SetParent(dog, false);
            dog.GetChild(0).localPosition = new Vector3(0.45f, 0.55f, 0);
        }

        // Ground tiles, a metre each, with a little colour jitter so the ground looks hand-painted.
        void BuildGround()
        {
            var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
            var cubeMesh = cube.GetComponent<MeshFilter>().sharedMesh;
            Destroy(cube);
            var rng = new System.Random(levelIndex);
            var x = -3f;
            var pits = new List<float[]>(level.Pits) { new[] { level.Length + 6, level.Length + 6 } };
            pits.Sort((a, b) => a[0].CompareTo(b[0]));
            foreach (var pit in pits)
            {
                for (var t = x; t < pit[0] - 0.001f; t += 1)
                {
                    var w = Mathf.Min(1, pit[0] - t);
                    var tile = new GameObject("tile");
                    tile.transform.position = new Vector3(t + w / 2, -0.6f, 0);
                    tile.transform.localScale = new Vector3(w, 1.2f, 1.2f);
                    // The tile's own copy of the cube mesh and of its material, made at runtime: see LoadLevel.
                    tile.AddComponent<MeshFilter>().mesh = Instantiate(cubeMesh);
                    var r = tile.AddComponent<MeshRenderer>();
                    r.sharedMaterial = baseMaterial;
                    var g = 0.62f + (float)rng.NextDouble() * 0.08f;
                    r.material.color = new Color(0.3f, g, 0.31f);
                }
                x = pit[1];
            }
        }

        GameObject Prop(PrimitiveType type, Vector3 at, Vector3 scale, Color color, Quaternion? rotation = null)
        {
            var go = GameObject.CreatePrimitive(type);
            Destroy(go.GetComponent<Collider>()); // the game does its own collisions
            go.transform.SetPositionAndRotation(at, rotation ?? Quaternion.identity);
            go.transform.localScale = scale;
            if (!shared.TryGetValue(color, out var m)) shared[color] = m = new Material(baseMaterial) { color = color };
            go.GetComponent<Renderer>().sharedMaterial = m;
            return go;
        }

        // ───────────────────────────── play ─────────────────────────────

        void Update()
        {
            if (quitAfter > 0 && !finished && Time.realtimeSinceStartup > quitAfter) Done("Time's up.");
            if (WantsJumpKey()) jumpAt = Time.time;
            if (dog != null) dog.position = new Vector3(pos.x, pos.y + 0.12f, 0);
            if (cam != null) cam.transform.SetPositionAndRotation(new Vector3(pos.x + 2.4f, 1.4f, -7.5f), Quaternion.Euler(4, 0, 0));
        }

        static bool WantsJumpKey()
        {
#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
            var k = UnityEngine.InputSystem.Keyboard.current;
            var p = UnityEngine.InputSystem.Pointer.current;
            return (k != null && (k.spaceKey.wasPressedThisFrame || k.upArrowKey.wasPressedThisFrame)) || (p != null && p.press.wasPressedThisFrame);
#else
            return Input.GetKeyDown(KeyCode.Space) || Input.GetKeyDown(KeyCode.UpArrow) || Input.GetMouseButtonDown(0);
#endif
        }

        void FixedUpdate()
        {
            if (busy || dead || finished || level == null) return;
            var t = Time.time;
            var dt = Time.fixedDeltaTime;
            var speed = t < respawnUntil ? 0 : t < boostUntil ? ZoomiesSpeed : Speed;
            vel.x = speed;
            if (bot != null && bot.WantsJump(pos.x, speed > 0 ? speed : Speed, grounded, level, Squirrels())) jumpAt = t;
            if (t - jumpAt < BufferS && t - lastGrounded < CoyoteS)
            {
                vel.y = JumpVy;
                jumpAt = lastGrounded = -1;
                grounded = false;
            }
            var wasAbove = pos.y >= 0;
            var prevX = pos.x;
            vel.y -= Gravity * dt;
            pos += vel * dt;
            if (pos.y < -0.02f && OverGround(pos.x + 0.2f)) pos.x = prevX; // in a pit: its far wall stops the dog
            if (OverGround(pos.x) && pos.y <= 0 && wasAbove)
            {
                pos.y = 0;
                vel.y = 0;
                grounded = true;
                lastGrounded = t;
            }
            else grounded = false;

            for (var i = 0; i < squirrels.Count; i++)
            {
                var s = squirrels[i];
                if (!s.gameObject.activeSelf) continue;
                var p = squirrelPatrol[i];
                if (s.position.x < p[0] - p[1]) p[2] = 0.8f;
                else if (s.position.x > p[0] + p[1]) p[2] = -0.8f;
                s.position += new Vector3(p[2] * dt, 0, 0);
            }
            Collide();
            foreach (var c in level.Checkpoints)
                if (pos.x > c && checkpoint < c) checkpoint = c;

            Glitchless.SetPosition(pos);
            Glitchless.SetContext("confetti", confetti);
        }

        IEnumerable<(int, float)> Squirrels()
        {
            for (var i = 0; i < squirrels.Count; i++)
                if (squirrels[i].gameObject.activeSelf) yield return (i, squirrels[i].position.x);
        }

        bool OverGround(float x)
        {
            if (x < -3 || x > level.Length + 6) return false;
            foreach (var p in level.Pits)
                if (x > p[0] && x < p[1]) return false;
            return true;
        }

        void Collide()
        {
            if (pos.y < -2.5f)
            {
                Die("fell");
                return;
            }
            foreach (var h in level.Hydrants)
            {
                if (Mathf.Abs(pos.x - h) < 0.32f && pos.y < 0.38f)
                {
                    Die("hydrant");
                    return;
                }
            }
            foreach (var s in squirrels)
            {
                if (!s.gameObject.activeSelf || Mathf.Abs(pos.x - s.position.x) > 0.36f || pos.y > 0.3f) continue;
                if (vel.y < 0 && pos.y > 0.12f)
                {
                    s.gameObject.SetActive(false);
                    vel.y = 4.8f;
                    Glitchless.Track("stomp", "squirrel");
                }
                else
                {
                    Die("squirrel");
                    return;
                }
            }
            var centre = pos + new Vector2(0, 0.16f);
            foreach (var b in bones)
            {
                if (!b.activeSelf || Vector2.Distance(centre, b.transform.position) > 0.32f) continue;
                b.SetActive(false);
                score += 10;
                Glitchless.Track("bone_collected");
            }
            foreach (var b in balls)
            {
                if (!b.activeSelf || Vector2.Distance(centre, b.transform.position) > 0.32f) continue;
                b.SetActive(false);
                FetchBall();
            }
            foreach (var f in frisbees)
            {
                if (!f.activeSelf || Vector2.Distance(centre, f.transform.position) > 0.36f) continue;
                f.SetActive(false);
                CatchToy("frisbee");
            }
            if (pos.x >= level.Goal) StartCoroutine(Finish());
        }

        /// <summary>The tennis-ball pickup: zoomies, and confetti. Also called by the agent API.</summary>
        public void FetchBall()
        {
            boostUntil = Time.time + PowerupSeconds["tennis_ball"];
            Glitchless.Track("powerup", "tennis_ball");
            ConfettiBurst(new Vector3(pos.x, pos.y + 0.3f, 0));
        }

        // GLITCHLESS-DEMO: confetti. 500 cubes made one at a time, each with its own material and a
        // Rigidbody, and a label built by string concatenation. They are never destroyed, so the physics
        // step keeps simulating every piece ever thrown, and the burst frame allocates enough to collect.
        void ConfettiBurst(Vector3 at)
        {
            var label = "";
            var rng = new System.Random(confetti);
            for (var i = 0; i < 500; i++)
            {
                var c = GameObject.CreatePrimitive(PrimitiveType.Cube);
                c.transform.position = at + new Vector3(0, 0, (float)rng.NextDouble() * 0.4f - 0.2f);
                c.transform.localScale = Vector3.one * 0.06f;
                c.GetComponent<Renderer>().material.color = Color.HSVToRGB((float)rng.NextDouble(), 0.8f, 1f);
                var rb = c.AddComponent<Rigidbody>();
                rb.AddForce(new Vector3((float)rng.NextDouble() * 6 - 2, 3 + (float)rng.NextDouble() * 5, 0), ForceMode.VelocityChange);
                label += i + ",";
                confetti++;
            }
            lastBurst = label;
        }

        void CatchToy(string kind)
        {
            var seconds = PowerupSeconds[kind]; // KeyNotFoundException: there is no "frisbee"
            boostUntil = Time.time + seconds;
            Glitchless.Track("powerup", kind);
        }

        void Die(string cause)
        {
            if (dead) return;
            dead = true;
            Glitchless.Death(pos, cause);
            lives--;
            var quit = bot != null && bot.Died(pos.x);
            StartCoroutine(AfterDeath(cause, quit));
        }

        IEnumerator AfterDeath(string cause, bool quit)
        {
            yield return new WaitForSeconds(0.6f);
            if (quit)
            {
                Done("The bot gave up.");
                yield break;
            }
            if (lives <= 0)
            {
                Glitchless.LevelFail(level.Id, cause);
                yield return LoadLevel(levelIndex);
                yield break;
            }
            pos = new Vector2(checkpoint, 0);
            vel = Vector2.zero;
            boostUntil = 0;
            respawnUntil = Time.time + 0.4f;
            dead = false;
        }

        IEnumerator Finish()
        {
            dead = true;
            Glitchless.LevelComplete(level.Id, score, Time.time - levelStartedAt);
            yield return new WaitForSeconds(0.5f);
            if (levelIndex + 1 < FetchLevel.All.Length) yield return LoadLevel(levelIndex + 1);
            else Done("Good dog!");
        }

        // The run is over. A bot run closes the game, the way a player would.
        void Done(string text)
        {
            finished = true;
            banner = text;
            if (!autoplay) return;
            StartCoroutine(Quit());
        }

        IEnumerator Quit()
        {
            yield return new WaitForSeconds(1.5f);
#if UNITY_EDITOR
            EditorApplication.isPlaying = false;
#else
            Application.Quit();
#endif
        }

        /// <summary>For agents and the console: what the game is doing.</summary>
        public string State() => Json.Serialize(new Dictionary<string, object>
        {
            ["level"] = level?.Id,
            ["x"] = pos.x,
            ["y"] = pos.y,
            ["lives"] = lives,
            ["score"] = score,
            ["confetti"] = confetti,
            ["attempt"] = attempt,
            ["last_burst"] = lastBurst?.Length ?? 0,
        });

        void OnGUI()
        {
            var style = new GUIStyle(GUI.skin.label) { fontSize = 22, fontStyle = FontStyle.Bold, normal = { textColor = new Color(0.08f, 0.13f, 0.24f) } };
            GUI.Label(new Rect(16, 10, 600, 32), $"{level?.Name}   bones {score}   lives {lives}", style);
            if (banner != null) GUI.Label(new Rect(Screen.width / 2f - 150, Screen.height / 2f - 30, 300, 60), banner, new GUIStyle(style) { fontSize = 40, alignment = TextAnchor.MiddleCenter });
        }
    }
}

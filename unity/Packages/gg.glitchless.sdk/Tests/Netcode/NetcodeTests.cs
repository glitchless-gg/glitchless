using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using NUnit.Framework;
using Unity.Netcode;
using Unity.Netcode.Transports.UTP;
using UnityEngine;
using UnityEngine.TestTools;

namespace GlitchlessSdk.Tests
{
    /// <summary>
    /// A real Netcode for GameObjects match in one Play mode run: a dedicated server and a client over Unity Transport on
    /// this machine, each with a Glitchless core reading its own NetworkManager. What each sends is checked against the
    /// wire format of docs/design/genre-coverage.md (A7 groups, A8 net and disconnects, A9 server windows). This assembly
    /// compiles only where NGO 2.x is installed, as it is in the package's test project (unity/).
    /// </summary>
    public class NetcodeTests
    {
        /// <summary>An intake that takes everything and keeps what it was sent.</summary>
        sealed class Intake : ITransport
        {
            public readonly List<string> Bodies = new List<string>();

            public void Send(string url, byte[] body, string contentType, Action<long> done)
            {
                Bodies.Add(Text(body));
                done(202);
            }

            public long SendNow(string url, byte[] body, string contentType, int timeoutMs)
            {
                Bodies.Add(Text(body));
                return 202;
            }

            public void Get(string url, Action<long, string> done) => done(200, "{\"ok\":true,\"features\":[\"counts\",\"props\",\"groups\",\"net\",\"server_mode\"]}");

            public void Abort() { }

            static string Text(byte[] body)
            {
                if (body.Length < 2 || body[0] != 0x1f || body[1] != 0x8b) return Encoding.UTF8.GetString(body);
                using (var gz = new GZipStream(new MemoryStream(body), CompressionMode.Decompress))
                using (var r = new StreamReader(gz)) return r.ReadToEnd();
            }

            public IEnumerable<Dictionary<string, object>> Envelopes => Bodies.Select(b => (Dictionary<string, object>)Json.Parse(b));

            public List<Dictionary<string, object>> Events(string type) =>
                Envelopes.SelectMany(e => ((List<object>)e["events"]).Cast<Dictionary<string, object>>()).Where(e => (string)e["type"] == type).ToList();
        }

        const string Service = "arena-test";
        const string MatchId = "lobby_0123456789"; // a Lobby or Multiplayer Services session ID would go here

        readonly List<GameObject> made = new List<GameObject>();

        [TearDown]
        public void TearDown()
        {
            foreach (var go in made)
            {
                if (!go) continue;
                var nm = go.GetComponent<NetworkManager>();
                if (nm && nm.IsListening) nm.Shutdown(true);
                UnityEngine.Object.Destroy(go);
            }
            made.Clear();
            LogAssert.ignoreFailingMessages = false;
        }

        static ushort FreePort()
        {
            using (var u = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0))) return (ushort)((IPEndPoint)u.Client.LocalEndPoint).Port;
        }

        NetworkManager Manager(string name, ushort port)
        {
            var go = new GameObject(name);
            made.Add(go);
            var nm = go.AddComponent<NetworkManager>();
            var transport = go.AddComponent<UnityTransport>();
            transport.SetConnectionData("127.0.0.1", port, "127.0.0.1");
            nm.NetworkConfig = new NetworkConfig { NetworkTransport = transport, EnableSceneManagement = false };
            return nm;
        }

        static GlitchlessCore Core(Intake intake, NetworkManager nm, GlitchlessRole role)
        {
            var core = new GlitchlessCore
            {
                Transport = intake,
                Log = _ => { },
                Device = DeviceInfo.Collect,
                ServerHost = DeviceInfo.ServerHost,
                IsBatchMode = Application.isBatchMode,
                IsDebugBuild = true,
            };
            core.NetSources.Add(new NgoSource(typeof(NetworkManager), () => nm));
            core.Init(new GlitchlessOptions { Service = Service, Intake = "http://intake.test", Role = role, ServerRegion = "local", WindowSeconds = 1 });
            return core;
        }

        // What the runner would measure: a little work a frame, and no FixedUpdate ticks (NGO's ticks count instead).
        static void Step(params GlitchlessCore[] cores)
        {
            var cost = FrameCost.Unknown;
            cost.Busy = 2;
            cost.FixedSteps = 0;
            foreach (var c in cores) c.Frame(Time.unscaledDeltaTime * 1000.0, cost);
        }

        [UnityTest]
        public IEnumerator AServerAndAClientSendTheirNetworkAndServerNumbers()
        {
            LogAssert.ignoreFailingMessages = true; // NGO logs as the server goes away
            var port = FreePort();
            var serverNm = Manager("ngo server", port);
            Assert.IsTrue(serverNm.StartServer());
            var clientNm = Manager("ngo client", port);
            Assert.IsTrue(clientNm.StartClient());

            var serverIntake = new Intake();
            var clientIntake = new Intake();
            var server = Core(serverIntake, serverNm, GlitchlessRole.Server);
            var client = Core(clientIntake, clientNm, GlitchlessRole.Auto);
            Assert.IsTrue(server.IsServer);
            Assert.IsFalse(client.IsServer);
            foreach (var c in new[] { server, client })
            {
                c.LevelStart("arena", new Dictionary<string, object> { ["mode"] = "duel" });
                c.SetGroup("match", MatchId);
            }
            // What a player's session holds, where it is, and a stream it counts: so the capture below has them too.
            client.SetProperties(new Dictionary<string, object> { ["mode"] = "duel", ["region"] = "local" });
            client.SetZone("north_gate");

            var t = Time.realtimeSinceStartup;
            while (!clientNm.IsConnectedClient && Time.realtimeSinceStartup - t < 15)
            {
                Step(server, client);
                yield return null;
            }
            Assert.IsTrue(clientNm.IsConnectedClient, "the client connected");
            t = Time.realtimeSinceStartup;
            while (Time.realtimeSinceStartup - t < 3.5f)
            {
                client.Count("shot", new Dictionary<string, object> { ["weapon"] = "bow", ["damage"] = 12 });
                Step(server, client);
                yield return null;
            }
            server.Flush();

            // The server goes away: it tells its client it is shutting down.
            serverNm.Shutdown();
            t = Time.realtimeSinceStartup;
            while (!client.Queued.Any(e => (string)e["type"] == "disconnect") && Time.realtimeSinceStartup - t < 10)
            {
                Step(client);
                yield return null;
            }
            client.Flush();

            var hashed = GameWords.HashGroupId(Service, MatchId);

            // The client: round trips in its frame windows, then the disconnect, which ends the level as an abandon.
            Assert.IsFalse(clientIntake.Envelopes.Any(e => e.ContainsKey("role")), "a player's batches have no role");
            var windows = clientIntake.Events("frame_window").Where(w => w.ContainsKey("net")).ToList();
            Assert.GreaterOrEqual(windows.Count, 2, "windows while connected carry net");
            foreach (var w in windows)
            {
                var net = (Dictionary<string, object>)w["net"];
                Assert.AreEqual("ngo", net["transport"]);
                Assert.AreEqual(false, net["host"]);
                Assert.AreEqual(false, net["relay"], "Unity Transport straight to the server, not through Relay");
                Assert.IsTrue(net.ContainsKey("link"));
                Assert.GreaterOrEqual((double)net["samples"], 1);
                var rtt = (Dictionary<string, object>)net["rtt"];
                Assert.AreEqual(0.05, rtt["a"]);
                Assert.That((double)net["rtt_p50"], Is.InRange(0, 200), "a round trip on this machine");
                Assert.AreEqual(hashed, w["match"], "every window carries the match");
                Assert.AreEqual("arena", w["level"]);
            }
            var disconnect = clientIntake.Events("disconnect").Single();
            Assert.AreEqual("server_closed", disconnect["reason"], "NGO's \"shutting down\" reason");
            Assert.AreEqual("ngo", disconnect["transport"]);
            Assert.Greater((double)disconnect["connected_s"], 2, "connected for 3.5 s, seen from the first sample after it connected");
            Assert.AreEqual(hashed, disconnect["match"]);
            var abandon = clientIntake.Events("level_abandon").Single();
            Assert.AreEqual("disconnect", abandon["reason"]);
            Assert.AreEqual("arena", abandon["level"]);
            Assert.AreEqual("duel", ((Dictionary<string, object>)clientIntake.Events("level_start").Single()["attrs"])["mode"]);

            // The server: the game's companion, with NGO's ticks, its player and that player's round trip.
            Assert.IsTrue(serverIntake.Envelopes.All(e => (string)e["role"] == "server" && e["player_id"] == null && (string)e["service"] == Service));
            var start = serverIntake.Events("session_start").Single();
            var info = (Dictionary<string, object>)start["server"];
            Assert.AreEqual("ngo", info["tick_source"]);
            Assert.AreEqual(30.0, info["tick_hz"], "NGO's default TickRate");
            Assert.AreEqual("local", info["region"]);
            Assert.IsEmpty(serverIntake.Events("frame_window"));
            var serving = serverIntake.Events("server_window").Where(w => w["players"] is double p && p == 1).ToList();
            Assert.IsNotEmpty(serving, "windows with the client connected");
            var full = serving.Last();
            Assert.AreEqual("ngo", full["tick_source"]);
            Assert.That((double)full["tick_hz"], Is.InRange(20, 40), "about 30 ticks a second reached");
            Assert.AreEqual(33.33, full["budget_ms"]);
            Assert.AreEqual(0.0, full["late"]);
            Assert.That((double)full["rtt_p95"], Is.InRange(0, 200), "the client's round trip as the server sees it");
            Assert.AreEqual(0.0, full["net_objects"]);
            Assert.AreEqual(hashed, full["match"], "the server marks the same match as its players");
            Assert.AreEqual(hashed, serverIntake.Events("group").Single()["id"]);

            // GLITCHLESS_CAPTURE=<file> keeps what both sides sent, for the server's own tests of each SDK's payloads
            // (server/test/fixtures/sdk-payloads in the Glitchless repo).
            var capture = Environment.GetEnvironmentVariable("GLITCHLESS_CAPTURE");
            if (!string.IsNullOrEmpty(capture))
            {
                var note = "NetcodeTests.AServerAndAClientSendTheirNetworkAndServerNumbers: a real NGO server and client over Unity Transport, the server shutting down";
                File.WriteAllText(capture, "{\"sdk\":\"unity\",\"service\":\"" + Service + "\",\"captured\":\"" + DateTime.UtcNow.ToString("o") + "\",\"note\":\"" + note + "\",\"batches\":[" + string.Join(",", serverIntake.Bodies.Concat(clientIntake.Bodies)) + "]}\n");
            }
        }

        [UnityTest]
        public IEnumerator AClientThatLeavesOnPurposeSendsNoDisconnect()
        {
            LogAssert.ignoreFailingMessages = true;
            var port = FreePort();
            var serverNm = Manager("ngo server", port);
            Assert.IsTrue(serverNm.StartServer());
            var clientNm = Manager("ngo client", port);
            Assert.IsTrue(clientNm.StartClient());
            var intake = new Intake();
            var client = Core(intake, clientNm, GlitchlessRole.Player);
            client.LevelStart("arena");
            var t = Time.realtimeSinceStartup;
            while ((!clientNm.IsConnectedClient || Time.realtimeSinceStartup - t < 1.5f) && Time.realtimeSinceStartup - t < 15)
            {
                Step(client);
                yield return null;
            }
            Assert.IsTrue(clientNm.IsConnectedClient);
            client.LevelAbandon("arena"); // the menu's Leave button
            clientNm.Shutdown();
            t = Time.realtimeSinceStartup;
            while (Time.realtimeSinceStartup - t < 2)
            {
                Step(client);
                yield return null;
            }
            client.Flush();
            Assert.IsEmpty(intake.Events("disconnect"));
            Assert.IsFalse(intake.Events("level_abandon").Single().ContainsKey("reason"), "the game's own abandon, not a disconnect");
            Assert.IsTrue(intake.Events("frame_window").Any(w => w.ContainsKey("net")), "it was connected");
        }
    }
}

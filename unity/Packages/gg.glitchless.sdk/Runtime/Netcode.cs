using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;

namespace GlitchlessSdk
{
    /// <summary>What one netcode library says, read once a second (GlitchlessCore.SampleNet).</summary>
    public struct NetState
    {
        public bool Connected; // a client connected to its server, or a host
        public bool Host; // hosts a listen server: its own round trip is zero, so it has none
        public bool Server; // a server with no player of its own (a dedicated or headless server)
        public double RttMs, LossPct, JitterMs; // -1: not known
        public bool? Relay; // NGO's Unity Transport over Unity Relay
        public int Players, NetObjects, MaxPlayers; // a server's; -1: not known
        public double TickHz; // a server's target tick rate; 0: not known
        public List<double> ClientRtts; // a server's view of each player's round trip

        public static NetState None => new NetState { RttMs = -1, LossPct = -1, JitterMs = -1, Players = -1, NetObjects = -1, MaxPlayers = -1 };
    }

    /// <summary>A netcode library the SDK reads. Netcode.Find makes one for each library the game has loaded; a test makes
    /// its own.</summary>
    public interface INetSource
    {
        /// <summary>net.transport: "ngo", "mirror".</summary>
        string Name { get; }
        NetState Sample();
        /// <summary>A server's network ticks since the last call, or -1 when the library updates once a frame.</summary>
        int TakeTicks();
        /// <summary>Set by the core: called with timeout, connection_lost, kicked, server_closed, failed_to_connect or other
        /// as the connection drops. Never when the game leaves on purpose.</summary>
        Action<string> Disconnected { get; set; }
    }

    /// <summary>
    /// Round trips, disconnects and a server's players from the game's own netcode (SPEC §5b). Netcode for GameObjects
    /// (with Unity Relay and Lobby, which run under it) and Mirror are found by reflection, as SteamInfo finds Steamworks,
    /// so the SDK depends on neither; a game with neither, or another library, calls Glitchless.NetSample and
    /// Glitchless.Disconnect itself. Nothing about the other end is read: no address, host name or player ID.
    /// </summary>
    public static class Netcode
    {
        const BindingFlags Instance = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
        const BindingFlags Static = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;

        /// <summary>A source for each library the game has loaded.</summary>
        public static List<INetSource> Find()
        {
            var found = new List<INetSource>();
            try
            {
                var ngo = Type.GetType("Unity.Netcode.NetworkManager, Unity.Netcode.Runtime", false);
                if (ngo != null) found.Add(new NgoSource(ngo));
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    if (asm.IsDynamic || asm.GetType("Mirror.NetworkClient", false) == null) continue;
                    found.Add(new MirrorSource(name => asm.GetType("Mirror." + name, false)));
                    break;
                }
            }
            catch (Exception)
            {
                // An assembly that won't list its types: no netcode this time.
            }
            return found;
        }

        internal static object Get(MemberInfo m, object target)
        {
            try
            {
                return m is PropertyInfo p ? p.GetValue(target) : m is FieldInfo f ? f.GetValue(target) : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static MemberInfo Member(Type t, string name, BindingFlags flags) =>
            t == null ? null : (MemberInfo)t.GetProperty(name, flags) ?? t.GetField(name, flags);

        internal static MemberInfo InstanceMember(Type t, string name) => Member(t, name, Instance);

        internal static MemberInfo StaticMember(Type t, string name) => Member(t, name, Static);

        internal static bool Bool(MemberInfo m, object target) => Get(m, target) is bool b && b;

        internal static double Number(object v, double fallback = -1)
        {
            try
            {
                return v is IConvertible c && !(v is bool) && !(v is string) ? c.ToDouble(System.Globalization.CultureInfo.InvariantCulture) : fallback;
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        internal static int Count(object collection)
        {
            if (collection is ICollection c) return c.Count;
            var p = collection?.GetType().GetProperty("Count");
            return p != null ? (int)Number(p.GetValue(collection)) : -1;
        }
    }

    /// <summary>
    /// Netcode for GameObjects 2.x: NetworkManager.Singleton, the client's round trip to the server from Unity Transport's
    /// GetCurrentRtt(ServerClientId), and disconnects from OnClientDisconnectCallback and OnTransportFailure, with the
    /// reason from NetworkManager.DisconnectEvent (and DisconnectReason, the server's own words when it gave any). On a
    /// server: ConnectedClientsIds, the spawned objects, each client's round trip, and NetworkTickSystem.Tick for its ticks.
    /// </summary>
    public sealed class NgoSource : INetSource
    {
        readonly Func<object> find;
        readonly MemberInfo isServer, isHost, isConnected, isListening, shuttingDown, disconnectReason, disconnectEvent, clients, spawnManager, tickSystem, localId, config;
        object manager, transport, ticker;
        MethodInfo rtt;
        MemberInfo protocol, tickRate;
        EventInfo tickEvent;
        readonly Action<ulong> onDisconnect, onConnect;
        readonly Action onFailure, onTick;
        bool wasConnected, reported;
        int ticks;

        public string Name => "ngo";
        public Action<string> Disconnected { get; set; }

        /// <param name="managerType">Unity.Netcode.NetworkManager.</param>
        /// <param name="find">The NetworkManager to read; null reads NetworkManager.Singleton. A test with a server and a
        /// client in one process passes each its own.</param>
        public NgoSource(Type managerType, Func<object> find = null)
        {
            var singleton = Netcode.StaticMember(managerType, "Singleton");
            this.find = find ?? (() => Netcode.Get(singleton, null));
            isServer = Netcode.InstanceMember(managerType, "IsServer");
            isHost = Netcode.InstanceMember(managerType, "IsHost");
            isConnected = Netcode.InstanceMember(managerType, "IsConnectedClient");
            isListening = Netcode.InstanceMember(managerType, "IsListening");
            shuttingDown = Netcode.InstanceMember(managerType, "ShutdownInProgress");
            disconnectReason = Netcode.InstanceMember(managerType, "DisconnectReason");
            disconnectEvent = Netcode.InstanceMember(managerType, "DisconnectEvent");
            clients = Netcode.InstanceMember(managerType, "ConnectedClientsIds");
            spawnManager = Netcode.InstanceMember(managerType, "SpawnManager");
            tickSystem = Netcode.InstanceMember(managerType, "NetworkTickSystem");
            localId = Netcode.InstanceMember(managerType, "LocalClientId");
            config = Netcode.InstanceMember(managerType, "NetworkConfig");
            onDisconnect = OnClientDisconnect;
            onConnect = OnClientConnect;
            onFailure = OnTransportFailure;
            onTick = () => ticks++;
        }

        public NetState Sample()
        {
            var st = NetState.None;
            var nm = find();
            if (!ReferenceEquals(nm, manager)) Watch(nm);
            if (nm == null || !Netcode.Bool(isListening, nm)) return st;
            var server = Netcode.Bool(isServer, nm);
            var host = Netcode.Bool(isHost, nm);
            var cfg = Netcode.Get(config, nm);
            var t = Transport(cfg);
            if (protocol != null && t != null) st.Relay = Netcode.Get(protocol, t)?.ToString() == "RelayUnityTransport";
            if (server)
            {
                WatchTicks(nm);
                st.Server = !host;
                st.Connected = host;
                st.Host = host;
                st.TickHz = Netcode.Number(Netcode.Get(tickRate, cfg), 0);
                var ids = Netcode.Get(clients, nm) as IEnumerable;
                var players = 0;
                st.ClientRtts = new List<double>();
                if (ids != null)
                    foreach (var id in ids)
                    {
                        if (host && id is ulong u && u == 0) continue; // the host's own player
                        players++;
                        var r = Rtt(t, id);
                        if (r >= 0) st.ClientRtts.Add(r);
                    }
                st.Players = players;
                var spawned = Netcode.Get(spawnManager, nm);
                if (spawned != null) st.NetObjects = Netcode.Count(Netcode.Get(Netcode.InstanceMember(spawned.GetType(), "SpawnedObjectsList"), spawned));
                return st;
            }
            if (!Netcode.Bool(isConnected, nm)) return st;
            wasConnected = true;
            reported = false;
            st.Connected = true;
            st.RttMs = Rtt(t, 0UL); // NetworkManager.ServerClientId
            return st;
        }

        public int TakeTicks()
        {
            var n = ticks;
            ticks = 0;
            return n;
        }

        object Transport(object cfg)
        {
            var t = cfg == null ? null : Netcode.Get(Netcode.InstanceMember(cfg.GetType(), "NetworkTransport"), cfg);
            if (!ReferenceEquals(t, transport))
            {
                transport = t;
                rtt = t?.GetType().GetMethod("GetCurrentRtt", new[] { typeof(ulong) });
                protocol = t == null ? null : Netcode.InstanceMember(t.GetType(), "Protocol");
                tickRate = cfg == null ? null : Netcode.InstanceMember(cfg.GetType(), "TickRate");
            }
            return t;
        }

        double Rtt(object t, object clientId)
        {
            if (t == null || rtt == null) return -1;
            try
            {
                return Netcode.Number(rtt.Invoke(t, new[] { clientId }));
            }
            catch (Exception)
            {
                return -1;
            }
        }

        // Callbacks on the manager the game uses now: a game can make a new one, in a later scene.
        void Watch(object nm)
        {
            if (manager != null) Subscribe(manager, false);
            manager = nm;
            ticker = null;
            wasConnected = reported = false;
            if (nm != null) Subscribe(nm, true);
        }

        void Subscribe(object nm, bool add)
        {
            var t = nm.GetType();
            void On(string name, Delegate handler)
            {
                try
                {
                    var ev = t.GetEvent(name);
                    if (ev == null) return;
                    if (add) ev.AddEventHandler(nm, handler);
                    else ev.RemoveEventHandler(nm, handler);
                }
                catch (Exception)
                {
                    // A version whose event takes something else: that callback is missed, and the polling above still runs.
                }
            }
            On("OnClientDisconnectCallback", onDisconnect);
            On("OnClientConnectedCallback", onConnect);
            On("OnTransportFailure", onFailure);
        }

        void WatchTicks(object nm)
        {
            var ts = Netcode.Get(tickSystem, nm);
            if (ts == null || ReferenceEquals(ts, ticker)) return;
            try
            {
                if (ticker != null) tickEvent?.RemoveEventHandler(ticker, onTick);
                tickEvent = ts.GetType().GetEvent("Tick");
                tickEvent?.AddEventHandler(ts, onTick);
                ticker = ts;
            }
            catch (Exception)
            {
                ticker = null;
            }
        }

        void OnClientConnect(ulong id)
        {
            var nm = manager;
            if (nm == null || Netcode.Bool(isServer, nm)) return;
            wasConnected = true;
            reported = false;
        }

        void OnClientDisconnect(ulong id)
        {
            var nm = manager;
            if (nm == null || Netcode.Bool(isServer, nm)) return; // a player left this server or host: not this game's disconnect
            if (Netcode.Get(localId, nm) is ulong me && me != id) return;
            var why = Netcode.Get(disconnectEvent, nm)?.ToString();
            var connected = wasConnected;
            wasConnected = false;
            // The game shut its own client down (NetworkManager.Shutdown): it left, nothing dropped. A transport failure
            // already said why.
            if (why == "TransportShutdown" || Netcode.Bool(shuttingDown, nm) || reported) return;
            reported = true;
            Disconnected?.Invoke(Reason(connected, why, Netcode.Get(disconnectReason, nm) as string));
        }

        void OnTransportFailure()
        {
            var nm = manager;
            if (nm == null || Netcode.Bool(isServer, nm) || reported) return;
            reported = true;
            var connected = wasConnected;
            wasConnected = false;
            Disconnected?.Invoke(connected ? "connection_lost" : "failed_to_connect");
        }

        /// <summary>NGO's disconnect event (NetworkTransport.DisconnectEvents) and the server's words → the reason SPEC §2
        /// names. The server's own reason replaces the transport's header in DisconnectReason: a server shutting down says
        /// so, and any other reason it gives is a kick.</summary>
        public static string Reason(bool wasConnected, string disconnectEvent, string disconnectReason)
        {
            if (!wasConnected) return "failed_to_connect"; // also a connection approval the server turned down
            var serverSaid = !string.IsNullOrEmpty(disconnectReason) && !disconnectReason.StartsWith("[Disconnect Event]", StringComparison.Ordinal);
            if (serverSaid) return disconnectReason.IndexOf("shutting down", StringComparison.OrdinalIgnoreCase) >= 0 ? "server_closed" : "kicked";
            switch (disconnectEvent)
            {
                case "ProtocolTimeout": return "timeout";
                case "MaxConnectionAttempts":
                case "AuthenticationFailure": return "failed_to_connect";
                case "ClosedByRemote": return "kicked"; // the server closed this connection and said nothing
                case "ProtocolError": return "connection_lost";
                default: return "other";
            }
        }
    }

    /// <summary>
    /// Mirror: the client's round trip and its variance from NetworkTime.rtt and rttVariance (seconds), whether it is
    /// connected from NetworkClient.isConnected, and disconnects from NetworkClient.OnDisconnectedEvent, with the reason from
    /// the state the connection was in (connecting: it never connected; disconnecting: the game left on purpose). On a
    /// server: NetworkServer.connections and spawned, each connection's rtt, and tickRate. Mirror updates its server once a
    /// frame, so each frame is a tick.
    /// </summary>
    public sealed class MirrorSource : INetSource
    {
        readonly Type client, server, time, manager;
        readonly MemberInfo isConnected, clientActive, serverActive, connections, spawned, tickRate, rttMember, rttVariance, connectState, onDisconnected, singleton;
        readonly Action onDisconnect;
        bool wasConnected, listening;

        public string Name => "mirror";
        public Action<string> Disconnected { get; set; }

        /// <param name="type">Mirror's types by name ("NetworkClient", "NetworkServer", "NetworkTime", "NetworkManager"). Tests
        /// pass stand-ins.</param>
        public MirrorSource(Func<string, Type> type)
        {
            client = type("NetworkClient");
            server = type("NetworkServer");
            time = type("NetworkTime");
            manager = type("NetworkManager");
            isConnected = Netcode.StaticMember(client, "isConnected");
            clientActive = Netcode.StaticMember(client, "active");
            connectState = Netcode.StaticMember(client, "connectState");
            onDisconnected = Netcode.StaticMember(client, "OnDisconnectedEvent");
            serverActive = Netcode.StaticMember(server, "active");
            connections = Netcode.StaticMember(server, "connections");
            spawned = Netcode.StaticMember(server, "spawned");
            tickRate = Netcode.StaticMember(server, "tickRate");
            rttMember = Netcode.StaticMember(time, "rtt");
            rttVariance = Netcode.StaticMember(time, "rttVariance");
            singleton = Netcode.StaticMember(manager, "singleton");
            onDisconnect = OnDisconnected;
        }

        public NetState Sample()
        {
            var st = NetState.None;
            Listen();
            var serving = Netcode.Bool(serverActive, null);
            var playing = Netcode.Bool(clientActive, null);
            var nm = Netcode.Get(singleton, null);
            if (nm != null)
            {
                var max = Netcode.Number(Netcode.Get(Netcode.InstanceMember(nm.GetType(), "maxConnections"), nm));
                if (max > 0) st.MaxPlayers = (int)max;
            }
            if (serving && !playing)
            {
                st.Server = true;
                st.TickHz = Netcode.Number(Netcode.Get(tickRate, null), 0);
                if (st.TickHz <= 0 && nm != null) st.TickHz = Netcode.Number(Netcode.Get(Netcode.InstanceMember(nm.GetType(), "sendRate"), nm), 0);
                var conns = Netcode.Get(connections, null) as IDictionary;
                st.Players = conns?.Count ?? -1;
                st.ClientRtts = new List<double>();
                if (conns != null)
                    foreach (var c in conns.Values)
                    {
                        var r = c == null ? -1 : Netcode.Number(Netcode.Get(Netcode.InstanceMember(c.GetType(), "rtt"), c));
                        if (r >= 0) st.ClientRtts.Add(r * 1000);
                    }
                var objects = Netcode.Get(spawned, null);
                if (objects != null) st.NetObjects = Netcode.Count(objects);
                return st;
            }
            if (!Netcode.Bool(isConnected, null)) return st;
            wasConnected = true;
            st.Connected = true;
            st.Host = serving; // a host's client talks to its own server
            var rtt = Netcode.Number(Netcode.Get(rttMember, null));
            if (rtt >= 0 && !serving) st.RttMs = rtt * 1000;
            var variance = Netcode.Number(Netcode.Get(rttVariance, null));
            if (variance >= 0 && !serving) st.JitterMs = Math.Sqrt(variance) * 1000;
            return st;
        }

        public int TakeTicks() => -1;

        // Mirror's NetworkManager sets NetworkClient.OnDisconnectedEvent with = when it starts a client, which drops any
        // handler added before: so each sample checks it is still there.
        void Listen()
        {
            try
            {
                if (onDisconnected is FieldInfo f && f.FieldType == typeof(Action))
                {
                    var current = (Action)f.GetValue(null);
                    if (current == null || Array.IndexOf(current.GetInvocationList(), onDisconnect) < 0) f.SetValue(null, (Action)Delegate.Combine(current, onDisconnect));
                }
                else if (onDisconnected == null && !listening)
                {
                    var ev = client?.GetEvent("OnDisconnectedEvent", BindingFlags.Public | BindingFlags.Static);
                    ev?.AddEventHandler(null, onDisconnect);
                    listening = ev != null;
                }
            }
            catch (Exception)
            {
                // A Mirror whose event is something else: only NetSample's numbers then.
            }
        }

        void OnDisconnected()
        {
            if (Netcode.Bool(serverActive, null)) return; // a host shutting down its own game
            var state = Netcode.Get(connectState, null)?.ToString();
            var connected = wasConnected;
            wasConnected = false;
            var reason = Reason(state, connected);
            if (reason != null) Disconnected?.Invoke(reason);
        }

        /// <summary>Mirror's ConnectState as the disconnect came → the reason, or null when the game left on purpose.</summary>
        public static string Reason(string connectState, bool wasConnected)
        {
            switch (connectState)
            {
                case "Disconnecting": return null; // NetworkClient.Disconnect(): the game left
                case "Connecting": return "failed_to_connect";
                case "Connected": return "connection_lost";
                default: return wasConnected ? "other" : "failed_to_connect";
            }
        }
    }
}

extends RefCounted
## What Godot's own networking says about the connection (SPEC §5, network):
## the round trip, its jitter and packet loss from ENet, bytes sent and
## received, and the connected players' round trips on a server. Godot's
## built-in MultiplayerAPI with ENetMultiplayerPeer, and WebSocketMultiplayerPeer
## for web exports, are what a multiplayer Godot game uses. WebSocket gives no
## round trip, so a web game passes its own with Glitchless.net_sample().
##
## Peers are read by class name and ClassDB constants, never by type, so a
## build without the ENet or WebSocket module (a web export has no ENet) still
## loads. Nothing here sends an address, a host name or a peer's ID.

const TARGET_SERVER := 1  # MultiplayerPeer.TARGET_PEER_SERVER: a client's peer for its server


## "enet", "websocket" or "webrtc", the lowercased class otherwise; "" for no
## peer or the OfflineMultiplayerPeer every MultiplayerAPI starts with.
static func transport(peer: Object) -> String:
	if peer == null or peer.is_class("OfflineMultiplayerPeer"):
		return ""
	for c: Array in [["ENetMultiplayerPeer", "enet"], ["WebSocketMultiplayerPeer", "websocket"], ["WebRTCMultiplayerPeer", "webrtc"]]:
		if peer.is_class(c[0]):
			return c[1]
	return peer.get_class().to_lower().trim_suffix("multiplayerpeer")


static func connected(peer: Object) -> bool:
	return transport(peer) != "" and peer.get_connection_status() == MultiplayerPeer.CONNECTION_CONNECTED


## A client's view of its server: {rtt, jitter, loss_pct} from ENet (null each
## where the transport has none), read from the ENetPacketPeer for peer 1.
static func client_sample(peer: Object) -> Dictionary:
	var out := {"rtt": null, "jitter": null, "loss_pct": null}
	if transport(peer) != "enet":
		return out
	var server: Object = peer.call("get_peer", TARGET_SERVER)
	if server == null:
		return out
	out.rtt = float(server.call("get_statistic", _enet("PEER_ROUND_TRIP_TIME")))
	out.jitter = float(server.call("get_statistic", _enet("PEER_ROUND_TRIP_TIME_VARIANCE")))
	var scale := float(_enet("PACKET_LOSS_SCALE"))
	out.loss_pct = float(server.call("get_statistic", _enet("PEER_PACKET_LOSS"))) / scale * 100.0 if scale > 0.0 else null
	return out


## The round trip to each connected player, as a server sees them (ENet only).
static func peer_rtts(peer: Object, ids: PackedInt32Array) -> Array[float]:
	var out: Array[float] = []
	if transport(peer) != "enet":
		return out
	for id in ids:
		var p: Object = peer.call("get_peer", id)
		if p != null:
			out.append(float(p.call("get_statistic", _enet("PEER_ROUND_TRIP_TIME"))))
	return out


## Bytes [sent, received] since the last call, from the ENet host's counters
## (pop_statistic reads and resets them). [null, null] for other transports.
static func take_bytes(peer: Object) -> Array:
	if transport(peer) != "enet":
		return [null, null]
	var host: Object = peer.get("host")
	if host == null:
		return [null, null]
	return [
		int(host.call("pop_statistic", ClassDB.class_get_integer_constant("ENetConnection", "HOST_TOTAL_SENT_DATA"))),
		int(host.call("pop_statistic", ClassDB.class_get_integer_constant("ENetConnection", "HOST_TOTAL_RECEIVED_DATA"))),
	]


## Why a client lost its server, from what the transport knows. A server that
## closes the connection (or kicks the player: the game can say "kicked" with
## net_disconnect) sends ENet's disconnect, which arrives with the drop; a
## connection that timed out brings nothing. A WebSocket that the server closed
## cleanly says 1000 or 1001.
static func lost_reason(transport_name: String, heard_at_drop: bool, ws_close_code: int) -> String:
	if transport_name == "enet":
		return "server_closed" if heard_at_drop else "timeout"
	if transport_name == "websocket":
		return "server_closed" if ws_close_code == 1000 or ws_close_code == 1001 else "connection_lost"
	return "connection_lost"


## The client's WebSocketPeer for its server, kept so its close code can be read
## once the connection is gone. null for other transports.
static func websocket(peer: Object) -> Object:
	return peer.call("get_peer", TARGET_SERVER) if transport(peer) == "websocket" else null


static func _enet(name: String) -> int:
	return ClassDB.class_get_integer_constant("ENetPacketPeer", name)

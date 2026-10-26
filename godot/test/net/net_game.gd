extends Node
## A tiny multiplayer game on Godot's MultiplayerAPI and ENet, for test/e2e.mjs:
## a dedicated server and a client that plays one level in one match while the
## connection drops and comes back. Each side sends to Glitchless.
##
##   godot --headless --path godot res://test/net/net_game.tscn -- --server --port=P --intake=URL --glitchless
##   godot --headless --path godot res://test/net/net_game.tscn -- --port=P --intake=URL --glitchless
##
## Steps follow connections, not the clock: e2e.mjs freezes the server
## (SIGSTOP), and a frozen Godot's clock stops with it.
##
## The server (Glitchless reads --server as server mode) puts the match and its
## map on its own events and counts the snapshots it sends. 2 s after the
## --kick-on-connect'th player connection it kicks everyone; once the players
## it kicked have come back and left, or at --stop-at seconds, it stops. The client:
##   - sets properties (one that names a person, which Glitchless drops), and changes them 3.5 s in;
##   - on connecting: the match, a level with attributes and a zone;
##   - counts shots and gold every frame;
##   - when the server goes (frozen, then the kick): connects again;
##   - 2 s after its --leave-on-connect'th connection: completes the level and leaves (closes the connection itself).

const MATCH_ID := "match-0001-arena"

var _server := false
var _port := 0
var _t := 0.0
var _kick_on := 0  # kick 2 s after this many player connections; 0: never
var _stop_at := 30.0
var _leave_on := 1  # leave 2 s after this many connections
var _kicked := false
var _left := false
var _connects := 0
var _drops := 0


func _ready() -> void:
	var intake := ""
	for a in OS.get_cmdline_user_args():
		if a == "--server":
			_server = true
		elif a.begins_with("--port="):
			_port = int(a.get_slice("=", 1))
		elif a.begins_with("--intake="):
			intake = a.get_slice("=", 1)
		elif a.begins_with("--kick-on-connect="):
			_kick_on = int(a.get_slice("=", 1))
		elif a.begins_with("--stop-at="):
			_stop_at = float(a.get_slice("=", 1))
		elif a.begins_with("--leave-on-connect="):
			_leave_on = int(a.get_slice("=", 1))
	multiplayer.peer_connected.connect(_on_peer_connected)
	multiplayer.peer_disconnected.connect(_on_peer_left)
	multiplayer.connected_to_server.connect(_on_connected)
	multiplayer.server_disconnected.connect(_on_server_gone)
	if _server:
		Glitchless.init("glitchless-godot-net", "", "dev", intake, {"region": "eu-west", "max_players": 8})
		var peer := ENetMultiplayerPeer.new()
		print("server listening: ", error_string(peer.create_server(_port, 8)))
		multiplayer.multiplayer_peer = peer
		Glitchless.level_start("arena")  # the map this server hosts
	else:
		Glitchless.init("glitchless-godot-net", "", "dev", intake, {"properties": {"mode": "duel", "input": "pad"}})
		Glitchless.set_properties({"rank": "gold", "email": "someone@example.com"})
		_connect()


func _connect() -> void:
	var peer := ENetMultiplayerPeer.new()
	peer.create_client("127.0.0.1", _port)
	multiplayer.multiplayer_peer = peer


func _on_peer_connected(id: int) -> void:
	if not _server or id == 1:
		return
	_connects += 1
	print("server: player connected (%d)" % _connects)
	Glitchless.set_group("match", MATCH_ID, {"mode": "duel", "players": 2})
	if _connects == _kick_on:
		await get_tree().create_timer(2.0).timeout
		_kicked = true
		print("server: kick")
		# Every peer: after the freeze the server may still hold the client's old, dead connection too.
		for peer_id in multiplayer.get_peers():
			(multiplayer.multiplayer_peer as ENetMultiplayerPeer).disconnect_peer(peer_id)


func _on_peer_left(_id: int) -> void:
	if _server and multiplayer.get_peers().is_empty() and (_kicked or _kick_on == 0) and _connects > _kick_on:
		print("server: everyone left")
		_stop.call_deferred()


func _stop() -> void:
	await get_tree().create_timer(1.0).timeout
	Glitchless.set_group("match", null)
	multiplayer.multiplayer_peer.close()
	get_tree().quit()


func _on_connected() -> void:
	_connects += 1
	print("client: connected (%d)" % _connects)
	# Time out within 2 s of hearing nothing, so the test's frozen server drops the client quickly.
	(multiplayer.multiplayer_peer as ENetMultiplayerPeer).get_peer(1).set_timeout(4, 1000, 2000)
	if _connects == 1:
		Glitchless.set_group("match", MATCH_ID)
		Glitchless.level_start("arena", {"mode": "duel", "party_size": 1})
		Glitchless.set_zone("north_gate")
	if _connects == _leave_on:
		await get_tree().create_timer(2.0).timeout
		_left = true
		print("client: leaving")
		Glitchless.level_complete("arena", 1200)
		multiplayer.multiplayer_peer.close()  # the player leaves: no disconnect
		await get_tree().create_timer(1.0).timeout
		get_tree().quit()


func _on_server_gone() -> void:
	if _server or _left:
		return
	_drops += 1
	print("client: server gone (%d)" % _drops)
	await get_tree().create_timer(0.5).timeout
	_connect()


func _physics_process(_delta: float) -> void:
	if _server and multiplayer.get_peers().size() > 0:
		Glitchless.count("snapshot", {"kind": "full"})


func _process(dt: float) -> void:
	_t += dt
	if _server:
		if _t >= _stop_at:
			_stop_at = INF
			_stop()
		return
	if _connects > 0 and not _left:
		Glitchless.count("shot", {"weapon": "bow", "hit": true})
		Glitchless.count("gold", {"source": "loot", "amount": 5})
	if _t >= 3.5 and _t - dt < 3.5:  # after the first batch, so it is a props event
		Glitchless.set_properties({"rank": "platinum", "input": null})

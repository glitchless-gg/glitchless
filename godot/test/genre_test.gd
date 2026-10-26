extends SceneTree
## The genre additions of glitchless.gd without a server: counters (count),
## session properties and their checks, groups and their hashed IDs, level
## attributes and zones, network samples and disconnects, and a dedicated
## server's windows and envelope. test/e2e.mjs runs it, then plays them for
## real (an ENet server and a client) against a fake intake.
##   godot --headless --path godot --script res://test/genre_test.gd

const Glitchless := preload("res://addons/glitchless/glitchless.gd")
const Properties := preload("res://addons/glitchless/properties.gd")
const NetInfo := preload("res://addons/glitchless/net.gd")
const Device := preload("res://addons/glitchless/device.gd")

var _failed := 0


func _init() -> void:
	DirAccess.remove_absolute(Glitchless.SERVER_OUTBOX_PATH)
	_counts()
	_properties()
	_groups()
	_levels_and_zones()
	_network()
	_server()
	DirAccess.remove_absolute(Glitchless.SERVER_OUTBOX_PATH)
	DirAccess.remove_absolute(Glitchless.OUTBOX_PATH)
	print("genre tests: %d failed" % _failed)
	quit(1 if _failed else 0)


func _counts() -> void:
	var g := _fresh()
	g.level = "nmd_ghoa"
	var started: int = g._win.started_at
	for i in 37:
		g.count("kill", {"monster": "elite"})
	g.count("kill", {"monster": "boss"}, 2)
	for i in 3:
		g.count("gold", {"source": "loot", "amount": 35, "crit": false})
	g.count("shot", "bow", 5)
	g.count("huge", null, 5000000)
	g.count("nothing", null, 0)
	_check("count() queues nothing per call", g._queue.is_empty())
	g._close_window()
	var counts := _of(g, "counts")
	_check("one counts event for the window", counts.size() == 1, "%d" % counts.size())
	var c: Dictionary = counts[0] if counts else {}
	_check("…stamped with the window's start, level and length", c.get("ts") == started and c.get("level") == "nmd_ghoa" and c.get("duration_s") is float and c.get("dropped") == 0, JSON.stringify(c))
	var by := {}
	for e: Dictionary in c.get("counts", []):
		by[e.name + JSON.stringify(e.attrs)] = e
	_check("a name splits by its words: 37 elite kills, 2 boss kills", by.get('kill{"monster":"elite"}', {}).get("n") == 37 and by.get('kill{"monster":"boss"}', {}).get("n") == 2, JSON.stringify(by.keys()))
	var gold: Dictionary = by.get('gold{"crit":false,"source":"loot"}', by.get('gold{"source":"loot","crit":false}', {}))
	_check("numbers are summed as passed, booleans split", gold.get("n") == 3 and gold.get("sums", {}).get("amount") == 105, JSON.stringify(gold))
	_check("one word is the attribute what, with n", by.get('shot{"what":"bow"}', {}).get("n") == 5)
	_check("n is at most 1,000,000 a call; n < 1 counts nothing", by.get("huge{}", {}).get("n") == 1000000 and not by.has("nothing{}"))
	_check("each entry has the time of its first call", by.get('kill{"monster":"elite"}', {}).get("first_ts", 0) >= started)
	g._close_window()
	_check("a window that counted nothing sends none", _of(g, "counts").size() == 1)
	g.free()

	g = _fresh()
	g.count("hit", {"a": "1", "b": "2", "c": "3", "d": "4", "e": "5", "n1": 1, "n2": 2, "n3": 3, "n4": 4, "n5": 5})
	g._close_window()
	var hit: Dictionary = _of(g, "counts")[0].counts[0]
	_check("at most 4 words split a counter and 4 numbers are summed", hit.attrs.size() == 4 and hit.sums.size() == 4, JSON.stringify(hit))
	g.free()

	g = _fresh()
	for i in 64:
		g.count("kill", {"monster": "m%d" % i})
	g.count("kill", {"monster": "m64"})
	g.count("kill", {"monster": "m65"})
	g.count("loot", null, 7)
	g._close_window()
	var full: Dictionary = _of(g, "counts")[0]
	var other: Array = full.counts.filter(func(e: Dictionary) -> bool: return e.attrs.get("monster") == "(other)")
	_check("past 64 entries a known name's new groups go under (other)", full.counts.size() == 65 and other.size() == 1 and other[0].n == 2, "%d entries" % full.counts.size())
	_check("…and a new name is dropped, its events added to dropped", full.dropped == 7)
	g.free()

	g = _fresh()
	g.level = "a"
	g.count("kill")
	g.level_start("b")
	g.count("kill")
	g._close_window()
	var levels: Array = _of(g, "counts").map(func(e: Dictionary) -> Variant: return e.level)
	_check("level_start closes the window, so counts keep their level", levels == ["a", "b"], JSON.stringify(levels))
	g.free()

	g = _fresh()
	g._features = {"server_mode": true}
	g.count("kill")
	g._close_window()
	_check("a server without counts gets none, and the game is told", _of(g, "counts").is_empty() and g._warned.has("feature:counts"))
	g.free()

	g = _fresh()
	for i in 25:
		g.track("shot")
	_check("a debug build warns once about a name tracked over 20 times a second", g._warned.has("stream:shot"))
	g.free()


func _properties() -> void:
	var good := {"mode": "squads", "level_band": "30-39", "tier": 2.0, "ranked": true, "note": "  diamond  ", "season": 7}
	for k: String in good:
		_check("property %s=%s passes" % [k, good[k]], Properties.check(k, good[k]).has("value"), str(Properties.check(k, good[k])))
	_check("whole floats are sent as ints, strings trimmed", Properties.check("tier", 2.0).value is int and Properties.check("note", "  diamond  ").value == "diamond")
	_check("strings are cut to 64 characters", Properties.check("mode", "x".repeat(80)).value.length() == 64)
	var bad := {
		"Rank": "gold", "1st": "a", "platform": "pc", "zone": "north", "match": "m", "steam_branch": "beta", "email": "x",
		"user_id": "x", "name": "x", "score": 3.5, "big": 2000000, "list": ["a"], "empty": "   ",
		"contact": "someone@example.com", "site": "see https://example.com", "www": "www.example.com",
		"phone": "+1 (555) 123-4567", "digits": "id 12345678", "uuid": "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
		"hex": "deadbeef0123abcd99", "token": "aB3dE5fG7hJ9kL1mN",
	}
	for k: String in bad:
		_check("property %s=%s is dropped" % [k, bad[k]], Properties.check(k, bad[k]).has("why"), str(Properties.check(k, bad[k])))

	var g := _fresh()
	g.set_properties({"mode": "squads", "rank": "gold", "input": "pad", "email": "someone@example.com", "score": 3.5})
	_check("only the properties that pass are kept", g._props == {"mode": "squads", "rank": "gold", "input": "pad"}, JSON.stringify(g._props))
	_check("…and the game is told once about each one dropped", g._warned.has("prop:email") and g._warned.has("prop:score"))
	var start: Dictionary = g._session_start_event()
	g._session_start_sent = true
	_check("session_start carries the properties set before it", start.get("props") == {"mode": "squads", "rank": "gold", "input": "pad"}, JSON.stringify(start.get("props")))
	g.set_property("rank", "platinum")
	g.set_property("input", null)
	g.set_property("mode", "squads")
	g.set_property("rank", "diamond")
	g._close_window()
	var props := _of(g, "props")
	_check("a later change is one props event a window, with each key's last value and null for one removed", props.size() == 1 and props[0].props == {"rank": "diamond", "input": null}, JSON.stringify(props))
	g.set_property("rank", "diamond")
	g._close_window()
	_check("a call that changes nothing sends nothing", _of(g, "props").size() == 1)
	for i in 20:
		g.set_property("k%d" % i, i)
	_check("a session takes at most 12 properties", g._props.size() == 12 and g._warned.has("props:max"), "%d" % g._props.size())
	g.free()

	g = _fresh()
	_check("a session with no properties sends no props", not g._session_start_event().has("props"))
	g.free()


func _groups() -> void:
	var g := _fresh()
	var sent: String = g.set_group("match", "m-8f2c-1234-abcd", {"mode": "squads", "players": 100})
	_check("a match ID goes hashed with the service: h_ and 24 hex of SHA-1(\"starlift:<id>\")", sent == "h_1f7d13e4fe8dcf476f9f7dd0", sent)
	_check("…the vector every Glitchless SDK checks: zoomies, m_8f2c91d04ab7", Glitchless.hash_group_id("Zoomies", "m_8f2c91d04ab7") == "h_d8a6ac978165726ac21a722b")
	var group := _of(g, "group")
	_check("a group event names its kind, ID and attributes", group.size() == 1 and group[0].kind == "match" and group[0].id == sent and group[0].attrs == {"mode": "squads", "players": 100}, JSON.stringify(group))
	g.track("pickup", "coin")
	g.death(1.0, 2.0, "fell")
	_check("every event carries the match as it carries the level", _of(g, "custom")[0].get("match") == sent and _of(g, "death")[0].get("match") == sent)
	g._frame(16.7)
	g._close_window()
	_check("…and so does every frame window", _of(g, "frame_window")[0].get("match") == sent)
	_check("the same match again sends nothing", g.set_group("match", "m-8f2c-1234-abcd") == sent and _of(g, "group").size() == 1)
	g.set_group("match", null)
	g.track("after")
	_check("set_group(kind, null) ends it: id null, and later events don't carry it", _of(g, "group")[-1].id == null and not _of(g, "custom")[-1].has("match"))
	_check("IDs that aren't 8 to 64 of A-Za-z0-9_.:- are dropped", g.set_group("party", "short") == "" and g.set_group("party", "has spaces in it") == "" and _of(g, "group").size() == 2)
	_check("only match, party and run", g.set_group("guild", "guild-12345678") == "")
	var run: String = g.set_group("run")
	_check("set_group(\"run\") makes a run ID: r_ and 12 characters", RegEx.create_from_string("^r_[a-z0-9]{12}$").search(run) != null and _of(g, "group")[-1].id == run, run)
	var resumed: String = g.set_group("run", "r_savedrun1234")
	_check("anonymous mode swaps a saved run ID for a new one, marked resumed", resumed != "r_savedrun1234" and resumed.begins_with("r_") and _of(g, "group")[-1].get("resumed") == true, resumed)
	g.free()

	g = _fresh({"privacy": "install"})
	g._privacy = "install"
	_check("install mode resumes a saved run under its own ID", g.set_group("run", "r_savedrun1234") == "r_savedrun1234" and _of(g, "group")[-1].get("resumed") == true)
	g.free()

	g = _fresh({"hash_group_ids": false})
	_check("hash_group_ids: false sends a match ID as the game made it", g.set_group("match", "m-8f2c-1234-abcd") == "m-8f2c-1234-abcd")
	_check("a party ID is hashed like a match ID", _fresh_free_hash("party") == Glitchless.hash_group_id("starlift", "party-0001-xyz"))
	g.free()


func _fresh_free_hash(kind: String) -> String:
	var g := _fresh()
	var out: String = g.set_group(kind, "party-0001-xyz")
	g.free()
	return out


func _levels_and_zones() -> void:
	var g := _fresh()
	g.level_start("pit", {"tier": "pit_80", "party_size": 3})
	g.level_start("town")
	var starts := _of(g, "level_start")
	_check("level_start carries the attempt's attributes", starts[0].get("attrs") == {"tier": "pit_80", "party_size": 3}, JSON.stringify(starts[0]))
	_check("…and a level started without any has none", not starts[1].has("attrs"))
	g.set_zone("ashen_wastes")
	g.track("loot")
	g._frame(16.7)
	g._close_window()
	_check("set_zone stamps events and windows", _of(g, "custom")[0].get("zone") == "ashen_wastes" and _of(g, "frame_window")[-1].get("zone") == "ashen_wastes")
	g._frame(16.7)
	g._win.started_ms -= 2000
	g.set_zone("frost_peaks")
	_check("a new zone closes a window over a second old, so it never spans two", _of(g, "frame_window").size() == 2 and _of(g, "frame_window")[-1].get("zone") == "ashen_wastes")
	g.set_zone("")
	g.track("x")
	_check("set_zone(\"\") or null clears it", g.zone == null and not _of(g, "custom")[-1].has("zone"))
	g.free()


func _network() -> void:
	_check("ENet: nothing arriving with the drop is a timeout", NetInfo.lost_reason("enet", false, -1) == "timeout")
	_check("ENet: the server's goodbye arriving with it is the server closing", NetInfo.lost_reason("enet", true, -1) == "server_closed")
	_check("WebSocket: 1000 or 1001 is the server closing, else connection_lost", NetInfo.lost_reason("websocket", false, 1000) == "server_closed" and NetInfo.lost_reason("websocket", false, -1) == "connection_lost")
	_check("no peer or the offline peer is no transport", NetInfo.transport(null) == "" and NetInfo.transport(OfflineMultiplayerPeer.new()) == "")
	_check("an ENet peer reads as enet, and isn't connected until it is", NetInfo.transport(ENetMultiplayerPeer.new()) == "enet" and not NetInfo.connected(ENetMultiplayerPeer.new()))

	var g := _fresh()
	g._frame(16.7)
	g._close_window()
	_check("a window while not connected has no net", not _of(g, "frame_window")[0].has("net"))
	g.net_sample(40.0, 0.5, 4.0)
	g.net_sample(60.0, 1.5, 6.0)
	g._frame(16.7)
	g._close_window()
	var net: Dictionary = _of(g, "frame_window")[1].get("net", {})
	_check("net_sample fills frame_window.net: a 5% sketch, percentiles, jitter and loss", net.get("samples") == 2 and net.get("rtt", {}).get("a") == 0.05 and absf(float(net.get("rtt_max", 0)) - 60.0) < 0.1 and net.get("jitter_ms") == 5.0 and net.get("loss_pct") == 1.0, JSON.stringify(net))
	_check("…with the transport, no link and not the host", net.get("transport") == "custom" and net.has("link") and net.link == null and net.get("host") == false, JSON.stringify(net))
	g.free()

	g = _fresh()
	g.level_start("arena")
	g.net_sample(50.0)
	g.net_disconnect("timeout")
	var d := _of(g, "disconnect")
	_check("a disconnect says why, how long it was connected, and the window's round trip", d.size() == 1 and d[0].reason == "timeout" and d[0].connected_s is float and absf(float(d[0].rtt_p95) - 50.0) < 3.0 and d[0].has("loss_pct"), JSON.stringify(d))
	var ab := _of(g, "level_abandon")
	_check("with a level open it also ends the attempt as an abandon, reason disconnect", ab.size() == 1 and ab[0].reason == "disconnect" and ab[0].level == "arena", JSON.stringify(ab))
	g.level_fail("arena", "lost")
	g.level_abandon()
	_check("the game's own fail or abandon for that attempt is dropped", _of(g, "level_fail").is_empty() and _of(g, "level_abandon").size() == 1)
	g.net_reconnect()
	var r := _of(g, "reconnect")
	_check("connecting again is a reconnect, after_s from the drop", r.size() == 1 and r[0].after_s is float)
	g.level_complete("arena", 10)
	_check("and the level plays on: its complete is sent", _of(g, "level_complete").size() == 1)
	g.net_disconnect("not a reason")
	_check("an unknown reason is other", _of(g, "disconnect")[-1].reason == "other")
	for i in 30:
		g.net_reconnect()
		g.net_disconnect("timeout")
	_check("at most 20 disconnect events a session", _of(g, "disconnect").size() == 20)
	g.free()

	# The MultiplayerAPI's signals, as net_game shows them: a drop is peer_disconnected(1) then
	# server_disconnected; the game closing the connection itself is server_disconnected alone.
	g = _fresh()
	g._net_connected("enet")
	g._on_net_server_gone()
	g._net_record()
	_check("the game closing its own connection is no disconnect", _of(g, "disconnect").is_empty() and not g._net_up)
	g._net_connected("enet")
	_check("…and connecting again after it is no reconnect", _of(g, "reconnect").is_empty())
	g._net_server_left = true
	g._net_goodbye = true
	g._on_net_server_gone()
	g._net_record()
	_check("the server going with a goodbye: server_closed", _of(g, "disconnect")[-1].reason == "server_closed")
	g._net_connected("enet")
	g._net_server_left = true
	g._net_goodbye = false
	g._on_net_server_gone()
	g.net_disconnect("kicked")  # the game's own handler of the same signal says why
	g._net_record()
	var reasons: Array = _of(g, "disconnect").map(func(e: Dictionary) -> Variant: return e.reason)
	_check("the game's reason wins over the one Glitchless would give", reasons == ["server_closed", "kicked"], JSON.stringify(reasons))
	g._on_net_failed()
	g._net_record()
	_check("a connection that never came up: failed_to_connect, connected 0 s", _of(g, "disconnect")[-1].reason == "failed_to_connect" and _of(g, "disconnect")[-1].connected_s == 0.0)
	g.free()


func _server() -> void:
	var g := _fresh({"role": "server"})
	_check("role: \"server\" makes a dedicated server", g._decide_role() == "server")
	g._opts.role = "player"
	_check("role: \"player\" keeps a game's own --server flag from meaning it", g._decide_role() == "player")
	g._opts.role = ""
	_check("no role, no flag, no dedicated-server export: a player", g._decide_role() == "player")
	g.role = "server"
	g._opts.region = "eu-west"
	g._opts.max_players = 8
	var server: Dictionary = g._session_start_event().get("server", {})
	_check("session_start says what the server is: tick rate, players it takes, build, region, host", server.get("tick_hz") == Engine.physics_ticks_per_second and server.get("max_players") == 8 and server.get("region") == "eu-west" and server.has("build") and server.get("host", {}).has("cores") and server.get("host", {}).has("memory_gb"), JSON.stringify(server))
	g._opts.region = "https://eu.example.com"
	_check("a region shaped like a link or an address isn't sent", g._session_start_event().server.region == null)

	var t := Time.get_ticks_usec()
	g._tick_at = t - 5000
	g._end_tick(t)
	g._tick_at = t - 30000
	g._end_tick(t)
	g._frame(16.7)
	g.set_players(3)
	g._win.peer_rtts = [20.0, 40.0]
	g.set_context({"bullets": 12})
	g._close_window()
	var w := _of(g, "server_window")
	var sw: Dictionary = w[0] if w else {}
	_check("a server sends server_window, never frame_window", w.size() == 1 and _of(g, "frame_window").is_empty())
	_check("…with its ticks against the budget: 2 ticks, 1 late, the slowest 30 ms", sw.get("ticks") == 2 and sw.get("late") == 1 and absf(float(sw.get("tick_max", 0)) - 30.0) < 0.5 and sw.get("tick", {}).get("n") == 2 and sw.get("budget_ms") == snappedf(1000.0 / Engine.physics_ticks_per_second, 0.01), JSON.stringify(sw))
	_check("…the players and their round trips, and the game's gauges", sw.get("players") == 3 and sw.get("players_max") == 3 and sw.get("rtt_p95") == 40.0 and sw.get("ctx", {}).get("bullets") == 12.0, JSON.stringify(sw))
	for k: String in ["tick_hz", "tick_p50", "tick_p95", "in_kbps", "out_kbps", "cpu_pct", "mem_mb", "net_objects", "duration_s"]:
		_check("server_window has %s" % k, sw.has(k))
	var events: Array[Dictionary] = [{"type": "custom", "ts": 1, "level": null}]
	var body: Dictionary = JSON.parse_string(g._body(g._batch(events)))
	_check("its envelope says role server, with no player ID", body.get("role") == "server" and body.get("player_id") == null and body.get("service") == "starlift", JSON.stringify(body))
	_check("it sends nothing until the server says it takes server sessions", not g._may_send())
	g._features = {"counts": true}
	_check("…not to one without server_mode", not g._may_send())
	g._features = {"server_mode": true}
	_check("…and does once it has server_mode", g._may_send())
	_check("a server keeps its unsent batches apart from a player build's", g._outbox_path() == Glitchless.SERVER_OUTBOX_PATH)

	g._opts.session_per_match = true
	g._features = null  # so the new session's flush keeps its batches (no HTTPRequest out of the tree)
	var first: String = g.session_id
	g.set_group("match", "match-0001-arena")
	g.set_group("match", null)
	var ends := _of(g, "session_end")
	_check("session_per_match: a match ending ends the server's session, and a new one starts", ends.size() == 1 and ends[0].reason == "match_end" and g.session_id != first, JSON.stringify(ends))
	g.free()

	var proc := Device.parse_proc("Name:\tgodot\nVmPeak:\t  900000 kB\nVmRSS:\t  524288 kB\n", "4242 (Godot Server (x)) S 1 4242 4242 0 -1 4194304 1000 0 0 0 1234 566 0 0 20 0 30 0 100")
	_check("Linux: resident memory and CPU seconds from /proc/self", proc == {"mem_mb": 512.0, "cpu_s": 18.0}, JSON.stringify(proc))


# The autoload's script, not in the tree, as if init() had turned sending on.
func _fresh(opts: Dictionary = {}) -> Node:
	var g: Node = Glitchless.new()
	g._win = g._new_window()
	g._ring.resize(Glitchless.RING_SIZE)
	g._opts.merge(opts, true)
	g._inited = true
	g.enabled = true
	g._service = "starlift"
	g.session_id = "s_test"
	return g


# Events of a type, queued or already cut into batches (a new session flushes).
func _of(g: Node, type: String) -> Array:
	var all: Array = []
	for b: Dictionary in g._outbox:
		all.append_array(b.events)
	all.append_array(g._queue)
	return all.filter(func(e: Dictionary) -> bool: return e.type == type)


func _check(name: String, ok: bool, detail: String = "") -> void:
	print("%s %s" % ["ok" if ok else "FAIL", name])
	if not ok:
		_failed += 1
		if detail != "":
			print("    ", detail)

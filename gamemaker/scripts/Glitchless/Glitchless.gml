// Feather disable all
/// Glitchless for GameMaker: frame times, hitches, errors, crashes, play events and players' bug reports
/// for a Glitchless server (https://glitchless.gg), in the same shape as the browser, Godot, Unity and
/// Unreal SDKs, so a GameMaker game gets the same dashboard, findings and agent tools.
///
///   glitchless_init("caverun", "1.4.0", "prod", "https://glitchless.example.com");
///   glitchless_level_start("cave_3", { difficulty: "hard" }); // rooms that read as levels start one by themselves
///   glitchless_level_abandon();                // the player went to the menu mid-level: not a fail
///   glitchless_track("play", "endless");
///   glitchless_count("kill", { enemy: "bat" }); // a stream of events, added up on the device
///   glitchless_death(x, y, "spikes");
///   glitchless_set_context({ enemies: instance_number(obj_enemy) });
///   glitchless_set_properties({ rank: "gold" }); // the game's words about the session
///   glitchless_set_group("match", match_id);   // every event carries the match from now on
///   glitchless_net_sample(ping_ms);            // the game's own ping, about once a second
///   glitchless_report_bug(note);               // or bug_reports in the options: F8 opens a form
///
/// Call glitchless_init once, as early as you can (the first room's creation code, or the Create event of
/// your first object). Every few seconds what happened goes out as one batch. Batches that could not be
/// sent are kept in glitchless/ in the game's save area and sent on a later launch, and so is a crash.
///
/// A build run from the IDE sends nothing unless it is run with -glitchless, so a developer's test runs do
/// not skew the numbers. Anonymous mode, the default, sends nothing that can be tied to a person:
/// PRIVACY.md lists every field each mode sends.
///
/// Flags (on the command line, or in the GLITCHLESS_ARGS environment variable):
///   -glitchless                  send from a build run from the IDE too
///   -glitchless-intake=URL       send to this server instead (and turn sending on)
///   -glitchless-privacy=MODE     anonymous, install or full, for a test run
///   -glitchless-measure=SECONDS  print frame stats as one line of JSON and quit
///   -glitchless-warmup=SECONDS   with -glitchless-measure: wait this long before measuring
///   -glitchless-out=PATH         with -glitchless-measure: write the JSON to this file too
///   -glitchless-synthetic        mark the session as a bot's (-autoplay does too)
///   -glitchless-debug            log what Glitchless does with show_debug_message

/// Says who the game is and where to send. Until this is called nothing is measured or sent.
/// @param {String} service   the game's name on the dashboard ("caverun")
/// @param {String} version   "" uses GM_version, the version in Game Options
/// @param {String} env       "prod", "staging", "dev"...
/// @param {String} intake    the Glitchless server, "https://..."
/// @param {Struct} options   see __glitchless_defaults() in __glitchless_core; every one is optional
function glitchless_init(_service, _version = "", _env = "prod", _intake = "", _options = {}) {
    __glitchless_init(_service, _version, _env, _intake, _options);
}

/// A level starts. Closes the current frame window, so a window never spans two levels. The first call
/// turns off rooms as levels: from then on the game says when levels start.
/// @param attrs  what this attempt is, in the game's words: { tier: "pit_80", party_size: 3 }. Boards split a
///               level's clears and fails by them. The outcome and deaths don't repeat them.
function glitchless_level_start(_level, _attrs = undefined) {
    __glitchless_level_start(_level, true, _attrs);
}

/// @param level       undefined: the current level
/// @param score       any number, or undefined
/// @param duration_s  -1: measured since the level started
function glitchless_level_complete(_level = undefined, _score = undefined, _duration_s = -1) {
    __glitchless_level_complete(_level, _score, _duration_s);
}

/// The player lost the level (died, ran out of time). Leaving it is glitchless_level_abandon.
function glitchless_level_fail(_level = undefined, _cause = "") {
    __glitchless_level_fail(_level, _cause);
}

/// The player left the level before it ended: went to the menu, restarted it, closed the game. Never counted
/// as a fail. Quitting mid-level (glitchless_quit, or the game ending) sends one by itself (SPEC §2 level_abandon).
/// @param level  undefined: the current level
function glitchless_level_abandon(_level = undefined) {
    __glitchless_level_abandon(_level);
}

/// A death at a place in the room. The place is sent only when positions are on (full mode, or the
/// positions option); the death and its cause always are.
function glitchless_death(_x, _y, _cause = "unknown", _z = 0) {
    __glitchless_death(_x, _y, _cause, _z);
}

/// A game event. `what` is one word about it ("endless", "forge"), a number, or a struct of attributes.
/// Use the game's own words, never anything the player typed or anything particular to them.
function glitchless_track(_name, _what = undefined) {
    __glitchless_track(_name, _what);
}

/// One more of a stream of events: kills, shots, gold picked up, taps. Nothing is queued: each is added to its
/// entry in this frame window, sent once a window as one `counts` event, so a stream can't fill the queue. Track a
/// moment, count a stream. `what` is a word, a number or a struct: its words and true/false values (at most 4)
/// split the count, and its numbers (at most 4) are added up as given.
///   glitchless_count("kill", { enemy: "elite" });
///   glitchless_count("gold", { source: "loot", amount: 35 });
/// @param n  how many happened at once (up to 1,000,000)
function glitchless_count(_name, _what = undefined, _n = 1) {
    __glitchless_count(_name, _what, _n);
}

/// Numbers that describe what is going on (enemies, bullets, particles). The largest value in each frame
/// window is sent, and the current ones go with each hitch, so the findings can say what was high when
/// frames stuttered. Call it at the end of the frame's work (an End Step event).
function glitchless_set_context(_gauges) {
    __glitchless_set_context(_gauges);
}

/// The game's words about this session, which boards split and filter by: a rank tier, a class, a mode, the
/// region of the game's servers, a band ("30-39") rather than an exact number. undefined removes one.
///   glitchless_set_properties({ rank: "diamond", region: "eu-west" });
/// Keys are lower-case words (at most 12 a session); values a word, a whole number, or true or false. Keys such as
/// email or user_id, and values shaped like an email address, a phone number, an ID or a link, are dropped. They go
/// in every privacy mode, and are kept in memory only. Set them where the game knows them (after sign-in, at the
/// menu, at matchmaking), or pass properties in glitchless_init's options.
function glitchless_set_properties(_properties) {
    __glitchless_set_properties(_properties);
}

/// Marks every event from now on as part of a group, until the same kind is set again or ended with undefined:
///   glitchless_set_group("match", match_id, { mode: "squads" }); // an ID the game's server made for the match
///   glitchless_set_group("party", party_id);                     // until the party breaks up
///   var _run = glitchless_set_group("run");                      // a new run: Glitchless makes its ID
///   glitchless_set_group("match", undefined);                    // the match is over
/// Match and party IDs are 8 to 64 letters, digits and _ . : - shared by everyone in the match or party, never an
/// account, guild or friends-list ID. They go hashed, with the service as the salt, unless the hash_group_ids
/// option is false. glitchless_set_group("run", saved_id) resumes a run the game saved, in install and full mode;
/// anonymous mode gives it a new ID. Returns the ID sent ("" when there is none).
function glitchless_set_group(_kind, _id = undefined, _attrs = undefined) {
    // No ID at all asks for a new one (a run); an ID of undefined ends the group. GML hands a parameter its default
    // for an undefined as well as a missing argument, so only argument_count tells the two apart.
    return __glitchless_set_group(_kind, argument_count < 2 ? "" : _id, _attrs);
}

/// Where the player is in an open world, apart from the level (an MMO region, a metroidvania room): every event
/// and frame window carries it, as they carry the level, so boards split by zone. "" or undefined: none.
function glitchless_set_zone(_zone) {
    __glitchless_set_zone(_zone);
}

/// One round trip to the game's server, from the game's own ping over network_* (about once a second), with its
/// packet loss and jitter where the game knows them. Each frame window then carries the connection's ping.
function glitchless_net_sample(_rtt_ms, _loss_pct = undefined, _jitter_ms = undefined) {
    __glitchless_net_sample(_rtt_ms, _loss_pct, _jitter_ms);
}

/// The connection dropped: "timeout", "connection_lost", "kicked", "server_closed", "failed_to_connect" or
/// "other". A level still going ends as an abandon with reason "disconnect", never a fail.
function glitchless_disconnect(_reason = "other") {
    __glitchless_disconnect(_reason);
}

/// Back on the connection after glitchless_disconnect.
function glitchless_reconnect() {
    __glitchless_reconnect();
}

/// The player's place, sampled 4 times a second for heatmaps. Ignored unless positions are on.
function glitchless_set_position(_x, _y, _z = 0) {
    __glitchless_set_position(_x, _y, _z);
}

/// An error the game caught itself: a message, or the exception a try/catch got.
///   try { load_save(); } catch (_e) { glitchless_error(_e, { slot: 2 }); }
function glitchless_error(_error, _attrs = {}) {
    __glitchless_error(_error, _attrs);
}

/// For a game that sets its own exception_unhandled_handler after glitchless_init (which replaces
/// Glitchless's): call this first thing in yours, so the crash is still written down and sent. Or pass
/// yours as the exception_handler option instead, and Glitchless calls it after.
function glitchless_crash(_exception) {
    __glitchless_crash(__glitchless(), _exception);
}

/// A player's bug report from the game's own UI: what they typed, a screenshot of the game (false sends
/// none), where they are and what just happened. Sent on its own straight away, from every session.
/// `callback({sent, reason})`: sent is true once the server has it; otherwise reason is "offline" (this
/// build sends nothing) or "error" (it goes with a later batch).
function glitchless_report_bug(_note = "", _screenshot = true, _callback = undefined) {
    __glitchless_report_bug(_note, _screenshot, _callback);
}

/// Opens the bug report form, for a game's own "Report a bug" button. Works whether or not bug_reports is
/// on (that adds the F8 key).
function glitchless_open_bug_report() {
    var _g = __glitchless();
    if (is_undefined(_g.bug)) __glitchless_bug_toggle(_g);
}

function glitchless_bug_report_is_open() {
    return !is_undefined(__glitchless().bug);
}

/// Frame stats over the next `seconds`, the same numbers as -glitchless-measure:
///   glitchless_measure(5, function(_stats) { show_debug_message(json_stringify(_stats)); });
function glitchless_measure(_seconds, _callback) {
    __glitchless_measure(_seconds, _callback);
}

/// Closes the current frame window and sends what is waiting. Runs by itself every few seconds.
function glitchless_flush() {
    __glitchless_flush(__glitchless());
}

/// Ends the session, gives the network up to 1.5 s to take the last batch, then calls game_end(). Use it
/// for the game's Quit button: game_end() alone leaves the last batch to the next launch.
function glitchless_quit() {
    __glitchless_quit();
}

/// Whether the game was started with a flag, read where Glitchless reads its own (the command line,
/// GLITCHLESS_ARGS, and glitchless/args.txt in a build run from the IDE): glitchless_has_flag("autoplay")
/// for -autoplay. For a game's own agent flags.
function glitchless_has_flag(_name) {
    return __glitchless_has_flag(__glitchless(), _name);
}

/// A flag's value: glitchless_flag_value("seed", "1") for -seed=7.
function glitchless_flag_value(_name, _fallback = "") {
    return __glitchless_flag_value(__glitchless(), _name, _fallback);
}

/// {sent, failed, errors, hitches, deaths, last_status}, for a debug overlay.
function glitchless_stats() {
    return __glitchless().stats;
}

/// This session's random ID, for a support screen. Empty before glitchless_init.
function glitchless_session_id() {
    return __glitchless().session_id;
}

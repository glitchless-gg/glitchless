// Testers: players and sessions a game's team marked as its own play (the developer's playtest, a friend trying a
// build), so they read as session type `tester` in every query, their past sessions too, and the numbers that count
// players (findings, share links, alerts, `type=user`) leave them out. An SDK can say so when it starts (sessionType),
// but a jam game's first player is its developer, long before anyone sets that: a mark fixes it afterwards, at read
// time, as known findings and resolved errors are kept. Glitchless Cloud keeps each game's list with its alert settings
// (SPEC §3e); the matching is the core's: analytics.js sessionContext applies q.testers (testerIndex) to every session
// before any filter, so a marked session is a tester's whatever is asked.
//
// An entry: { player?, session?, note, by, at }, with one of
//   player   a player ID: every session that player sent, before and after the mark
//   session  one session's ID: for a game in anonymous mode (no player IDs), or one playtest of a player who also plays
// Only a session its SDK sent as `user` becomes a tester's: a bot's or a store test phone's stays `synthetic`. A marked
// session says so (`marked_tester: true` in its summary), so an agent can tell a mark from what the game sent.

export const TESTER_LIMITS = {
  max: 200, // entries a game keeps
  idMax: 128,
  noteMax: 200,
};

// The entries as the sets sessionContext looks sessions up in; null when there are none.
export function testerIndex(entries = []) {
  const players = new Set();
  const sessions = new Set();
  for (const e of entries || []) {
    if (typeof e?.player === 'string' && e.player) players.add(e.player);
    if (typeof e?.session === 'string' && e.session) sessions.add(e.session);
  }
  return players.size || sessions.size ? { players, sessions } : null;
}

// A player's session (one its SDK sent as `user`) that the index marks reads as a tester's.
export function markTester(s, index) {
  if (!index || s.session_type !== 'user') return;
  if (!index.sessions.has(s.session_id) && !(s.player_id != null && index.players.has(s.player_id))) return;
  s.session_type = 'tester';
  s.marked_tester = true;
}

// An entry's key, for the list: one per player or session.
export const testerKey = (e) => (e.player ? `player:${e.player}` : `session:${e.session}`);

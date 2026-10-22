---
name: dashboard
description: Build a game's own Glitchless dashboard. Work out what this game's developer wants to know, add the collectors for it (custom events with track(), levels, gauges, positions, game tools agents can call), check the data arrives, then design the game's dashboard (its pages: boards of panels and the built-in views it needs) with the glitchless_set_dashboard MCP tool. Use when the user asks for a dashboard, metrics, KPIs or analytics for their game, wants to track or count something, asks "how many players…", "which mode…", "does the paywall convert", or wants a different view of their game in Glitchless.
---

# Build a game's own dashboard

Every game needs different numbers. A mobile game cares whether players come back, which mode they pick and
whether the paywall turns into purchases; a puzzle game, how long a puzzle takes and how often hints are used; a
platformer or shooter, where players die and whether frames hold up in a fight. Glitchless doesn't guess: you
add the collectors this game needs, and design its dashboard from them: its own pages, in its own words. The
developer then sees it in Glitchless, and you can read the same data back over MCP to debug.

Before this skill, the game should already send data (the `instrument` skill). If it doesn't, do that first.

## 1. Find out what they want to know

Write down three to eight questions, in the developer's words. Ask if they haven't said; read the game to
suggest some (menus, modes, shops, level lists, settings, anything with a counter). Good questions are about
decisions: "Do players finish the tutorial?", "Which mode do they play?", "Does the paywall convert?", "Which
stage is too hard?", "Does it stutter on phones?". Leave out what nobody would act on.

## 2. Pick a collector for each question

| The question is about | Collector | Shows on a board as |
| --- | --- | --- |
| how often something happens, or which option players choose | `track(name, attrs)` | `stat`, `series`, `breakdown` |
| a sequence (tutorial → first win, paywall → purchase) | one `track` per step | `funnel` |
| progress or difficulty through stages, puzzles, waves, stops | `levelStart` / `levelComplete` / `levelFail` | `levels` |
| dying, and where | `death` (and `setPosition` for places) | `deaths`, the Heatmaps view |
| smoothness, and what makes it worse | automatic frame times, plus `setContext` gauges (enemies, particles) | `frame_time`, `stat: frame_p95` |
| crashes and errors | automatic, plus `error()` for handled ones | `errors`, `stat: crash_free_pct` |

The calls, per engine:

| | Three.js or Phaser | Godot | Unity |
| --- | --- | --- | --- |
| a game event | `glitchless.track('play', { mode: 'endless' })` | `Glitchless.track("play", "endless")` | `Glitchless.Track("play", "endless");` |
| several attributes | `glitchless.track('buy', { step: 'done', item: 'full_game' })` | `Glitchless.track("buy", {"step": "done"})` | `Glitchless.Track("buy", new Dictionary<string, object> { ["step"] = "done" });` |
| a level | `levelStart(id)`, `levelComplete(id, { score })`, `levelFail(id, { cause })` | `level_start`, `level_complete`, `level_fail` | `LevelStart`, `LevelComplete`, `LevelFail` |
| a gauge | `glitchless.setContext({ enemies })` | `Glitchless.set_context({"enemies": n})` | `Glitchless.SetContext("enemies", n)` |

Rules that keep the numbers useful:

- One event name per moment, in the game's own words (`open`, `play`, `paywall`, `buy`), and keep names stable:
  renaming an event splits its history.
- Put the choice in an attribute, not the name: `play` with `mode: 'endless'`, not `play_endless`. Godot and
  Unity turn one word into the attribute `what`.
- Attributes are strings, numbers or booleans, at most 12 per event; strings are cut to 64 characters. Keep their
  values to a small set (modes, places, outcomes): a value per player or per run makes a useless breakdown.
- Never send anything that identifies a player: no names, emails, account ids or anything they typed.

Add the calls where the moment happens in code, then run the game (or let the bots play it) and check with
`glitchless_events` that every event arrives with the attributes you expect.

## 3. Design the dashboard

A dashboard is the game's pages, in the order its sidebar shows them; the first opens first. Each page is a
board, panels you choose, or a built-in view the game keeps: `events` (every event, breakdowns, funnels),
`performance` (frame time and hitches), `errors`, `players`, `heatmaps` (positions on the level), `sessions`
(each with its replay), `versions` and `live` (events as they arrive; `options.events` keeps only some). Give the
game the pages its developer would open, named in the game's words, and drop the views it has no data for: no
Heatmaps for a puzzle or mobile game, no Performance for a game that sends no frame times.

Start from what is there: `glitchless_dashboard` returns the current pages (`spec`; an automatic dashboard until
someone saves one). Then call `glitchless_set_dashboard` with every page. On a board: a row of stats, then the
game's own events and funnels, then levels, then frame time and errors. Title each panel with the question it
answers. Each panel takes `size`: `s` (a quarter row, for stats), `m` (half) or `l` (full width); and a `note`,
one line on why it matters.

| type | fields |
| --- | --- |
| `stat` | `metric` (sessions, players, avg_session_s, crash_free_pct, error_free_pct, frame_p95, avg_fps, hitches_per_min, errors, deaths, rage_quit_pct), or `event` with an optional `per` (a percentage) |
| `series` | `event`, optional `by` (split by an attribute, or `$version` / `$level`), `limit` |
| `breakdown` | `event`, `by`, `limit` |
| `funnel` | `steps`: events in order, comma-separated |
| `levels` | `label`: what the game calls a level ("Stop", "Puzzle", "Wave") |
| `sessions` | `sent`: only sessions that sent this event ("buy=done"), `limit` |
| `versions` | none: this board's stats, version by version |
| `live` | `events`: only these names or types, as they arrive |
| `findings`, `frame_time`, `errors`, `deaths`, `events` | none (`limit` for findings and errors) |

An event is written `name`, `name=value` (any attribute has that value) or `name:key=value`.

A mobile game with modes, stops and a paywall:

```json
{
  "pages": [
    { "title": "Overview", "icon": "overview", "panels": [
      { "type": "stat", "metric": "players", "size": "s" },
      { "type": "stat", "event": "open", "title": "App opens", "size": "s" },
      { "type": "stat", "event": "buy=done", "per": "paywall", "title": "Paywall to purchase", "size": "s" },
      { "type": "stat", "metric": "crash_free_pct", "size": "s" },
      { "type": "findings", "limit": 3, "size": "l" },
      { "type": "breakdown", "event": "play", "by": "what", "title": "Which modes they play", "size": "m" },
      { "type": "series", "event": "open", "by": "what", "title": "Opens, free vs full", "size": "m" }
    ] },
    { "id": "paywall", "title": "Paywall", "icon": "bolt", "panels": [
      { "type": "funnel", "steps": "paywall,buy=tapped,buy=done", "title": "Paywall to purchase", "size": "l" },
      { "type": "breakdown", "event": "paywall", "by": "what", "title": "Where the paywall opens", "size": "m" },
      { "type": "versions", "title": "Paywall numbers by version", "size": "m" },
      { "type": "sessions", "sent": "buy=done", "title": "Sessions that bought", "size": "l" }
    ] },
    { "id": "stops", "title": "Stops", "icon": "flag", "panels": [
      { "type": "levels", "label": "Stop", "title": "Stops won and lost", "size": "l" },
      { "type": "breakdown", "event": "difficulty", "by": "what", "title": "Difficulty picked", "size": "m" }
    ] },
    { "id": "purchases-live", "title": "Purchases, live", "view": "live", "options": { "events": ["paywall", "buy"] } },
    { "view": "events" },
    { "view": "sessions" },
    { "view": "versions" },
    { "view": "errors" }
  ]
}
```

A puzzle game: an Overview with `stat` players and average session, `levels` with `"label": "Puzzle"` (completion
and time), a `breakdown` of `hint` by `what` and a `funnel` of `tutorial=done,puzzle_solved`; then Events, Sessions
and Errors. No Performance unless it's slow, no Heatmaps, no deaths.

A platformer or shooter: an Overview with `stat` frame_p95 and crash_free_pct, `findings`, `frame_time`, `levels`,
`deaths` and a `breakdown` of `weapon` or `powerup`; then Performance, Heatmaps, Errors, Sessions and Versions.

Saving checks every page and answers with each panel as it looks over the last week; a panel without data says
why ("No "buy" events in this window"), and `glitchless_dashboard` with `page` shows one board's numbers. Show the
developer, then change what they ask for: "split opens by version", "add the shop" is one more `track` call and one
more panel, "a page for the tutorial" one more board. People can rename, reorder, add and remove pages in the
dashboard too (Edit pages), so read the current pages before saving over them.

## 4. Use it to debug

The boards also decide what a release is judged on: the Versions view and `glitchless_compare_versions` compare
the stats on every board, version by version (purchases per paywall view, opens per session), so ship a change,
bump the version, and read whether it moved the numbers this game cares about. For one event across versions on a
board, use `by: "$version"`; for a board's own stats, a `versions` panel.

The dashboard's numbers are what you read when something looks wrong: `glitchless_events` with a `funnel` finds
where players drop off, `glitchless_triage` ranks performance, crash and difficulty problems, and in a browser
game the WebMCP tools let you reproduce one in the running game. Add a panel for anything you find yourself
checking twice.

## Report

List the questions, the events and calls you added (file:line), and the dashboard's pages and panels, and say
which panels will fill in only once players or bots send that data.

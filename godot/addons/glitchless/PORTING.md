# From `Metrics.count` to Glitchless

Linebreakers and Starlift each count play with their own `Metrics` autoload (`src/net/metrics.gd`). It sends `"event:word"` totals every 45 s to a Lambda function, which adds them to DynamoDB daily totals that `tools/metrics.py` reads. Those totals answer *how often*. Glitchless answers *what happened in a session*: where frames stuttered, which error followed which event, and which level people stop at, split by version and device tier.

The two can run side by side. This guide shows how the calls map. Nothing in either game has been changed: adding Glitchless changes what the game sends, so the privacy page and store answers must change first ([PRIVACY.md](PRIVACY.md)). That is the owner's decision.

## 1. Add the addon

Copy `addons/glitchless/` into the game, then add it under `[autoload]` after `Metrics`:

```ini
Glitchless="*res://addons/glitchless/glitchless.gd"
```

Call `init` once at startup, for example in `src/main.gd`'s `_ready`:

```gdscript
Glitchless.init("starlift", "", "prod", Endpoints.GLITCHLESS_URL, {"enabled": Metrics.enabled})
```

- `""` for the version uses `application/config/version`, the version the stores show.
- `Endpoints.GLITCHLESS_URL` would sit beside `DAILY_URL` / `COUNTS_URL`.
- `{"enabled": Metrics.enabled}` keeps one switch for both. `Metrics` turns itself on in release builds or with `--metrics`. Leave the option out to use Glitchless's own switch, `--glitchless`.

## 2. Forward every count

The smallest change is one line at the end of `Metrics.count()`, so every existing call also reaches Glitchless with no other edits:

```gdscript
func count(event: String, what: String = "all") -> void:
	if not enabled:
		return
	...
	Save.set_setting(SAVE_KEY, _pending)
	Glitchless.track(event, what)  # the same event and word, with a time and the level it happened on
```

`Glitchless.track(event, what)` sends `{"type": "custom", "name": event, "attrs": {"what": what}}`. Every `Metrics` key `play:endless` becomes a custom event named `play` with `what: "endless"`. Breadcrumbs and the findings' "what came before the stutter" analysis use the event name.

## 3. Use the level calls where a count is really a level

The funnel, completion rates, rage quits and per-level frame times come from `level_start` / `level_complete` / `level_fail`, not from custom events. So the counts that mark a stop's start and end are worth a real level call too:

| game | today | Glitchless |
| --- | --- | --- |
| Linebreakers | `Metrics.count("stop_start", id)` | `Glitchless.level_start(id)` |
| Linebreakers | `Metrics.count("stop_won" if won else "stop_lost", _stop)` | `Glitchless.level_complete(_stop)` or `Glitchless.level_fail(_stop, "lost")` |
| Linebreakers | `Metrics.count("stop_left", _stop)` | `Glitchless.level_fail(_stop, "left")` |
| Linebreakers | `Metrics.count("battle", "won" if won else "lost")` | keep as `track`, or `level_complete` / `level_fail` with the map as the level |
| Starlift | `Metrics.count("play", "voyage")`, then a stop begins | `Glitchless.level_start(stop_id)` where the stop begins |
| Starlift | `Metrics.count("stop_won" if won else "stop_lost", id + hard)` | `Glitchless.level_complete(id + hard)` or `Glitchless.level_fail(id + hard, "lost")` |
| Starlift | `Metrics.count("play", _mode)` for endless, daily or duel | keep as `track`; for per-mode frame times, `level_start(_mode)` when the run begins |
| both | `Metrics.count("open", …)`, `("paywall", why)`, `("buy", …)`, `("tutorial", …)`, `("sheet", …)` | `track`, as forwarded in step 2 |

Starlift would have both a `stop_won` custom event and a `level_complete` for the same moment, which is fine: they answer different questions.

## 4. Add what counts can't hold

These have no `Metrics` equivalent:

- **Deaths.** In Starlift, `Glitchless.death(x, y, "overflow")` when the stack tops out. In Linebreakers, when a commander falls. Anonymous mode sends only the cause; the place goes too with `{"positions": true}`, and it is a place on the board, not the player's location.
- **Gauges**, at the end of the frame's work: blocks on the board, units on the field, effects playing. A stutter then says what was high when it happened:

  ```gdscript
  Glitchless.set_context({"blocks": _board.count(), "effects": _fx.get_child_count()})
  ```

- **Caught errors:** `Glitchless.error("save slot unreadable", {"slot": slot})` where the game recovers from something.

Frame times, hitches, engine counts, errors and the device tier need no code.

## 5. Bots and agents

The games' debug flags keep working:

- `--autoplay` marks a session `synthetic`, so the dashboard can show bot runs apart from players.
- A debug build sends only with `--glitchless`, which keeps the agents' bot runs out of the players' numbers unless asked.

```bash
# a bot run into a local Glitchless server (node server/src/local.js)
godot --path . -- --autoplay --seed=7 --glitchless --glitchless-intake=http://localhost:7777

# frame stats for one seeded run, as JSON, then quit
godot --path . -- --autoplay --seed=7 --screen=battle --glitchless-measure=10 | grep '^{"glitchless_measure"'
```

`--glitchless-measure` is the native version of the browser SDK's `glitchless_measure` WebMCP tool. Run it before and after a change with the same seed and compare `frame_ms.p95`, `hitch_count` and `memory_delta.orphan_nodes`.

## What the switch costs

- **Privacy text.** The counts carry no time and no session. Glitchless reports carry both, so the privacy page needs the new paragraph in [PRIVACY.md](PRIVACY.md), and the App Store and Play answers change.
- **Data.** A 5 s frame window is about 0.8 KB, more when frame times are spread out. A ten-minute session sends roughly 100–150 KB, against a few bytes a day for the counts.
- **Frame time.** About a dozen engine reads and a sketch update per frame, plus two near-empty `_process` callbacks.
- **The daily totals stay** as they are. Glitchless keeps events for 14 to 30 days (see PRIVACY.md), so the long-run trend lives in the counts.

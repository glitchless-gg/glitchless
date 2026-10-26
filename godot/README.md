# Glitchless for Godot

- [`addons/glitchless`](addons/glitchless): the SDK. Copy this folder into a game. Read its [README](addons/glitchless/README.md), what it sends in [PRIVACY.md](addons/glitchless/PRIVACY.md), and how to move over from `Metrics.count` in [PORTING.md](addons/glitchless/PORTING.md).
- [`demo`](demo): a tiny game with planted problems, so Glitchless has something to find: a `push_error` with a device path, a stutter, an orphan-node leak and a script error. It takes `--autoplay --seed=N` like Linebreakers and Starlift do.
- [`test`](test):
  - `e2e.mjs` plays the demo against a fresh local Glitchless server and checks the results through `/v1/query`, then plays `net/net_game.tscn`, a small ENet game, as a dedicated server (`--server`) and a client against a fake intake, for counters, properties, groups, zones, network quality, disconnects and server mode.
  - `sketch_fixture.gd` writes the fixture behind `server/test/godot.test.js`.

This folder is itself a Godot 4.7 project (Mobile renderer).

## Try it

```bash
npm run server                                   # Glitchless on http://localhost:7777
godot --path godot -- --autoplay --seed=3 --glitchless
npm run dashboard                                # or open http://localhost:7777 after npm run build
```

Frame stats for one run, as JSON:

```bash
godot --path godot -- --autoplay --seed=3 --glitchless-measure=8 | grep '^{"glitchless_measure"'
```

## Tests

```bash
npm run test:godot   # needs Godot 4.5+; set GODOT=/path/to/Godot if it isn't on PATH
npm test             # includes the GDScript-sketch merge test, no Godot needed
```

To regenerate the sketch fixture after changing `sketch.gd`:

```bash
godot --headless --path godot --script res://test/sketch_fixture.gd
```

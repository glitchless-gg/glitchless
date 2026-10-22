# Changelog

## 0.1.0

The first release.

- Frame times from `Time.unscaledDeltaTime`, summed up per 5-second window in the frame-time sketch the browser and Godot SDKs use, with update, physics, render and GPU time per frame.
- Hitches with likely causes: garbage collection, shader compiles, scene loads, object bursts, long script, physics or render work, frozen frames.
- Uncaught exceptions, `Debug.LogError`, assertions and engine errors, grouped by fingerprint, with the game events before each.
- Scenes as levels, deaths, level completes and fails, game events, gauges and positions.
- Draw calls, SetPass calls, batches, triangles and memory from Unity's profiler counters; mesh, material, texture and object counts in development builds.
- Anonymous by default. Gzipped batches with retries, an offline outbox, and a last send when the app goes to the background or quits.
- `--glitchless-measure` for coding agents, and the Fetch! sample with planted bugs.
- Unity 2022.3 LTS and Unity 6.

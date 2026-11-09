# Glitchless for Unity

- [`Packages/gg.glitchless.sdk`](Packages/gg.glitchless.sdk): the SDK, a Unity package (Unity 6.0 LTS and later). Read its [README](Packages/gg.glitchless.sdk/README.md) and what it sends in [PRIVACY.md](Packages/gg.glitchless.sdk/PRIVACY.md). Its `Samples~/Fetch` is a small game with planted bugs.
- [`test`](test):
  - `e2e.mjs` builds the sample as a macOS player, plays it against a fresh local Glitchless server and checks the results through `/v1/query`.
  - `make-fixtures.mjs` writes the fixture the EditMode tests check the C# sketch and fingerprints against.
  - `overhead.mjs` builds a release player with `Assets/Overhead` in it and prints what the SDK costs the main thread (the package README's "What it costs").
  - `map.mjs` checks level maps (`Glitchless.CaptureMap`) for real: the PlayMode `MapCaptureTests` in the built-in pipeline and in URP with its 2D and Universal renderers (on copies of this project), then a WebGL build of `Assets/MapProbe` played in headless Chromium against a local server, whose heatmap query must put each death on what stood there. It needs a graphics device, so it runs the Editor without `-nographics`.
- [`PUBLISHING.md`](PUBLISHING.md): releasing a version (git tags, OpenUPM, the Asset Store).

This folder is itself a Unity project on the current LTS (Unity 6.3, 6000.3.27f1) that embeds the package; `Assets/Editor/SampleBuilder.cs` imports the sample and builds it. It also has Netcode for GameObjects 2.13 (the SDK itself doesn't depend on it), for the PlayMode test that runs an NGO server and client in one run.

## Try it

```bash
npm run server                                   # Glitchless on http://localhost:7777
```

Open this folder in Unity 6000.3.27f1 (or a later Unity 6), choose **Glitchless → Import the Fetch! sample**, open `Assets/Samples/Glitchless/Fetch/FetchBoot.unity`, tick **Autoplay** on the **Fetch** GameObject and press Play. Then open http://localhost:7777.

## Tests

```bash
npm run test:unity       # builds and plays the sample; UNITY=/path/to/Unity for another Editor version
npm run test:unity:map   # level maps in each pipeline and in a WebGL build (about 4 minutes once unity/ is imported)
```

With `UNITY=/path/to/Unity`, both run on a copy of this folder with that Editor's own packages (`test/editor-packages.mjs`), so Unity 6.0 LTS, the oldest the package supports, runs it too.

EditMode and PlayMode tests run in Unity's Test Runner, or from the command line:

```bash
Unity -batchmode -nographics -projectPath unity -runTests -testPlatform EditMode -testResults edit.xml
```

To regenerate the fixture after changing the JavaScript sketch or fingerprints: `node unity/test/make-fixtures.mjs`.

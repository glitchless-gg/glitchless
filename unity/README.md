# Glitchless for Unity

- [`Packages/gg.glitchless.sdk`](Packages/gg.glitchless.sdk): the SDK, a Unity package (2022.3 LTS and Unity 6). Read its [README](Packages/gg.glitchless.sdk/README.md) and what it sends in [PRIVACY.md](Packages/gg.glitchless.sdk/PRIVACY.md). Its `Samples~/Fetch` is a small game with planted bugs.
- [`test`](test):
  - `e2e.mjs` builds the sample as a macOS player, plays it against a fresh local Glitchless server and checks the results through `/v1/query`.
  - `make-fixtures.mjs` writes the fixture the EditMode tests check the C# sketch and fingerprints against.
- [`PUBLISHING.md`](PUBLISHING.md): releasing a version (git tags, OpenUPM, the Asset Store).

This folder is itself a Unity 2022.3 project that embeds the package; `Assets/Editor/SampleBuilder.cs` imports the sample and builds it.

## Try it

```bash
npm run server                                   # Glitchless on http://localhost:7777
```

Open this folder in Unity 2022.3.62f3 (or Unity 6), choose **Glitchless → Import the Fetch! sample**, open `Assets/Samples/Glitchless/Fetch/FetchBoot.unity`, tick **Autoplay** on the **Fetch** GameObject and press Play. Then open http://localhost:7777.

## Tests

```bash
npm run test:unity   # builds and plays the sample; UNITY=/path/to/Unity for another Editor version
```

EditMode and PlayMode tests run in Unity's Test Runner, or from the command line:

```bash
Unity -batchmode -nographics -projectPath unity -runTests -testPlatform EditMode -testResults edit.xml
```

To regenerate the fixture after changing the JavaScript sketch or fingerprints: `node unity/test/make-fixtures.mjs`.

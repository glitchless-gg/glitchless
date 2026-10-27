# Glitchless against Fab's rules for code plugins

This checks the plugin against Fab's [Technical Requirements](https://www.fab.com/technical-requirements) ("Last
Updated: September 21, 2026", read 2026-10-23), §1 and §4, and against the
[Asset File Format and Structure Requirements](https://dev.epicgames.com/documentation/fab/asset-file-format-and-structure-requirements-in-fab)
and the support article [Plugin Compilation Environment](https://support.fab.com/s/article/Fab-Plugin-Compilation-Environment).
`node unreal/scripts/package-plugin.mjs --fab --engine 5.8` checks the rows marked *script*.

The status column says who has to act:

- **ok**: the plugin meets the rule as it is.
- **U1**: needs a change in the plugin's files. U1 made the ones in `unreal-u2-requests-for-u1.md` (shared notes) on
  main in 22966b2 and 4d2305a; what's left is the Win64 build.
- **zip**: the release script handles it.
- **owner**: done in the portal ([STEPS.md](STEPS.md)).

| rule | what it asks | Glitchless | status |
| --- | --- | --- | --- |
| 4.2.1.a | one plugin per zip | the zip holds only `Glitchless/` (*script*) | zip |
| 4.2.2.b, c | supports the latest engine version | made for UE 5.8, the latest | ok |
| 4.2.2.d | one project version and zip per engine version, differing in `EngineVersion` | `--engine 5.8` stamps `"EngineVersion": "5.8.0"` into the zip's copy | zip |
| 4.2.3.a | target platforms work as advertised | Mac is built and passes U1's e2e; Win64 isn't built yet; iOS, Android and Linux are untested | owner (list Mac, plus Windows once built) |
| 4.2.4 | distribution method | Engine Plugin | owner |
| 4.2.5 | third-party software declared | fdlibm's `__ieee754_log` in `Source/ThirdParty/fdlibm` (Sun notice kept); [LISTING.md](LISTING.md) has the declaration | owner |
| 4.3.1.d | Experimental dependencies stated | none in this plugin. The Toolset (Unreal MCP, Experimental) isn't part of the product, and the description says so | ok |
| 4.3.1.i | works in binary engine builds | built and tested on the launcher's UE 5.8.4 | ok |
| 4.3.6.a | `EngineVersion` in the `.uplugin` | stamped into the Fab zip (*script*) | zip |
| 4.3.6.b | `PlatformAllowList` or `PlatformDenyList` on every module | `["Win64", "Mac", "Linux", "IOS", "Android"]` (U1, 22966b2) | ok |
| 4.3.6.c | `FabURL` with the listing's ID | ID known only once the draft exists; `--fab-url` stamps it | owner then zip (STEPS 10) |
| 4.3.6.d | depends only on plugins that ship with the engine | Glitchless depends on none. GlitchlessToolset depends on Glitchless, so it can't be listed and stays on GitHub (*script*) | ok |
| 4.3.6.1.a | source included | all source, no binaries | ok |
| Legal (review, 27 Oct 2026) | no EULA, licence or conduct files, nor policies other than the licence chosen on Fab | the Fab zip has no LICENSE (the review found it there: Changes needed), names no other licence, and the listing text doesn't mention MIT; the script refuses a licence file or "MIT License" outside `Source/ThirdParty` (*script*) | fixed |
| 4.3.6.1.b | a copyright comment with the publisher and year in every source and header file | `// Copyright (c) 2026 The Glitchless authors.` in every file of the Fab zip (the repo's own add `MIT License: see LICENSE.`, which the script leaves out for Fab) | ok |
| 4.3.6.1.c | at least one C++ module | `Glitchless` (Runtime) | ok |
| 4.3.6.1.d | integrates UE with third-party systems or adds editor features | sends telemetry to a Glitchless server; settings page, Blueprint library | ok |
| 4.3.6.1.e | no `.exe` or `.msi` (*script*) | none | ok |
| 4.3.6.2.a | no errors or consequential warnings | `BuildPlugin` (Fab's build) on the staged zip failed the game target on Mac until `GlitchlessRuntime.h` included `UObject/WeakObjectPtr.h` (with no shared PCH, U1 fixed it in 4d2305a). Now it builds editor and game, arm64 and x64, with 0 plugin warnings. Win64 not yet built | **U1** (Win64 BuildPlugin on the winbox) |
| 4.3.6.2.b | test with `RunUAT BuildPlugin … -Rocket` | `package-plugin.mjs --fab --engine 5.8 --build` runs it on the staged zip contents | U1 / zip |
| 4.3.6.2.c | IWYU (`PCHUsage = UseExplicitOrSharedPCHs`) | set in `Glitchless.Build.cs` | ok |
| 4.3.6.2.e | own include paths through `ModuleDirectory` | no extra include paths (only if fdlibm moves to `Source/ThirdParty`) | ok |
| 4.3.6.3 | an example project, linked from Technical Information, without the plugin inside | `unreal/demo` loads the plugin through `AdditionalPluginDirectories` and carries no copy | ok |
| 4.3.7.1.c | names in English letters, digits and underscores (*script*) | all names pass | ok |
| 4.3.7.3.a | no Binaries, Build, Intermediate or Saved (*script*) | the zip is built from git, which tracks none | zip |
| 4.3.7.3.b | `Config/FilterPlugin.ini` for anything outside Config, Content, Resources and Source | lists README.md and PRIVACY.md in the Fab zip (*script*) | ok |
| 4.3.7.3.c | paths of 170 characters or less (*script*) | the longest is 67 | ok |
| 4.3.7.3.d | third-party code in `Source/ThirdParty` | `Source/ThirdParty/fdlibm/fdlibm_log.h`, with Sun's notice and a README (U1, 22966b2) | ok |
| 4.3.8 | free documentation in English | README.md and PRIVACY.md in the plugin, and on GitHub | ok |
| 1.1.b | a support channel that is watched | support@glitchless.gg and GitHub issues | owner |
| 1.3.a | publisher name without Epic or Unreal words | `Glitchless` | ok |
| 1.8.1 | English text with correct spelling | LISTING.md | ok |
| 1.8.4 | Technical Information complete, with dependencies | LISTING.md names the server, network use and fdlibm | ok |
| 1.8.6.a | media shows the product accurately | dashboard captures and the demo, real data from the demo's bot runs | ok |
| 1.8.8.a | says whether AI was used | Yes: coding agents | owner |
| — | `Resources/Icon128.png` (not a Fab rule; the Plugins window and the store build use it) | the Glitchless icon (U1, 22966b2) | ok |

Fab compiles against "the three latest major engine versions" only when they are declared (§4.3.6.2.d). Declare 5.8
alone: 5.7 is guarded in the code, but nobody has compiled it.

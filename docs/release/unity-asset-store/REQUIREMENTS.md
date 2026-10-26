# The Unity package against the Asset Store's rules

`gg.glitchless.sdk` 0.5.1 checked against the [Submission Guidelines](https://assetstore.unity.com/publishing/submission-guidelines)
and the UPM publishing pages ([enroll](https://docs.unity.com/en-us/asset-store/publishing/upm-packages/apply),
[draft](https://docs.unity.com/en-us/asset-store/publishing/upm-packages/create-draft),
[validate and upload](https://docs.unity.com/en-us/asset-store/publishing/upm-packages/validate),
[submit](https://docs.unity.com/en-us/asset-store/publishing/upm-packages/submit)), read 26 October 2026. "Script"
means `unity/scripts/asset-store.mjs` checks or does it on every run.

| rule | what it asks | Glitchless | who |
| --- | --- | --- | --- |
| 1.1.b | No errors or warnings from the package | The store project imported in 6000.3.27f1 with none (26 Oct). The package's tests stay on GitHub: in a project without the Test Framework they don't compile | script |
| 1.1.e | A UPM product under 700 MB (550 MB on the upload page) | 372 KB | script |
| 1.1.f | Demo scenes for 3D, 2D, VFX, animation and templates | Not required for tools; the Fetch! sample is included anyway | done |
| 1.1.g | No unsafe code, no mishandled identifying data | Anonymous by default; PRIVACY.md lists every field of every mode | done |
| 1.1.j–l | MCP or AI features: only the data they need, no training, no slow Editor | Nothing in the package runs in the Editor or talks to an AI; the MCP server is a separate npm package and a hosted URL | done |
| 1.2.a | A Third-Party Notices file for third-party code | None in the package (Unity's modules only); the script refuses a ThirdParty folder without a notices file | script |
| 1.2.c | Code under the Asset Store EULA, or open-source terms Unity agrees to in writing | The store copy has no LICENSE.md and points `licensesUrl` at the EULA; GitHub stays MIT | script |
| 1.3.a | Unity 2022.3 or newer | 6000.3 (6.3 LTS) | done |
| 1.3.c | Submissions made with 6.5 or newer support URP or HDRP | Made with 6.3; the SDK draws nothing pipeline-specific (IMGUI form only), so all three pipelines work | done |
| 1.4.a, 1.4.c | A service's login and usage limits disclosed | The description's first paragraph: self-hosting needs no account; Glitchless Cloud's plans and session limits | LISTING.md |
| 1.5.a | No executables | None | script |
| 1.5.b | Keys not built into games, and the description says how they're stored | The public client token is made to ship (it can only send); secret keys never go in a build. The description says so | LISTING.md |
| 1.5.c | A service's terms and costs at the top of the description and in the docs | First paragraph of the description; the README's install section links the server and Cloud | LISTING.md |
| 1.5.d | Analytics and SaaS SDKs are asked to consider Verified Solutions | Optional; worth a look once listed | owner, later |
| **1.5.e** | **Analytics opt-in, and customers can opt out at any time** | Opt-in: nothing is sent until `Glitchless.Init()` or the Bootstrap; the automatic start keeps early frames in memory only, and `GLITCHLESS_DISABLE` turns it off. **Missing: a runtime off switch** (a player's "share data" setting) in every SDK. Worth adding before submitting: `Glitchless.SetEnabled(false)` that stops sending and clears the outbox, in SPEC and all SDKs | **to do** |
| 1.6.a | AI-made functional parts disclosed in the "AI description" field | Filled in | LISTING.md |
| 2.1.a, d, e | One root folder; no AssetStoreTools folder; paths under 150 characters from the package's name | One package folder; longest path well under | script |
| 2.3.a, b | Documentation for code, setup and options, as .md or similar | README.md, PRIVACY.md and CHANGELOG.md in the package | done |
| 2.5.a, f | Your own namespaces, no Unity or trademark namespaces | `GlitchlessSdk` | done |
| 2.5.b | 64-bit Android | Pure C#, no native plugins | done |
| 2.5.g | No reflection into internal Editor APIs | No Editor code. Runtime reflection reads the public API of Netcode for GameObjects, Mirror and the Steamworks wrappers when a game has them, so the SDK depends on none | done |
| 2.5.h | From 6.6: Play mode with domain reload off | Statics reset at `SubsystemRegistration` already | done |
| 2.5.i | No obsolete-API warnings on the newest supported Unity | None in 6000.3.27f1 | done |
| 2.5.1 | Editor menus under existing menus or Tools; no installing packages | Only `Component → Glitchless → Glitchless Bootstrap`; installs nothing | done |
| 5.1 | UPM publishers: identity check, namespace proof | Persona, and glitchless.gg's DNS for `gg.glitchless` | owner (STEPS 4) |
| 5.2.a, b, d | Scripts in assemblies, valid asmdefs, a .meta for every asset | `GlitchlessSdk.asmdef`; every file has its .meta | script |
| 5.2.e–k | Manifest fields; semantic version; author is the publisher's name | `unityRelease` and author added by the script | script |
| 1.1.m | 5 submissions a month in the first 6 months | One product | done |

## Known risks

- **The review queue.** Unity says at least five business days; publishers reported a month and more in October 2026.
- **The opt-out (1.5.e).** A reviewer may read "opt out at any time" as needing a runtime switch. Adding one is small
  and helps every SDK's store privacy answers too.
- **The validator.** Its checks aren't published; anything it flags comes back to the parent session (STEPS 9).

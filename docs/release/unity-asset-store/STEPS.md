# Putting Glitchless on the Unity Asset Store: your steps

These are the owner's steps, from the draft to "Submit". Every value to type is in [LISTING.md](LISTING.md), and the
package comes from `node unity/scripts/asset-store.mjs`, never by hand.

It goes up as a **classic package**: a `.unitypackage` that imports into `Assets/Glitchless`, with the Fetch! sample
in `Assets/Glitchless/Samples/Fetch`. That needs only a publisher account, no UPM enrollment. The draft is
**Glitchless Game Observability** (package 1534106, made 26 October 2026), and it takes uploads from Unity 2022.3 or
newer, up to 6 GB. The store copy is 370 KB.

Allow an hour for the upload and the listing, then Unity's review: "at least five business days" by Unity's docs,
but publishers on Unity's forum reported queues of a month and more in October 2026. GitHub stays the install route
until it's live.

## Before you start (the parent session)

1. **The package passes.** `node unity/scripts/asset-store.mjs --classic` must print no rule failures, and the
   project it writes (`dist/unity-asset-store/GlitchlessClassic`) must import in Unity 6000.3.27f1 with no errors or
   warnings, with the sample scene's scripts found (it did on 26 October 2026, for 0.5.1).
2. **Worth doing first: a player opt-out.** Rule 1.5.e says analytics must be opt-in, and "customers must be permitted
   to opt out at any time". Nothing is sent until `Glitchless.Init()`, so a developer opts in; but no SDK can be
   turned off at runtime yet, for a game whose players switch "share performance data" off in its settings. See
   REQUIREMENTS.md.

## Upload the package

3. **The store project.** Ask the parent session to run `node unity/scripts/asset-store.mjs --classic` on the
   commit you release, then open `dist/unity-asset-store/GlitchlessClassic` in Unity Hub (**Add → Add project from
   disk**) with **6000.3.27f1**. Its `Packages/manifest.json` lists the five built-in modules the package uses, as
   every new project does.
4. **Asset Store Publishing Tools.** The draft page links them (or https://assetstore.unity.com/packages/package/5368745):
   **Add to My Assets**, then in the project **Window → Package Manager → My Assets → Asset Store Publishing Tools →
   Install**. They install under `Packages/`, so they stay out of the upload.
5. **Validate.** **Window → Tools → Asset Store → Validator**, the Tools category, the folder **`Assets/Glitchless`**,
   **Validate**. Anything it flags goes to the parent session, which fixes the source and makes the project again.
6. **Upload.** **Window → Tools → Asset Store → Uploader**, sign in, and open **Glitchless Game Observability** under
   the drafts. Upload type **From Assets Folder**, folder **`Assets/Glitchless`**. If it offers **Include Package
   Manifest**, turn it on and tick the five built-in modules (Unity Web Request, IMGUI, Image Conversion, Screen
   Capture, Physics) so a buyer's import turns them on. Then **Export and Upload**. The draft page then shows the
   package and the Unity version it came from (6000.3.27f1).

## Fill in the listing

7. **Product information.** Paste from LISTING.md: summary, description (its first paragraph stays first),
   technical details, keywords, category **Tools → Integration**, price **Free**, render pipelines, documentation
   link, release notes, the **AI description** and "no third-party software".
8. **Media.** From `media/`: the four key images (icon, card, cover, social) and the screenshots, in order.
9. **Submit**, and choose **Manually publish** if you want to pick the moment, or **Publish immediately**.

## After

10. Tell the parent session it's submitted. A rejection comes in the Publisher Portal or by email ("Rejection reasons
    sent by email"): send the text to the parent session, which fixes the package and makes a new store project at a
    new version for you to upload. Don't resubmit unchanged: rule 2.1.h can close the account for it.
11. If nothing is heard after two weeks, Unity's docs say to ask Unity support for an update.
12. **Updates** go to the same product: a new version in the Publisher Portal, then steps 3 to 6 and Submit. The
    files keep their GUIDs between versions, so an update replaces them in a buyer's project instead of adding copies.

## Later: a UPM product instead

A UPM product installs through the Package Manager, as the GitHub git URL does, and its sample stays out of the
project until someone imports it. It needs UPM enrollment first:

- **Enroll.** Publisher Portal → **Enrollment**: **Individual**, with your legal name and country (as on Fab and
  OpenAI); Persona checks a government ID against your face; for the namespace, the domain route with
  **glitchless.gg**, whose TXT record goes in GoDaddy (My Products → glitchless.gg → DNS → Add → TXT). Unity answers in
  5 to 7 business days.
- **Product.** Once **Active**: **Products → Create product**, **Single package**, namespace `gg.glitchless`,
  technical name **`gg.glitchless.sdk`**, Unity version **6000.3**.
- **Package.** `node unity/scripts/asset-store.mjs` (no `--classic`) writes `dist/unity-asset-store/GlitchlessAssetStore`.
  Validate with Validation Type **UPM**, then **Uploader → UPM Packages → Upload** next to `gg.glitchless.sdk`.

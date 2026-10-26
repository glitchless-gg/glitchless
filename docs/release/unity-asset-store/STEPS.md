# Putting Glitchless on the Unity Asset Store: your steps

These are the owner's steps, from no publisher account to "Submit". Every value to type is in
[LISTING.md](LISTING.md), and the package comes from `node unity/scripts/asset-store.mjs`, never by hand. It goes up
as a **UPM product**: the Asset Store installs it through the Package Manager, as the GitHub git URL does today.

Allow a week for the UPM enrollment (Unity answers in 5 to 7 business days), an hour for the listing, and then
Unity's review: "at least five business days" by Unity's docs, but publishers on Unity's forum reported queues of a
month and more in October 2026. GitHub stays the install route until it's live.

## Before you start (the parent session)

1. **The package passes.** `node unity/scripts/asset-store.mjs` must print no rule failures, and the project it
   writes (`dist/unity-asset-store/GlitchlessAssetStore`) must import in Unity 6000.3.27f1 with no errors or
   warnings (it did on 26 October 2026, for 0.5.1).
2. **Worth doing first: a player opt-out.** Rule 1.5.e says analytics must be opt-in, and "customers must be permitted
   to opt out at any time". Nothing is sent until `Glitchless.Init()`, so a developer opts in; but no SDK can be
   turned off at runtime yet, for a game whose players switch "share performance data" off in its settings. See
   REQUIREMENTS.md.

## Make the publisher account

3. Go to **https://publisher.unity.com**, sign in with the Unity ID that should own the listing, and create the
   publisher profile: name **Glitchless**, website, support email and support page from LISTING.md → "Publisher
   profile". Use the Glitchless icon (`docs/release/fab/media/publisher-avatar.png`) as its picture.

## Enroll as a UPM publisher

4. **Publisher Portal → Enrollment.** Pick your Unity organization, then:
   - **Individual**, with your legal name and country (as on Fab and OpenAI). An organization needs a DUNS number.
   - **Identity:** Persona checks a government ID against your face, so have the ID and a camera ready.
   - **Namespace:** choose the domain route and enter **glitchless.gg**, so the namespace is `gg.glitchless`. The
     portal shows a TXT record: add it in GoDaddy (My Products → glitchless.gg → DNS → Add → TXT, host and value as
     shown), then verify. Leave the other records as they are.
5. Wait for **Active**: Unity answers in 5 to 7 business days, and the UPM Publisher Portal then shows in the menu.

## Make the draft and upload the package

6. **Products → Create product**, named **Glitchless Game Observability**. On the **Package** tab: **Single
   package**, namespace `gg.glitchless`, technical name **`gg.glitchless.sdk`** (it must match the package exactly).
   Unity version **6000.3**.
7. **The store project.** Ask the parent session to run `node unity/scripts/asset-store.mjs` on the commit you
   release, then open `dist/unity-asset-store/GlitchlessAssetStore` in Unity Hub (**Add → Add project from disk**)
   with **6000.3.27f1**.
8. **Asset Store Publishing Tools.** Add them from https://assetstore.unity.com/packages/package/5368745 (**Add to My
   Assets**), then in the project **Window → Package Manager → My Assets → Asset Store Publishing Tools → Install**.
   Sign in when they ask.
9. **Validate.** **Window → Tools → Asset Store → Validator**, Validation Type **UPM**, package `gg.glitchless.sdk`,
   **Validate**. Anything it flags goes to the parent session, which fixes the source and makes the project again.
10. **Upload.** **Window → Tools → Asset Store → Uploader → UPM Packages → Upload** next to `gg.glitchless.sdk`. It
    gives you a link to the draft.

## Fill in the listing

11. **Product information.** Paste from LISTING.md: summary, description (its first paragraph stays first),
    technical details, keywords, category **Tools → Integration**, price **Free**, Unity version and render
    pipelines, documentation link, release notes, the **AI description** and "no third-party software".
12. **Media.** From `media/`: the four key images (icon, card, cover, social) and the screenshots, in order.
13. **Submit**, and choose **Manually publish** if you want to pick the moment, or **Publish immediately**.

## After

14. Tell the parent session it's submitted. A rejection comes in the Publisher Portal or by email ("Rejection reasons
    sent by email"): send the text to the parent session, which fixes the package and makes a new store project at a
    new version for you to upload. Don't resubmit unchanged: rule 2.1.h can close the account for it.
15. If nothing is heard after two weeks, Unity's docs say to ask Unity support for an update.

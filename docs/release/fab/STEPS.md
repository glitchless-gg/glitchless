# Putting Glitchless on Fab: your steps

These are the steps for the owner, in the Fab publisher portal, from no seller account to "Submit for review". Every
value to type is in [LISTING.md](LISTING.md), and every file is in this folder or comes from the release script. Allow
about an hour; Fab then reviews the listing (it doesn't publish a review time). GitHub stays the jam-day route, so a
late review blocks nothing. The plan is to submit by **Nov 3**.

## Before you start (needs the parent session, not the portal)

1. **The plugin passes Fab's checks.** U1 made the changes Fab needs on main (22966b2, 4d2305a): a platform list per
   module, a copyright line in every source file, `Config/FilterPlugin.ini`, `Resources/Icon128.png`, fdlibm in
   `Source/ThirdParty`, and the include that lets the game target build without a shared PCH. On the commit you
   release, this must still print no `error:` lines:
   ```bash
   node unreal/scripts/package-plugin.mjs --fab --engine 5.8
   ```
2. **It builds on Windows.** Fab compiles the plugin itself, Win64 included, and one failed build rejects the whole
   submission (Fab §4.3.6.2). On the Windows box, run the same command with `--build` added. It must finish with no
   warnings from the plugin. If the box isn't ready by Nov 2, submit Mac only (step 15) and add Windows as a file
   update later.

## Make the seller account

3. Go to **https://www.fab.com**, sign in with the Epic account that should own the listing, and click **Publish** in
   the top bar, then **Get Started**.
4. Accept the **Fab Distribution Agreement**. Read it first: it's the legal agreement for selling, and listing for
   free too.
5. **Publisher profile:** the publisher name is `Glitchless`, and the creator code is `glitchless` (or the closest
   one free). Upload `media/publisher-avatar.png` (the Glitchless icon, 512 × 512) as the avatar if it asks for one.
6. **Trader verification, tax and payout.** Fill these in with your own details as an individual or company. Fab asks
   for them even for free products under EU trader rules. You enter them yourself, and nobody else should.
7. In **Publish Settings** (the publisher profile page), set the support fields from LISTING.md → "Publisher profile
   and support": website `https://glitchless.gg`, support email `support@glitchless.gg`, and support URL
   `https://github.com/glitchless-gg/glitchless/issues` (Fab §1.1.b: a support channel you watch).

## Make the draft listing (so it has an ID)

8. **Publish → Listings → Create new listing.** Choose the **Unreal Engine** format for a code plugin.
9. Type the **Title** (`Glitchless Game Observability`) and click **Save draft**.
10. **Copy the listing's ID.** It's the long ID at the end of the listing's address in the browser (32 letters and
    digits, or a UUID). Send it to the parent session, or run this yourself:
    ```bash
    node unreal/scripts/package-plugin.mjs --fab --engine 5.8 --fab-url <the ID or the whole address>
    ```
    That writes `dist/unreal/Glitchless_0.4.0_UE5.8.zip`, with `"FabURL": "com.epicgames.launcher://ue/Fab/product/<ID>"`
    in its `.uplugin` (Fab §4.3.6.c), and a `.sha256` beside it.

## Host the zip

11. **Put the zip where Fab can download it without signing in** (Fab §4.2.1; a password, if any, goes in the version
    notes). Either:
    - a **GitHub release asset**, if the public repo and its release exist by then. The parent session makes the
      release only with your OK. The link looks like
      `https://github.com/glitchless-gg/glitchless/releases/download/glitchless-unreal%2Fv0.4.0/Glitchless_0.4.0_UE5.8.zip`; or
    - **Google Drive, Dropbox or OneDrive**, shared as "anyone with the link". Use a link that downloads the file, not
      a preview page.

    Keep it there until the listing is live (Fab asks for that). Fab wants one zip per engine version, each holding
    one plugin folder; this one is `Glitchless/` for 5.8.

## Fill in the listing

12. **Description.** Paste "Short description" (if the form has a summary field) and "Description" from LISTING.md.
13. **Category:** Tools & Plugins, and the subcategory closest to engine or debugging tools. **Tags:** the ones in
    LISTING.md that the picker offers.
14. **Media.**
    - **Thumbnail:** `media/thumbnail.png`.
    - **Gallery:** `media/gallery-01-findings.png` to `media/gallery-06-agent.png`, in that order.
    - **No 3D model or video is needed:** Fab §4.1.1 asks for a video only for animation, audio and Blueprint
      projects.
15. **Project version** ("Included files" / "Project Versions" → add):
    - **Engine version:** 5.8.
    - **Target platforms:** Mac, plus Windows if step 2 passed.
    - **Distribution method:** Engine Plugin.
    - **Project file link:** the link from step 11.
    - **Version notes:** `0.4.0: first Fab release, for Unreal Engine 5.8.`
16. **Technical information.** Paste the "Technical information" box from LISTING.md. If step 2 didn't pass, change
    the two platform lines to Mac only.
17. **Third-party software:** "This product uses third-party software". Fill in Fab's form from LISTING.md →
    "Third-party software declaration" (fdlibm's logarithm).
18. **Price:** Free ($0.00), Standard license.
19. **Declarations:**
    - **Created with AI:** Yes, since coding agents wrote the code. Change it if you see it differently; Fab §1.8.8
      wants it accurate.
    - **Mature content:** No.
    - **Promotional content:** No paid promotion.
20. **FAQ (optional):** add the five from LISTING.md with **+ Add FAQ**.
21. **Forum post:** "No, do not create a forum post", unless you want a support thread on the Unreal forums. Fab can't
    remove one once it's made.

## Check and submit

22. **Preview listing.** Read it as a buyer would. Check that every gallery image shows the real product (Fab
    §1.8.6.a), and that the documentation and example project links open.
23. **Submit for review.** Choose **Manual activation** if you want to pick the publish moment, for example just
    before the jam on Nov 11. Choose **Automatic** to publish as soon as it passes.
24. **Tell the parent session** the listing ID and when it's submitted. Fab emails you the result; a "Changes needed"
    lists what to fix, the first build errors included. Send that email's text to the parent session, which fixes the
    plugin, rebuilds the zip with the same version, and gives you a new link to put in the project version.

## After it's approved

25. If the parent session committed `FabURL` to the `.uplugin`, nothing is left. If not, it adds it then, so GitHub
    copies point to the Fab page too. Each new engine version (5.9…) is a new project version with its own zip:
    `--engine 5.9`.

# Putting Glitchless on Godot's two catalogues: your steps

Godot has two places to find addons, and Glitchless goes in both:

- **The Godot Asset Store** (store.godotengine.org) is the new one, live since May 2026 and built into the editor's
  Asset Store tab from Godot 4.7. Nothing moved over from the old library, so Glitchless is uploaded there as a new
  asset, with a publisher of its own.
- **The Asset Library** (godotengine.org/asset-library) is the old one, still online and still what Godot 4.5 and 4.6
  search from their AssetLib tab. Glitchless has been listed there since 4 November 2026 as
  [asset 5587](https://godotengine.org/asset-library/asset/5587), installed from a commit of
  [glitchless-gg/glitchless-godot](https://github.com/glitchless-gg/glitchless-godot).

Every value to type is in [LISTING.md](LISTING.md). The zip and the library's fields come from the export script,
never by hand. The parent session runs it, commits, tags and pushes the mirror, and hands you the output.

## The Asset Store, the first time (about 30 minutes, then the store's review)

1. **Sign in.** Open https://store.godotengine.org and click **Log in**. It uses the Godot community account, shared
   with the forum and the development fund. If you have none, make one on the sign-in page.
2. **Make the publisher.** Click **Upload Asset**. It first asks for a publisher: **Publisher Name** `Glitchless`,
   **Publisher URL Slug** `glitchless`.
3. **The asset.** Name it `Glitchless: game observability for coding agents`. In **Settings**:
   - Asset Summary and Detailed description: paste them from LISTING.md.
   - Asset type: **Addon**.
   - License: **MIT**.
   - Link to source code: `https://github.com/glitchless-gg/glitchless-godot`.
   - Tags: the ones in LISTING.md, picking the store's existing spelling where it suggests one.
   - AI usage disclosure: the text in LISTING.md, once you've checked it's true.
4. **Media.** Thumbnail: `media/thumbnail.png`. Screenshots: `screenshot-01` to `screenshot-04`, in order. Upload them
   from `docs/release/godot-asset-store/media/`, or paste the `raw.githubusercontent.com` links in LISTING.md if the form
   asks for links.
5. **Versions.** Add a version:
   - Version name `0.6.6`.
   - Changelog: from LISTING.md.
   - Minimum Godot version `4.5`, no maximum.
   - Additional information: from LISTING.md.
   - The file: `dist/godot-asset-store/glitchless-0.6.6.zip` in this repo (the export script writes it).
6. **Pricing.** Free. Leave the donation link empty and reviews on.
7. **Submit.** On **Overview**, press **Submit**: it goes into the review queue. The store doesn't say how long review
   takes.
8. **Tell the parent session when it's live.** It then adds the store link to glitchless.gg/godot.html, the mirror's
   README and the addon's README. None of them name the store until the listing is there.

## Each Godot release after that (about 5 minutes)

The parent session runs `node scripts/export-godot-addon.mjs`, which writes the mirror and
`dist/godot-asset-store/glitchless-<version>.zip`. It commits, tags `v<version>` and pushes the mirror, then runs
`node scripts/export-godot-addon.mjs --fields` and gives you its output. Then:

1. **The Asset Store.** Open the asset, **Versions** tab, add a version: the version name, its changelog, minimum Godot
   `4.5`, and the new zip. Submit it for review.
2. **The Asset Library.** Open https://godotengine.org/asset-library/asset/5587, signed in, and choose **Submit an
   edit**. Change only **Version** and **Download Commit** to what `--fields` printed. The Download URL fills itself in
   from the commit, since the provider is GitHub. Submit it; a moderator approves it.

Neither catalogue offers a way to publish a version automatically. The store has no API, and the library takes edits
from a signed-in account, with a moderator approving each.

## Now, for 0.6.6

- **Asset Store:** the first-time steps above, with version `0.6.6`.
- **Asset Library:** the edit, once the parent session has pushed 0.6.6 and run `--fields`. The 0.6.5 commit
  (`3eeedc97cd41b1df083a0eac6e2982fbb762c3bc`) is superseded: skip it and go straight to 0.6.6.

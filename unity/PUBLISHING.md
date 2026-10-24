# Releasing the Unity package

The package is `gg.glitchless.sdk`, in `unity/Packages/gg.glitchless.sdk` of the public repo `glitchless-gg/glitchless`. People install it three ways: a git URL, OpenUPM, and (once listed) the Asset Store. All three read the same folder.

## Each release

1. Set the new version in three places: `version` in `Packages/gg.glitchless.sdk/package.json`, `SdkVersion` in `Runtime/GlitchlessCore.cs`, and the `sdk` value in `PRIVACY.md`. Add a section to `CHANGELOG.md`. Update the version in `test/e2e.mjs`'s checks and the pinned URL in the package README.
2. Run the tests on the current LTS (the project's Editor), and on the newest Unity 6 if it's installed:
   ```bash
   npm run test:unity
   UNITY=/Applications/Unity/Hub/Editor/6000.5.9f1/Unity.app/Contents/MacOS/Unity npm run test:unity
   ```
   and the EditMode and PlayMode tests in each (see the dev project's README).
3. Once the change is in the public repo, tag it there. The tag names the package, so Unity tags stay apart from any other tags in the repo:
   ```bash
   git tag gg.glitchless.sdk/v0.1.0
   git push origin gg.glitchless.sdk/v0.1.0
   ```
4. Check the install from a fresh project: **Package Manager → + → Add package from git URL** with
   `https://github.com/glitchless-gg/glitchless.git?path=unity/Packages/gg.glitchless.sdk#gg.glitchless.sdk/v0.1.0`,
   then import the Fetch! sample and press Play.

Every file in the package needs its `.meta` file in git: a package installed from git is read-only, and Unity ignores files without one. Opening the dev project makes them; commit them with the files.

## OpenUPM (once)

OpenUPM builds a release from every new git tag. To list the package:

1. Open https://openupm.com/packages/add/ and enter the repo `glitchless-gg/glitchless`. It finds `unity/Packages/gg.glitchless.sdk/package.json`.
2. Set the git tag prefix to `gg.glitchless.sdk/`, so it only reads this package's tags.
3. Submit. The form opens a pull request on `openupm/openupm` with `data/packages/gg.glitchless.sdk.yml`. Once it's merged, each tag pushed above shows up as a release within an hour or so, and `openupm add gg.glitchless.sdk` works.

## Unity Asset Store (once, by the account owner)

The Asset Store takes UPM packages through its UPM publishing workflow. It needs a publisher account, which only the owner can set up:

1. Sign in at https://id.unity.com with the Unity ID that will own the listing.
2. Create a publisher profile at https://publisher.unity.com (name **Glitchless**, website https://www.glitchless.gg, support email support@glitchless.gg). A free package needs no payout or tax details.
3. Enroll as a UPM publisher (https://assetstore.unity.com/publishing/upm-publishing). When asked for the publisher namespace, use **`gg.glitchless`**: it's the reverse of the domain glitchless.gg. Changing it later means a support ticket.
4. In the Publisher Portal (Cloud Dashboard → Products → Publisher Portal), create a product with a single package and the product namespace **`sdk`**. That makes the technical name `gg.glitchless.sdk`, which matches the package's folder and `package.json` name, as the upload requires.
5. In this dev project, add **Asset Store Publishing Tools** (`com.unity.asset-store-tools`) from the Package Manager, sign in with the same Unity ID, and use it to validate and upload `Packages/gg.glitchless.sdk`.
6. Fill in the listing in the Publisher Portal:
   - Title: Glitchless: game observability. Category: Tools.
   - Price: free.
   - Unity versions: 2022.3 and 6. Render pipelines: Built-in, URP, HDRP (the SDK draws nothing).
   - Description: start from the package README's first section. Say plainly that the package sends performance and error reports to a Glitchless server the developer chooses, and link PRIVACY.md.
   - Images: an icon (160×160), a card image (420×280) and a cover (1200×630), plus a few screenshots of the dashboard and the sample. The brand files are in `assets/brand/glitchless`.
7. Submit for review. Reviews take one to two weeks; answer any questions from the reviewers in the Publisher Portal.

Later releases: upload the new version with the Publishing Tools and submit it in the Publisher Portal, after tagging it as above.

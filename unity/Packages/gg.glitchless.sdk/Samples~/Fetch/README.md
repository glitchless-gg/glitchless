# Fetch! (the Glitchless Unity sample)

A small runner. A purple pup runs right on its own; jump over pits, fire hydrants and squirrels (or land on them) to reach the flag at the end of three levels. Everything is built from primitives at runtime, and each level is its own scene, so Glitchless reports levels with no extra code.

Open `FetchBoot.unity`, set **Intake** on the **Fetch** GameObject to your Glitchless server, and press Play. Space, the up arrow or a click jumps. Tick **Autoplay** to let the bot play.

A built player takes `--autoplay --seed=7 --skill=0.9 --level=2 --privacy=full --quit-after=60`.

It runs in anonymous mode with `Positions = true`, so deaths have places for the heatmap but there is no player ID. It uses Unity's Physics and IMGUI modules, which new projects have.

## The planted bugs

Each is marked `GLITCHLESS-DEMO` in the code. Don't fix them: they are what Glitchless finds.

| Bug | Where | What Glitchless shows |
| --- | --- | --- |
| **Mesh and material leak.** Every ground tile gets its own copy of the cube mesh and its own material. Unloading a level destroys the tiles but not those copies. | `BuildGround` and `LoadLevel` | the mesh and material counts climb with every level load (development builds and the Editor) |
| **Confetti that never goes away.** Each tennis ball makes 500 cubes one at a time, each with a Rigidbody and its own material, plus a label built by string concatenation. They are never destroyed. | `ConfettiBurst` | a hitch on each pickup with causes `gc` and `physics`, physics time per frame climbing, `game_objects` and `materials` in `ctx` |
| **The frisbee.** `PowerupSeconds` has no `frisbee` entry, so catching the frisbee on level 3 throws. | `CatchToy` | a `KeyNotFoundException` issue at `FetchGame.CatchToy` |
| **The Long Jump.** The last pit on level 2 is 1.9 m wide; a jump at normal speed covers about 2.08 m. | `FetchLevels.cs` | deaths (`fell`) piling up at x ≈ 34 on level 2 |

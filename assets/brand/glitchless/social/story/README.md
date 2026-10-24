# The vibe debugging story (51 s)

`out/glitchless-story.mp4`: 1920x1080, 30 fps, H.264, voiced and captioned, mastered to -14 LUFS for X and the like.
Each scene runs as long as its line, shows one thing big, and leaves the words to the captions. Plain words throughout:
the audience vibe codes, it doesn't tune renderers. All from real material:

| Seconds | Beat | From |
| --- | --- | --- |
| 0–2 | The hook: "It runs great on your machine." | text |
| 2–10 | The game: Zoomies on our Mac, the buggy build at 60 fps; it glitches apart, music and all | the site's `media/hero-before.mp4` and its frame log |
| 10–18 | The bug: the same build on a slower laptop, sliding from 40 fps to 21 as the confetti piles up, then Rooftops at 11 | `media/hero-before-t4.mp4` (Chrome's CPU slowed 4x) and its frame log |
| 18–29 | The agent finds it: `triage` says it stutters, the live game counts 1,600 bits of confetti | `public/agent-beats.json`, the real Claude Code run of Oct 15, 2026 (tools named `gamedog_*` then) |
| 29–37 | The fix: time to draw a frame, 8.85 → 1.10 ms, 8x faster | `docs/demo/confetti-fix.patch` and that run's re-measure |
| 37–41 | Fast again: the same Rooftops seconds at 60 fps | `media/hero-after-t4.mp4` and its frame log |
| 41–51 | The dashboard, then the end card with Glitchy | the site's `img/dash-overview.webp` (sample data) |

The fps on the footage is live: the recordings' own frame times over the last 1.5 s.

## Rebuild

```bash
SITE=../../../../../../glitchless-site/media
cp $SITE/hero-before.mp4 public/clips/dev.mp4
cp $SITE/hero-before-t4.mp4 public/clips/before.mp4
cp $SITE/hero-after-t4.mp4 public/clips/after.mp4
node scripts/frames.mjs   # public/frames.json, the three recordings' frame times
npm install
npm run render            # renders out/story-raw.mp4, then scripts/master.mjs makes out/glitchless-story.mp4
```

`npm run studio` to edit.

## Voice, captions and sound

`scripts/voiceover.mjs` makes them with ElevenLabs (Eleven v4, the voice Liam) into `public/voiceover`, `public/sfx`
and `public/music`, which are committed. To change a line, edit `LINES` (each line in its caption phrases) and make
just that line again; scene lengths and word timings follow on their own:

```bash
set -a && source ../../../../../.env && set +a   # ELEVENLABS_API_KEY
node scripts/voiceover.mjs --only fix
```

The sound effects and the 48 s music bed are made once; delete a file to make it again. The music stops dead when
the game breaks and comes back with the agent.

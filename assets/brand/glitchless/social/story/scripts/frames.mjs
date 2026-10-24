// public/frames.json: every frame's time in the three recordings the story plays, from the site's frame logs
// (../glitchless-site/media/hero-*.frames.json, [second in the recording, ms]).
//   dev     hero-before.mp4     the buggy build on our Mac: 60 fps through Dog Park
//   before  hero-before-t4.mp4  the same build, Chrome's CPU slowed 4x (a slower laptop): ~40 fps, then 21, then 11
//   after   hero-after-t4.mp4   the fixed build, slowed the same: 60 fps
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = path.resolve(ROOT, '../../../../../../glitchless-site/media');
const CLIPS = { dev: 'hero-before', before: 'hero-before-t4', after: 'hero-after-t4' };

const out = {};
for (const [clip, name] of Object.entries(CLIPS)) {
  out[clip] = JSON.parse(fs.readFileSync(path.join(MEDIA, `${name}.frames.json`), 'utf8')).frames;
  console.log(`${clip}: ${out[clip].length} frames`);
}
fs.writeFileSync(path.join(ROOT, 'public/frames.json'), JSON.stringify(out));

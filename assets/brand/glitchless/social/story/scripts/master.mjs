// Masters the render for social: two-pass loudnorm to -14 LUFS (what X, YouTube and the rest play at), video copied as is.
// Usage: node scripts/master.mjs out/story-raw.mp4 out/glitchless-story.mp4
import { execFileSync, spawnSync } from 'node:child_process';

const [input = 'out/story-raw.mp4', output = 'out/glitchless-story.mp4'] = process.argv.slice(2);
const target = 'I=-14:TP=-1.5:LRA=11';

// loudnorm prints its measurement on stderr.
const probe = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', input, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']).stderr.toString();
const m = JSON.parse(probe.match(/\{[^{}]*"input_i"[^{}]*\}/)[0]);
const measured = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;

execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-c:v', 'copy', '-af', `loudnorm=${target}:${measured}`, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output], { stdio: 'inherit' });
console.log(`${input} (${m.input_i} LUFS) → ${output} (-14 LUFS)`);

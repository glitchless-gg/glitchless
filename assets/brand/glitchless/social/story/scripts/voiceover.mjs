// The story's voice, captions and sound, from ElevenLabs (ELEVENLABS_API_KEY from the repo's .env, never printed):
//   public/voiceover/<scene>.mp3   the line, Eleven v4
//   public/voiceover/<scene>.json  its words with their times (Remotion's Caption shape), from the character alignment,
//                                  and which caption phrase each word is in
//   public/voiceover/durations.json each line's length in seconds
//   public/sfx/*.mp3, public/music/bed.mp3   a glitch hit, a soft ding and a quiet bed (skipped if the plan can't)
//
//   node scripts/voiceover.mjs [--only bug,fix] [--voice <voice id>]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error('ELEVENLABS_API_KEY is not set: run with `set -a && source ../../../../../.env && set +a`');
const VOICE = flag('voice', 'TX3LPaxmHKxFdv7VOQHJ'); // Liam: energetic, social media creator
const MODEL = 'eleven_v4';

// Each line in its caption phrases; the voice reads them joined. Plain words: the audience vibe codes, it doesn't tune renderers.
export const LINES = {
  hook: ['It runs great on your machine.'],
  game: ['Like Zoomies,', 'a little dog platformer', 'we vibe coded with Claude Code.', 'On our Mac,', 'a smooth sixty frames a second.'],
  bug: ["But on a player's slower laptop,", 'every pickup makes it slower,', "until it's unplayable:", 'eleven frames a second.'],
  agent: ['So we asked Claude Code.', 'It checked Glitchless,', 'played the level itself,', 'and found it:', 'every pickup leaves behind', 'eight hundred bits of confetti,', 'and nothing cleans them up.'],
  fix: ['The fix:', 'Claude reuses the same confetti', 'instead of piling up more.', 'Now each frame draws', 'eight times faster.'],
  fast: ['Same run.', 'Sixty frames a second.'],
  dash: ["Glitchless watches every player's game,", 'and shows you the worst problems first.'],
  end: ['Glitchless.', 'Vibe debugging and analytics for games.'],
};

async function api(p, body) {
  const res = await fetch(`https://api.elevenlabs.io${p}`, { method: 'POST', headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${p} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// Words with their start and end, from ElevenLabs' per-character times.
function words(alignment) {
  const out = [];
  let cur = null;
  alignment.characters.forEach((ch, i) => {
    const start = alignment.character_start_times_seconds[i];
    const end = alignment.character_end_times_seconds[i];
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = null;
      return;
    }
    if (!cur) cur = { text: '', startMs: Math.round(start * 1000), endMs: 0, timestampMs: null, confidence: null };
    cur.text += ch;
    cur.endMs = Math.round(end * 1000);
  });
  if (cur) out.push(cur);
  return out.map((w) => ({ ...w, timestampMs: w.startMs }));
}

const seconds = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

const only = flag('only', null)?.split(',');
fs.mkdirSync(path.join(ROOT, 'public/voiceover'), { recursive: true });
const durationsFile = path.join(ROOT, 'public/voiceover/durations.json');
const durations = fs.existsSync(durationsFile) ? JSON.parse(fs.readFileSync(durationsFile, 'utf8')) : {};
for (const [id, phrases] of Object.entries(LINES)) {
  if (only && !only.includes(id)) continue;
  const text = phrases.join(' ');
  const res = await api(`/v1/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_128`, {
    text,
    model_id: MODEL,
    voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
  });
  const data = await res.json();
  const mp3 = path.join(ROOT, `public/voiceover/${id}.mp3`);
  fs.writeFileSync(mp3, Buffer.from(data.audio_base64, 'base64'));
  fs.writeFileSync(path.join(ROOT, `public/voiceover/${id}.json`), JSON.stringify(words(data.alignment), null, 1));
  durations[id] = Math.round(seconds(mp3) * 1000) / 1000;
  console.log(`${id}: ${durations[id]} s`);
}
fs.writeFileSync(durationsFile, JSON.stringify(durations, null, 1));

// Every line's words get their caption phrase (no API call, so a phrase change needs no new voice).
for (const [id, phrases] of Object.entries(LINES)) {
  const file = path.join(ROOT, `public/voiceover/${id}.json`);
  if (!fs.existsSync(file)) continue;
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const phraseOf = phrases.flatMap((p, k) => p.split(/\s+/).map(() => k));
  if (phraseOf.length !== list.length) throw new Error(`${id}: ${list.length} spoken words, ${phraseOf.length} in LINES; make it again with --only ${id}`);
  fs.writeFileSync(file, JSON.stringify(list.map((w, i) => ({ ...w, phrase: phraseOf[i] })), null, 1));
}

// Sound: two short effects and a 48 s bed, made once (delete a file to make it again).
fs.mkdirSync(path.join(ROOT, 'public/sfx'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'public/music'), { recursive: true });
const effects = {
  'sfx/glitch.mp3': ['A short digital glitch: a video game freezing and stuttering, crunchy bit-crushed stutter, 0.6 seconds', 0.8],
  'sfx/ding.mp3': ['A soft, bright UI success chime, single clean tone, modern app notification', 1.0],
};
for (const [file, [prompt, length]] of Object.entries(effects)) {
  const out = path.join(ROOT, 'public', file);
  if (fs.existsSync(out)) continue;
  try {
    const res = await api('/v1/sound-generation', { text: prompt, duration_seconds: length, prompt_influence: 0.6 });
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`${file}: made`);
  } catch (err) {
    console.log(`${file}: skipped (${err.message.slice(0, 120)})`);
  }
}
const bed = path.join(ROOT, 'public/music/bed.mp3');
if (!fs.existsSync(bed)) {
  try {
    const res = await api('/v1/music?output_format=mp3_44100_128', {
      prompt: 'Upbeat, light electronic beat for a developer tool launch video: clean synth plucks, soft kick, warm pads, steady 110 bpm, no vocals, unobtrusive under narration, ends on a resolved chord',
      music_length_ms: 48000,
    });
    fs.writeFileSync(bed, Buffer.from(await res.arrayBuffer()));
    console.log('music/bed.mp3: made');
  } catch (err) {
    console.log(`music/bed.mp3: skipped (${err.message.slice(0, 160)})`);
  }
}

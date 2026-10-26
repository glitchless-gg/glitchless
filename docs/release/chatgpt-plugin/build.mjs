// Packs Glitchless for OpenAI's plugin directory (ChatGPT and Codex): the Agent Plugins package in plugins/glitchless
// (plugin.json, mcp.json, the logo and the skills, the same package Cursor and Antigravity install) plus this folder's
// submission.json (the verified developer name, review test cases, release notes). It checks them against the rules
// OpenAI publishes for a remote MCP submission (developers.openai.com/plugins/deploy/submission and
// submission-errors, read 25 and 26 October 2026), then zips them into dist/chatgpt-plugin/ at the repo root.
//
//   node docs/release/chatgpt-plugin/build.mjs
//
// Values only the owner can give are marked OWNER-TODO (the demo video, the verified developer name). While any is
// left the zip is named …-DRAFT.zip and the command says what's missing; it uploads, but won't pass final review.
// Portal-only fields (reviewer sign-in, annotation justifications, attestations) are in README.md, never in the zip.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const pkg = path.join(repo, 'plugins/glitchless');
const submission = JSON.parse(fs.readFileSync(path.join(here, 'submission.json'), 'utf8'));
// The uploaded plugin.json is the package's, with the submission's developer name, review and publication added.
const plugin = JSON.parse(fs.readFileSync(path.join(pkg, 'plugin.json'), 'utf8'));
const openai = plugin.extensions['com.openai'];
openai.interface.developerName = submission.developerName;
openai.review = submission.review;
openai.publication = submission.publication;
const mcp = JSON.parse(fs.readFileSync(path.join(pkg, 'mcp.json'), 'utf8'));
const ui = openai.interface;
const review = openai.review ?? {};
const publication = openai.publication ?? {};

const CATEGORIES = ['Productivity', 'Creativity', 'Developer Tools', 'Business & Operations', 'Data & Analytics', 'Communication', 'Education & Research', 'Security', 'Finance', 'Healthcare', 'Travel', 'Entertainment', 'Other'];
const problems = [];
const check = (ok, message) => ok || problems.push(message);
const oneLine = (s) => typeof s === 'string' && s.trim() !== '' && !/[\r\n]/.test(s);
const text = (label, s, max, { line = true } = {}) => {
  check(typeof s === 'string' && s.trim() !== '', `${label} is required`);
  if (typeof s !== 'string') return;
  check(s.length <= max, `${label} is ${s.length} characters (at most ${max})`);
  if (line) check(oneLine(s), `${label} must be one line`);
};
const https = (label, s) => check(typeof s === 'string' && /^https:\/\/[^\s]+$/.test(s) && s.length <= 1024, `${label} must be an https URL of at most 1,024 characters`);

// ── package and listing ─────────────────────────────────────────
check(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(plugin.name || ''), 'name: ASCII letters, digits, _ and -, at most 64');
check(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(plugin.version || '') && plugin.version.length <= 64, 'version must be a semantic version');
text('description', plugin.description, 4000, { line: false });
text('author.name', plugin.author?.name, 120);
check(!plugin.author?.email || plugin.author.email.length <= 320, 'author.email is at most 320 characters');
if (plugin.author?.url) https('author.url', plugin.author.url);
if (plugin.homepage) https('homepage', plugin.homepage);
text('displayName', ui.displayName, 30);
check(!/\b(mcp|plugin)\b/i.test(ui.displayName || ''), 'displayName must not add "MCP" or "Plugin" to the name');
text('shortDescription', ui.shortDescription, 30);
text('longDescription', ui.longDescription, 4000, { line: false });
text('developerName', ui.developerName, 80);
check(CATEGORIES.includes(ui.category), `category must be one of: ${CATEGORIES.join(', ')}`);
check(Array.isArray(ui.capabilities) && ui.capabilities.length <= 20, 'capabilities: at most 20');
for (const c of ui.capabilities ?? []) text(`capability "${c.slice(0, 30)}…"`, c, 120);
const prompts = ui.defaultPrompt ?? [];
check(prompts.length <= 3, 'defaultPrompt: at most 3');
for (const p of prompts) {
  text(`defaultPrompt "${p.slice(0, 30)}…"`, p, 128);
  check(!p.includes('@'), `defaultPrompt "${p.slice(0, 30)}…" must not @mention`);
}
check(new Set(prompts.map((p) => p.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase())).size === prompts.length, 'defaultPrompt entries must be unique');
for (const k of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) https(k, ui[k]);

// Brand colours: 2:1 against white (light) and against #212121 (dark), by WCAG relative luminance.
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const colours = [];
for (const [key, against] of [['brandColor', '#FFFFFF'], ['brandColorDark', '#212121']]) {
  if (ui[key] == null) continue;
  if (!/^#[0-9A-Fa-f]{6}$/.test(ui[key])) {
    problems.push(`${key} must be #RRGGBB`);
    continue;
  }
  const ratio = contrast(ui[key], against);
  colours.push(`${key} ${ui[key]} is ${ratio.toFixed(1)}:1 against ${against}`);
  check(ratio >= 2, `${key} ${ui[key]} has ${ratio.toFixed(2)}:1 contrast against ${against} (needs 2:1)`);
}

// Images: the manifest's relative paths, square, 48 to 4,096 px, 5 MiB at most (PNG read from its header).
const files = new Set(['mcp.json']);
for (const key of ['logo', 'logoDark', 'composerIcon', 'composerIconDark']) {
  if (ui[key] == null) {
    check(key !== 'logo', 'logo is required');
    continue;
  }
  const rel = ui[key].replace(/^\.\//, '');
  const file = path.join(pkg, rel);
  if (!ui[key].startsWith('./') || !fs.existsSync(file)) {
    problems.push(`${key}: ${ui[key]} must be a ./ path to a file in plugins/glitchless`);
    continue;
  }
  files.add(rel);
  const bytes = fs.readFileSync(file);
  check(bytes.length <= 5 * 1024 * 1024, `${key} is over 5 MiB`);
  if (bytes.subarray(1, 4).toString() === 'PNG') {
    const [w, h] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    check(w === h && w >= 48 && w <= 4096, `${key} is ${w}×${h}: it must be square, 48 to 4,096 px`);
  } else check(/\.(svg|jpe?g|webp)$/i.test(rel), `${key} must be PNG, JPEG, WebP or SVG`);
}
check(!ui.screenshots?.length, 'screenshots: none, because Glitchless returns no UI (the portal rejects them)');

// ── review and publication ──────────────────────────────────────
const positive = review.test_cases?.positive ?? [];
const negative = review.test_cases?.negative ?? [];
check(positive.length === 5, `review needs exactly 5 positive test cases (has ${positive.length})`);
check(negative.length === 3, `review needs exactly 3 negative test cases (has ${negative.length})`);
for (const [i, c] of positive.entries()) for (const k of ['description', 'prompt', 'tools_triggered', 'expected_behavior']) check(typeof c[k] === 'string' && c[k].trim(), `positive case ${i + 1} needs ${k}`);
for (const [i, c] of negative.entries()) for (const k of ['description', 'prompt']) check(typeof c[k] === 'string' && c[k].trim(), `negative case ${i + 1} needs ${k}`);
https('review.demo_recording_url', review.demo_recording_url);
check(typeof review.commerce === 'boolean', 'review.commerce must be true or false');
check(typeof publication.release_notes === 'string' && publication.release_notes.trim(), 'publication.release_notes is required');
check(!JSON.stringify(plugin).match(/test_credentials|reviewer_instructions/), 'credentials and reviewer instructions go in the portal, never in the package');

// ── the MCP server ──────────────────────────────────────────────
const servers = Object.entries(mcp.mcpServers ?? {});
check(servers.length === 1, 'mcp.json declares exactly one server');
for (const [name, s] of servers) {
  check(s.type === 'streamable-http', `${name}: type must be streamable-http`);
  check(/^https:\/\//.test(s.url || ''), `${name}: url must be https`);
  check(!s.headers || !Object.keys(s.headers).length, `${name}: no headers (the portal rejects them)`);
  const auth = s.extensions?.['com.openai']?.auth;
  check(auth?.type === 'oauth' && auth.client?.mode === 'cimd', `${name}: auth must be OAuth with client.mode cimd`);
  check(!JSON.stringify(s).includes('clientSecret'), `${name}: no clientSecret (enter it in the portal)`);
}

// ── skills ──────────────────────────────────────────────────────
// Each skills/<name>/SKILL.md (references/ beside it) with frontmatter naming it: lowercase letters, digits and
// hyphens up to 64, matching its folder, and a description up to 1,024 (the Agent Skills limits). No keys or tokens
// beyond the public placeholders the skills show (gl_pub_dev, gl_pub_…).
const skills = fs.existsSync(path.join(pkg, 'skills')) ? fs.readdirSync(path.join(pkg, 'skills')).filter((d) => !d.startsWith('.')) : [];
check(skills.length > 0, 'the package has no skills (run node scripts/sync-agent-plugin.mjs)');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === '.DS_Store' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const name of skills) {
  const md = path.join(pkg, 'skills', name, 'SKILL.md');
  if (!fs.existsSync(md)) {
    problems.push(`skills/${name} has no SKILL.md`);
    continue;
  }
  const fm = fs.readFileSync(md, 'utf8').match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const field = (k) => fm.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1]?.replace(/^(["'])(.*)\1$/, '$2');
  check(field('name') === name && /^[a-z0-9-]{1,64}$/.test(name), `skills/${name}: frontmatter name must be "${name}" (a-z, 0-9 and -, at most 64)`);
  check(field('description') && field('description').length <= 1024, `skills/${name}: description is required, at most 1,024 characters`);
  for (const f of walk(path.join(pkg, 'skills', name))) {
    const rel = path.relative(pkg, f);
    files.add(rel);
    const secret = fs.readFileSync(f, 'utf8').match(/\bgl_(?:sk|ws|share)_[A-Za-z0-9]{8,}|\bgl_pub_(?!dev\b)[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/);
    check(!secret, `${rel} holds something that looks like a key (${secret?.[0].slice(0, 12)}…)`);
  }
}

// ── what only the owner can give ───────────────────────────────
const owner = [];
(function walk(value, at) {
  if (typeof value === 'string' && value.includes('OWNER-TODO')) owner.push(`${at}: ${value}`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, at ? `${at}.${k}` : k);
})(plugin, '');

if (problems.length) {
  console.error(`plugin.json or mcp.json breaks OpenAI's rules:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

const out = path.join(repo, 'dist/chatgpt-plugin');
const zip = path.join(out, `${plugin.name}-${plugin.version}${owner.length ? '-DRAFT' : ''}.zip`);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-chatgpt-plugin-'));
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
  fs.copyFileSync(path.join(pkg, f), path.join(stage, f));
}
fs.writeFileSync(path.join(stage, 'plugin.json'), `${JSON.stringify(plugin, null, 2)}\n`);
fs.mkdirSync(out, { recursive: true });
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-q', '-X', '-r', zip, 'plugin.json', ...files], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });

console.log(`Checked against OpenAI's rules: ${ui.displayName} — "${ui.shortDescription}", ${ui.category}, ${ui.capabilities.length} capabilities, ${prompts.length} starter prompts, ${positive.length}+${negative.length} test cases.`);
console.log(colours.map((c) => `  ${c}`).join('\n'));
console.log(`Packed plugin.json, mcp.json, the logo and ${skills.length} skills (${skills.join(', ')}; ${files.size} files besides plugin.json) into ${path.relative(repo, zip)}.`);
if (owner.length) console.log(`\nNOT READY TO SUBMIT: fill these in submission.json, then build again:\n${owner.map((o) => `  - ${o}`).join('\n')}`);

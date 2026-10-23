#!/usr/bin/env node
// The set-up prompt (docs/agent-setup-prompt.md) filled in for a local server, written into the README's quickstart
// between the setup-prompt markers. Glitchless Cloud's Get started page fills the same text with a project's keys.
//
//   node scripts/setup-prompt.mjs           update README.md
//   node scripts/setup-prompt.mjs --check   exit 1 if README.md's copy is out of date (npm test runs this)
//   node scripts/setup-prompt.mjs --print   print the filled prompt, unwrapped (the website's copy is the same text)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(ROOT, 'README.md');
const LOCAL = { INTAKE_URL: 'http://localhost:7777', CLIENT_TOKEN: 'gl_pub_dev', DASHBOARD_URL: 'http://localhost:7777' };
const START = '<!-- setup-prompt:start -->';
const END = '<!-- setup-prompt:end -->';

// GitHub doesn't wrap code blocks, so the README's copy is wrapped at WIDTH, each line's continuation indented
// under its text (after "1. " or "- "), never inside a `command`. Agents read it the same.
const WIDTH = 100;
function wrap(text) {
  return text
    .split('\n')
    .flatMap((line) => {
      const lead = line.match(/^\s*/)[0];
      const indent = ' '.repeat(line.match(/^\s*(?:\d+\. |- )?/)[0].length);
      const out = [];
      let cur = '';
      for (const word of line.slice(lead.length).match(/[^\s`]*`[^`]*`\S*|\S+/g) || []) {
        if (cur && cur.length + 1 + word.length > WIDTH) {
          out.push(cur);
          cur = indent + word;
        } else cur = cur ? `${cur} ${word}` : lead + word;
      }
      return [...out, cur];
    })
    .join('\n');
}

export function setupPrompt(values = LOCAL) {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/agent-setup-prompt.md'), 'utf8');
  const text = doc.split('<!-- prompt:start -->')[1].split('<!-- prompt:end -->')[0].trim();
  return text.replace(/\{\{(\w+)\}\}/g, (m, key) => values[key] ?? m);
}

const arg = process.argv[2];
const prompt = setupPrompt();
if (arg === '--print') {
  process.stdout.write(prompt + '\n');
} else {
  const readme = fs.readFileSync(README, 'utf8');
  const [before, rest] = readme.split(START);
  if (rest === undefined || !rest.includes(END)) throw new Error(`README.md needs ${START} and ${END} where the prompt goes`);
  const updated = `${before}${START}\n\`\`\`text\n${wrap(prompt)}\n\`\`\`\n${END}${rest.split(END)[1]}`;
  if (arg === '--check') {
    if (updated !== readme) {
      console.error("README.md's setup prompt differs from docs/agent-setup-prompt.md: run node scripts/setup-prompt.mjs");
      process.exit(1);
    }
  } else if (updated !== readme) {
    fs.writeFileSync(README, updated);
    console.log('README.md: setup prompt updated');
  } else {
    console.log('README.md: setup prompt already up to date');
  }
}

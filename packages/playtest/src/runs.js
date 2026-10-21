// Saved playtest runs live in .glitchless/playtest/<name>.json so a baseline can be compared later,
// by a person, an agent or CI.

import fs from 'node:fs';
import path from 'node:path';

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function runPath(dir, name) {
  if (!NAME.test(name)) throw new Error(`Run name "${name}" must be 1–64 letters, digits, dots, dashes or underscores.`);
  return path.join(dir, `${name}.json`);
}

export function saveRun(dir, name, run) {
  fs.mkdirSync(dir, { recursive: true });
  const file = runPath(dir, name);
  fs.writeFileSync(file, JSON.stringify({ ...run, name }, null, 2));
  return file;
}

export function loadRun(dir, nameOrFile) {
  const file = nameOrFile.endsWith('.json') ? path.resolve(nameOrFile) : runPath(dir, nameOrFile);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function listRuns(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
}

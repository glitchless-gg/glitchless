// QR codes (qr.js) for jam rooms: the same modules another encoder makes for the same text and mask, and an SVG and
// terminal text drawn from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { qrMatrix, qrSvg, qrText } from '../src/qr.js';

// Made by the `qrcode` npm package (byte mode, level M, mask 3), module by module.
const FIXTURES = JSON.parse(fs.readFileSync(new URL('./fixtures/qr-codes.json', import.meta.url)));

test('every module matches another encoder for the same text, version and mask', () => {
  assert.ok(FIXTURES.length >= 5);
  for (const { text, mask, rows } of FIXTURES) {
    const q = qrMatrix(text, { mask });
    assert.equal(q.size, rows.length, text);
    for (let y = 0; y < q.size; y++) assert.equal(Array.from({ length: q.size }, (_, x) => (q.dark(x, y) ? '1' : '0')).join(''), rows[y], `${text}, row ${y}`);
  }
});

test('the version grows with the text, the mask is picked, and a text past version 20 is refused', () => {
  assert.equal(qrMatrix('a').version, 1);
  assert.equal(qrMatrix('https://play.glitchless.gg/r/K7Q2M/neon-dash/').version, 4);
  const picked = qrMatrix('https://app.glitchless.gg/r/K7Q2M');
  assert.ok(picked.mask >= 0 && picked.mask < 8);
  assert.equal(qrMatrix('z'.repeat(650)).version, 20);
  assert.throws(() => qrMatrix('z'.repeat(700)), /too long/);
});

test('the SVG draws the dark modules inside a quiet zone, and the text draws two rows a line', () => {
  const link = 'https://app.glitchless.gg/r/K7Q2M';
  const q = qrMatrix(link);
  const svg = qrSvg(link);
  assert.match(svg, new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${q.size + 8} ${q.size + 8}"`));
  // The top-left finder's first row: seven dark modules from (4, 4), inside the 4-module margin.
  assert.match(svg, /M4 4h7v1h-7z/);
  const dark = [...svg.matchAll(/h(\d+)v1/g)].reduce((n, m) => n + Number(m[1]), 0);
  let count = 0;
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) count += q.dark(x, y) ? 1 : 0;
  assert.equal(dark, count);

  const lines = qrText(link).split('\n');
  assert.equal(lines.length, Math.ceil((q.size + 4) / 2));
  assert.ok(lines.every((l) => [...l].length === q.size + 4));
  // Light modules are drawn: the quiet zone's first line is all full blocks, and a finder's dark corner is blank.
  assert.equal(lines[0], '█'.repeat(q.size + 4));
  assert.deepEqual([...lines[1]].slice(1, 3), ['█', ' '], 'rows 0 and 1: the margin, then the finder (dark, so blank)');
  const painted = qrText(link, { ansi: true }).split('\n');
  assert.ok(painted.every((l) => l.startsWith('\x1b[30;47m') && l.endsWith('\x1b[0m')));
});

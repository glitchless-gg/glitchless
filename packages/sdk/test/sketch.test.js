import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sketch } from '../src/sketch.js';

test('quantiles are within 2% relative error', () => {
  const s = new Sketch();
  const values = [];
  for (let i = 0; i < 20000; i++) {
    const v = i % 50 === 0 ? 40 + Math.random() * 80 : 14 + Math.random() * 6; // 2% hitches
    values.push(v);
    s.add(v);
  }
  values.sort((a, b) => a - b);
  for (const q of [0.5, 0.95, 0.99]) {
    const exact = values[Math.floor(q * (values.length - 1))];
    const est = s.quantile(q);
    assert.ok(Math.abs(est - exact) / exact <= 0.021, `q${q}: ${est} vs ${exact}`);
  }
});

test('merging sketches equals sketching the union', () => {
  const a = new Sketch(), b = new Sketch(), all = new Sketch();
  for (let i = 1; i <= 1000; i++) { a.add(i / 10); all.add(i / 10); }
  for (let i = 1; i <= 500; i++) { b.add(i); all.add(i); }
  const merged = Sketch.from(a.toJSON()).merge(JSON.parse(JSON.stringify(b.toJSON())));
  for (const q of [0.1, 0.5, 0.9, 0.99]) assert.equal(merged.quantile(q), all.quantile(q));
  assert.equal(merged.n, 1500);
});

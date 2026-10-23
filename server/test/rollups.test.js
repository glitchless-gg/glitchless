// Rollups written at ingest must give exactly the answers the raw events give, whatever order batches
// arrive in, wherever a range starts and ends, and whichever env/version filter is applied
// (helpers/rollup-check.js).
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file.js';
import { batches, fill, compare, assertCovered } from './helpers/rollup-check.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-rollups-'));

test('file store: rollups kept at ingest match the raw path, and again after a restart', async () => {
  const dir = tmpdir();
  const store = new FileStore(dir);
  await fill([store], batches);
  assertCovered(await compare(store));
  assertCovered(await compare(new FileStore(dir)));
});

// The stores the store-level tests run on: the file store, plus any a host adds. GLITCHLESS_TEST_STORES names a
// module whose default export maps a name to make(options), so another store runs the same tests (SPEC §7):
//   GLITCHLESS_TEST_STORES=./my-stores.js npm test -w glitchless-server
// make(options) gives a fresh, empty store; options are the FileStore's ({ legacyProject }). It returns
//   store         the store
//   settle()      optional: waits until what was written can be read, for a store that writes in the background
//   close()       optional: frees what the store holds
//   blobs(kind)   optional: the stored files of a kind ('reports'), to check that a delete removed them
//   clears        false for a store that can't clear a game's data (DELETE /v1/data)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileStore } from '../../src/stores/file.js';

function file(options = {}) {
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-store-')), options);
  const blobs = (kind) => (fs.existsSync(path.join(store.dir, kind)) ? fs.readdirSync(path.join(store.dir, kind)) : []);
  return { store, blobs };
}

const added = process.env.GLITCHLESS_TEST_STORES ? (await import(pathToFileURL(path.resolve(process.env.GLITCHLESS_TEST_STORES)).href)).default : {};

export const STORES = { file, ...added };

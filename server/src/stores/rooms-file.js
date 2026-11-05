// Jam rooms on disk, for the open-source server (rooms.js says what a room is). Under GLITCHLESS_DATA_DIR/rooms:
//
//   <CODE>.json              the room, its games and its votes: { room, games: { slug: game }, votes: { voter: slug } }
//   snapshots/<CODE>.json    what the jam did, written when it ends; it outlives the room
//   answers/<CODE>.json      the survey's answers: { respondent: record }
//   templates.json           organisers' survey templates: { owner: { id: template } }
//   files/<CODE>/<slug>/…    games' files, as play.js serves them (DirFiles)
//
// Every write reads, changes and replaces one file with synchronous calls, so two requests in this process never
// interleave; a file is written to a temporary name and renamed over the old one, so a crash never leaves half of it.
import fs from 'node:fs';
import path from 'node:path';

export class FileRoomStore {
  constructor(dir) {
    this.dir = dir;
    this.kind = 'file';
    for (const d of ['', 'snapshots', 'answers']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  }

  file(code, kind = '') {
    if (!/^[A-Z0-9]{5}$/.test(code)) throw new Error('bad room code');
    return path.join(this.dir, kind, `${code}.json`);
  }

  read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  write(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  }

  change(code, fn) {
    const doc = this.read(this.file(code));
    if (!doc) return false;
    const out = fn(doc);
    if (out === false) return false;
    this.write(this.file(code), doc);
    return true;
  }

  // A new room, unless its code is taken (by a room, or a past jam's snapshot).
  async claimRoom(room) {
    if (fs.existsSync(this.file(room.code)) || fs.existsSync(this.file(room.code, 'snapshots'))) return false;
    this.write(this.file(room.code), { room, games: {}, votes: {} });
    return true;
  }

  async getRoom(code) {
    return this.read(this.file(code))?.room ?? null;
  }

  async putRoom(room) {
    this.change(room.code, (doc) => void (doc.room = room));
  }

  async deleteRoom(code) {
    fs.rmSync(this.file(code), { force: true });
  }

  async allRooms() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => /^[A-Z0-9]{5}\.json$/.test(f))
      .map((f) => this.read(path.join(this.dir, f))?.room)
      .filter(Boolean);
  }

  async rooms(owner) {
    return (await this.allRooms()).filter((r) => r.owner === owner);
  }

  async games(code) {
    return Object.values(this.read(this.file(code))?.games ?? {});
  }

  async getGame(code, slug) {
    return this.read(this.file(code))?.games?.[slug] ?? null;
  }

  // create: only if the slug is free (false when it isn't).
  async putGame(code, game, { create = false } = {}) {
    return this.change(code, (doc) => {
      if (create && doc.games[game.slug]) return false;
      doc.games[game.slug] = game;
    });
  }

  async deleteGame(code, slug) {
    this.change(code, (doc) => void delete doc.games[slug]);
  }

  async putVote(code, voter, slug) {
    this.change(code, (doc) => {
      if (slug == null) delete doc.votes[voter];
      else doc.votes[voter] = slug;
    });
  }

  async votes(code) {
    return Object.entries(this.read(this.file(code))?.votes ?? {}).map(([voter, slug]) => ({ voter, slug }));
  }

  async putAnswers(code, respondent, record) {
    const file = this.file(code, 'answers');
    const all = this.read(file) ?? {};
    all[respondent] = record;
    this.write(file, all);
  }

  async answers(code) {
    return Object.values(this.read(this.file(code, 'answers')) ?? {});
  }

  async putSnapshot(code, snapshot) {
    this.write(this.file(code, 'snapshots'), snapshot);
  }

  async getSnapshot(code) {
    return this.read(this.file(code, 'snapshots'));
  }

  async allSnapshots() {
    return fs
      .readdirSync(path.join(this.dir, 'snapshots'))
      .filter((f) => /^[A-Z0-9]{5}\.json$/.test(f))
      .map((f) => this.read(path.join(this.dir, 'snapshots', f)))
      .filter(Boolean);
  }

  async snapshots(owner) {
    return (await this.allSnapshots()).filter((s) => s.owner === owner);
  }

  async templates(owner) {
    return Object.values(this.read(path.join(this.dir, 'templates.json'))?.[owner] ?? {});
  }

  async putTemplate(owner, template) {
    const file = path.join(this.dir, 'templates.json');
    const all = this.read(file) ?? {};
    (all[owner] ??= {})[template.id] = template;
    this.write(file, all);
  }

  async deleteTemplate(owner, id) {
    const file = path.join(this.dir, 'templates.json');
    const all = this.read(file) ?? {};
    if (all[owner]) delete all[owner][id];
    this.write(file, all);
  }

  async deleteSnapshot(code) {
    fs.rmSync(this.file(code, 'snapshots'), { force: true });
    fs.rmSync(this.file(code, 'answers'), { force: true });
  }
}

// Games' files in a folder, by key (<CODE>/<slug>/…, made by rooms.js from checked parts). play.js serves them.
export class DirFiles {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  at(key) {
    const file = path.resolve(this.dir, key);
    if (file !== this.dir && !file.startsWith(this.dir + path.sep)) throw new Error('a key outside the files folder');
    return file;
  }

  async put(key, bytes) {
    const file = this.at(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }

  async get(key) {
    try {
      return fs.readFileSync(this.at(key));
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
      throw err;
    }
  }

  async stat(key) {
    try {
      const s = fs.statSync(this.at(key));
      return s.isFile() ? { bytes: s.size } : null;
    } catch {
      return null;
    }
  }

  // Everything under a prefix that ends in / (a room, a game, one upload), or one file.
  async remove(prefix) {
    fs.rmSync(this.at(prefix), { recursive: true, force: true });
  }
}

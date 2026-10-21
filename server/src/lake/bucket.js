// Object storage for the lake: S3, or a local directory with the same methods for development, tests
// and the load test. Both count requests and bytes (`meter`), which is what S3 bills.
//
//   put(key, body)        get(key) → Buffer | null        list(prefix) → [{ key, size }]
//   delete(keys)          path(key) → a local file path DuckDB can read (S3 downloads into a cache dir)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function newMeter() {
  return { put: 0, get: 0, list: 0, delete: 0, bytesIn: 0, bytesOut: 0 };
}

export class FsBucket {
  constructor(dir) {
    this.dir = dir;
    this.meter = newMeter();
    fs.mkdirSync(dir, { recursive: true });
  }

  get kind() {
    return 'fs';
  }

  file(key) {
    const f = path.join(this.dir, ...key.split('/'));
    if (!f.startsWith(this.dir + path.sep)) throw new Error(`bad key: ${key}`);
    return f;
  }

  async put(key, body) {
    const f = this.file(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const buf = Buffer.from(body);
    // Write then rename, so a reader never sees half an object.
    const tmp = `${f}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, f);
    this.meter.put++;
    this.meter.bytesIn += buf.length;
  }

  async get(key) {
    this.meter.get++;
    try {
      const buf = fs.readFileSync(this.file(key));
      this.meter.bytesOut += buf.length;
      return buf;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async list(prefix) {
    this.meter.list++;
    const out = [];
    const walk = (dir, rel) => {
      let names;
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of names) {
        const key = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (prefix.startsWith(key + '/') || key.startsWith(prefix) || (key + '/').startsWith(prefix)) walk(path.join(dir, d.name), key);
        } else if (key.startsWith(prefix) && !key.endsWith('.tmp')) out.push({ key, size: fs.statSync(path.join(dir, d.name)).size });
      }
    };
    walk(this.dir, '');
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  async delete(keys) {
    for (const key of keys) {
      this.meter.delete++;
      fs.rmSync(this.file(key), { force: true });
    }
  }

  // DuckDB reads the object where it lies.
  async path(key) {
    this.meter.get++;
    const f = this.file(key);
    if (!fs.existsSync(f)) return null;
    this.meter.bytesOut += fs.statSync(f).size;
    return f;
  }
}

export class S3Bucket {
  constructor({ bucket, region, client = null, cacheDir = path.join(os.tmpdir(), 'glitchless-lake'), cacheBytes = 512e6 }) {
    this.bucket = bucket;
    this.region = region;
    this.client = client;
    this.cacheDir = cacheDir;
    this.cacheBytes = cacheBytes;
    this.cached = new Map(); // key → { file, size }, least recently used first
    this.meter = newMeter();
  }

  get kind() {
    return 's3';
  }

  async s3() {
    if (!this.client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      this.client = new S3Client({ region: this.region });
    }
    return import('@aws-sdk/client-s3');
  }

  async put(key, body, { contentType } = {}) {
    const { PutObjectCommand } = await this.s3();
    const buf = Buffer.from(body);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buf, ContentType: contentType }));
    this.meter.put++;
    this.meter.bytesIn += buf.length;
  }

  async get(key) {
    const { GetObjectCommand } = await this.s3();
    this.meter.get++;
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const buf = Buffer.from(await res.Body.transformToByteArray());
      this.meter.bytesOut += buf.length;
      return buf;
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async list(prefix) {
    const { ListObjectsV2Command } = await this.s3();
    const out = [];
    let ContinuationToken;
    do {
      this.meter.list++;
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken }));
      for (const o of res.Contents || []) out.push({ key: o.Key, size: o.Size });
      ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return out;
  }

  async delete(keys) {
    const { DeleteObjectsCommand } = await this.s3();
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      this.meter.delete += batch.length;
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
    }
  }

  // Objects never change once written (new data gets new keys), so downloads are cached on local disk.
  async path(key) {
    const hit = this.cached.get(key);
    if (hit && fs.existsSync(hit.file)) {
      this.cached.delete(key);
      this.cached.set(key, hit);
      return hit.file;
    }
    const buf = await this.get(key);
    if (!buf) return null;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const file = path.join(this.cacheDir, crypto.createHash('sha256').update(key).digest('hex').slice(0, 32) + path.extname(key.replace(/\.gz$/, '')) + (key.endsWith('.gz') ? '.gz' : ''));
    fs.writeFileSync(file, buf);
    this.cached.set(key, { file, size: buf.length });
    let total = 0;
    for (const v of this.cached.values()) total += v.size;
    for (const [k, v] of this.cached) {
      if (total <= this.cacheBytes) break;
      if (k === key) continue;
      fs.rmSync(v.file, { force: true });
      this.cached.delete(k);
      total -= v.size;
    }
    return file;
  }
}

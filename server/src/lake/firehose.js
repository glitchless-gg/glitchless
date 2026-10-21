// Sending records to Amazon Data Firehose, or to a local stand-in that delivers them to a FsBucket the
// way Firehose does (gzip objects per partition and buffer interval), for development, tests and the
// load test. Both count what Firehose bills: records, bytes, and bytes rounded up to 5 KB per record.

import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { rawPrefix, hourOf } from './layout.js';

const FIREHOSE_BATCH_RECORDS = 500;
const FIREHOSE_BATCH_BYTES = 4 * 1024 * 1024;
const BILLING_STEP = 5 * 1024;

export function newFirehoseMeter() {
  return { calls: 0, records: 0, bytes: 0, billedBytes: 0, objects: 0, objectBytes: 0, retried: 0 };
}

function count(meter, lines) {
  for (const line of lines) {
    const n = Buffer.byteLength(line);
    meter.records++;
    meter.bytes += n;
    meter.billedBytes += Math.ceil(n / BILLING_STEP) * BILLING_STEP;
  }
}

export class FirehoseSink {
  constructor({ stream, region, client = null }) {
    this.stream = stream;
    this.region = region;
    this.client = client;
    this.meter = newFirehoseMeter();
  }

  async send(lines) {
    if (!lines.length) return;
    const { FirehoseClient, PutRecordBatchCommand } = await import('@aws-sdk/client-firehose');
    this.client ||= new FirehoseClient({ region: this.region });
    let batch = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      let pending = batch;
      for (let attempt = 0; pending.length; attempt++) {
        this.meter.calls++;
        const res = await this.client.send(new PutRecordBatchCommand({ DeliveryStreamName: this.stream, Records: pending.map((l) => ({ Data: Buffer.from(l) })) }));
        if (!res.FailedPutCount) break;
        // Only the records that failed are sent again (throttling, service errors).
        pending = pending.filter((_, i) => res.RequestResponses[i]?.ErrorCode);
        this.meter.retried += pending.length;
        if (attempt >= 5) throw new Error(`firehose: ${pending.length} records failed: ${res.RequestResponses.find((r) => r.ErrorCode)?.ErrorMessage}`);
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
      batch = [];
      bytes = 0;
    };
    for (const line of lines) {
      const n = Buffer.byteLength(line);
      if (batch.length >= FIREHOSE_BATCH_RECORDS || bytes + n > FIREHOSE_BATCH_BYTES) await flush();
      batch.push(line);
      bytes += n;
    }
    await flush();
    count(this.meter, lines);
  }
}

// Buffers records per partition (arrival hour, and project when partitioning by project) and writes one
// gzip object per partition once its buffer interval has passed, under the same keys Firehose uses.
export class LocalFirehose {
  constructor({ bucket, bufferMs = 300_000, partitionByProject = true, now = Date.now, stream = 'glitchless-events' }) {
    this.bucket = bucket;
    this.bufferMs = bufferMs;
    this.partitionByProject = partitionByProject;
    this.now = now;
    this.stream = stream;
    this.buffers = new Map();
    this.meter = newFirehoseMeter();
  }

  async send(lines) {
    if (!lines.length) return;
    this.meter.calls++;
    count(this.meter, lines);
    const t = this.now();
    for (const line of lines) {
      const project = JSON.parse(line).p;
      const key = `${hourOf(t)}\n${this.partitionByProject ? project : ''}`;
      let b = this.buffers.get(key);
      if (!b) this.buffers.set(key, (b = { hour: hourOf(t), project, since: t, lines: [] }));
      b.lines.push(line);
    }
  }

  // Deliver every buffer that is due (or all of them).
  async deliver({ all = false } = {}) {
    const t = this.now();
    const keys = [];
    for (const [key, b] of this.buffers) {
      if (!all && t - b.since < this.bufferMs) continue;
      this.buffers.delete(key);
      const stamp = new Date(b.since).toISOString().replace(/[-:T]/g, '-').slice(0, 19);
      const name = `${this.stream}-1-${stamp}-${crypto.randomUUID()}.gz`;
      const objectKey = `${rawPrefix(b.hour)}${this.partitionByProject ? `project=${b.project}/` : ''}${name}`;
      const body = zlib.gzipSync(b.lines.join(''));
      await this.bucket.put(objectKey, body);
      this.meter.objects++;
      this.meter.objectBytes += body.length;
      keys.push(objectKey);
    }
    return keys;
  }
}

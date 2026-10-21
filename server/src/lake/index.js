// Wiring for the hosted event store, from environment variables (the hosted stack sets them):
//
//   GLITCHLESS_LAKE_BUCKET   S3 bucket for raw, Parquet and session files
//   GLITCHLESS_LAKE_TABLE    DynamoDB table for summaries, the session index, services and maps
//   GLITCHLESS_LAKE_STREAM   Firehose stream (the web function only)
//   GLITCHLESS_LAKE_BUFFER_SECONDS     Firehose's buffer interval: records may take 1.5 × this (plus a
//                                      minute) to reach S3, so summaries are complete up to that long ago
//
// The web function builds the store with createLakeStore(); the compactor Lambda runs handler().

import { LakeStore } from '../stores/lake.js';
import { S3Bucket } from './bucket.js';
import { FirehoseSink } from './firehose.js';
import { LakeTable } from './table.js';
import { Compactor } from './compactor.js';

function settings(env) {
  const region = env.GLITCHLESS_REGION || env.AWS_REGION || 'us-east-1';
  for (const k of ['GLITCHLESS_LAKE_BUCKET', 'GLITCHLESS_LAKE_TABLE']) if (!env[k]) throw new Error(`${k} is not set`);
  return { region, bucket: new S3Bucket({ bucket: env.GLITCHLESS_LAKE_BUCKET, region }), table: new LakeTable({ table: env.GLITCHLESS_LAKE_TABLE, region }) };
}

export function createLakeStore(env = process.env) {
  if (!env.GLITCHLESS_LAKE_STREAM) throw new Error('GLITCHLESS_LAKE_STREAM is not set');
  const { region, bucket, table } = settings(env);
  return new LakeStore({ table, bucket, firehose: new FirehoseSink({ stream: env.GLITCHLESS_LAKE_STREAM, region }) });
}

export function createCompactor(env = process.env) {
  const { bucket, table } = settings(env);
  const buffer = Number(env.GLITCHLESS_LAKE_BUFFER_SECONDS);
  return new Compactor({ bucket, table, log: console.log, ...(buffer > 0 ? { deliveryDelayMs: buffer * 1500 + 60_000 } : {}) });
}

// The compactor Lambda (EventBridge Scheduler invokes it every few minutes).
let compactor = null;
export async function handler() {
  compactor ||= createCompactor();
  return compactor.run();
}

// DuckDB over the lake's files: the Firehose gzip JSON (raw/ and raw-errors/) and the compacted Parquet.
// Both read as the same rows, one per event:
//
//   project, plan, service, a, n, w, i who sent it, and the order it arrived in (record arrival ms,
//                                     sequence and writer, position in the record)
//   ts, type, level, session_id, version
//   env, e                            the envelope and the event, as JSON text
//   src                               the raw file a row came from (null for Parquet)
//
// toEvent() turns a row back into the event the intake stored. Files are local paths: the bucket
// downloads S3 objects into a cache (bucket.js), so no DuckDB extension or S3 credentials are needed.

import os from 'node:os';
import path from 'node:path';

let instance = null;

export async function duck() {
  if (!instance) {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    // Spill to the temp dir (on Lambda the code directory is read-only).
    instance = await DuckDBInstance.create(':memory:', { threads: '4', temp_directory: path.join(os.tmpdir(), 'duckdb') });
  }
  return instance.connect();
}

const COLUMNS = `project, plan, service, a, n, w, i, ts, type, level, session_id, version, env, e`;
const ROW = `${COLUMNS}, src`;

function list(files) {
  return '[' + files.map((f) => `'${String(f).replace(/'/g, "''")}'`).join(', ') + ']';
}

// Firehose records → event rows. Error output (records Firehose could not partition) holds the record
// base64-encoded in rawData.
function rawRows({ raw = [], errors = [] }) {
  const parts = [];
  if (raw.length) {
    parts.push(
      `SELECT p, plan, o, env, events, filename FROM read_json(${list(raw)}, format='newline_delimited', compression='gzip', filename=true, columns={p:'VARCHAR', plan:'VARCHAR', o:'BIGINT[]', env:'JSON', events:'JSON[]'})`,
    );
  }
  if (errors.length) {
    parts.push(
      `SELECT j->>'p' AS p, j->>'plan' AS plan, CAST(j->'o' AS BIGINT[]) AS o, j->'env' AS env, CAST(j->'events' AS JSON[]) AS events, filename FROM (SELECT json(decode(from_base64(rawData))) AS j, filename FROM read_json(${list(errors)}, format='newline_delimited', compression='auto_detect', filename=true, columns={rawData:'VARCHAR'}))`,
    );
  }
  if (!parts.length) return null;
  return `SELECT p AS project, plan, env->>'service' AS service, o[1] AS a, o[2] AS n, coalesce(o[3], 0) AS w, i, CAST(e->>'ts' AS DOUBLE) AS ts, e->>'type' AS type, e->>'level' AS level,
      env->>'session_id' AS session_id, env->>'version' AS version, CAST(env AS VARCHAR) AS env, CAST(e AS VARCHAR) AS e, filename AS src
    FROM (SELECT *, unnest(events) AS e, generate_subscripts(events, 1) AS i FROM (${parts.join(' UNION ALL ')}))`;
}

function parquetRows(files) {
  return files.length ? `SELECT ${COLUMNS}, NULL AS src FROM read_parquet(${list(files)})` : null;
}

// Event rows from raw and Parquet files, filtered by `where` (SQL over the row columns), in arrival
// order unless `order` says otherwise.
export function eventsSql({ raw = [], errors = [], parquet = [] }, where = 'TRUE', { order = 'ts, a, n, i', limit = null, columns = ROW } = {}) {
  const sources = [rawRows({ raw, errors }), parquetRows(parquet)].filter(Boolean);
  if (!sources.length) return null;
  return `SELECT ${columns} FROM (${sources.join(' UNION ALL ')}) WHERE ${where} ORDER BY ${order}${limit ? ` LIMIT ${Number(limit)}` : ''}`;
}

export async function queryRows(conn, files, where, opts) {
  const sql = eventsSql(files, where, opts);
  if (!sql) return [];
  return (await conn.runAndReadAll(sql)).getRowObjectsJson();
}

// Compact rows into one Parquet file, sorted for pruning by the drill-downs (type, level, then time).
export async function writeParquet(conn, files, where, out) {
  const sql = eventsSql(files, where, { order: 'type, level, ts, a, n, i', columns: COLUMNS });
  if (!sql) return 0;
  await conn.run(`COPY (${sql}) TO '${out.replace(/'/g, "''")}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000)`);
  const res = await conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${out.replace(/'/g, "''")}')`);
  return Number(res.getRowObjectsJson()[0].n);
}

export function toEvent(row) {
  return { ...JSON.parse(row.e), ...JSON.parse(row.env), project_id: row.project };
}

// SQL string literal.
export function lit(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

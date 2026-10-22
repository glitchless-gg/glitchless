// Where the hosted event store keeps things. Raw events go to S3 through Firehose; a compactor turns
// them into per-minute summaries in DynamoDB, per-session files and hourly Parquet files in S3.
//
// S3 (one bucket):
//   raw/dt=<YYYY-MM-DD>/hour=<HH>/project=<p>/…gz            Firehose: one JSON line per beacon batch, gzip,
//                                                              by arrival time (project= only when Firehose
//                                                              partitions by project, the default)
//   raw-errors/…                                               Firehose records it could not partition
//   events/plan=<plan>/project=<p>/service=<s>/dt=<D>/hour=<HH>/<run>.parquet
//                                                              compacted events of one event-time hour
//   sessions/plan=<plan>/project=<p>/service=<s>/dt=<D>/<session>.json.gz
//                                                              one finished session, for detail and replay
//   state/…                                                    the compactor's own state
//
// The plan comes first under events/ and sessions/ so that one lifecycle rule per plan expires them
// (lifecycleRules() below); raw/ is only kept until it is compacted.
//
// DynamoDB (one table, on-demand), every key under the project:
//   P#<p>#L#<s>#<YYYY-MM-DD>  <family>#<hour>#<run>#<chunk>   summaries of one hour (summaries.js), gzip JSON:
//                                                              C = minute cells + facts, F = per-minute
//                                                              session states, H = per-hour session states
//   P#<p>#Y#<s>#<YYYY>        <D|R>#<day>#<run>#<chunk>       daily rollups of the days of one year (daily.js),
//                                                              gzip JSON, for ranges of more than 31 days:
//                                                              D = the day's rollups, R = its latest sessions
//   P#<p>#X#<s>               <session>                       session index: first/last seen, session file
//   P#<p>#SVC                 <service>                       versions, envs, last_seen (as DynamoStore)
//   P#<p>#MAP#<s>             <level>#<version>               level map thumbnails (as DynamoStore)
//   P#<p>#CLEAR               <service>                       data cleared at: older raw data is skipped
//   LAKE#META                 watermark | days | lease        compactor progress (minutes; the days with daily
//                                                              rollups) and its single-run lease

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// Retention per plan, in days: events, session files and summaries expire after this. The plans are
// the hosted service's Free, Indie and Studio; a project without a plan is on `free`.
export const PLAN_RETENTION_DAYS = { free: 14, indie: 90, studio: 400 };
export const DEFAULT_PLAN = 'free';
export const RAW_RETENTION_DAYS = 3;
export const RAW_ERRORS_RETENTION_DAYS = 14;

export function planOf(plan) {
  return Object.hasOwn(PLAN_RETENTION_DAYS, plan) ? plan : DEFAULT_PLAN;
}

export function retentionDays(plan) {
  return PLAN_RETENTION_DAYS[planOf(plan)];
}

export function hourOf(ts) {
  return Math.floor(ts / HOUR) * HOUR;
}

export function dayOf(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function hourLabel(ts) {
  return new Date(ts).toISOString().slice(11, 13);
}

// Service names and session ids come from clients; keep them to one path segment.
export function seg(s) {
  return encodeURIComponent(String(s)).replace(/\./g, '%2E');
}

export const rawPrefix = (hourTs) => `raw/dt=${dayOf(hourTs)}/hour=${hourLabel(hourTs)}/`;
export const rawErrorsPrefix = 'raw-errors/';

export function parquetKey({ plan, project, service, hour, run }) {
  return `events/plan=${planOf(plan)}/project=${project}/service=${seg(service)}/dt=${dayOf(hour)}/hour=${hourLabel(hour)}/${run}.parquet`;
}

export function sessionKey({ plan, project, service, start, session }) {
  return `sessions/plan=${planOf(plan)}/project=${project}/service=${seg(service)}/dt=${dayOf(start)}/${seg(session)}.json.gz`;
}

export const STATE_KEY = 'state/compactor.json';
export const OPEN_SESSIONS_KEY = 'state/open-sessions.json.gz';

// DynamoDB keys.
export const summaryPk = (project, service, dayTs) => `P#${project}#L#${service}#${dayOf(dayTs)}`;
export const summarySk = (family, hour, run, chunk = 0) => `${family}#${String(hour).padStart(13, '0')}#${run}#${String(chunk).padStart(3, '0')}`;
export const indexPk = (project, service) => `P#${project}#X#${service}`;
export const servicesPk = (project) => `P#${project}#SVC`;
export const mapsPk = (project, service) => `P#${project}#MAP#${service}`;
export const dashboardPk = (project) => `P#${project}#DASH`;
export const clearPk = (project) => `P#${project}#CLEAR`;
export const dailyPk = (project, service, dayTs) => `P#${project}#Y#${service}#${dayOf(dayTs).slice(0, 4)}`;
export const dailySk = (dayTs, run, chunk = 0, family = 'D') => `${family}#${String(dayTs).padStart(13, '0')}#${run}#${String(chunk).padStart(3, '0')}`;
export const META_PK = 'LAKE#META';

// S3 lifecycle rules for the bucket: raw data after compaction, then events and sessions per plan.
export function lifecycleRules() {
  const expire = (id, prefix, days) => ({ ID: id, Status: 'Enabled', Prefix: prefix, ExpirationInDays: days });
  return [
    expire('raw', 'raw/', RAW_RETENTION_DAYS),
    expire('raw-errors', rawErrorsPrefix, RAW_ERRORS_RETENTION_DAYS),
    ...Object.entries(PLAN_RETENTION_DAYS).flatMap(([plan, days]) => [expire(`events-${plan}`, `events/plan=${plan}/`, days), expire(`sessions-${plan}`, `sessions/plan=${plan}/`, days)]),
    { ID: 'incomplete-uploads', Status: 'Enabled', Prefix: '', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
  ];
}

// Checks OTLP/JSON request bodies against opentelemetry-proto (v1.x messages) and the OTLP spec's JSON
// encoding rules: lowerCamelCase field names only, 64-bit integers as decimal strings, enums as
// integers, exactly one value in every AnyValue and every Metric data oneof, unique attribute keys.
// Returns a list of problems, each with its path; empty means valid. Shared by the unit tests and the
// end-to-end check's local receiver.

const FIELDS = {
  ExportMetricsServiceRequest: ['resourceMetrics'],
  ResourceMetrics: ['resource', 'scopeMetrics', 'schemaUrl'],
  ScopeMetrics: ['scope', 'metrics', 'schemaUrl'],
  Metric: ['name', 'description', 'unit', 'gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary', 'metadata'],
  Sum: ['dataPoints', 'aggregationTemporality', 'isMonotonic'],
  Gauge: ['dataPoints'],
  NumberDataPoint: ['attributes', 'startTimeUnixNano', 'timeUnixNano', 'asDouble', 'asInt', 'exemplars', 'flags'],
  ExponentialHistogram: ['dataPoints', 'aggregationTemporality'],
  ExponentialHistogramDataPoint: ['attributes', 'startTimeUnixNano', 'timeUnixNano', 'count', 'sum', 'scale', 'zeroCount', 'positive', 'negative', 'flags', 'exemplars', 'min', 'max', 'zeroThreshold'],
  Buckets: ['offset', 'bucketCounts'],
  ExportLogsServiceRequest: ['resourceLogs'],
  ResourceLogs: ['resource', 'scopeLogs', 'schemaUrl'],
  ScopeLogs: ['scope', 'logRecords', 'schemaUrl'],
  LogRecord: ['timeUnixNano', 'observedTimeUnixNano', 'severityNumber', 'severityText', 'body', 'attributes', 'droppedAttributesCount', 'flags', 'traceId', 'spanId', 'eventName'],
  Resource: ['attributes', 'droppedAttributesCount', 'entityRefs'],
  InstrumentationScope: ['name', 'version', 'attributes', 'droppedAttributesCount'],
  KeyValue: ['key', 'value'],
};
const ANY_VALUE = ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'arrayValue', 'kvlistValue', 'bytesValue'];
const METRIC_DATA = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'];

export function validateMetricsRequest(body) {
  const v = new Validator();
  v.message(body, 'ExportMetricsServiceRequest', '$');
  v.list(body.resourceMetrics, '$.resourceMetrics', (rm, p) => {
    v.message(rm, 'ResourceMetrics', p);
    v.resource(rm.resource, `${p}.resource`);
    v.list(rm.scopeMetrics, `${p}.scopeMetrics`, (sm, p2) => {
      v.message(sm, 'ScopeMetrics', p2);
      v.scope(sm.scope, `${p2}.scope`);
      v.list(sm.metrics, `${p2}.metrics`, (m, p3) => v.metric(m, p3));
    });
  });
  return v.errors;
}

export function validateLogsRequest(body) {
  const v = new Validator();
  v.message(body, 'ExportLogsServiceRequest', '$');
  v.list(body.resourceLogs, '$.resourceLogs', (rl, p) => {
    v.message(rl, 'ResourceLogs', p);
    v.resource(rl.resource, `${p}.resource`);
    v.list(rl.scopeLogs, `${p}.scopeLogs`, (sl, p2) => {
      v.message(sl, 'ScopeLogs', p2);
      v.scope(sl.scope, `${p2}.scope`);
      v.list(sl.logRecords, `${p2}.logRecords`, (r, p3) => v.logRecord(r, p3));
    });
  });
  return v.errors;
}

class Validator {
  errors = [];

  fail(path, msg) {
    this.errors.push(`${path}: ${msg}`);
  }

  message(obj, type, path) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return this.fail(path, `${type} must be an object`);
    for (const k of Object.keys(obj)) if (!FIELDS[type].includes(k)) this.fail(path, `unknown ${type} field "${k}"`);
  }

  list(arr, path, each) {
    if (!Array.isArray(arr)) return this.fail(path, 'must be an array');
    if (!arr.length) this.fail(path, 'is empty');
    arr.forEach((x, i) => each(x, `${path}[${i}]`));
  }

  uint64(v, path) {
    if (typeof v !== 'string' || !/^\d+$/.test(v)) this.fail(path, `64-bit integer must be a decimal string, got ${JSON.stringify(v)}`);
  }

  int64(v, path) {
    if (typeof v !== 'string' || !/^-?\d+$/.test(v)) this.fail(path, `64-bit integer must be a decimal string, got ${JSON.stringify(v)}`);
  }

  int32(v, path) {
    if (!Number.isInteger(v)) this.fail(path, `must be an integer, got ${JSON.stringify(v)}`);
  }

  double(v, path) {
    if (typeof v !== 'number' || !Number.isFinite(v)) this.fail(path, `must be a finite number, got ${JSON.stringify(v)}`);
  }

  resource(r, path) {
    this.message(r, 'Resource', path);
    this.attributes(r?.attributes, `${path}.attributes`);
  }

  scope(s, path) {
    this.message(s, 'InstrumentationScope', path);
    if (typeof s?.name !== 'string' || !s.name) this.fail(path, 'scope needs a name');
  }

  attributes(list, path) {
    if (list === undefined) return;
    if (!Array.isArray(list)) return this.fail(path, 'must be an array of KeyValue');
    const seen = new Set();
    list.forEach((kv, i) => {
      const p = `${path}[${i}]`;
      this.message(kv, 'KeyValue', p);
      if (typeof kv?.key !== 'string' || !kv.key) this.fail(p, 'key must be a non-empty string');
      if (seen.has(kv?.key)) this.fail(p, `duplicate attribute key "${kv.key}"`);
      seen.add(kv?.key);
      this.anyValue(kv?.value, `${p}.value`);
    });
  }

  anyValue(v, path) {
    if (!v || typeof v !== 'object') return this.fail(path, 'AnyValue must be an object');
    const keys = Object.keys(v);
    if (keys.length !== 1 || !ANY_VALUE.includes(keys[0])) return this.fail(path, `AnyValue must have exactly one of ${ANY_VALUE.join('/')}, got ${keys.join(',') || 'none'}`);
    const [k] = keys;
    const x = v[k];
    if (k === 'stringValue' && typeof x !== 'string') this.fail(path, 'stringValue must be a string');
    if (k === 'boolValue' && typeof x !== 'boolean') this.fail(path, 'boolValue must be a boolean');
    if (k === 'intValue') this.int64(x, `${path}.intValue`);
    if (k === 'doubleValue') this.double(x, `${path}.doubleValue`);
    if (k === 'arrayValue') (x?.values || []).forEach((y, i) => this.anyValue(y, `${path}.arrayValue.values[${i}]`));
    if (k === 'kvlistValue') this.attributes(x?.values || [], `${path}.kvlistValue.values`);
  }

  times(dp, path) {
    this.uint64(dp.timeUnixNano, `${path}.timeUnixNano`);
    if (dp.startTimeUnixNano !== undefined) {
      this.uint64(dp.startTimeUnixNano, `${path}.startTimeUnixNano`);
      if (/^\d+$/.test(dp.startTimeUnixNano) && /^\d+$/.test(dp.timeUnixNano) && BigInt(dp.startTimeUnixNano) > BigInt(dp.timeUnixNano)) this.fail(path, 'starts after it ends');
    }
  }

  metric(m, path) {
    this.message(m, 'Metric', path);
    if (typeof m?.name !== 'string' || !m.name) this.fail(path, 'metric needs a name');
    const data = METRIC_DATA.filter((k) => m?.[k] !== undefined);
    if (data.length !== 1) return this.fail(path, `metric must have exactly one of ${METRIC_DATA.join('/')}, got ${data.join(',') || 'none'}`);
    const kind = data[0];
    const d = m[kind];
    if (kind === 'sum' || kind === 'exponentialHistogram' || kind === 'histogram') {
      if (![1, 2].includes(d.aggregationTemporality)) this.fail(`${path}.${kind}`, `aggregationTemporality must be 1 (delta) or 2 (cumulative) as an integer, got ${JSON.stringify(d.aggregationTemporality)}`);
    }
    if (kind === 'sum') {
      this.message(d, 'Sum', `${path}.sum`);
      if (typeof d.isMonotonic !== 'boolean') this.fail(`${path}.sum`, 'isMonotonic must be a boolean');
      this.list(d.dataPoints, `${path}.sum.dataPoints`, (dp, p) => this.numberPoint(dp, p));
    } else if (kind === 'gauge') {
      this.message(d, 'Gauge', `${path}.gauge`);
      this.list(d.dataPoints, `${path}.gauge.dataPoints`, (dp, p) => this.numberPoint(dp, p));
    } else if (kind === 'exponentialHistogram') {
      this.message(d, 'ExponentialHistogram', `${path}.exponentialHistogram`);
      this.list(d.dataPoints, `${path}.exponentialHistogram.dataPoints`, (dp, p) => this.expPoint(dp, p));
    }
  }

  numberPoint(dp, path) {
    this.message(dp, 'NumberDataPoint', path);
    this.attributes(dp.attributes, `${path}.attributes`);
    this.times(dp, path);
    const vals = ['asInt', 'asDouble'].filter((k) => dp[k] !== undefined);
    if (vals.length !== 1) return this.fail(path, 'needs exactly one of asInt/asDouble');
    if (vals[0] === 'asInt') this.int64(dp.asInt, `${path}.asInt`);
    else this.double(dp.asDouble, `${path}.asDouble`);
  }

  expPoint(dp, path) {
    this.message(dp, 'ExponentialHistogramDataPoint', path);
    this.attributes(dp.attributes, `${path}.attributes`);
    this.times(dp, path);
    this.uint64(dp.count, `${path}.count`);
    this.int32(dp.scale, `${path}.scale`);
    if (dp.scale < -10 || dp.scale > 20) this.fail(`${path}.scale`, 'must be between -10 and 20');
    if (dp.zeroCount !== undefined) this.uint64(dp.zeroCount, `${path}.zeroCount`);
    if (dp.zeroThreshold !== undefined) this.double(dp.zeroThreshold, `${path}.zeroThreshold`);
    for (const k of ['sum', 'min', 'max']) if (dp[k] !== undefined) this.double(dp[k], `${path}.${k}`);
    if (dp.min !== undefined && dp.max !== undefined && dp.min > dp.max) this.fail(path, 'min > max');
    let buckets = 0n;
    for (const side of ['positive', 'negative']) {
      const b = dp[side];
      if (b === undefined) continue;
      this.message(b, 'Buckets', `${path}.${side}`);
      if (b.offset !== undefined) this.int32(b.offset, `${path}.${side}.offset`);
      (b.bucketCounts || []).forEach((c, i) => {
        this.uint64(c, `${path}.${side}.bucketCounts[${i}]`);
        if (/^\d+$/.test(c)) buckets += BigInt(c);
      });
    }
    if (/^\d+$/.test(dp.count) && /^\d*$/.test(dp.zeroCount ?? '0')) {
      const total = buckets + BigInt(dp.zeroCount ?? 0);
      if (total !== BigInt(dp.count)) this.fail(path, `count ${dp.count} != zeroCount + buckets (${total})`);
    }
  }

  logRecord(r, path) {
    this.message(r, 'LogRecord', path);
    this.uint64(r.timeUnixNano, `${path}.timeUnixNano`);
    if (r.observedTimeUnixNano !== undefined) this.uint64(r.observedTimeUnixNano, `${path}.observedTimeUnixNano`);
    if (r.severityNumber !== undefined && !(Number.isInteger(r.severityNumber) && r.severityNumber >= 0 && r.severityNumber <= 24)) this.fail(`${path}.severityNumber`, 'must be an integer 0-24');
    if (r.body !== undefined) this.anyValue(r.body, `${path}.body`);
    this.attributes(r.attributes, `${path}.attributes`);
  }
}

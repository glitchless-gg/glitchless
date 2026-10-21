#!/usr/bin/env node
// Creates the Glitchless dashboard and monitors in your Datadog org, and enables percentile
// aggregations on the glitchless.frame.time distribution (needed for p50/p95/p99 queries).
//
// Needs an API key AND an application key:  DD_API_KEY (or DATADOG_KEY) + DD_APP_KEY in .env
//   node datadog/setup.js
// Without an app key, import datadog/dashboard.json by hand: Dashboards → New Dashboard → ⚙ → Import dashboard JSON.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv } from '../server/src/config.js';

loadEnv();
const apiKey = process.env.DD_API_KEY || process.env.DATADOG_KEY;
const appKey = process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY;
const site = process.env.DD_SITE || 'datadoghq.com';
if (!apiKey || !appKey) {
  console.error('Need DD_API_KEY (or DATADOG_KEY) and DD_APP_KEY in .env. Without an app key, import datadog/dashboard.json in the Datadog UI.');
  process.exit(1);
}
const headers = { 'Content-Type': 'application/json', 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey };
const call = async (method, p, body) => {
  const res = await fetch(`https://api.${site}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

// Percentiles on distributions are opt-in per metric.
try {
  await call('PATCH', '/api/v2/metrics/glitchless.frame.time/tags', { data: { type: 'manage_tags', id: 'glitchless.frame.time', attributes: { include_percentiles: true, tags: ['service', 'env', 'version', 'level', 'gpu_tier', 'browser', 'session_type'], metric_type: 'distribution' } } });
  console.log('✓ percentiles enabled on glitchless.frame.time');
} catch (err) {
  if (/404/.test(err.message)) {
    try {
      await call('POST', '/api/v2/metrics/glitchless.frame.time/tags', { data: { type: 'manage_tags', id: 'glitchless.frame.time', attributes: { include_percentiles: true, tags: ['service', 'env', 'version', 'level', 'gpu_tier', 'browser', 'session_type'], metric_type: 'distribution' } } });
      console.log('✓ percentiles enabled on glitchless.frame.time');
    } catch (e) {
      console.warn('! could not enable percentiles (send some data first):', e.message);
    }
  } else console.warn('! could not enable percentiles:', err.message);
}

const dashboard = JSON.parse(fs.readFileSync(path.join(ROOT, 'datadog/dashboard.json'), 'utf8'));
const d = await call('POST', '/api/v1/dashboard', dashboard);
console.log(`✓ dashboard: https://app.${site}${d.url}`);

for (const m of JSON.parse(fs.readFileSync(path.join(ROOT, 'datadog/monitors.json'), 'utf8'))) {
  const created = await call('POST', '/api/v1/monitor', m);
  console.log(`✓ monitor #${created.id}: ${m.name}`);
}

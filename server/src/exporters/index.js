// Exporters send Glitchless telemetry on to other backends. Each one has the same small shape, so the app
// never cares which ones run:
//   kind            'datadog' | 'otlp'
//   export(events)  normalized events from one intake request; resolves once sent, never rejects
//   status()        plain JSON for /v1/health, with no secrets in it
//   shutdown()      sends anything still buffered and stops timers
//
// Settings are plain JSON ({ kind: 'otlp', endpoint, headers } or { kind: 'datadog', apiKey, site }).
// Today they come from env vars; a hosted, multi-tenant server can store them per project and keep one
// createExporters(project.exporters) per project, calling shutdown() when it drops one.

import { DatadogExporter } from './datadog.js';
import { OtlpExporter, otlpSettingsFromEnv } from './otlp.js';

const KINDS = { datadog: DatadogExporter, otlp: OtlpExporter };

// deps: { fetch, logger } shared by every exporter (tests pass a fake fetch).
export function createExporter({ kind, ...settings }, deps = {}) {
  const Exporter = KINDS[kind];
  if (!Exporter) throw new Error(`unknown exporter kind: ${kind}`);
  return new Exporter({ ...settings, ...deps });
}

export function createExporters(settingsList = [], deps = {}) {
  return new ExporterSet(settingsList.map((s) => createExporter(s, deps)), deps);
}

// Fans each intake batch out to every exporter. forward(events) is all the app calls; with no exporters
// it does nothing.
export class ExporterSet {
  constructor(exporters = [], { logger = console } = {}) {
    this.exporters = exporters;
    this.logger = logger;
  }

  get enabled() {
    return this.exporters.length > 0;
  }

  async forward(events) {
    if (!events.length) return;
    await Promise.all(this.exporters.map((x) => x.export(events).catch((err) => this.logger.warn(`[${x.kind}]`, err.message))));
  }

  status() {
    return this.exporters.map((x) => x.status());
  }

  async shutdown() {
    await Promise.all(this.exporters.map((x) => x.shutdown()));
  }
}

// The single-tenant server's exporters: Datadog when an API key is set, OTLP when an
// OTEL_EXPORTER_OTLP_*ENDPOINT is set. Either, both or neither.
export function exporterSettingsFromEnv(env = process.env) {
  const list = [];
  const apiKey = env.DD_API_KEY || env.DATADOG_KEY || env.DATADOG_API_KEY;
  if (apiKey && env.GLITCHLESS_DATADOG !== 'off') list.push({ kind: 'datadog', apiKey, site: env.DD_SITE || 'datadoghq.com' });
  const otlp = otlpSettingsFromEnv(env);
  if (otlp) list.push(otlp);
  return list;
}

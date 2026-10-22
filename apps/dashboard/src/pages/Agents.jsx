import { useEffect, useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery, health, publicApiUrl } from '../api.js';
import { useShell } from '../shell.js';
import { Widget, CodeBlock, Status, Findings, GroupTitle } from '../components.jsx';
import { fmtNum, fmtTime, timeAgo } from '../format.js';

const MCP_TOOLS = [
  ['glitchless_list_games', 'games, versions and environments reporting telemetry'],
  ['glitchless_triage', 'Findings ranked by severity, with evidence + suggested fix'],
  ['glitchless_performance', 'frame-time percentiles by level / GPU tier / version, hitch causes'],
  ['glitchless_get_error', 'one error issue: stack, breadcrumbs, affected sessions'],
  ['glitchless_player_funnel', 'level completion, deaths, rage quits'],
  ['glitchless_death_hotspots', 'where players die on a level (clustered)'],
  ['glitchless_events', "the game's own events: counts, breakdowns, funnels"],
  ['glitchless_dashboard', "the game's pages, and a board's panels with their numbers"],
  ['glitchless_set_dashboard', "save the game's pages: boards in its own words, built-in views"],
  ['glitchless_compare_versions', "before/after a fix, in the game's own stats first"],
  ['glitchless_session', 'one session timeline (replay data)'],
];

const WEBMCP_TOOLS = [
  ['glitchless_live_performance', 'fps, p95, draw calls, geometries, context gauges — right now'],
  ['glitchless_measure', 'measure the next N seconds (A/B before & after a change)'],
  ['glitchless_inspect_scene', 'scene graph summary: instancing candidates, heavy meshes'],
  ['glitchless_errors', 'errors in this session with stacks'],
  ['glitchless_game_events', 'recent deaths, pickups, level events'],
  ['glitchless_screenshot', 'see the game canvas'],
  ['glitchless_annotate', "drop a note into the session's telemetry timeline"],
  ['+ game tools', 'whatever the game registers via glitchless.registerTool(), e.g. load_level'],
];

const EXPORTER = {
  datadog: {
    name: 'Datadog',
    detail: () => 'API key from server env · metrics, distributions, logs, events',
    hint: (
      <>
        Query <code>glitchless.frame.time</code> (distribution, p95 across all players), <code>glitchless.deaths</code>, <code>glitchless.errors</code> by <code>level</code>, <code>version</code>, <code>gpu_tier</code>. Errors land in Error Tracking via logs; the Datadog MCP server can read all of it too.
      </>
    ),
  },
  otlp: {
    name: 'OpenTelemetry (OTLP)',
    detail: (x) => `${x.protocol} · ${x.signals.join(' + ')} · ${x.temporality}`,
    hint: (
      <>
        Metrics <code>glitchless.frame.time</code> (exponential histogram), <code>glitchless.deaths</code>, <code>glitchless.errors</code>, <code>glitchless.frame.slow</code> by <code>game.level</code>, <code>game.gpu_tier</code>, <code>user_agent.name</code>; the game is <code>service.name</code> / <code>service.version</code>. Logs carry <code>session.id</code>, errors <code>exception.*</code>.
      </>
    ),
  },
};

function ExporterStatus({ x }) {
  const info = EXPORTER[x.kind] || { name: x.kind, detail: () => '', hint: null };
  const sent = Object.values(x.sent || {}).reduce((a, b) => a + b, 0);
  const failing = x.last_failure_at && !(x.last_success_at > x.last_failure_at);
  const [kind, label] = failing ? ['alert', 'failing'] : sent ? ['ok', 'sending'] : ['neutral', 'waiting for data'];
  const rejected = Object.values(x.rejected || {}).reduce((a, b) => a + b, 0);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <b>{info.name}</b>
        <Status kind={kind}>{label}</Status>
        <span className="muted mono" style={{ fontSize: 12 }}>
          {x.target}
        </span>
      </div>
      <dl className="kv">
        <dt>Sends</dt>
        <dd>{info.detail(x)}</dd>
        <dt>Metric points sent</dt>
        <dd>{fmtNum(x.sent?.metrics)}</dd>
        <dt>Logs sent</dt>
        <dd>{fmtNum(x.sent?.logs)}</dd>
        {x.sent?.events != null && (
          <>
            <dt>Events sent</dt>
            <dd>{fmtNum(x.sent.events)}</dd>
          </>
        )}
        {rejected > 0 && (
          <>
            <dt>Rejected by backend</dt>
            <dd>{fmtNum(rejected)}</dd>
          </>
        )}
        <dt>Failures</dt>
        <dd>
          {x.failures} {x.last_error && <span className="muted">({x.last_error})</span>}
        </dd>
        {x.last_success_at && (
          <>
            <dt>Last export</dt>
            <dd>{timeAgo(x.last_success_at)}</dd>
          </>
        )}
      </dl>
      {info.hint && (
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          {info.hint}
        </div>
      )}
    </div>
  );
}

export function Agents() {
  const f = useFilters();
  const activity = useQuery('activity', {}, { refreshMs: 3000 });
  const triage = useQuery('findings', f.params, { enabled: !!f.service });
  const [h, setH] = useState(null);
  useEffect(() => {
    health().then(setH).catch(() => {});
    const t = setInterval(() => health().then(setH).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, []);
  const apiUrl = publicApiUrl();
  const shell = useShell();
  const exporters = h?.exporters || [];
  const kinds = new Set(exporters.map((x) => x.kind));

  return (
    <div className="grid">
      <Widget span={12}>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0' }}>
          <img src={shell.heroImage} alt="" style={{ width: 72 }} />
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>Vibe-coded games are written by agents. Glitchless gives the agent eyes.</div>
            <div className="muted" style={{ marginTop: 4, maxWidth: 820 }}>
              The same telemetry you see here is available to Claude Code, Codex or Cursor in two ways: the <b>Glitchless MCP server</b> (production data from every player, plus ranked findings) and <b>WebMCP</b> (the running game itself exposes tools, so an agent can measure, inspect the scene and verify a fix live). The loop: players hit a problem → Glitchless flags it → the agent reads the evidence, edits the code → ships a new version → Glitchless confirms the fix.
            </div>
          </div>
        </div>
      </Widget>

      <Widget span={6} title="① Glitchless MCP server" sub="production telemetry for coding agents">
        <CodeBlock code={`claude mcp add glitchless \\\n  -e GLITCHLESS_URL=${apiUrl} \\\n  -- npx -y glitchless-mcp`} />
        <div className="muted" style={{ margin: '8px 0 4px', fontSize: 12 }}>
          Any other MCP client: the command is <code>npx -y glitchless-mcp</code>, with <code>GLITCHLESS_URL</code> (and <code>GLITCHLESS_API_KEY</code> if the server needs one) in its environment.
        </div>
        <table className="dt" style={{ marginTop: 6 }}>
          <tbody>
            {MCP_TOOLS.map(([n, d]) => (
              <tr key={n}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                  {n}
                </td>
                <td className="muted">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Widget>
      <Widget span={6} title="② WebMCP — the live game is a tool server" sub="every game with Glitchless exposes these while it runs">
        <CodeBlock code={`claude mcp add webmcp -- npx -y @jason.today/webmcp@latest --mcp\n\n# then in Claude Code: "give me a WebMCP token"\n# and paste it into the WebMCP widget on the game page`} />
        <div className="muted" style={{ margin: '8px 0 4px', fontSize: 12 }}>
          Also registered through the W3C <code>document.modelContext</code> API when the browser supports it (Chrome origin trial).
        </div>
        <table className="dt" style={{ marginTop: 6 }}>
          <tbody>
            {WEBMCP_TOOLS.map(([n, d]) => (
              <tr key={n}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                  {n}
                </td>
                <td className="muted">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Widget>

      <Widget span={6} title="③ Claude Code plugin" sub="skills + MCP in one install">
        <CodeBlock code={`/plugin marketplace add glitchless-gg/glitchless\n/plugin install glitchless@glitchless\n\n/glitchless:instrument   # add Glitchless to a three.js game\n/glitchless:triage       # read the findings and fix the top one`} />
      </Widget>
      <Widget span={6} title="④ Exporters" sub="Glitchless sends the same telemetry on to Datadog or any OpenTelemetry backend">
        {shell.exportersHelp}
        {exporters.map((x, i) => (
          <ExporterStatus key={i} x={x} />
        ))}
        {!shell.exportersHelp && !exporters.length && <CodeBlock code={`# .env on the Glitchless server: either, both or neither\nOTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318\nOTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=…\nDD_API_KEY=…`} />}
        <div className="muted" style={{ marginTop: 8, fontSize: 12, display: shell.exportersHelp ? 'none' : undefined }}>
          {!kinds.has('otlp') && (
            <div>
              <b>OpenTelemetry:</b> set <code>OTEL_EXPORTER_OTLP_ENDPOINT</code> (and <code>OTEL_EXPORTER_OTLP_HEADERS</code>) to send OTLP to a Collector, Grafana, Honeycomb, New Relic or Datadog.
            </div>
          )}
          {!kinds.has('datadog') && (
            <div>
              <b>Datadog:</b> set <code>DD_API_KEY</code> (or <code>DATADOG_KEY</code>) to forward to Datadog with distributions, Error Tracking and version events.
            </div>
          )}
        </div>
      </Widget>

      <GroupTitle>Agent activity</GroupTitle>
      <Widget span={6} title="Recent agent queries" sub="MCP tool calls hitting this Glitchless API">
        {(activity.data?.activity || []).length ? (
          <div>
            {activity.data.activity.slice(0, 25).map((a, i) => (
              <div className="agentrow" key={i}>
                <span className="muted mono">{fmtTime(a.ts)}</span>
                <span>
                  <Status kind="brand">{a.client}</Status>
                </span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {a.query}
                  <span className="muted"> {Object.entries(a.params).filter(([k]) => !['from', 'to', 'api_key'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ')}</span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">No agent queries yet. Connect the MCP server and ask: “what's wrong with my game?”</div>
        )}
      </Widget>
      <Widget span={6} title="What an agent sees: glitchless_triage">
        <Findings findings={triage.data?.findings} compact />
      </Widget>
    </div>
  );
}

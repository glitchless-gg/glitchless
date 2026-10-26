// The game's servers (docs/design/genre-coverage.md A9; SPEC §3 servers): dedicated servers that run a Glitchless SDK in
// server mode, kept under the game's companion service (`<game>.server`) so they never count as players. Tick time by
// players connected and by map, crashes with the matches they ended, versions, memory that climbs, and recent server
// runs, from the `servers` query (server/src/servers.js).
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, TimeSeries, Status, Empty, CodeBlock } from '../components.jsx';
import { fmtNum, fmtPct, fmtDuration, fmtTime, pctStatus } from '../format.js';
import { NoGame } from './Overview.jsx';
import { ServerRows, ServerCrashes, fmtTick } from '../genre.jsx';

export function Servers() {
  const f = useFilters();
  const { data } = useQuery('servers', f.params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const companion = data.meta?.companion ?? `${f.service}.server`;
  if (!data.kpis) return <NoServers why={data.why} service={f.service} />;
  const k = data.kpis;
  const s = data.series;
  const budget = k.budget_ms;
  return (
    <div className="grid">
      <QueryValue span={2} label="Servers running now" value={data.servers_now != null ? fmtNum(data.servers_now) : null} sub={data.players_on_servers != null ? `${fmtNum(data.players_on_servers)} players connected` : 'not counted here'} />
      <QueryValue span={2} label="Server runs" value={fmtNum(k.servers)} sub={`${fmtNum(k.hours, 1)} hours of ticks`} />
      <QueryValue span={2} label="Slowest 5% of ticks" value={fmtTick(k.tick_p95)} sub={budget ? `budget ${fmtTick(budget)} (${fmtNum(1000 / budget, 0)} Hz)` : `median ${fmtTick(k.tick_p50)}`} status={budget ? (k.tick_p95 > budget ? 'alert' : k.tick_p95 > budget * 0.8 ? 'warn' : 'ok') : 'neutral'} />
      <QueryValue span={2} label="Windows over budget" value={fmtPct(k.over_budget_pct, 1)} sub={`${fmtPct(k.late_pct, 1)} of ticks late`} status={pctStatus(k.over_budget_pct, 2, 10, false)} />
      <QueryValue span={2} label="Runs without a crash" value={fmtPct(k.crash_free_pct, 1)} sub={`${fmtNum(k.crashed)} crashed`} status={pctStatus(k.crash_free_pct, 99, 95)} />
      <QueryValue span={2} label="Players per server" value={fmtNum(k.players, 1)} sub={`${fmtNum(k.players_max)} at most`} />

      <Widget span={8} title="Tick time" sub="the median tick and the slowest 5%, against the budget" info="A tick is one step of the server's simulation. A server that falls behind its budget makes every player in its match see lag at once.">
        <TimeSeries ts={s.ts} height={200} format={fmtTick} series={[{ label: 'median tick', values: s.tick_p50, color: '#3d8cf5' }, { label: 'slowest 5%', values: s.tick_p95, color: '#ff6b57' }]} thresholds={budget ? [{ value: budget, color: '#1fae84', label: 'budget' }] : []} />
      </Widget>
      <Widget span={4} title="Players and servers" sub="players connected per server, and servers running">
        <TimeSeries ts={s.ts} height={200} series={[{ label: 'players per server', values: s.players, color: 'var(--ink)' }, { label: 'servers running', values: s.servers, color: '#3d8cf5' }]} />
      </Widget>

      <Widget span={6} title="Ticks by players connected" sub="does the server fall behind as it fills up?" info="Each bar is the share of 5-second windows whose ticks ran over budget 5% of the time or more, by how many players were connected, in tenths of the servers' capacity.">
        {data.by_players.length ? <ServerRows by="players" rows={data.by_players} /> : <div className="why">The servers send no player counts.</div>}
      </Widget>
      <Widget span={6} title="Ticks by map" flush>
        <ServerRows by="$level" rows={data.by_level} />
      </Widget>

      <Widget span={12} title="Server crashes" sub="each with the matches it ended and the players it dropped" info={`Open a crash's stack in the Errors view of ${companion}, or ask your agent: glitchless_get_error with service "${companion}".`} flush>
        <ServerCrashes crashes={data.crashes} />
      </Widget>

      <Widget span={6} title="Versions" flush>
        <ServerRows by="$version" rows={data.by_version} />
      </Widget>
      <Widget span={6} title="Memory that climbs" sub="long-running servers whose memory or objects only grow">
        <Climbing memory={data.memory} climbing={data.climbing} />
      </Widget>

      <Widget span={12} title="Recent server runs" sub="newest first" flush>
        <div className="tablewrap" style={{ maxHeight: 420 }}>
          <table className="dt">
            <thead>
              <tr>
                <th>Started</th>
                <th>Version</th>
                <th>Region</th>
                <th className="num">Ran for</th>
                <th className="num">Players (most / room)</th>
                <th className="num">Slowest 5% tick</th>
                <th className="num">Over budget</th>
                <th className="num">Matches</th>
                <th>How it ended</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((r) => (
                <tr key={r.session_id} className="click" onClick={() => f.go(`sessions/${r.session_id}?service=${encodeURIComponent(companion)}`)}>
                  <td className="muted">{fmtTime(r.start, true)}</td>
                  <td>
                    <span className="tag">{r.version}</span>
                  </td>
                  <td>{r.region ?? '–'}</td>
                  <td className="num">{fmtDuration(r.duration_s)}</td>
                  <td className="num">
                    {fmtNum(r.players_max)}
                    {r.max_players != null && <span className="muted"> / {fmtNum(r.max_players)}</span>}
                  </td>
                  <td className="num">{fmtTick(r.tick_p95)}</td>
                  <td className="num">{fmtPct(r.over_budget_pct, 0)}</td>
                  <td className="num">{fmtNum(r.matches)}</td>
                  <td>{r.crashed ? <Status kind="alert">crashed</Status> : r.ended ? <span className="muted">{endWords(r.end_reason)}</span> : <Status kind="ok">running</Status>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
    </div>
  );
}

// How a server session ended (SPEC §1 Node server SDK session_end reasons), in words.
function endWords(reason) {
  return { shutdown: 'shut down', exit: 'exited', match_end: 'match over', max_duration: 'cut after 6 hours', closed: 'closed' }[reason] ?? 'ended';
}

function Climbing({ memory, climbing }) {
  if (!memory?.length && !climbing?.length) return <div className="why">Nothing on the servers keeps climbing in this window.</div>;
  const words = (k) => (k === 'mem_mb' ? 'Memory (MB)' : k === 'net_objects' ? 'Networked objects' : k);
  return (
    <div className="tablewrap">
      <table className="dt">
        <thead>
          <tr>
            <th>What</th>
            <th className="num">Runs it climbed in</th>
            <th className="num">From → to (median)</th>
          </tr>
        </thead>
        <tbody>
          {memory.map((g) => (
            <tr key={g.key}>
              <td>{words(g.key)}</td>
              <td className="num">
                {fmtNum(g.climbing)} of {fmtNum(g.sessions)}
              </td>
              <td className="num">
                {fmtNum(g.median_first)} → <b className="alert-t">{fmtNum(g.median_last)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {climbing?.length > 0 && (
        <div className="muted" style={{ fontSize: 11.5, padding: '6px 0 0' }}>
          Longest climbs: {climbing.slice(0, 3).map((c) => `${words(c.gauge)} ${fmtNum(c.first)} → ${fmtNum(c.last)} over ${fmtNum(c.hours, 1)} h (${c.version})`).join('; ')}
        </div>
      )}
    </div>
  );
}

function NoServers({ why, service }) {
  return (
    <div className="grid">
      <div className="s12">
        <Empty title="No servers of this game in this window">
          {why} A dedicated or authoritative server runs the SDK in server mode; its batches go under {service}.server, so they never count as players.
        </Empty>
      </div>
      <Widget span={6} title="A JavaScript game server (ws, Socket.IO, Colyseus)">
        <CodeBlock code={"import { GlitchlessServer, instrumentWs } from 'glitchless/server';\nconst server = GlitchlessServer.init({ service: '" + service + "', version: '1.0.0', intake, clientToken, tickHz: 30 });\nsetInterval(server.measureTick(update), 1000 / 30);\ninstrumentWs(server, wss);"} />
      </Widget>
      <Widget span={6} title="Unity, Godot and Unreal">
        <div className="muted">A dedicated-server build runs in server mode by itself (Unity UNITY_SERVER, Godot's dedicated_server export, Unreal's dedicated server); or pass --glitchless-server.</div>
      </Widget>
    </div>
  );
}

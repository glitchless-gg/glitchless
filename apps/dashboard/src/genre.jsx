// What the genre additions put on boards and views (docs/design/genre-coverage.md A5 to A9; SPEC §3b): network quality
// (the `net` panel), a game's servers (the `servers` panel and the Servers view), levels split by what describes each
// attempt, retention by a session property, and the words they share. Board.jsx, Performance.jsx and the Servers and
// Matches views draw them from the server's answers (server/src/network.js, servers.js, levels.js, matches.js).
import { TimeSeries, BarList, Status } from './components.jsx';
import { fmtNum, fmtPct, fmtDuration, colorFor } from './format.js';

// A disconnect's reason (SPEC §2 disconnect), in words.
export const REASONS = { timeout: 'Timed out', connection_lost: 'Connection lost', kicked: 'Kicked', server_closed: 'Server closed', failed_to_connect: "Couldn't connect", other: 'Other' };
export const reasonWords = (r) => REASONS[r] ?? r;

const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
export const fmtPing = (v) => (v == null ? '–' : `${fmtNum(v, v < 10 ? 1 : 0)} ms`);
// A rate per hour played: two decimals under 10.
export const fmtPerHour = (v) => (v == null ? '–' : `${fmtNum(v, v < 10 ? 2 : 1)} / h`);

// Ping against how late play starts to feel: green under 80 ms, amber to 150, red past it.
export function pingKind(ms) {
  if (ms == null) return 'neutral';
  return ms < 80 ? 'ok' : ms < 150 ? 'warn' : 'alert';
}

// What a `by` names, in words: a property or a split without its $.
export const byWords = (by) => (by === 'players' ? 'players connected' : by === '$link' ? 'connection' : by?.startsWith('$') ? by.slice(1) : by);

// ───────────────────────────── the net panel ─────────────────────────────

// A `net` panel's one short line: the numbers every row is read against.
export function netLine(p) {
  const k = p.kpis;
  if (!k) return null;
  if (p.show === 'loss') return `${fmtPct(k.loss_pct, 2)} of packets lost on average${k.jitter_ms != null ? ` · jitter ${fmtPing(k.jitter_ms)}` : ''}`;
  if (p.show === 'disconnects') return `${plural(k.disconnects, 'disconnect')} in ${fmtNum(k.hours, 1)} hours played${k.disconnect_pct != null ? ` · ${fmtPct(k.disconnect_pct)} of attempts` : ''}`;
  return `Median ${fmtPing(k.ping_p50)}, slowest 5% ${fmtPing(k.ping_p95)} · ${fmtPct(k.lag_pct, 0)} of play over ${p.lag_ms ?? 150} ms`;
}

// What a `net` panel's numbers are, for its info icon.
export function netInfo(p) {
  const out = [];
  if (p.show === 'disconnects') out.push('A disconnect is the connection dropping in play (a timeout, a kick, the server closing). One that ends a level attempt counts as an abandon, never a fail or a rage quit; "of attempts" is the share of level attempts it ended.');
  else if (p.show === 'loss') out.push('Packet loss and jitter as the game measured them, weighted by how many samples each window had.');
  else out.push(`Ping is the round trip to the game's server. The lines are the median and the slowest 5% over time; the dashed line is ${p.lag_ms ?? 150} ms, where play starts to feel late, and "play over ${p.lag_ms ?? 150} ms" is the share of connected time spent past it. A host's own round trip (zero) is left out.`);
  if (p.by) out.push(p.by === '$version' || p.by === '$level' || p.by === '$zone' ? 'Rows come from every minute of the range.' : `Rows come from each session's own windows, by its ${byWords(p.by)} (31 days or less).`);
  if (p.more > 0) out.push(`${plural(p.more, 'more row')} not shown.`);
  return out;
}

export function NetBody({ p }) {
  const rows = p.rows || [];
  if (p.show === 'disconnects') {
    return (
      <>
        {p.reasons?.length ? (
          <BarList rows={p.reasons.map((r, i) => ({ label: reasonWords(r.reason), value: r.count, color: colorFor(r.reason, i + 3), display: `${fmtNum(r.count)} · ${fmtPerHour(r.per_hour)}`, title: `${reasonWords(r.reason)}: ${plural(r.count, 'disconnect')}, ${fmtPerHour(r.per_hour)} played` }))} />
        ) : (
          <div className="why">Nobody's connection dropped in this window.</div>
        )}
        {rows.length > 0 && (
          <NetTable
            p={p}
            cols={[
              ['Disconnects', (r) => fmtNum(r.disconnects)],
              ['Per hour played', (r) => fmtPerHour(r.disconnects_per_hour)],
              ['Of attempts', (r) => (r.disconnect_pct == null ? '–' : fmtPct(r.disconnect_pct))],
            ]}
          />
        )}
      </>
    );
  }
  if (p.show === 'loss') {
    return (
      <>
        <TimeSeries ts={p.ts} height={150} format={(v) => fmtPct(v, v < 1 ? 2 : 1)} series={[{ label: 'packet loss', values: p.loss_pct, color: '#ff6b57' }]} />
        {rows.length > 0 && (
          <NetTable
            p={p}
            cols={[
              ['Loss', (r) => fmtPct(r.loss_pct, 2)],
              ['Jitter', (r) => fmtPing(r.jitter_ms)],
              ['Median ping', (r) => fmtPing(r.ping_p50)],
            ]}
          />
        )}
      </>
    );
  }
  return (
    <>
      <TimeSeries ts={p.ts} height={150} unit=" ms" series={[{ label: 'median', values: p.p50, color: '#3d8cf5' }, { label: 'slowest 5%', values: p.p95, color: '#ff6b57' }]} thresholds={[{ value: p.lag_ms ?? 150, color: '#f2a93b', label: `${p.lag_ms ?? 150} ms` }]} />
      {rows.length > 0 && (
        <NetTable
          p={p}
          cols={[
            ['Median', (r) => <Status kind={pingKind(r.ping_p50)}>{fmtPing(r.ping_p50)}</Status>],
            ['Slowest 5%', (r) => fmtPing(r.ping_p95)],
            [`Play over ${p.lag_ms ?? 150} ms`, (r) => fmtPct(r.lag_pct, 0)],
          ]}
        />
      )}
    </>
  );
}

// A net panel's rows: the value, its sessions (where they're known), then the panel's own columns.
function NetTable({ p, cols }) {
  const sessions = p.rows.some((r) => r.sessions != null);
  return (
    <div className="tablewrap" style={{ marginTop: 8 }}>
      <table className="dt wrap-th">
        <thead>
          <tr>
            <th>{byWords(p.by)}</th>
            {sessions && <th className="num">Sessions</th>}
            {cols.map(([h]) => (
              <th className="num" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <tr key={r.value}>
              <td>{r.value}</td>
              {sessions && <td className="num">{fmtNum(r.sessions)}</td>}
              {cols.map(([h, cell]) => (
                <td className="num" key={h}>
                  {cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────── the servers panel ─────────────────────────────

export function serversLine(p) {
  const k = p.kpis;
  if (!k) return null;
  if (p.show === 'crashes') return `${plural(k.crashed, 'crash', 'crashes')} in ${plural(k.servers, 'server run')} · ${fmtPct(k.crash_free_pct)} without one`;
  if (p.show === 'players') return `${fmtNum(k.players, 1)} players connected on average, ${fmtNum(k.players_max)} at most, over ${plural(k.servers, 'server run')}`;
  return `Slowest 5% of ticks: ${fmtTick(k.tick_p95)}${p.budget_ms ? ` against a ${fmtTick(p.budget_ms)} budget` : ''} · ${fmtPct(k.over_budget_pct, 0)} of windows over it`;
}

export function serversInfo(p) {
  const out = [];
  if (p.show === 'crashes') out.push("A server crash ends the match for everyone on it. Each crash says how many matches were open on the servers it stopped, and how many players they had connected then.");
  else if (p.show === 'players') out.push('Players connected to the game\'s servers, from their own windows: they run the SDK in server mode, so they never count as players themselves.');
  else
    out.push(
      `A tick is one step of the server's simulation. The lines are the median tick and the slowest 5% over time; the dashed line is the budget, 1000 ms over the tick rate${p.budget_ms ? ` (${fmtTick(p.budget_ms)})` : ''}. A window is over budget when 5% or more of its ticks run late.`,
    );
  if (p.by === 'players') out.push("By players connected, in tenths of the servers' capacity: when the bars climb with the players, the server falls behind when it fills up.");
  return out;
}

export const fmtTick = (v) => (v == null ? '–' : `${fmtNum(v, v < 10 ? 2 : 1)} ms`);

export function ServersBody({ p }) {
  if (p.show === 'crashes') return <ServerCrashes crashes={p.crashes} />;
  const rows = p.rows || [];
  const ticks = p.show !== 'players';
  return (
    <>
      {ticks ? (
        <TimeSeries ts={p.ts} height={150} format={fmtTick} series={[{ label: 'median tick', values: p.tick_p50, color: '#3d8cf5' }, { label: 'slowest 5%', values: p.tick_p95, color: '#ff6b57' }]} thresholds={p.budget_ms ? [{ value: p.budget_ms, color: '#1fae84', label: 'budget' }] : []} />
      ) : (
        <TimeSeries ts={p.ts} height={150} series={[{ label: 'players per server', values: p.players, color: 'var(--ink)' }, { label: 'servers running', values: p.servers, color: '#3d8cf5' }]} />
      )}
      {rows.length > 0 && <ServerRows by={p.by} rows={rows} ticks={ticks} />}
    </>
  );
}

// Ticks (or players) per band of players connected, map or version.
export function ServerRows({ by, rows, ticks = true }) {
  if (by === 'players') {
    return (
      <div style={{ marginTop: 8 }}>
        <BarList
          max={100}
          rows={rows.map((r) => ({
            label: r.value,
            value: r.over_budget_pct ?? 0,
            color: r.over_budget_pct >= 10 ? '#ff6b57' : r.over_budget_pct > 0 ? '#f2a93b' : '#1fae84',
            display: `${fmtPct(r.over_budget_pct, 0)} over`,
            title: `${r.value}: ${fmtPct(r.over_budget_pct)} of ${plural(r.windows, 'window')} over budget; ${fmtPct(r.late_pct)} of ticks late`,
          }))}
        />
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          Share of 5-second windows with ticks over budget, by players connected
        </div>
      </div>
    );
  }
  return (
    <div className="tablewrap" style={{ marginTop: 8 }}>
      <table className="dt wrap-th">
        <thead>
          <tr>
            <th>{by === '$version' ? 'Version' : by === '$level' ? 'Map' : byWords(by)}</th>
            {rows.some((r) => r.servers != null) && <th className="num">Servers</th>}
            {ticks && <th className="num">Slowest 5% tick</th>}
            {ticks && <th className="num">Windows over budget</th>}
            <th className="num">Players</th>
            {!ticks && <th className="num">At most</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.value}>
              <td>{r.value}</td>
              {rows.some((x) => x.servers != null) && <td className="num">{fmtNum(r.servers)}</td>}
              {ticks && <td className="num">{fmtTick(r.tick_p95)}</td>}
              {ticks && (
                <td className="num">
                  <Status kind={r.over_budget_pct >= 10 ? 'alert' : r.over_budget_pct > 2 ? 'warn' : 'ok'}>{fmtPct(r.over_budget_pct, 0)}</Status>
                </td>
              )}
              <td className="num">{fmtNum(r.players, 1)}</td>
              {!ticks && <td className="num">{fmtNum(r.players_max)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Server crashes: what crashed, how often, and the matches and players each ended.
export function ServerCrashes({ crashes, onOpen }) {
  if (!crashes?.length) return <div className="why">No server crashed in this window.</div>;
  return (
    <div className="tablewrap">
      <table className="dt">
        <tbody>
          {crashes.map((c) => (
            <tr key={c.fingerprint} className={onOpen ? 'click' : undefined} onClick={onOpen ? () => onOpen(c) : undefined}>
              <td>
                {c.message}
                {c.location && (
                  <div className="muted mono" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {c.location}
                  </div>
                )}
              </td>
              <td className="num">{plural(c.count, 'time')}</td>
              <td className="num">
                <b>{plural(c.matches_ended ?? 0, 'match', 'matches')}</b> ended
                <div className="muted">{plural(c.players_dropped ?? 0, 'player')} dropped</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────── retention by a property ─────────────────────────────

// D1, D7 and D30 per value of a session property, under everyone's (Players.jsx RetentionTable has the cohorts).
export function RetentionBy({ r }) {
  // A board panel's answer says `split`; the players query's retention says `by`.
  const by = r.split ?? r.by;
  if (!by?.rows) return null;
  const days = ['d1', 'd7', 'd30'];
  const cell = (v) => (v == null ? <span className="muted" title="that day has not ended in this range">–</span> : fmtPct(v, 0));
  return (
    <div className="tablewrap" style={{ marginBottom: 8 }}>
      <table className="dt">
        <thead>
          <tr>
            <th>{by.key}</th>
            <th className="num">New players</th>
            {days.map((d) => (
              <th className="num" key={d}>
                {d.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {by.rows.map((x) => (
            <tr key={x.value}>
              <td>{x.value}</td>
              <td className="num">{fmtNum(x.new_players)}</td>
              {days.map((d) => (
                <td className="num" key={d}>
                  {cell(x[d])}
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <td className="muted">Everyone</td>
            <td className="num muted">{fmtNum(r.new_players)}</td>
            {days.map((d) => (
              <td className="num muted" key={d}>
                {cell(r[d])}
              </td>
            ))}
          </tr>
          {by.why && (
            <tr>
              <td colSpan={5} className="muted">
                {by.why}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────── groups and properties ─────────────────────────────

// A session's groups (A7) as chips: the match opens its page.
export function GroupChips({ groups, start }) {
  if (!groups?.length) return null;
  return (
    <span>
      {groups.map((g) => (
        <span className="tag" key={`${g.kind}:${g.id}`} title={`${g.kind} ${g.id}: ${fmtDuration((g.to - g.from) / 1000)}${start != null ? `, from +${fmtDuration((g.from - start) / 1000)}` : ''}${g.attrs ? ` · ${Object.entries(g.attrs).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`}>
          {g.kind === 'match' ? <a href={`#/matches/${encodeURIComponent(g.id)}`}>match {g.id.slice(0, 10)}…</a> : `${g.kind} ${g.id.slice(0, 10)}…`}
        </span>
      ))}
    </span>
  );
}

export function PropChips({ props }) {
  const entries = Object.entries(props || {});
  if (!entries.length) return null;
  return (
    <span>
      {entries.map(([k, v]) => (
        <span className="tag" key={k}>
          {k}: {String(v)}
        </span>
      ))}
    </span>
  );
}

// A window's counters in a line: "shot ×29, hit ×2" (the most first).
export function countsLine(counts) {
  const by = new Map();
  for (const c of counts || []) by.set(c.name, (by.get(c.name) || 0) + c.n);
  return [...by]
    .sort((a, b) => b[1] - a[1])
    .map(([n, k]) => `${n} ×${fmtNum(k)}`)
    .join(', ');
}

// Matches (docs/design/genre-coverage.md A7, A8, A9; SPEC §3 matches): everyone in one match, lobby or battle, from every
// side. A match ID comes from the game's server and every SDK hashes it the same way, so a match's players and its server
// line up. The list is the range's matches (the most recent, or the worst by lag or disconnects); a match's page shows
// each player's ping and frame time in 30-second slots from the match's start, the server's ticks under them, and the
// slots where the whole lobby lagged at once (the server) or one player did (their connection).
import { useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, Status, Segmented, Empty } from '../components.jsx';
import { fmtNum, fmtPct, fmtDuration, fmtTime } from '../format.js';
import { NoGame } from './Overview.jsx';
import { fmtPing, fmtTick, pingKind, reasonWords, PropChips } from '../genre.jsx';

const OUTCOMES = { complete: ['won', 'ok'], fail: ['lost', 'neutral'], abandon: ['left', 'warn'], disconnect: ['dropped', 'alert'] };

export function Matches({ route }) {
  if (route.arg) return <MatchPage id={decodeURIComponent(route.arg)} />;
  return <MatchList />;
}

function MatchList() {
  const f = useFilters();
  const [sort, setSort] = useState('recent');
  const { data } = useQuery('matches', { ...f.params, sort }, { refreshMs: f.live ? 15000 : 0, enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const list = data.matches || [];
  return (
    <div className="grid">
      <Widget
        span={12}
        title="Matches"
        sub={list.length ? `${fmtNum(data.total)} in this window${data.total > list.length ? `, ${fmtNum(list.length)} shown` : ''}` : null}
        actions={<Segmented value={sort} onChange={setSort} options={[{ value: 'recent', label: 'Latest' }, { value: 'lag', label: 'Most lag' }, { value: 'disconnects', label: 'Most drops' }]} />}
        flush
      >
        {list.length ? (
          <div className="tablewrap" style={{ maxHeight: 640 }}>
            <table className="dt">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Map</th>
                  <th className="num">Lasted</th>
                  <th className="num">Players</th>
                  <th>Outcomes</th>
                  <th className="num">Ping</th>
                  <th className="num">Lag</th>
                  <th className="num">Server tick</th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id} className="click" onClick={() => f.go(`matches/${encodeURIComponent(m.id)}`)}>
                    <td className="muted">{fmtTime(m.from, true)}</td>
                    <td>
                      {m.level ?? '–'}
                      {m.attrs && (
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {Object.entries(m.attrs)
                            .map(([k, v]) => `${k} ${v}`)
                            .join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="num">{fmtDuration(m.duration_s)}</td>
                    <td className="num">{fmtNum(m.sessions)}</td>
                    <td>
                      <Outcomes outcomes={m.outcomes} />
                    </td>
                    <td className="num">
                      <Status kind={pingKind(m.ping_p50)}>{fmtPing(m.ping_p50)}</Status>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        slowest 5% {fmtPing(m.ping_p95)}
                      </div>
                    </td>
                    <td className="num">{m.lag_pct == null ? '–' : fmtPct(m.lag_pct, 0)}</td>
                    <td className="num">{m.server ? fmtTick(m.server.tick_p95) : <span className="muted">no server data</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No matches in this window">
            A match is the ID the game's server makes for it: <code>glitchless.setGroup('match', id)</code> on every player and on the server, so they all send one ID.
          </Empty>
        )}
      </Widget>
    </div>
  );
}

function Outcomes({ outcomes }) {
  const entries = Object.entries(outcomes || {});
  if (!entries.length) return <span className="muted">–</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {entries.map(([k, n]) => (
        <Status key={k} kind={OUTCOMES[k]?.[1] ?? 'neutral'}>
          {fmtNum(n)} {OUTCOMES[k]?.[0] ?? k}
        </Status>
      ))}
    </span>
  );
}

function MatchPage({ id }) {
  const f = useFilters();
  const { data } = useQuery('matches', { ...f.params, id }, { enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const m = data.match;
  if (!m) return <div className="empty">{data.error || 'No such match in this window.'} Pick a longer range, or go back to <a href="#/matches">the matches</a>.</div>;
  const lobby = new Set(m.lobby_spikes);
  const dropped = m.sessions.filter((s) => s.disconnects.length).length;
  const tick = serverTicks(m);
  return (
    <div className="grid">
      <Widget span={12}>
        <div className="match-head">
          <div>
            <div className="muted kicker">MATCH</div>
            <div className="mono" style={{ fontWeight: 600 }}>
              {m.id}
            </div>
          </div>
          <div>
            <div className="muted kicker">STARTED</div>
            {fmtTime(m.from, true)}
          </div>
          <div>
            <div className="muted kicker">LASTED</div>
            {fmtDuration(m.duration_s)}
          </div>
          <div>
            <div className="muted kicker">MAP</div>
            {m.level ?? '–'} {m.attrs && <PropChips props={m.attrs} />}
          </div>
          <div>
            <div className="muted kicker">PLAYERS</div>
            {fmtNum(m.sessions.length)} <Outcomes outcomes={m.outcomes} />
          </div>
          <div>
            <div className="muted kicker">PING</div>
            <Status kind={pingKind(m.ping_p50)}>{fmtPing(m.ping_p50)}</Status> <span className="muted">slowest 5% {fmtPing(m.ping_p95)}</span>
          </div>
          {tick && (
            <div>
              <div className="muted kicker">SERVER TICK</div>
              {fmtTick(tick.usual)} <span className="muted">usual, worst stretch {fmtTick(tick.worst)} · {fmtNum(tick.players)} {tick.players === 1 ? 'player' : 'players'} at most</span>
            </div>
          )}
        </div>
        <div className="match-verdict">
          {m.lobby_spikes.length ? (
            <span>
              <Status kind="alert">whole lobby</Status> Most of the lobby lagged at once {spans(m.lobby_spikes, m.slot_s)}: that points at the server or its network, not at players' connections.
            </span>
          ) : (
            <span className="muted">The lobby never lagged all at once{m.sessions.some((s) => s.slots.some((x) => x.spike)) ? '; the marked slots are one player lagging on their own (their connection).' : '.'}</span>
          )}
          {dropped > 0 && <span className="muted"> {fmtNum(dropped)} {dropped === 1 ? 'player' : 'players'} dropped out ({Object.entries(m.disconnect_reasons).map(([r, n]) => `${fmtNum(n)} ${reasonWords(r).toLowerCase()}`).join(', ')}).</span>}
        </div>
      </Widget>

      <Widget span={12} title="Slot by slot" sub={`every ${m.slot_s} seconds from the match's start: each player's ping, and the server's ticks under them`} info={['A cell is one player\'s median ping in that slot: green under 80 ms, amber to 150 ms, red past it. A ringed cell is that player lagging: twice their own usual ping and 50 ms over it. A shaded column is the whole lobby lagging at once (60% or more of the players with network data).', 'The server row is its slowest 5% of ticks in the slot, against its tick budget (red: over it), or the match\'s usual where the server said no tick rate. Hover a cell for its numbers.']} flush>
        <SlotGrid m={m} lobby={lobby} />
      </Widget>

      <Widget span={12} title="What happened" sub="levels, deaths, disconnects and errors of the match's players, from its start" flush>
        <div className="tablewrap" style={{ maxHeight: 360 }}>
          <table className="dt">
            <tbody>
              {/* Everyone joins at the start; a join says something only when it comes later. */}
              {m.events.filter((e) => !(e.type === 'group' && e.t < 5)).map((e, i) => (
                <tr key={i} className="click" onClick={() => f.go(`sessions/${e.session_id}`)}>
                  <td className="mono muted" style={{ width: 70 }}>
                    +{fmtDuration(e.t)}
                  </td>
                  <td className="mono muted" style={{ width: 120 }}>
                    {playerLabel(m, e.session_id)}
                  </td>
                  <td>
                    <b>{eventWords(e)}</b>
                    {e.message && <div className="muted">{e.message}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
    </div>
  );
}

// "60 to 90 s in", or "at 1, 3 and 4 minutes".
function spans(slots, size) {
  const at = (t) => (t >= 120 ? `${fmtNum(t / 60, 1)} min` : `${t} s`);
  if (slots.length === 1) return `${at(slots[0])} to ${at(slots[0] + size)} in`;
  return `in ${slots.length} slots, first ${at(slots[0])} in`;
}

function playerLabel(m, sid) {
  const i = m.sessions.findIndex((s) => s.session_id === sid);
  return i >= 0 ? `player ${i + 1}` : sid.slice(0, 10);
}

function eventWords(e) {
  if (e.type === 'level_start') return `▶ ${e.level ?? 'level'} started`;
  if (e.type === 'level_complete') return `✓ ${e.level} won`;
  if (e.type === 'level_fail') return `✗ ${e.level} lost${e.name ? `: ${e.name}` : ''}`;
  if (e.type === 'level_abandon') return e.reason === 'disconnect' ? `${e.level} ended by a disconnect` : `left ${e.level}`;
  if (e.type === 'death') return `died${e.name ? `: ${e.name}` : ''}`;
  if (e.type === 'disconnect') return `disconnected: ${reasonWords(e.reason).toLowerCase()}`;
  if (e.type === 'reconnect') return 'reconnected';
  if (e.type === 'group') return 'joined the match';
  if (e.type === 'error') return `error: ${e.name ?? ''}`;
  return e.name ?? e.type;
}

// Rows of 30-second cells: one per player (ping, ringed where they spiked), then the server's ticks; columns the whole
// lobby lagged in are shaded. Wider than a phone, so it scrolls sideways inside its panel.
// The match's server ticks: the usual slot (the median of its slowest-5% ticks), the worst slot, the most players
// connected and the tick budget (1000 over the server's tick rate, when it said one), or null without server windows.
function serverTicks(m) {
  const slots = (m.server || []).flatMap((s) => s.slots).filter((x) => x.tick_p95 != null);
  if (!slots.length) return null;
  const sorted = slots.map((x) => x.tick_p95).sort((a, b) => a - b);
  const budget = (m.server || []).find((s) => s.budget_ms != null)?.budget_ms ?? null;
  return { usual: sorted[Math.floor(sorted.length / 2)], worst: sorted.at(-1), players: Math.max(...slots.map((x) => x.players ?? 0)), budget };
}

function SlotGrid({ m, lobby }) {
  const n = m.slots.length;
  const ticks = serverTicks(m);
  const usual = ticks?.usual ?? null;
  // Against the server's own budget where it said one (over it: a missed tick), else against the match's usual slot.
  const tickKind = (v) => (v == null || usual == null ? 'none' : ticks.budget != null ? (v > ticks.budget ? 'alert' : v > ticks.budget * 0.8 ? 'warn' : 'ok') : v > usual * 1.5 ? 'alert' : v > usual * 1.15 ? 'warn' : 'ok');
  const cols = { gridTemplateColumns: `minmax(112px, 150px) repeat(${n}, 16px)` };
  const every = n > 40 ? 8 : n > 20 ? 4 : 2;
  return (
    <div className="slotwrap">
      <div className="slotgrid" style={cols}>
        <div className="sl-label muted">from start</div>
        {m.slots.map((t, i) => (
          <div key={t} className={`sl-tick${lobby.has(t) ? ' lobby' : ''}`}>
            {i % every === 0 ? (t >= 60 ? `${Math.round(t / 60)}m` : `${t}s`) : ''}
          </div>
        ))}
        {m.sessions.map((s, k) => {
          const by = new Map(s.slots.map((x) => [x.t, x]));
          return (
            <Row key={s.session_id} label={`player ${k + 1}`} sub={[s.platform, s.props?.region].filter(Boolean).join(' · ')} href={`#/sessions/${s.session_id}`} outcome={s.outcome}>
              {m.slots.map((t) => {
                const x = by.get(t);
                const kind = x ? pingKind(x.ping_p50) : 'none';
                const title = x ? `+${fmtDuration(t)}: ping ${fmtPing(x.ping_p50)} (slowest 5% ${fmtPing(x.ping_p95)}), frames ${x.fps != null ? `${fmtNum(x.fps)} fps` : '–'}, slowest 5% ${x.frame_p95 != null ? `${fmtNum(x.frame_p95, 1)} ms` : '–'}${x.loss_pct ? `, ${fmtPct(x.loss_pct, 1)} lost` : ''}${x.hitches ? `, ${x.hitches} hitches` : ''}${x.spike ? ' · lagging on their own' : ''}` : `+${fmtDuration(t)}: not playing`;
                return <div key={t} className={`sl ${kind}${x?.spike ? ' spike' : ''}${lobby.has(t) ? ' lobby' : ''}`} title={title} />;
              })}
            </Row>
          );
        })}
        {m.server.map((sv) => {
          const by = new Map(sv.slots.map((x) => [x.t, x]));
          return (
            <Row key={sv.session_id} label="server" sub="slowest 5% tick">
              {m.slots.map((t) => {
                const x = by.get(t);
                return <div key={t} className={`sl ${tickKind(x?.tick_p95)} server${lobby.has(t) ? ' lobby' : ''}`} title={x ? `+${fmtDuration(t)}: ticks ${fmtTick(x.tick_p95)} (${ticks.budget != null ? `budget ${fmtTick(ticks.budget)}` : `usual ${fmtTick(usual)}`}), ${fmtNum(x.players)} players${x.late ? `, ${fmtNum(x.late)} late ticks` : ''}${x.net_objects != null ? `, ${fmtNum(x.net_objects)} networked objects` : ''}` : `+${fmtDuration(t)}: no server window`} />;
              })}
            </Row>
          );
        })}
      </div>
      <div className="legend slot-legend">
        <span>
          <i className="sl ok" /> under 80 ms
        </span>
        <span>
          <i className="sl warn" /> 80–150 ms
        </span>
        <span>
          <i className="sl alert" /> over 150 ms
        </span>
        <span>
          <i className="sl ok spike" /> one player lagging
        </span>
        <span>
          <i className="sl none lobby" /> the whole lobby lagging
        </span>
      </div>
    </div>
  );
}

function Row({ label, sub, href, outcome, children }) {
  return (
    <>
      <div className="sl-label">
        {href ? <a href={href}>{label}</a> : <b>{label}</b>}
        {outcome && <span className="muted"> · {OUTCOMES[outcome]?.[0] ?? outcome}</span>}
        {sub && <div className="muted">{sub}</div>}
      </div>
      {children}
    </>
  );
}

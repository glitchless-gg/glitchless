// The game's own metrics: every custom event it sends with track() or count(), how its attribute values break down,
// funnels between events, and the session properties it sets (setProps). Anything here can be added to one of the
// game's boards.
import { useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, TimeSeries, BarList, Sparkline, CodeBlock, Empty } from '../components.jsx';
import { fmtNum, fmtPct, fmtSum, colorFor } from '../format.js';
import { CsvButton, eventsCsv, panelCsv } from '../csv.jsx';
import { NoGame } from './Overview.jsx';
import { FunnelTable } from './Board.jsx';
import { addToBoard } from '../dashboard.js';

export function Events({ route }) {
  const f = useFilters();
  const [sdk, setSdk] = useState(false);
  const funnel = route.query.get('funnel') || '';
  const [draft, setDraft] = useState(funnel);
  const [added, setAdded] = useState(null);
  const params = { ...f.params, ...(sdk ? { sdk: 1 } : {}), ...(funnel ? { funnel } : {}) };
  const { data } = useQuery('events', params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const events = data.events || [];
  const link = (next) => {
    const q = new URLSearchParams({ ...(route.query.get('name') ? { name: route.query.get('name') } : {}), ...(funnel ? { funnel } : {}), ...next });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    f.go(`events${q.size ? `?${q}` : ''}`);
  };
  const add = async (panel, label) => {
    setAdded(null);
    try {
      const id = await addToBoard(f, panel);
      setAdded(`Added "${label}" to ${f.dashboard.spec.pages.find((p) => p.id === id)?.title || 'a new board'}.`);
    } catch (err) {
      setAdded(`Couldn't add it: ${err.message}`);
    }
  };
  if (!events.length && !sdk) return <NoEvents onSdk={() => setSdk(true)} />;
  const picked = events.find((e) => e.name === route.query.get('name')) || events[0];
  const total = events.reduce((n, e) => n + e.count, 0);
  return (
    <div className="grid">
      <QueryValue span={3} label="Event types" value={fmtNum(events.length)} sub={sdk ? 'including the SDK\'s own' : 'sent by the game with track() or count()'} />
      <QueryValue span={3} label="Events" value={fmtNum(total)} />
      <QueryValue span={3} label="Sessions" value={fmtNum(data.sessions)} sub="in this window" />
      <QueryValue span={3} label="Most sent" value={events[0]?.name ?? '–'} sub={events[0] ? `${fmtNum(events[0].count)} times` : null} />

      <Widget
        span={7}
        title="Events"
        sub="click one for its breakdown"
        actions={
          <>
            <label className="muted" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={sdk} onChange={(e) => setSdk(e.target.checked)} /> SDK events too
            </label>
            {events.length > 0 && <CsvButton name="events" rows={() => eventsCsv(events)} />}
          </>
        }
        flush
      >
        <table className="dt">
          <thead>
            <tr>
              <th>Event</th>
              <th className="num">Count</th>
              <th className="num">Sessions</th>
              <th className="num">Per session</th>
              <th>Over time</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.name} className={`click ${picked?.name === e.name ? 'sel' : ''}`} onClick={() => link({ name: e.name })}>
                <td>
                  <b>{e.name}</b>
                  {e.sdk && <span className="tag">sdk</span>}
                  {e.counted && (
                    <span className="tag" title="Counted in the game with count() and sent as totals">
                      counted
                    </span>
                  )}
                </td>
                <td className="num">{fmtNum(e.count)}</td>
                <td className="num">
                  {fmtNum(e.sessions)} <span className="muted">· {fmtPct(e.sessions_pct, 0)}</span>
                </td>
                <td className="num">{fmtNum(e.per_session, 1)}</td>
                <td>
                  <Sparkline values={e.series} color="var(--ink)" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Widget>

      {picked && (
        <Widget span={5} title={picked.name} sub={`${fmtNum(picked.count)} in ${fmtNum(picked.sessions)} sessions`} actions={<button className="btn" onClick={() => add({ type: 'series', event: picked.name, size: 'm' }, picked.name)}>Add to board</button>}>
          {picked.counted && <div className="muted" style={{ marginBottom: 8 }}>Counted in the game with count() and sent as totals every few seconds, so even thousands a minute cost nothing. Each attribute value is its own count.</div>}
          <TimeSeries ts={data.ts} height={120} bars series={[{ label: picked.name, values: picked.series, color: 'var(--ink)' }]} />
          {picked.attrs.map((a) => (
            <div key={a.key} style={{ marginTop: 14 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>by {a.key}</b>
                <button className="btn" onClick={() => add({ type: 'breakdown', event: picked.name, by: a.key, size: 'm' }, `${picked.name} by ${a.key}`)}>
                  Add to board
                </button>
              </div>
              <BarList rows={a.values.slice(0, 8).map((v, i) => ({ label: v.value, value: v.count, color: colorFor(v.value, i), display: `${fmtNum(v.count)} · ${fmtNum(v.sessions)} sessions` }))} />
              {a.values.length > 8 && <div className="muted">{a.values.length - 8} more values</div>}
              {a.avg != null && <div className="muted">average {fmtNum(a.avg, 1)}</div>}
              {(picked.sums || [])
                .filter((x) => x.attr === a.key)
                .map((x) => (
                  <div className="muted" key={x.currency || ''}>
                    sum {fmtSum(x.sum, x.currency)} · {fmtNum(x.events)} events{x.currency ? ` in ${x.currency}` : ''}
                  </div>
                ))}
            </div>
          ))}
        </Widget>
      )}

      <Widget span={12} title="Funnel" sub="sessions that sent each event after the one before it, in order. A step can need a value: buy=done, or buy:step=done">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            link({ funnel: draft.trim() });
          }}
        >
          <input className="funnel-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={events.slice(0, 3).map((e) => e.name).join(', ') || 'open, paywall, buy=done'} />
          <button className="btn primary">Show funnel</button>
          {data.funnel && (
            <button type="button" className="btn" onClick={() => add({ type: 'funnel', steps: funnel, size: 'l' }, funnel)}>
              Add to board
            </button>
          )}
          {data.funnel && <CsvButton name="funnel" rows={() => panelCsv({ type: 'funnel', steps: data.funnel })} />}
        </form>
        {data.funnel && <div style={{ marginTop: 10 }}><FunnelTable steps={data.funnel} /></div>}
      </Widget>
      {data.properties?.length > 0 && <Properties list={data.properties} f={f} />}
      {added && <div className="s12 muted">{added}</div>}
    </div>
  );
}

// Session properties (A6): what the game says holds for a session (a mode, a rank, a class), each with its values.
// A value opens every page filtered to it; a key with too many values is really an ID and splits nothing.
function Properties({ list, f }) {
  return (
    <Widget span={12} title="Session properties" sub="set with setProps; click a value to see only those sessions" info="Each session keeps the latest value of each property. Split any board panel by one with by: $<key>, or keep a page to some sessions with its where.">
      <div className="prop-grid">
        {list.map((p) => (
          <div key={p.key}>
            <b className="mono">${p.key}</b>
            {p.identifier_like ? (
              <div className="why warn-t" style={{ marginTop: 4 }}>
                This looks like an ID, not a property: over 200 values a day. Splits show it as (too many values). Send it as an event attribute instead, or leave it out.
              </div>
            ) : (
              <BarList
                rows={p.values.slice(0, 8).map((v, i) => ({ label: v.value, value: v.sessions, color: colorFor(v.value, i), display: `${fmtNum(v.sessions)} sessions`, title: `${fmtNum(v.players)} players` }))}
                onClick={f.setProps ? (r) => f.setProps({ [p.key]: [r.label] }) : undefined}
              />
            )}
            {!p.identifier_like && p.values.length > 8 && <div className="muted">{p.values.length - 8} more values</div>}
          </div>
        ))}
      </div>
    </Widget>
  );
}

function NoEvents({ onSdk }) {
  return (
    <div className="grid">
      <div className="s12">
        <Empty title="This game sends no events of its own yet">
          Every game counts different things: plays by mode, levels cleared, purchases, hints used. Send them with <code>track</code>, and they show up here and on the game's boards.
        </Empty>
      </div>
      <Widget span={3} title="Web games (Three.js, Phaser, Babylon.js, PlayCanvas)">
        <CodeBlock code={"glitchless.track('play', { mode: 'endless' });\nglitchless.track('buy', { step: 'done' });"} />
      </Widget>
      <Widget span={3} title="Godot">
        <CodeBlock code={'Glitchless.track("play", "endless")\nGlitchless.track("buy", {"step": "done"})'} />
      </Widget>
      <Widget span={3} title="Unity">
        <CodeBlock code={'Glitchless.Track("play", "endless");\nGlitchless.Track("buy", "done");'} />
      </Widget>
      <Widget span={3} title="Unreal">
        <CodeBlock code={'FGlitchless::Track(TEXT("play"), TEXT("endless"));\n// Blueprint: Track Event (What)'} />
      </Widget>
      <div className="s12 muted" style={{ textAlign: 'center' }}>
        <button className="btn" onClick={onSdk}>
          Show the SDK's own events
        </button>
      </div>
    </div>
  );
}

// The game's own metrics: every custom event it sends with track(), how its attribute values break down,
// and funnels between events. Anything here can be added to one of the game's boards.
import { useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, TimeSeries, BarList, Sparkline, CodeBlock, Empty } from '../components.jsx';
import { fmtNum, fmtPct, colorFor } from '../format.js';
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
      <QueryValue span={3} label="Event types" value={fmtNum(events.length)} sub={sdk ? 'including the SDK\'s own' : 'sent by the game with track()'} />
      <QueryValue span={3} label="Events" value={fmtNum(total)} />
      <QueryValue span={3} label="Sessions" value={fmtNum(data.sessions)} sub="in this window" />
      <QueryValue span={3} label="Most sent" value={events[0]?.name ?? '–'} sub={events[0] ? `${fmtNum(events[0].count)} times` : null} />

      <Widget
        span={7}
        title="Events"
        sub="click one for its breakdown"
        actions={
          <label className="muted" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={sdk} onChange={(e) => setSdk(e.target.checked)} /> SDK events too
          </label>
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
                </td>
                <td className="num">{fmtNum(e.count)}</td>
                <td className="num">
                  {fmtNum(e.sessions)} <span className="muted">· {fmtPct(e.sessions_pct, 0)}</span>
                </td>
                <td className="num">{fmtNum(e.per_session, 1)}</td>
                <td>
                  <Sparkline values={e.series} color="#14213d" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Widget>

      {picked && (
        <Widget span={5} title={picked.name} sub={`${fmtNum(picked.count)} in ${fmtNum(picked.sessions)} sessions`} actions={<button className="btn" onClick={() => add({ type: 'series', event: picked.name, size: 'm' }, picked.name)}>Add to board</button>}>
          <TimeSeries ts={data.ts} height={120} bars series={[{ label: picked.name, values: picked.series, color: '#14213d' }]} />
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
        </form>
        {data.funnel && <div style={{ marginTop: 10 }}><FunnelTable steps={data.funnel} /></div>}
      </Widget>
      {added && <div className="s12 muted">{added}</div>}
    </div>
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
      <Widget span={4} title="Three.js or Phaser">
        <CodeBlock code={"glitchless.track('play', { mode: 'endless' });\nglitchless.track('buy', { step: 'done' });"} />
      </Widget>
      <Widget span={4} title="Godot">
        <CodeBlock code={'Glitchless.track("play", "endless")\nGlitchless.track("buy", {"step": "done"})'} />
      </Widget>
      <Widget span={4} title="Unity">
        <CodeBlock code={'Glitchless.Track("play", "endless");\nGlitchless.Track("buy", "done");'} />
      </Widget>
      <div className="s12 muted" style={{ textAlign: 'center' }}>
        <button className="btn" onClick={onSdk}>
          Show the SDK's own events
        </button>
      </div>
    </div>
  );
}

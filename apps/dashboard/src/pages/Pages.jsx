// The game's pages: rename, reorder, remove, add a board or a built-in view, or edit the whole dashboard as
// JSON. A coding agent does the same over MCP (glitchless_set_dashboard).
import { useState } from 'react';
import { useFilters } from '../filters.js';
import { VIEWS, saveDashboard, resetDashboard } from '../dashboard.js';
import { Widget, Icon } from '../components.jsx';
import { timeAgo } from '../format.js';
import { NoGame } from './Overview.jsx';

export function Pages() {
  const f = useFilters();
  const d = f.dashboard;
  const [draft, setDraft] = useState(null);
  const [currency, setCurrency] = useState(null);
  const [json, setJson] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!f.service) return <NoGame />;
  if (!d.spec) return <div className="loading-bar" />;
  const pages = draft || d.spec.pages;
  // The game's one currency for money on its boards; empty: the one most of its events are sent in.
  const money = currency ?? d.spec.currency ?? '';
  const set = (next) => {
    setDraft(next);
    setNote(null);
  };
  const change = (page, patch) => set(pages.map((p) => (p === page ? { ...p, ...patch } : p)));
  const move = (i, by) => {
    const next = [...pages];
    const [p] = next.splice(i, 1);
    next.splice(i + by, 0, p);
    set(next);
  };
  const freeId = (base) => {
    let id = base;
    for (let n = 2; pages.some((p) => p.id === id); n++) id = `${base}-${n}`;
    return id;
  };
  const run = async (fn, done) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      setDraft(null);
      setCurrency(null);
      setJson(null);
      setNote({ ok: true, text: done });
    } catch (err) {
      setNote({ ok: false, text: err.message });
    }
    setBusy(false);
  };
  const save = () =>
    run(async () => {
      let spec = { ...(money.trim() ? { currency: money.trim().toUpperCase() } : {}), pages };
      if (json != null) {
        try {
          spec = JSON.parse(json);
        } catch {
          throw new Error('That is not valid JSON.');
        }
      }
      await saveDashboard(f, spec);
    }, 'Saved.');
  const changed = draft != null || json != null || currency != null;

  return (
    <div className="grid">
      <Widget span={8} title="Pages" sub={d.source === 'saved' ? `saved${d.updated_by ? ` by ${d.updated_by === 'dashboard' ? 'you' : d.updated_by}` : ''} ${timeAgo(d.updated_at)}` : 'automatic: made from what this game sends'} flush>
        <table className="dt pages">
          <tbody>
            {pages.map((p, i) => (
              <tr key={p.id}>
                <td style={{ width: 28 }}>
                  <Icon name={p.icon || (p.view ? VIEWS[p.view].icon : 'board')} />
                </td>
                <td style={{ width: '30%' }}>
                  <input className="input" value={p.title} maxLength={40} onChange={(e) => change(p, { title: e.target.value })} aria-label="Page title" />
                </td>
                <td className="muted">
                  {p.view ? VIEWS[p.view].about : `board · ${p.panels.length} panel${p.panels.length === 1 ? '' : 's'}`}
                  {p.view === 'live' && (
                    <input
                      className="input"
                      style={{ marginTop: 4 }}
                      value={(p.options?.events || []).join(', ')}
                      placeholder="only these events (optional): buy, error"
                      onChange={(e) => {
                        const events = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
                        change(p, { options: events.length ? { events } : undefined });
                      }}
                    />
                  )}
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn" disabled={!i} onClick={() => move(i, -1)} title="Move up" aria-label="Move up">
                    ↑
                  </button>{' '}
                  <button className="btn" disabled={i === pages.length - 1} onClick={() => move(i, 1)} title="Move down" aria-label="Move down">
                    ↓
                  </button>{' '}
                  <button className="btn" disabled={pages.length === 1} onClick={() => set(pages.filter((x) => x !== p))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row pages-foot">
          <button className="btn" onClick={() => set([...pages, { id: freeId('board'), title: 'New board', icon: 'board', panels: [{ type: 'stat', metric: 'sessions' }, { type: 'events', size: 'l' }] }])}>
            Add a board
          </button>
          <select className="btn" value="" onChange={(e) => e.target.value && set([...pages, { id: freeId(e.target.value), title: VIEWS[e.target.value].title, icon: VIEWS[e.target.value].icon, view: e.target.value }])}>
            <option value="">Add a built-in view…</option>
            {Object.entries(VIEWS).map(([v, info]) => (
              <option key={v} value={v}>
                {info.title}
              </option>
            ))}
          </select>
          <span className="spacer" />
          {d.source === 'saved' && (
            <button className="btn" disabled={busy} onClick={() => run(() => resetDashboard(f), 'Back to the automatic dashboard.')}>
              Go back to automatic
            </button>
          )}
          {changed && (
            <button className="btn" disabled={busy} onClick={() => (setDraft(null), setCurrency(null), setJson(null), setNote(null))}>
              Discard
            </button>
          )}
          <button className="btn primary" disabled={busy || !changed} onClick={save}>
            Save pages
          </button>
        </div>
        {note && <div className={note.ok ? 'ok-t pages-note' : 'err pages-note'}>{note.text}</div>}
      </Widget>
      <Widget span={4} title="Let your agent design it">
        <p className="muted" style={{ marginTop: 0 }}>
          Every game needs different pages. Ask your coding agent to set up a Glitchless dashboard for this game: it adds the events the game is missing with <code>track()</code>, then saves pages that fit with{' '}
          <code>glitchless_set_dashboard</code>.
        </p>
        <p className="muted">The first page opens first. To change a board&rsquo;s panels, open it and choose Edit panels.</p>
        <label className="muted pages-currency">
          Money is in{' '}
          <input className="input" value={money} maxLength={3} placeholder="USD" onChange={(e) => (setCurrency(e.target.value), setNote(null))} aria-label="Currency" />{' '}
          <span title="Revenue panels add up purchases in this currency and name the ones sent in another. Empty: the currency most purchases are sent in.">(ISO code; empty: from the events)</span>
        </label>
        <button className="btn" onClick={() => setJson(json == null ? JSON.stringify({ ...(money.trim() ? { currency: money.trim().toUpperCase() } : {}), pages }, null, 2) : null)}>
          {json == null ? 'Edit as JSON' : 'Close JSON'}
        </button>
      </Widget>
      {json != null && (
        <Widget span={12} title="The whole dashboard as JSON" sub="currency (optional, e.g. USD), and pages: { id, title, icon, panels } for a board, { id, title, view, options } for a built-in view">
          <textarea className="board-editor" spellCheck={false} value={json} onChange={(e) => (setJson(e.target.value), setNote(null))} />
        </Widget>
      )}
    </div>
  );
}

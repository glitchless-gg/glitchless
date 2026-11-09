// The organiser's home in the jam (SPEC §3j, docs/design/jam-rooms.md §5), at the jam's base (Jam.jsx): make a room,
// see its games and their plays, end the jam, take a game out, delete a room, set the room's survey (its heading, intro
// and questions, by hand or from a template, until its first answer), keep survey templates for the next jam, and look
// back at past jams: their snapshot as JSON or CSV, and what people answered in the survey. Every call carries the
// dashboard's own key and headers (api.js), which is what makes someone an organiser; a 401 asks for the key once.
import { useState } from 'react';
import { Widget, BarList, Status, Empty, Icon } from '../components.jsx';
import { apiFetch, askForKey } from '../api.js';
import { fmtNum, timeAgo } from '../format.js';
import { roomCall, roomLinks, usePoll, when, plural, versionLabel } from '../room.jsx';

const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// A call with the dashboard's headers. A 401 asks for the server's key (or the host's sign-in) once a page load, then
// tries again; a failure says the status too (a survey with answers is a 409). `raw` answers the response itself.
let declined = false;
async function send(method, path, body, { raw = false } = {}) {
  for (let tries = 0; ; tries++) {
    const res = await apiFetch(path, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (res.status === 401 && !tries && !declined) {
      if (askForKey()) continue;
      declined = true;
    }
    if (raw && res.ok) return res;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw Object.assign(new Error("This server needs its key to make and change jam rooms: reload the page to enter it."), { status: 401 });
    if (!res.ok) throw Object.assign(new Error(sentence(data.error || `HTTP ${res.status}`)), { status: res.status });
    return data;
  }
}

// A template's id from its name: "Meetup, long" → "meetup-long".
const idOf = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');

export function Rooms({ base = '/' }) {
  const rooms = usePoll(() => send('GET', '/v1/rooms'), 20_000, []);
  const templates = usePoll(() => send('GET', '/v1/rooms/templates'), 0, []);
  const list = templates.data?.templates ?? [];
  const open = rooms.data?.rooms ?? [];
  const past = rooms.data?.past ?? [];
  if (rooms.error && !rooms.data)
    return (
      <div className="grid">
        <Widget span={12} title="Jam rooms">
          <p className="err">{rooms.error.status === 404 ? 'This server has no jam rooms.' : rooms.error.status === 401 ? rooms.error.message : `Couldn't load your rooms: ${rooms.error.message}`}</p>
        </Widget>
      </div>
    );
  return (
    <div className="grid room-org-page">
      <MakeRoom onMade={rooms.reload} templates={list} />
      {rooms.data && !open.length && !past.length && (
        <Widget span={12}>
          <Empty title="No jam rooms yet">Make one above. You get a five-letter code, an arcade page for everyone's phones and a big screen for the projector.</Empty>
        </Widget>
      )}
      {open.map((r) => (
        <RoomCard key={r.code} room={r} base={base} onChange={rooms.reload} templates={list} onTemplates={templates.reload} />
      ))}
      {past.length > 0 && <PastJams past={past} onChange={rooms.reload} />}
      {list.length > 0 && <Templates templates={list} onChange={templates.reload} />}
    </div>
  );
}

// A new room: a title, a line about it, its survey's template, how long until it ends by itself, and whether it's an
// online jam (over days, its games often on itch.io: up to 21 days instead of 7).
function MakeRoom({ onMade, templates }) {
  const [title, setTitle] = useState('');
  const [about, setAbout] = useState('');
  const [template, setTemplate] = useState('default');
  const [hours, setHours] = useState('24');
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function make(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const picked = templates.some((t) => t.id === template) ? template : undefined;
      await send('POST', '/v1/rooms', { title, about: about || undefined, hours: Number(hours) || undefined, template: picked, ...(online ? { online: true } : {}) });
      setTitle('');
      setAbout('');
      onMade();
    } catch (err) {
      setError(sentence(err.message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Widget span={12} title="Make a jam room" sub="Makers' agents join it by its code and publish their games to it; everyone plays them from its arcade.">
      <form className="room-org-make" onSubmit={make}>
        <label>
          <span>Title</span>
          <input className="input" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Generative AI DC mini jam" />
        </label>
        <label>
          <span>About (on the arcade)</span>
          <input className="input" maxLength={280} value={about} onChange={(e) => setAbout(e.target.value)} placeholder="Make a game with your agent in 90 minutes, then play everyone's." />
        </label>
        {templates.length > 0 && (
          <label>
            <span>Survey</span>
            <select className="input" value={template} onChange={(e) => setTemplate(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>Ends by itself after</span>
          <span className="room-org-hours">
            <input className="input" type="number" min={1} max={online ? 504 : 168} value={hours} onChange={(e) => setHours(e.target.value)} />
            hours
          </span>
        </label>
        <label>
          <span>Online jam</span>
          <span className="room-org-hours">
            <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} />
            Up to 21 days
          </span>
        </label>
        <button className="btn primary" disabled={busy || !title.trim()}>
          {busy ? 'Making…' : 'Make the room'}
        </button>
      </form>
      {error && <p className="err">{error}</p>}
    </Widget>
  );
}

// One room: its links, its games with their plays, and what its organiser can do.
function RoomCard({ room: r, base, onChange, templates, onTemplates }) {
  const live = usePoll(() => roomCall('GET', `${r.code}/live`, { fresh: true }), 20_000, [r.code, r.games.length, r.ended]);
  const plays = new Map((live.data?.games ?? []).map((g) => [g.slug, g]));
  const links = roomLinks(r.code, base);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const act = async (what, fn) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      onChange();
      live.reload();
    } catch (err) {
      setError(sentence(err.message));
    } finally {
      setBusy(null);
    }
  };
  const end = () =>
    window.confirm(`End ${r.title} now? Publishing and voting stop, the awards are worked out and the survey opens. This can't be undone.`) &&
    act('end', () => send('PATCH', `/v1/rooms/${r.code}`, { end: true }));
  const joining = () => act('joining', () => send('PATCH', `/v1/rooms/${r.code}`, { joining: !r.joining }));
  const remove = () =>
    window.confirm(`Delete room ${r.code}, ${r.title}? Its games, their files and every vote are deleted now${r.ended ? ", and so are its snapshot and the survey's answers" : ''}. This can't be undone.`) &&
    act('delete', () => send('DELETE', `/v1/rooms/${r.code}`));
  // Every game that joined: the published ones with their version and plays, then those still being made.
  const published = new Map(r.games.map((g) => [g.slug, g]));
  const rows = (r.joined ?? r.games).filter((g) => !g.removed).map((g) => ({ ...g, ...(published.get(g.slug) ?? {}) }));
  const takeOut = (g) =>
    window.confirm(`Take ${g.title} out of the room? It disappears from the arcade and the big screen, its files are deleted, and it can't join this room again.`) &&
    act(`out:${g.slug}`, () => send('DELETE', `/v1/rooms/${r.code}/games/${encodeURIComponent(g.slug)}?by=organiser`));

  return (
    <Widget
      span={12}
      className="room-org-card"
      title={
        <span className="room-org-title">
          {r.title} <span className="room-org-code">{r.code}</span>
        </span>
      }
      actions={
        <>
          {!r.ended && (
            <button className="btn" onClick={joining} disabled={busy != null} title={r.joining ? 'Games already in the room can still publish' : undefined}>
              {r.joining ? 'Stop taking new games' : 'Take new games again'}
            </button>
          )}
          {!r.ended && (
            <button className="btn primary" onClick={end} disabled={busy != null}>
              {busy === 'end' ? 'Ending…' : 'End the jam'}
            </button>
          )}
          <button className="btn room-org-danger" onClick={remove} disabled={busy != null}>
            Delete room
          </button>
        </>
      }
    >
      <div className="room-org-meta">
        {r.ended ? <Status kind="neutral">Ended {when(r.ended_at)}</Status> : <Status kind="ok">On until {when(r.closes_at)}</Status>}
        {!r.ended && !r.joining && <Status kind="warn">Not taking new games</Status>}
        {r.online && <Status kind="neutral">Online</Status>}
        <span className="muted">
          {plural(r.games.length, 'game')} published{r.building && !r.ended ? `, ${fmtNum(r.building)} still being made` : ''}
          {live.data ? ` · ${plural(live.data.totals.plays, 'play')}` : ''}
        </span>
      </div>
      {r.about && <p className="room-org-about">{r.about}</p>}
      <div className="room-org-links">
        <a className="btn" href={links.arcade} target="_blank" rel="noreferrer">
          Arcade <Icon name="ext" />
        </a>
        <a className="btn" href={links.live} target="_blank" rel="noreferrer">
          Big screen <Icon name="ext" />
        </a>
        {!r.ended && (
          <a className="btn" href={links.join} target="_blank" rel="noreferrer">
            Join page <Icon name="ext" />
          </a>
        )}
        {r.ended && (
          <a className="btn" href={links.survey} target="_blank" rel="noreferrer">
            Survey <Icon name="ext" />
          </a>
        )}
      </div>
      {error && <p className="err">{error}</p>}
      {rows.length > 0 && (
        <div className="tablewrap room-org-games">
          <table className="dt">
            <thead>
              <tr>
                <th>Game</th>
                <th>Version</th>
                <th className="num">Plays</th>
                {r.ended && <th className="num">Votes</th>}
                <th>Published</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.slug}>
                  <td>
                    {g.url ? (
                      <a href={g.url} target="_blank" rel="noreferrer">
                        <b>{g.title}</b>
                      </a>
                    ) : (
                      <b>{g.title}</b>
                    )}
                    {g.by && <span className="muted"> by {g.by}</span>}
                  </td>
                  <td>{g.version ? versionLabel(g.version) : '–'}</td>
                  <td className="num">{plays.has(g.slug) ? fmtNum(plays.get(g.slug).plays) : '–'}</td>
                  {r.ended && <td className="num">{fmtNum(plays.get(g.slug)?.votes ?? 0)}</td>}
                  <td className="muted">{g.published_at ? timeAgo(g.published_at) : 'Still being made'}</td>
                  <td className="num">
                    <button className="btn room-org-quiet" onClick={() => takeOut(g)} disabled={busy != null}>
                      {busy === `out:${g.slug}` ? 'Removing…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <SurveyEditor room={r} templates={templates} onTemplates={onTemplates} />
      {r.ended && <Snapshot code={r.code} />}
    </Widget>
  );
}

// The fields of a survey, a room's or a template's: its heading, its intro and its questions (as JSON, up to 10).
const formOf = (s) => ({ heading: s.heading ?? '', intro: s.intro ?? '', questions: JSON.stringify(s.questions ?? [], null, 2) });
function SurveyFields({ form, onChange, readOnly = false }) {
  const set = (k) => (e) => onChange({ ...form, [k]: e.target.value });
  return (
    <>
      <label>
        <span>Heading, on the survey and the big screen</span>
        <input className="input" maxLength={120} value={form.heading} onChange={set('heading')} readOnly={readOnly} placeholder="How was {room}?" />
      </label>
      <label>
        <span>Intro (optional)</span>
        <textarea className="input" rows={2} maxLength={400} value={form.intro} onChange={set('intro')} readOnly={readOnly} placeholder="Two questions, then grab a slice." />
      </label>
      <label>
        <span>Questions</span>
        <textarea className="board-editor room-org-questions" value={form.questions} spellCheck={false} onChange={set('questions')} readOnly={readOnly} />
      </label>
      <p className="muted room-org-hint">
        <code>{'{room}'}</code> in the heading or the intro is the room's title. Each question has an <code>id</code>, a <code>kind</code> (<code>scale</code> for 1 to 5, <code>choice</code> with <code>options</code>, or <code>text</code>) and its <code>text</code>; up to 10.
      </p>
    </>
  );
}

// The questions typed in, or null with a message when they aren't JSON.
function questionsOf(form, fail) {
  try {
    return JSON.parse(form.questions);
  } catch {
    fail("The questions aren't valid JSON: check the commas and quotes.");
    return null;
  }
}

// A room's survey: set by hand or from a template until its first answer (also after the end), and saved as a template
// for the next jam. Before the end only the filled-in survey can be read, so the room's title in it goes back to
// {room}; after it, the snapshot has the survey as it was set, and its answers.
function SurveyEditor({ room: r, templates, onTemplates }) {
  const [form, setForm] = useState(null);
  const [answered, setAnswered] = useState(0);
  const [state, setState] = useState(null);
  const [pick, setPick] = useState('default');
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const fail = (error) => setState({ error });
  const load = async () => {
    if (form) return;
    try {
      if (r.ended) {
        const snap = await send('GET', `/v1/rooms/${r.code}/snapshot`);
        setForm(formOf(snap.survey));
        setAnswered(snap.survey.answers?.length ?? 0);
      } else {
        const filled = await roomCall('GET', `${r.code}/survey`, { fresh: true });
        const unfill = (t) => (t == null ? '' : t.split(r.title).join('{room}'));
        setForm(formOf({ heading: unfill(filled.heading), intro: unfill(filled.intro), questions: filled.questions }));
      }
    } catch (err) {
      fail(sentence(err.message));
    }
  };
  const builtIn = templates.find((t) => t.builtin);
  const set = async (body, saved) => {
    setState({ busy: true });
    try {
      setForm(formOf(await send('PATCH', `/v1/rooms/${r.code}/survey`, body)));
      setState({ saved });
    } catch (err) {
      if (err.status === 409) setAnswered((n) => Math.max(n, 1));
      fail(err.message);
    }
  };
  const save = () => {
    const questions = questionsOf(form, fail);
    // The default questions stay the default (null), so a room keeps up with them.
    if (questions) set({ heading: form.heading, intro: form.intro, questions: builtIn && JSON.stringify(questions) === JSON.stringify(builtIn.questions) ? null : questions }, 'Saved');
  };
  const saveAs = async () => {
    const questions = questionsOf(form, fail);
    if (!questions) return;
    setState({ busy: true });
    try {
      const t = await send('PUT', `/v1/rooms/templates/${id || idOf(name)}`, { name, heading: form.heading, intro: form.intro, questions });
      setState({ saved: `Saved as the template "${t.name}"` });
      setName('');
      setId('');
      onTemplates();
    } catch (err) {
      fail(err.message);
    }
  };
  const locked = answered > 0;
  const heading = form ? (form.heading || 'How was {room}?').split('{room}').join(r.title) : null;
  return (
    <details className="room-org-details" onToggle={(e) => e.currentTarget.open && load()}>
      <summary>Survey{heading ? `: ${heading}` : ''}</summary>
      {!form && !state?.error && <div className="loading-bar" />}
      {form && (
        <div className="room-org-survey">
          <p className="muted">{r.ended ? 'People answer it from its QR code on the big screen and the top of the arcade.' : 'It opens when the jam ends: its QR code shows on the big screen with the awards, and at the top of the arcade.'}</p>
          {locked && (
            <p className="room-org-locked">
              {plural(answered, 'person has', 'people have')} answered, so the survey can't change now: their answers have to match its questions. Save it as a template to use it again.
            </p>
          )}
          <SurveyFields form={form} onChange={(f) => (setForm(f), setState(null))} readOnly={locked} />
          {!locked && (
            <div className="row">
              <button className="btn primary" onClick={save} disabled={state?.busy}>
                Save the survey
              </button>
            </div>
          )}
          <div className="room-org-tools">
            {!locked && templates.length > 0 && (
              <div className="room-org-tool">
                <span className="muted">Use a template</span>
                <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button className="btn" disabled={state?.busy} onClick={() => set({ template: pick }, `Now using "${templates.find((t) => t.id === pick)?.name}"`)}>
                  Use it
                </button>
              </div>
            )}
            <div className="room-org-tool">
              <span className="muted">Save as a template</span>
              <input className="input" placeholder="Name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
              <input className="input mono" placeholder={idOf(name) || 'id'} maxLength={32} value={id} onChange={(e) => setId(e.target.value.toLowerCase())} title="Its id: a-z, 0-9 and -. Saving under an id you have replaces that template." />
              <button className="btn" disabled={state?.busy || !name.trim() || !(id || idOf(name))} onClick={saveAs}>
                Save as a template
              </button>
            </div>
          </div>
        </div>
      )}
      {state?.saved && <p className="ok-t room-org-done">{state.saved}</p>}
      {state?.error && <p className="err">{state.error}</p>}
    </details>
  );
}

// The organiser's survey templates, beside the default (shown, never changed): edit, delete, or start a new one.
function Templates({ templates, onChange }) {
  const [open, setOpen] = useState(null); // a template's id, or 'new'
  const [from, setFrom] = useState(null); // what a new one starts from
  const [error, setError] = useState(null);
  const builtIn = templates.find((t) => t.builtin);
  const remove = async (t) => {
    if (!window.confirm(`Delete the survey template "${t.name}"? Rooms already using it keep their survey.`)) return;
    setError(null);
    try {
      await send('DELETE', `/v1/rooms/templates/${t.id}`);
      if (open === t.id) setOpen(null);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };
  const startNew = (base) => (setFrom({ ...base, id: '', name: base.builtin ? '' : `${base.name} (copy)` }), setOpen('new'));
  return (
    <Widget span={12} title="Survey templates" sub="A room's survey starts from one of these: pick it when you make the room, or later in its survey.">
      <div className="room-org-templates">
        {templates.map((t) => (
          <div key={t.id} className="room-org-template">
            <div className="room-org-template-head">
              <b>{t.name}</b>
              {t.builtin ? <Status kind="neutral">Built in</Status> : <code className="muted">{t.id}</code>}
              <span className="muted">
                {plural(t.questions.length, 'question')} · {t.heading}
              </span>
              <span className="spacer" />
              <button className="btn room-org-quiet" onClick={() => setOpen(open === t.id ? null : t.id)}>
                {open === t.id ? 'Close' : t.builtin ? 'View' : 'Edit'}
              </button>
              <button className="btn room-org-quiet" onClick={() => startNew(t)}>
                Copy
              </button>
              {!t.builtin && (
                <button className="btn room-org-quiet room-org-danger" onClick={() => remove(t)}>
                  Delete
                </button>
              )}
            </div>
            {open === t.id && <TemplateEditor key={t.updated_at ?? t.id} template={t} onSaved={() => (setOpen(null), onChange())} />}
          </div>
        ))}
        {open === 'new' ? (
          <div className="room-org-template">
            <div className="room-org-template-head">
              <b>New template</b>
              <span className="spacer" />
              <button className="btn room-org-quiet" onClick={() => setOpen(null)}>
                Cancel
              </button>
            </div>
            <TemplateEditor template={from ?? builtIn} isNew onSaved={() => (setOpen(null), onChange())} />
          </div>
        ) : (
          <div className="row room-org-new">
            <button className="btn" onClick={() => startNew(builtIn)}>
              New template
            </button>
          </div>
        )}
      </div>
      {error && <p className="err">{error}</p>}
    </Widget>
  );
}

// One template's fields. The default is read only; a new one also takes a name and an id.
function TemplateEditor({ template: t, isNew = false, onSaved }) {
  const [form, setForm] = useState(() => formOf(t));
  const [name, setName] = useState(isNew ? t.name ?? '' : t.name);
  const [id, setId] = useState('');
  const [state, setState] = useState(null);
  const readOnly = !!t.builtin && !isNew;
  const fail = (error) => setState({ error });
  const save = async () => {
    const questions = questionsOf(form, fail);
    if (!questions) return;
    setState({ busy: true });
    try {
      await send('PUT', `/v1/rooms/templates/${isNew ? id || idOf(name) : t.id}`, { name, heading: form.heading, intro: form.intro, questions });
      onSaved();
    } catch (err) {
      fail(err.message);
    }
  };
  return (
    <div className="room-org-survey">
      {readOnly ? (
        <p className="muted">The default can't change. Copy it to make your own.</p>
      ) : (
        <div className="room-org-tool">
          <label>
            <span>Name</span>
            <input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Meetup" />
          </label>
          {isNew && (
            <label>
              <span>Id</span>
              <input className="input mono" maxLength={32} value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder={idOf(name) || 'meetup'} />
            </label>
          )}
        </div>
      )}
      <SurveyFields form={form} onChange={(f) => (setForm(f), setState(null))} readOnly={readOnly} />
      {!readOnly && (
        <div className="row">
          <button className="btn primary" onClick={save} disabled={state?.busy || !name.trim() || (isNew && !(id || idOf(name)))}>
            {isNew ? 'Save the template' : 'Save changes'}
          </button>
        </div>
      )}
      {state?.error && <p className="err">{state.error}</p>}
    </div>
  );
}

// Past jams whose rooms are gone: only their snapshots are left, for a year.
function PastJams({ past, onChange }) {
  const [error, setError] = useState(null);
  const remove = async (s) => {
    if (!window.confirm(`Delete the snapshot of ${s.title} (${s.code})? Its numbers, awards and survey answers are deleted now. This can't be undone.`)) return;
    setError(null);
    try {
      await send('DELETE', `/v1/rooms/${s.code}`);
      onChange();
    } catch (err) {
      setError(sentence(err.message));
    }
  };
  return (
    <Widget span={12} title="Past jams" sub="A jam's room and games are deleted a day after it ends. Its snapshot stays a year: the games, what players did, the votes, the awards and the survey's answers.">
      {error && <p className="err">{error}</p>}
      <div className="room-org-past">
        {past.map((s) => (
          <div key={s.code} className="room-org-past-row">
            <div className="room-org-past-head">
              <b>{s.title}</b> <span className="room-org-code">{s.code}</span>
              <span className="muted">
                ended {when(s.ended_at)} · {plural(s.games, 'game')}
              </span>
              <button className="btn room-org-quiet" onClick={() => remove(s)}>
                Delete
              </button>
            </div>
            <Snapshot code={s.code} />
          </div>
        ))}
      </div>
    </Widget>
  );
}

// A jam's snapshot: download it, and read what people answered in its survey.
function Snapshot({ code }) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState(null);
  const download = async (format) => {
    setError(null);
    try {
      const res = await send('GET', `/v1/rooms/${code}/snapshot${format === 'csv' ? '?format=csv' : ''}`, undefined, { raw: true });
      const blob = format === 'csv' ? await res.blob() : new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jam-${code}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(sentence(err.message));
    }
  };
  const load = async () => {
    if (snap) return;
    try {
      setSnap(await send('GET', `/v1/rooms/${code}/snapshot`));
    } catch (err) {
      setError(sentence(err.message));
    }
  };
  return (
    <div className="room-org-snapshot">
      <div className="row">
        <span className="muted">Snapshot:</span>
        <button className="btn" onClick={() => download('csv')}>
          CSV, a row a game
        </button>
        <button className="btn" onClick={() => download('json')}>
          JSON, everything
        </button>
      </div>
      <details className="room-org-details" onToggle={(e) => e.currentTarget.open && load()}>
        <summary>Survey answers</summary>
        {snap ? <Answers survey={snap.survey} funnel={snap.funnel} /> : !error && <div className="loading-bar" />}
      </details>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

// What people answered: each question's answers counted (a scale's average too), and what they wrote.
function Answers({ survey, funnel }) {
  const answers = survey.answers ?? [];
  const emails = answers.map((a) => a.email).filter(Boolean);
  return (
    <div className="room-org-answers">
      <p className="muted">
        {answers.length ? `${plural(answers.length, 'person', 'people')} answered` : 'Nobody has answered yet'}
        {survey.closes_at ? ` · the survey ${Date.now() < survey.closes_at ? 'is open until' : 'closed'} ${when(survey.closes_at)}` : ''}
      </p>
      {funnel && (
        <p className="muted">
          Games: {funnel.joined} joined · {funnel.published} published · {funnel.sending} played · {funnel.improved} published a second version · {funnel.fixed} had fewer problems in it
        </p>
      )}
      {answers.length > 0 && (
        <div className="room-org-answer-grid">
          {survey.questions.map((q) => {
            const given = answers.map((a) => a.answers[q.id]).filter((v) => v != null && v !== '');
            if (q.kind === 'text')
              return (
                <div key={q.id} className="room-org-answer">
                  <h4>{q.text}</h4>
                  {given.length ? (
                    <ul className="room-org-quotes">
                      {given.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">No answers.</p>
                  )}
                </div>
              );
            const options = q.kind === 'scale' ? [5, 4, 3, 2, 1] : q.options;
            const avg = q.kind === 'scale' && given.length ? given.reduce((n, v) => n + v, 0) / given.length : null;
            return (
              <div key={q.id} className="room-org-answer">
                <h4>
                  {q.text}
                  {avg != null && <span className="muted"> · {avg.toFixed(1)} on average</span>}
                </h4>
                <BarList rows={options.map((o) => ({ label: String(o), value: given.filter((v) => v === o).length }))} max={Math.max(1, given.length)} />
              </div>
            );
          })}
        </div>
      )}
      {emails.length > 0 && <p className="muted">Said yes to being emailed about their answers: {emails.join(', ')}</p>}
    </div>
  );
}

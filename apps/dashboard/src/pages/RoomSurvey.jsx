// A jam room's survey, <base><CODE>/survey (SPEC §3j, docs/design/jam-rooms.md §7c): how the jam went, asked of everyone
// as it ends, makers and players alike, who scan it off the big screen right after the awards. One quick thing on a
// phone: the organiser's heading and intro ("{room}" already filled in by the server), then the questions (a 1 to 5
// scale, a choice, or a few words), filled in with this person's own answers if they gave some, else what the room
// suggests (the agent their game was published with), and a Send button that stays in reach with how many are done.
// Answering again replaces the answers, for the 7 days the survey is open.
import { useEffect, useState } from 'react';
import { roomCall, roomLinks, usePoll, RoomStage, RoomGone, RoomLoading, when } from '../room.jsx';

const SCALE = [1, 2, 3, 4, 5];

export function RoomSurvey({ code, base, voter, signInUrl }) {
  // Before the end it asks again every half minute, so the survey opens by itself when the organiser ends the jam.
  const q = usePoll(() => roomCall('GET', `${code}/survey`, { headers: voter() }), 30_000, [code]);
  const s = q.data;
  const [values, setValues] = useState(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const links = roomLinks(code, base);

  const heading = s?.heading || (s?.title ? `How was ${s.title}?` : 'How was the jam?');
  useEffect(() => {
    if (s) document.title = heading;
  }, [s, heading]);
  // The form starts from the person's own answers, else the suggestions; later polls leave what they've typed alone.
  useEffect(() => {
    if (!s?.open || values) return;
    const start = { ...(s.answers ?? {}) };
    for (const [id, v] of Object.entries(s.suggested ?? {})) if (start[id] == null && s.questions.some((x) => x.id === id)) start[id] = v;
    setValues(start);
  }, [s, values]);

  if (!s) return q.error ? <RoomGone code={code} error={q.error} /> : <RoomLoading />;

  const stage = (sub) => (
    <RoomStage kicker="Survey" title={heading} className="compact">
      {sub}
    </RoomStage>
  );
  const intro = s.intro ? <p className="room-about">{s.intro}</p> : null;

  if (!s.open) {
    const later = s.closes_at == null;
    return (
      <div className="room room-survey">
        {stage(<p className="room-about">{s.title}</p>)}
        <main className="room-main narrow">
          <div className="room-empty">
            <h2>{later ? 'The survey opens when the jam ends' : 'The survey has closed'}</h2>
            <p>{later ? 'Keep playing. This page opens the questions by itself once the organiser ends the jam.' : `It closed on ${when(s.closes_at)}. Thanks to everyone who answered.`}</p>
            {later && (
              <a className="room-btn ghost" href={links.arcade}>
                Back to the games
              </a>
            )}
          </div>
        </main>
      </div>
    );
  }

  const set = (id, v) => setValues((x) => ({ ...x, [id]: v }));
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const answers = Object.fromEntries(Object.entries(values ?? {}).filter(([, v]) => v != null && v !== ''));
      const done = await roomCall('PUT', `${code}/survey`, { headers: voter(), body: { answers } });
      q.set({ ...s, answers: done.answers });
      setSent(true);
    } catch (err) {
      setError(err);
      if (err.status === 409) q.reload();
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <div className="room room-survey">
        {stage(<p className="room-about">{s.title}</p>)}
        <main className="room-main narrow">
          <div className="room-thanks" role="status">
            <h2>Thanks!</h2>
            <p>Your answers are in. The organiser reads them to make the next jam better.</p>
            <p className="muted">You can change them until {when(s.closes_at)}.</p>
            <div className="room-row">
              <a className="room-btn play" href={links.arcade}>
                Back to the awards
              </a>
              <button type="button" className="room-btn ghost" onClick={() => setSent(false)}>
                Change my answers
              </button>
            </div>
          </div>
        </main>
      </div>
    );

  const total = s.questions.length;
  const done = s.questions.filter((x) => values?.[x.id] != null && values[x.id] !== '').length;
  return (
    <div className="room room-survey">
      {stage(
        <>
          {intro}
          <p className="room-quick">
            {total === 1 ? 'One quick question' : `${total} quick questions`} · about a minute · skip any you like
          </p>
        </>,
      )}
      <main className="room-main narrow">
        <form className="room-form" onSubmit={submit}>
          {s.answers && <p className="room-sub">You answered already. Change anything and send it again.</p>}
          {s.questions.map((x) => (
            <Question key={x.id} q={x} value={values?.[x.id]} onChange={(v) => set(x.id, v)} />
          ))}
          {error && (
            <p className="room-note" role="alert">
              {error.status === 401 ? (
                signInUrl ? (
                  <>
                    Sign in to answer, so your answers count once. <a href={signInUrl}>Sign in</a>
                  </>
                ) : (
                  'This browser could not be told apart from others: allow this site to keep data, then send again.'
                )
              ) : (
                error.message.charAt(0).toUpperCase() + error.message.slice(1)
              )}
            </p>
          )}
          <div className="room-form-foot">
            <span className="room-progress" aria-live="polite">
              <i style={{ '--done': total ? done / total : 0 }} aria-hidden="true" />
              {done} of {total} done
            </span>
            <button type="submit" className="room-btn play" disabled={busy || !values}>
              {busy ? 'Sending…' : s.answers ? 'Send my new answers' : 'Send my answers'}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

// One question: a 1 to 5 scale, a choice of a few answers, or a few words (at most 1,000 characters).
function Question({ q, value, onChange }) {
  const name = `q-${q.id}`;
  if (q.kind === 'text')
    return (
      <label className="room-q">
        <span className="room-q-text">{q.text}</span>
        <textarea className="room-text" rows={2} maxLength={1000} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  const options = q.kind === 'scale' ? SCALE : q.options;
  return (
    <fieldset className={`room-q ${q.kind}`}>
      <legend className="room-q-text">{q.text}</legend>
      <div className="room-choices">
        {options.map((o) => (
          <label key={o} className={`room-choice ${value === o ? 'on' : ''}`.trim()}>
            <input type="radio" name={name} value={o} checked={value === o} onChange={() => onChange(o)} />
            <span>{o}</span>
          </label>
        ))}
      </div>
      {q.kind === 'scale' && (
        <div className="room-scale-ends" aria-hidden="true">
          <span>Not great</span>
          <span>Loved it</span>
        </div>
      )}
    </fieldset>
  );
}

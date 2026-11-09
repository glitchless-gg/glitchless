// A jam room's pages (SPEC §3j, docs/design/jam-rooms.md §9), under the jam's base (/jam/, or the root of the jam's own
// host). They open without signing in, at
//   <base><CODE>          the arcade (here): every published game with a Play button, its QR code and a Vote button
//                         while the jam is on; the survey and the awards once it has ended. Phone first; a grid of large
//                         QR codes at projector width. It asks again every 20 seconds. A game linked from itch.io (an
//                         online room's) plays there: its Play button and QR code open its page in a new tab.
//   <base><CODE>/live     the big screen (RoomLive.jsx)
//   <base><CODE>/survey   the survey (RoomSurvey.jsx)
//   <base><CODE>/join     how a maker's agent joins (RoomJoin.jsx)
// JamApp (Jam.jsx) renders RoomRoute for these paths, and passes on what a host's shell gives it:
//   base           the jam's base, ending in /
//   voterHeaders   headers (or a function giving them) that say who votes and answers the survey. The open-source
//                  default is this browser's own random token; a host with accounts passes {} and uses its sign-in
//   signInUrl      where "Sign in to vote" goes when a vote or an answer comes back 401 (none: no such link)
//   joinPage       the join page's component ({ code, base, voter, signInUrl }), for a host with its own setup steps
import { lazy, Suspense, useEffect, useState } from 'react';
import { jamBase, roomPath, roomLinks, roomCall, browserVoterHeaders, usePoll, Qr, RoomStage, RoomGone, RoomLoading, JamState, Awards, versionLabel, plural } from '../room.jsx';
import { RoomLive } from './RoomLive.jsx';
import { RoomSurvey } from './RoomSurvey.jsx';

// The join page is for makers on their laptops; a phone opening the arcade doesn't load it (or the dashboard's parts it
// uses).
const RoomJoin = lazy(() => import('./RoomJoin.jsx').then((m) => ({ default: m.RoomJoin })));

export function RoomRoute({ path = window.location.pathname, base = jamBase(path), voterHeaders = browserVoterHeaders, signInUrl = null, joinPage: JoinPage = RoomJoin }) {
  const at = roomPath(path, base);
  // Room pages stay out of search engines, as the games do (X-Robots-Tag on the games' port).
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  if (!at || at.home) return <RoomGone code="" error={{ status: 404 }} />;
  const voter = typeof voterHeaders === 'function' ? voterHeaders : () => voterHeaders ?? {};
  const props = { code: at.code, base: at.base, voter, signInUrl };
  if (at.view === 'live') return <RoomLive {...props} />;
  if (at.view === 'survey') return <RoomSurvey {...props} />;
  if (at.view === 'join')
    return (
      <Suspense fallback={<RoomLoading />}>
        <JoinPage {...props} />
      </Suspense>
    );
  return <Arcade {...props} />;
}

function Arcade({ code, base, voter, signInUrl }) {
  const room = usePoll(({ fresh }) => roomCall('GET', code, { fresh }), 20_000, [code]);
  const r = room.data;
  const ended = !!r?.ended;
  // This person's vote and their own games (none on the open-source server). On Glitchless Cloud nobody is anyone
  // until they sign in: a 401 here means the Vote buttons offer that instead.
  const ballot = usePoll(() => roomCall('GET', `${code}/vote`, { headers: voter() }).catch((err) => (err.status === 401 ? { vote: null, own: [], signedOut: true } : Promise.reject(err))), 0, [code, r?.games.length, ended]);
  // After the end: the awards, from the big screen's answer.
  const live = usePoll(() => (ended ? roomCall('GET', `${code}/live`, { fresh: true }) : null), 0, [code, ended]);
  // And the survey: its heading, and whether this person answered already.
  const survey = usePoll(() => (ended ? roomCall('GET', `${code}/survey`, { headers: voter() }) : null), 0, [code, ended]);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  useEffect(() => {
    if (r?.title) document.title = `${r.title} · Jam room ${r.code}`;
  }, [r?.title, r?.code]);

  if (!r) return room.error ? <RoomGone code={code} error={room.error} /> : <RoomLoading />;
  const links = roomLinks(r.code, base);
  const mine = ballot.data?.vote ?? null;
  const own = new Set(ballot.data?.own ?? []);
  const signedOut = !!ballot.data?.signedOut;
  const voting = !ended && !!ballot.data;

  // One vote: voting for another game moves it, voting for the same one again takes it back.
  async function vote(slug) {
    const next = mine === slug ? null : slug;
    setBusy(slug);
    setNote(null);
    try {
      const done = await roomCall('PUT', `${code}/vote`, { headers: voter(), body: { slug: next } });
      ballot.set({ ...ballot.data, vote: done.vote });
    } catch (err) {
      if (err.status === 401) ballot.set({ ...ballot.data, signedOut: true });
      else setNote(err.message.charAt(0).toUpperCase() + err.message.slice(1));
      if (err.status === 409) room.reload();
    } finally {
      setBusy(null);
    }
  }

  const voteControl = (g) => {
    if (!voting) return null;
    if (own.has(g.slug)) return <span className="room-own">Your game</span>;
    if (signedOut)
      return signInUrl ? (
        <a className="room-btn vote" href={signInUrl}>
          Sign in to vote
        </a>
      ) : null;
    const on = mine === g.slug;
    return (
      <button type="button" className={`room-btn vote ${on ? 'on' : ''}`.trim()} aria-pressed={on} disabled={busy != null} onClick={() => vote(g.slug)} title={on ? 'Take your vote back' : mine ? 'Move your vote here' : undefined}>
        {on ? '★ Your vote' : 'Vote'}
      </button>
    );
  };

  return (
    <div className="room room-arcade">
      <RoomStage title={r.title}>
        {r.about && !ended && <p className="room-about">{r.about}</p>}
        <div className="room-status">
          <JamState room={r} />
          <span className="room-code-line">
            Room <b className="room-code">{r.code}</b>
          </span>
        </div>
      </RoomStage>
      <main className="room-main">
        {ended && (
          <>
            {survey.data?.open && <TellUs survey={survey.data} href={links.survey} />}
            {live.data?.awards && <Awards awards={live.data.awards} games={live.data.games} />}
          </>
        )}
        {!ended && r.games.length > 0 && (
          <p className="room-lede">
            {signedOut && !signInUrl
              ? 'Play the games: scan a code or tap Play.'
              : 'Play the games, then give your one vote to your favourite. You can move it until the jam ends.'}
          </p>
        )}
        {note && (
          <p className="room-note" role="alert">
            {note}
          </p>
        )}
        {ended && r.games.length > 0 && <h2 className="room-games-h">The games</h2>}
        {r.games.length > 0 && (
          <section className="room-games" aria-label="Games">
            {r.games.map((g, i) => (
              <GameCard key={g.slug} g={g} i={i} code={r.code} report={r.report} vote={voteControl(g)} fresh={g.new && !ended} />
            ))}
          </section>
        )}
        {!r.games.length && (
          <div className="room-empty">
            <h2>No games yet</h2>
            <p>{r.building ? `${plural(r.building, 'game is', 'games are')} being made right now. They show up here the moment they're published.` : ended ? 'Nobody published a game in this jam.' : 'Games show up here the moment their makers publish them.'}</p>
          </div>
        )}
        {r.games.length > 0 && r.building > 0 && !ended && <p className="room-more">{plural(r.building, 'more game is', 'more games are')} still being made.</p>}
        {!ended && (
          <aside className="room-makers">
            {r.joining ? (
              <>
                <p>
                  <b>Making a game?</b> Tell your agent to join room <span className="room-code">{r.code}</span>
                  {r.online ? ', then link each version of your game on itch.io.' : '.'}
                </p>
                <a className="room-btn ghost" href={links.join}>
                  How to join →
                </a>
              </>
            ) : (
              <p>This room has stopped taking new games. The games in it can still publish new versions.</p>
            )}
          </aside>
        )}
      </main>
      <footer className="room-foot">
        <a href={links.live}>Big screen</a>
        {!ended && <a href={links.join}>Join with your agent</a>}
        {ended && <a href={links.survey}>Survey</a>}
        <span className="muted">Glitchless Jam</span>
      </footer>
    </div>
  );
}

// Once the jam has ended, first thing on the arcade: the survey, in the organiser's words, one tap away.
function TellUs({ survey, href }) {
  const answered = !!survey.answers;
  return (
    <a className="room-tell" href={href}>
      <span className="room-tell-kicker">{answered ? 'Thanks for telling us' : 'Tell us how it went'}</span>
      <span className="room-tell-heading">{survey.heading}</span>
      {!answered && <span className="room-tell-intro">{survey.intro || 'It takes a minute.'}</span>}
      <span className="room-btn play">{answered ? 'Change my answers' : 'Answer now'}</span>
    </a>
  );
}

// One game on the arcade: its QR code (to show a friend), title, maker, version ("New" for a publish in the last 10
// minutes, while the jam is on), Play, the vote, and Report. A linked game (g.site, itch.io) plays on its page there,
// in a new tab, so the arcade stays open for the next game and the vote.
function GameCard({ g, i, code, report, vote, fresh }) {
  const subject = `Report: ${g.title} in jam room ${code}`;
  const body = `Game: ${g.url}\n\nWhat's wrong with it:\n`;
  const away = g.site ? { target: '_blank', rel: 'noopener' } : {};
  return (
    <article className="room-game" style={{ '--i': Math.min(i, 12) }}>
      <a className="room-game-qr" href={g.url} tabIndex={-1} aria-hidden="true" {...away}>
        <Qr text={g.url} label="" />
      </a>
      <div className="room-game-body">
        <div className="room-game-tags">
          {fresh && <span className="room-new">New</span>}
          <span className="room-version">{versionLabel(g.version)}</span>
        </div>
        <h2 className="room-game-title">{g.title}</h2>
        {g.by && <div className="room-by">by {g.by}</div>}
        <div className="room-game-actions">
          <a className="room-btn play" href={g.url} {...away}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M6 4l14 8-14 8z" fill="currentColor" />
            </svg>
            {g.site ? `Play on ${g.site}` : 'Play'}
          </a>
          {vote}
        </div>
        {report && (
          <a className="room-report" href={`mailto:${report}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>
            Report this game
          </a>
        )}
      </div>
    </article>
  );
}

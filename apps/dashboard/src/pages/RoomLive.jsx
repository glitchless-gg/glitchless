// A jam room's big screen, <base><CODE>/live (SPEC §3j, docs/design/jam-rooms.md §6): made for a projector across a room,
// and still fine on a phone. The room's QR code to the arcade, large, with its code in big letters; the room's totals;
// "Needs players" first (the fewest plays first, each with its QR code, so nobody's game sits unplayed) and the three
// most played. When the jam ends it turns into the awards and, the biggest thing after them, the survey's QR code with
// its heading, so everyone answers right there. It asks again every 15 seconds.
import { useEffect } from 'react';
import { fmtNum } from '../format.js';
import { roomCall, roomLinks, usePoll, Qr, RoomStage, RoomGone, RoomLoading, JamState, Awards, bare, isLocal, plural, versionLabel } from '../room.jsx';

// How many games "Needs players" shows with their codes; the rest are on the arcade.
const NEEDS_SHOWN = 8;

export function RoomLive({ code, base }) {
  const q = usePoll(() => roomCall('GET', `${code}/live`), 15_000, [code]);
  const d = q.data;
  const ended = !!d?.room?.ended;
  // Once it has ended: the survey's heading, as the organiser set it (they can still change it until the first answer).
  const survey = usePoll(() => (ended ? roomCall('GET', `${code}/survey`) : null), 60_000, [code, ended]);
  useEffect(() => {
    if (d?.room?.title) document.title = `${d.room.title} · Big screen`;
  }, [d?.room?.title]);
  if (!d) return q.error ? <RoomGone code={code} error={q.error} /> : <RoomLoading />;

  const room = d.room;
  const links = roomLinks(room.code, base);
  const bySlug = new Map(d.games.map((g) => [g.slug, g]));
  const needs = d.needs_players.map((s) => bySlug.get(s)).filter(Boolean);
  const top = d.most_played.map((s) => bySlug.get(s)).filter(Boolean);
  // Phones can't open localhost: say how to fix it, on the one screen the organiser is sure to look at.
  const local = isLocal(links.arcade) || d.games.some((g) => isLocal(g.url));
  const t = d.totals;
  const totals = ended
    ? [
        [t.games, 'games'],
        [t.plays, t.plays === 1 ? 'play' : 'plays'],
        [t.minutes_played, t.minutes_played === 1 ? 'minute played' : 'minutes played'],
        [t.phone_pct == null ? '–' : `${t.phone_pct}%`, 'of plays on phones'],
      ]
    : [
        [t.games, t.games === 1 ? 'game to play' : 'games to play'],
        [t.building, 'still being made'],
        [t.plays, t.plays === 1 ? 'play' : 'plays'],
        [t.playing_now, 'playing now', 'now'],
        [t.phone_pct == null ? '–' : `${t.phone_pct}%`, 'of plays on phones'],
      ];

  return (
    <div className="room room-live">
      <RoomStage
        className={ended ? 'room-live-stage ended' : 'room-live-stage'}
        kicker="Big screen"
        title={room.title}
        aside={
          // Once it has ended, the one code on the screen is the survey's, under the awards.
          ended ? null : (
            <div className="room-scan">
              <Qr text={links.arcade} label={`QR code for jam room ${room.code}`} className="xl" />
              <div className="room-scan-text">
                <div className="room-scan-label">Scan to play every game</div>
                <div className="room-code-xl" aria-label={`Room code ${room.code.split('').join(' ')}`}>
                  {room.code}
                </div>
                <div className="room-scan-url">{bare(links.arcade)}</div>
              </div>
            </div>
          )
        }
      >
        <div className="room-status">
          <JamState room={room} />
        </div>
        <dl className="room-totals">
          {totals.map(([value, label, kind]) => (
            <div key={label} className={kind ? `room-total ${kind}` : 'room-total'}>
              <dt>{label}</dt>
              <dd>{typeof value === 'number' ? fmtNum(value) : value}</dd>
            </div>
          ))}
        </dl>
      </RoomStage>

      <main className="room-main room-live-main">
        {local && (
          <p className="room-note">
            Phones can't open addresses on localhost. Start the server with GLITCHLESS_PUBLIC_URL set to this computer's address on the network (for example http://192.168.1.20:7777), then open this page at that address.
          </p>
        )}
        {ended ? (
          <>
            <div className="room-ended">
              {d.awards ? <Awards awards={d.awards} games={d.games} big /> : <div />}
              {survey.data?.open !== false && (
                <a className="room-survey-scan" href={links.survey}>
                  <div className="room-survey-scan-text">
                    <div className="room-survey-scan-kicker">Tell us how it went</div>
                    <h2>{survey.data?.heading || `How was ${room.title}?`}</h2>
                  </div>
                  <Qr text={links.survey} label={`QR code for the survey of jam room ${room.code}`} className="xxl" />
                  <div className="room-survey-scan-text">
                    <p>Scan and tell us, it takes a minute.</p>
                    <div className="room-scan-url">{bare(links.survey)}</div>
                  </div>
                </a>
              )}
            </div>
            {d.games.length > 0 && <FinalNumbers games={d.games} />}
          </>
        ) : !d.games.length ? (
          <div className="room-empty big">
            <h2>No games yet</h2>
            <p>{t.building ? `${plural(t.building, 'game is', 'games are')} being made. They show up here when they're published.` : `Makers: tell your agent to join room ${room.code}.`}</p>
          </div>
        ) : (
          <div className="room-live-cols">
            <section className="room-needs" aria-labelledby="room-needs-h">
              <h2 id="room-needs-h">Needs players</h2>
              <p className="room-sub">The fewest plays first. Scan one and play it.</p>
              <div className="room-need-grid">
                {needs.slice(0, NEEDS_SHOWN).map((g) => (
                  <a key={g.slug} className="room-need" href={g.url}>
                    <Qr text={g.url} label={`QR code for ${g.title}`} />
                    <div className="room-need-title">{g.title}</div>
                    <div className="room-need-plays">
                      <b>{fmtNum(g.plays)}</b> {g.plays === 1 ? 'play' : 'plays'}
                      {g.new && <span className="room-new">New</span>}
                    </div>
                  </a>
                ))}
              </div>
              {needs.length > NEEDS_SHOWN && <p className="room-sub">And {plural(needs.length - NEEDS_SHOWN, 'more game')} on the arcade.</p>}
            </section>
            <section className="room-top" aria-labelledby="room-top-h">
              <h2 id="room-top-h">Most played</h2>
              {top.length ? (
                <ol className="room-podium">
                  {top.map((g, i) => (
                    <li key={g.slug}>
                      <span className="room-rank">{i + 1}</span>
                      <div className="room-podium-text">
                        <div className="room-podium-title">{g.title}</div>
                        <div className="room-sub">
                          {plural(g.plays, 'play')}
                          {g.minutes_played > 0 ? ` · ${plural(g.minutes_played, 'minute')} played` : ''}
                          {g.by ? ` · by ${g.by}` : ''}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="room-sub">No plays yet. The first game played goes straight to the top.</p>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

// After the end: every game's final plays and votes, the most played first.
function FinalNumbers({ games }) {
  const rows = [...games].sort((a, b) => b.plays - a.plays || (b.votes ?? 0) - (a.votes ?? 0));
  return (
    <section className="room-final" aria-labelledby="room-final-h">
      <h2 id="room-final-h">Every game</h2>
      <div className="tablewrap">
        <table className="dt">
          <thead>
            <tr>
              <th>Game</th>
              <th className="num">Plays</th>
              <th className="num">Minutes played</th>
              <th className="num">Votes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.slug}>
                <td>
                  <b>{g.title}</b>
                  <span className="muted">
                    {g.by ? ` by ${g.by}` : ''} · {versionLabel(g.version)}
                  </span>
                </td>
                <td className="num">{fmtNum(g.plays)}</td>
                <td className="num">{fmtNum(g.minutes_played)}</td>
                <td className="num">{fmtNum(g.votes ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

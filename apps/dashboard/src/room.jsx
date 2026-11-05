// What the jam's pages share (SPEC §3j, docs/design/jam-rooms.md): their addresses under the jam's base, the room API's
// calls, this browser's voter token, QR codes drawn here with the server's own encoder (qr.js, so the arcade makes no
// request per code), times in plain words, the navy stage at the top of every jam page, and the awards. Jam.jsx,
// Room.jsx and the pages beside them use these, and so can a host's own join page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from './api.js';
import { fmtNum } from './format.js';
import { qrSvg } from '../../../server/src/qr.js';
import mark from '../../../assets/brand/glitchless/logo/glitchless-mark-dark.svg';
import glitchyWin from './images/glitchy-win.png';

export const ROOM_VIEWS = ['arcade', 'live', 'survey', 'join'];

// Where the jam's pages are: /jam/ on a server that serves them beside the dashboard, else the root of a host of their
// own (jam.glitchless.gg).
export function jamBase(pathname = window.location.pathname) {
  return pathname === '/jam' || pathname.startsWith('/jam/') ? '/jam/' : '/';
}

// What a path is under the jam's base: the organiser's home (the base itself), or a room's page, <base><CODE> (the
// arcade), <base><CODE>/live, /survey or /join. null for a path outside the base.
export function roomPath(pathname = window.location.pathname, base = jamBase(pathname)) {
  const b = base.endsWith('/') ? base : `${base}/`;
  if (pathname === b || `${pathname}/` === b) return { base: b, home: true };
  if (!pathname.startsWith(b)) return null;
  const [code, view] = pathname.slice(b.length).split('/');
  return { base: b, code: code.toUpperCase(), view: ROOM_VIEWS.includes(view) ? view : 'arcade' };
}

// A room's pages at the address this page was opened at (the server's own links name its configured address, which
// can be localhost when someone opened it by the machine's address on the network).
export function roomLinks(code, base = '/') {
  const arcade = `${window.location.origin}${base}${code}`;
  return { arcade, live: `${arcade}/live`, survey: `${arcade}/survey`, join: `${arcade}/join` };
}

// An address as people read it off a screen: no http://, no trailing slash.
export const bare = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');

// Phones can't open these, so a room served from one needs GLITCHLESS_PUBLIC_URL.
export const isLocal = (url) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/.test(String(url));

export class RoomCallError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// One call to /v1/rooms/<path>: JSON in and out. Throws RoomCallError with the server's own words. The public reads
// are cached for 15 seconds; `fresh` asks past the browser's copy (after a change, or for the organiser).
export async function roomCall(method, path, { headers = {}, body, fresh = false } = {}) {
  const res = await fetch(`${API_BASE}/v1/rooms/${path}`, {
    method,
    cache: fresh ? 'no-cache' : 'default',
    headers: { 'x-glitchless-client': 'dashboard', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new RoomCallError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

// The open-source server has no accounts: a browser votes and answers the survey with a random token of its own, kept
// in localStorage (or for this visit only, when the browser keeps nothing).
const VOTER_KEY = 'glitchless.voter';
let visitVoter = null;
function newVoter() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function browserVoter() {
  try {
    let token = localStorage.getItem(VOTER_KEY);
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(token || '')) {
      token = newVoter();
      localStorage.setItem(VOTER_KEY, token);
    }
    return token;
  } catch {
    return (visitVoter ??= newVoter());
  }
}
export const browserVoterHeaders = () => ({ 'x-glitchless-voter': browserVoter() });

// Loads now and every `ms` (0: once), skipping while the page is hidden and catching up when it shows again. Keeps
// the last answer while it asks again, so nothing flashes. load({ fresh }) is told when the answer must be current:
// `reload` (after a change) asks past the browser's cache. `set` puts an answer in at once (a vote just made).
export function usePoll(load, ms, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback((fresh = false) => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve({ fresh: fresh === true })
      .then(load)
      .then((data) => id === seq.current && setState({ data, error: null, loading: false }))
      .catch((error) => id === seq.current && setState((s) => ({ ...s, error, loading: false })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    run();
    if (!ms) return undefined;
    const tick = () => !document.hidden && run();
    const t = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [run, ms]);
  const set = useCallback((data) => {
    seq.current++;
    setState({ data, error: null, loading: false });
  }, []);
  const reload = useCallback(() => run(true), [run]);
  return { ...state, reload, set };
}

// A QR code on white with its quiet zone (four modules), drawn here: it scans from a phone in either theme.
export function Qr({ text, label, className = '' }) {
  const src = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(text))}`, [text]);
  return <img className={`room-qr ${className}`.trim()} src={src} alt={label} draggable={false} />;
}

// Times as people say them: "3:30 PM" today, "Thu, Nov 6, 3:30 PM" on another day.
export function when(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

export const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

// "v1.0.1" for a number, the version as it is otherwise.
export const versionLabel = (v) => (v == null ? '' : /^\d/.test(v) ? `v${v}` : v);

// Whether the jam is on, in a pill: "Jam on until 3:30 PM" or "The jam has ended".
export function JamState({ room }) {
  if (!room) return null;
  return room.ended ? (
    <span className="room-pill ended">The jam has ended</span>
  ) : (
    <span className="room-pill on">
      <i aria-hidden="true" /> Jam on until {when(room.closes_at)}
    </span>
  );
}

// A frame-time strip along the stage's foot, as on Glitchless's emails: short mint bars, one coral stutter, then smooth.
const STRIP = Array.from({ length: 72 }, (_, i) => (i === 11 ? 30 : i === 10 || i === 12 ? 15 : 5 + ((i * 7) % 5)));
export function FrameStrip() {
  return (
    <svg className="room-strip" viewBox={`0 0 ${STRIP.length * 6} 32`} preserveAspectRatio="none" aria-hidden="true">
      {STRIP.map((h, i) => (
        <rect key={i} x={i * 6 + 1} y={32 - h} width="4" height={h} rx="1" className={h > 12 ? 'spike' : undefined} />
      ))}
    </svg>
  );
}

// The navy band at the top of every jam page: Glitchless Jam, a kicker (which page this is), the title, and whatever
// the page adds under it.
export function RoomStage({ kicker = 'Arcade', title, aside, children, className = '' }) {
  return (
    <header className={`room-stage ${className}`.trim()}>
      <div className="room-stage-in">
        <div className="room-stage-text">
          <div className="room-brand">
            <img src={mark} alt="" />
            <span className="room-brand-name">
              Glitchless <b>Jam</b>
            </span>
            <span className="room-kicker">{kicker}</span>
          </div>
          {title && <h1 className="room-title">{title}</h1>}
          {children}
        </div>
        {aside}
      </div>
      <FrameStrip />
    </header>
  );
}

// The page for a room that isn't there (a wrong code, or a day past its end), or that couldn't be reached.
export function RoomGone({ code, error }) {
  const missing = error?.status === 404;
  return (
    <div className="room">
      <RoomStage title={missing ? `No jam room ${code}` : "Can't reach this jam room"} />
      <main className="room-main">
        <div className="room-empty">
          {missing ? (
            <p>Check the code on the big screen. A room is also taken down a day after its jam ends.</p>
          ) : (
            <p>
              {error?.message ? `The server said: ${error.message}. ` : ''}It will try again in a moment.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

export function RoomLoading() {
  return (
    <div className="room">
      <RoomStage />
      <div className="loading-bar" />
    </div>
  );
}

// The awards (§7): each one's title, the games that won it, and what they did in plain words; or why nobody won it.
export function Awards({ awards, games, big = false }) {
  const title = (slug) => games.find((g) => g.slug === slug)?.title ?? slug;
  // The text names the winners first ("Neon Dash: 9 votes"); under their names in big letters, the rest says enough.
  const rest = (a) => {
    const names = `${a.games.map(title).join(' and ')}: `;
    const s = a.games.length && a.text.startsWith(names) ? a.text.slice(names.length) : a.text;
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  return (
    <section className={`room-awards ${big ? 'big' : ''}`.trim()} aria-labelledby="room-awards-h">
      <div className="room-awards-head">
        <img src={glitchyWin} alt="" />
        <h2 id="room-awards-h">The awards</h2>
      </div>
      <div className="room-award-grid">
        {awards.map((a) => (
          <article key={a.id} className={`room-award ${a.games.length ? 'won' : 'none'}`}>
            <div className="room-award-name">{a.title}</div>
            {a.games.length ? <div className="room-award-games">{a.games.map(title).join(' and ')}</div> : <div className="room-award-games none">Not given</div>}
            <p className="room-award-text">{rest(a)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

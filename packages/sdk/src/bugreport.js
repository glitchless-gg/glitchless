// Player bug reports (SPEC §2 bug_report): a note the player types, what was on screen, where they were and what the
// game was doing just before. glitchless.reportBug({ note }) sends one from the game's own UI; with `bugReports` in
// init options a hotkey (F8 by default) and a button in the overlay open a small form for it. While the form is
// open, the game gets no keys, clicks or mouse movement.

import { anonymizeDevice } from './device.js';
import { LOGO_DATA_URI } from './logo.js';

export const MAX_SCREENSHOT = 200_000; // characters of data URL the server keeps (larger ones lose the picture)
const RECENT = 20;
const FRAMES = 6;
// Tried in order until the JPEG fits: width in pixels, quality.
const SIZES = [
  [960, 0.7],
  [800, 0.6],
  [640, 0.6],
  [480, 0.5],
  [320, 0.5],
];

// What the player is looking at and doing right now. `screenshot`: true captures the game's canvas, a data URL is
// used as it is, false leaves it out.
export async function snapshot(gd, { screenshot = true } = {}) {
  const at = { ts: Date.now(), level: gd.level, position: gd.positionsOn && gd.position ? gd.position.map((v) => round(v, 2)) : null };
  let shot = null;
  try {
    shot = typeof screenshot === 'string' ? screenshot : screenshot ? await gd.render?.screenshot?.({ maxWidth: SIZES[0][0] }) : null;
    // Taking the picture is not the game stuttering: the frame it lands in isn't timed.
    if (screenshot === true) gd.skipFrame?.();
    shot = await fitScreenshot(shot);
  } catch (err) {
    gd.log('bug report screenshot failed', err);
    shot = null;
  }
  return { ...at, screenshot: shot, recent: recentEvents(gd, at.ts), frames: recentFrames(gd) };
}

// Sends one report on its own request. Resolves { sent: true } once the intake took it, or { sent: false, reason }.
// Reports go out from every session, sampled or not; a failed send is queued and tried again with the next batch.
export async function sendReport(gd, snap, note = '') {
  const e = {
    type: 'bug_report',
    ts: snap.ts,
    level: snap.level,
    note: String(note ?? '').slice(0, 2000),
    ...(snap.screenshot ? { screenshot: snap.screenshot } : {}),
    ...(snap.position ? { x: snap.position[0], y: snap.position[1], z: snap.position[2] } : {}),
    recent: snap.recent,
    frames: snap.frames,
    device: gd.privacy === 'full' ? gd.device() : anonymizeDevice(gd.device()),
  };
  gd.history.push({ ts: e.ts, level: e.level, type: 'bug_report', note: e.note });
  if (gd.history.length > 300) gd.history.shift();
  gd.remember('bug_report');
  gd.overlay?.onEvent?.(e);
  if (!gd.opts.intake) return { sent: false, reason: 'offline' };
  gd.flush(); // the session's own events first, so the report's session is there when someone opens it
  return (await gd.send([e], false)) ? { sent: true } : { sent: false, reason: 'error' };
}

// The last game events, oldest first: what the SDK keeps for agents (levels, deaths, errors, custom events) and
// the latest hitches.
function recentEvents(gd, now) {
  const hitches = gd.recentHitches.filter((h) => now - h.ts < 60_000).map((h) => ({ ts: h.ts, type: 'hitch', level: h.level, duration_ms: h.duration_ms, causes: h.causes }));
  return [...gd.history.filter((e) => e.type !== 'bug_report').map(slimEvent), ...hitches]
    .sort((a, b) => a.ts - b.ts)
    .slice(-RECENT);
}

function slimEvent(e) {
  const out = { ts: e.ts, type: e.type, level: e.level ?? null };
  for (const k of ['name', 'cause', 'kind', 'reason', 'duration_s', 'score']) if (e[k] != null) out[k] = e[k];
  if (e.message) out.message = String(e.message).slice(0, 200);
  for (const k of ['x', 'y', 'z']) if (typeof e[k] === 'number') out[k] = e[k];
  if (e.attrs && JSON.stringify(e.attrs).length <= 300) out.attrs = e.attrs;
  return out;
}

// Frame rate and p95 frame time of the last windows, and of the one still open.
function recentFrames(gd) {
  const frames = gd.recentWindows.slice(-FRAMES);
  const w = gd.win;
  if (w.frames > 0) {
    const s = (Date.now() - w.startedAt) / 1000;
    frames.push({ ts: w.startedAt, level: gd.level, fps: round(w.frames / Math.max(s, 0.001), 1), p95: round(w.sketch.quantile(0.95), 2) });
  }
  return frames.slice(-FRAMES);
}

// A JPEG data URL of at most `max` characters: the screenshot as it is when it fits, else re-encoded smaller.
export async function fitScreenshot(dataUrl, max = MAX_SCREENSHOT) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  if (dataUrl.length <= max && dataUrl.startsWith('data:image/jpeg')) return dataUrl;
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  for (const [width, quality] of SIZES) {
    const scale = Math.min(1, width / img.width);
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', quality);
    if (out.length <= max) return out;
  }
  return null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('screenshot could not be decoded'));
    img.src = src;
  });
}

// ───────────────────────────── the form ─────────────────────────────

// Input the game must not see while the form is open. Key releases still reach it, so a key held when the form
// opened is not stuck down when it closes.
const HELD_BACK = ['keydown', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend'];

// What one input event does: 'open' the form, 'send' or 'cancel' it, 'block' it from the game, or 'pass' it on.
// `inForm`: the event happened inside the form; `button`: 'send' or 'cancel' when it was one of its buttons.
export function route(e, { open, hotkey, inForm = false, button = null }) {
  const key = e.type === 'keydown';
  if (key && hotkey && !e.repeat && (e.code === hotkey || e.key === hotkey)) return open ? 'cancel' : 'open';
  if (!open) return 'pass';
  if (key && e.key === 'Escape') return 'cancel';
  if (key && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return 'send';
  if (e.type === 'click' && inForm && button) return button;
  return 'block';
}

const CSS = `
:host { all: initial; }
.back { position: fixed; inset: 0; z-index: 2147483600; display: grid; place-items: center; background: rgba(8, 12, 24, .55); font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; color: #eef3fb; }
.panel { width: min(380px, calc(100vw - 32px)); background: #14213d; border: 1px solid rgba(46, 230, 166, .35); border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,.5); padding: 14px; box-sizing: border-box; }
.hdr { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.hdr img { width: 22px; height: auto; }
.hdr b { font-size: 14px; }
.shot { width: 100%; aspect-ratio: 16 / 9; border-radius: 6px; background: #0e182e; display: grid; place-items: center; overflow: hidden; color: #8fa1c4; font-size: 11.5px; margin-bottom: 10px; }
.shot img { width: 100%; height: 100%; object-fit: contain; display: block; }
textarea { width: 100%; box-sizing: border-box; min-height: 92px; resize: vertical; background: #0e182e; color: #eef3fb; border: 1px solid #2a3c63; border-radius: 6px; padding: 8px 10px; font: inherit; outline: none; }
textarea:focus { border-color: #2ee6a6; }
.row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.hint { font-size: 11px; color: #8fa1c4; margin-right: auto; }
button { font: 600 12.5px/1 inherit; font-family: inherit; border-radius: 6px; padding: 8px 14px; cursor: pointer; border: 1px solid #2a3c63; background: transparent; color: #eef3fb; }
button.send { background: #2ee6a6; border-color: #2ee6a6; color: #14213d; }
button:disabled { opacity: .5; cursor: default; }
.note { font-size: 11px; color: #8fa1c4; margin-top: 8px; }
.done { padding: 22px 6px; text-align: center; font-weight: 600; }
`;

export class BugReportForm {
  // hotkey: a KeyboardEvent code or key ('F8'), or null for none. onOpen / onClose: the game pauses and resumes.
  constructor(gd, { hotkey = 'F8', screenshot = true, onOpen = null, onClose = null } = {}) {
    this.gd = gd;
    this.opts = { hotkey, screenshot, onOpen, onClose };
    this.isOpen = false;
    this.host = null;
    // On window, in the capture phase, so it runs before the game's own listeners can see the event.
    for (const type of HELD_BACK) window.addEventListener(type, (e) => this.onInput(e), { capture: true, passive: false });
  }

  onInput(e) {
    const path = this.isOpen && e.composedPath ? e.composedPath() : [];
    const inForm = path.includes(this.host);
    const button = path.includes(this.sendBtn) ? 'send' : path.includes(this.cancelBtn) ? 'cancel' : null;
    const what = route(e, { open: this.isOpen, hotkey: this.opts.hotkey, inForm, button });
    if (what === 'pass') return;
    e.stopImmediatePropagation();
    if (what === 'block') {
      // Typing and clicking inside the form still work (those are the browser's defaults); outside it, nothing.
      if (!inForm && e.cancelable && e.type !== 'pointermove' && e.type !== 'mousemove') e.preventDefault();
      return;
    }
    e.preventDefault();
    if (what === 'open') this.open();
    else if (what === 'cancel') this.close();
    else if (what === 'send' && this.sendBtn && !this.sendBtn.disabled) this.send();
  }

  async open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.mount();
    document.exitPointerLock?.();
    this.render('form');
    try {
      this.opts.onOpen?.();
    } catch (err) {
      this.gd.log('bugReports.onOpen threw', err);
    }
    const snap = (this.snap = snapshot(this.gd, { screenshot: this.opts.screenshot }));
    const s = await snap;
    if (this.snap !== snap || !this.isOpen) return;
    this.shotEl.textContent = s.screenshot ? '' : this.opts.screenshot ? 'No screenshot: this game has no engine adapter that can take one.' : 'Screenshots are off for this game.';
    if (s.screenshot) {
      const img = document.createElement('img');
      img.src = s.screenshot;
      img.alt = 'Screenshot that will be sent';
      this.shotEl.append(img);
    }
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.snap = null;
    this.host?.remove();
    try {
      this.opts.onClose?.();
    } catch (err) {
      this.gd.log('bugReports.onClose threw', err);
    }
  }

  async send() {
    const snap = this.snap;
    if (!snap) return;
    this.sendBtn.disabled = true;
    this.sendBtn.textContent = 'Sending…';
    const result = await sendReport(this.gd, await snap, this.textarea.value);
    if (this.snap !== snap) return;
    this.render(result.sent ? 'sent' : result.reason === 'offline' ? 'offline' : 'failed');
    setTimeout(() => this.snap === snap && this.close(), result.sent ? 1200 : 2500);
  }

  mount() {
    if (!this.host) {
      this.host = document.createElement('div');
      this.host.id = 'glitchless-bug-report';
      this.root = this.host.attachShadow({ mode: 'open' });
    }
    document.body.appendChild(this.host);
  }

  render(state) {
    const done = { sent: 'Thanks! Your report was sent.', offline: 'Not sent: this build has no Glitchless intake.', failed: "Couldn't send it now. It will be sent with the game's next batch." }[state];
    this.root.innerHTML = `<style>${CSS}</style>
      <div class="back"><div class="panel" role="dialog" aria-modal="true" aria-label="Report a bug">
        <div class="hdr"><img src="${LOGO_DATA_URI}" alt=""><b>Report a bug</b></div>
        ${
          done
            ? `<div class="done">${done}</div>`
            : `<div class="shot">Taking a screenshot…</div>
        <textarea maxlength="2000" placeholder="What went wrong? What did you expect?" aria-label="What went wrong"></textarea>
        <div class="row"><span class="hint">Ctrl+Enter sends · Esc cancels</span><button class="cancel" type="button">Cancel</button><button class="send" type="button">Send</button></div>
        <div class="note">Sends your note, the screenshot and where you are in the game to its developers.</div>`
        }
      </div></div>`;
    this.shotEl = this.root.querySelector('.shot');
    this.textarea = this.root.querySelector('textarea');
    this.sendBtn = this.root.querySelector('button.send');
    this.cancelBtn = this.root.querySelector('button.cancel');
    this.textarea?.focus();
  }
}

function round(v, d) {
  if (v == null || Number.isNaN(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

// In-game HUD. Works fully offline — the "no cloud needed" mode of Glitchless.
// Toggle with the backtick (`) key. Rendered in a shadow root so game CSS can't touch it.

import { LOGO_DATA_URI } from './logo.js';

const CSS = `
:host { all: initial; }
.gd { position: fixed; right: 12px; bottom: 12px; z-index: 2147483000; font: 500 11px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; color: #eef3fb; user-select: none; }
.panel { width: 268px; background: rgba(20, 33, 61, 0.94); border: 1px solid rgba(46, 230, 166, 0.3); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.45); backdrop-filter: blur(6px); overflow: hidden; }
.hdr { display: flex; align-items: center; gap: 7px; padding: 7px 9px; background: linear-gradient(90deg, #1d2e52, #14213d); cursor: pointer; }
.hdr img { width: 22px; height: auto; }
.hdr .t { font-weight: 700; font-size: 12px; letter-spacing: .2px; }
.hdr .svc { opacity: .8; font-size: 10.5px; margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #8a8a9a; flex: none; }
.dot.ok { background: #2ee6a6; box-shadow: 0 0 6px #2ee6a6; } .dot.error { background: #ff6b57; } .dot.offline { background: #f0b429; }
.big { display: grid; grid-template-columns: repeat(3, 1fr); padding: 8px 10px 4px; }
.big .v { font: 700 18px/1.1 ui-monospace, "SF Mono", Menlo, monospace; }
.big .l { font-size: 9.5px; text-transform: uppercase; letter-spacing: .6px; opacity: .6; }
canvas { display: block; width: 248px; height: 46px; margin: 4px 10px 6px; border-radius: 4px; background: rgba(255,255,255,.04); }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 6px; padding: 2px 10px 8px; }
.grid .l { font-size: 9.5px; opacity: .55; text-transform: uppercase; letter-spacing: .4px; }
.grid .v { font: 600 12px ui-monospace, "SF Mono", Menlo, monospace; }
.ctx { padding: 0 10px 6px; font: 500 10.5px ui-monospace, Menlo, monospace; opacity: .85; }
.ctx span { display: inline-block; margin-right: 8px; }
.ftr { display: flex; justify-content: space-between; gap: 6px; padding: 6px 10px; border-top: 1px solid rgba(255,255,255,.08); font-size: 10px; opacity: .75; }
.bug { display: block; width: calc(100% - 20px); margin: 0 10px 8px; padding: 6px 0; border: 1px solid rgba(46,230,166,.35); border-radius: 6px; background: rgba(46,230,166,.08); color: #eef3fb; font: 600 11px/1.2 inherit; font-family: inherit; cursor: pointer; }
.bug:hover { background: rgba(46,230,166,.18); }
.good { color: #2ee6a6; } .warn { color: #f0b429; } .bad { color: #ff6b57; }
.pill { display: none; align-items: center; gap: 6px; padding: 5px 9px 5px 6px; background: rgba(20,33,61,.92); border: 1px solid rgba(46,230,166,.35); border-radius: 999px; cursor: pointer; font: 700 11px ui-monospace, Menlo, monospace; }
.pill img { width: 20px; height: auto; }
.collapsed .panel { display: none; } .collapsed .pill { display: inline-flex; }
.flash { animation: flash .6s ease-out; } @keyframes flash { from { background: rgba(255,107,87,.35); } to { background: transparent; } }
`;

export class Overlay {
  constructor(gd) {
    this.gd = gd;
    this.host = document.createElement('div');
    this.host.id = 'glitchless-overlay';
    const root = this.host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="gd">
        <div class="panel">
          <div class="hdr" title="Click or press \` to collapse"><img src="${LOGO_DATA_URI}" alt=""><span class="t">Glitchless</span><span class="svc"></span><span class="dot"></span></div>
          <div class="big">
            <div><div class="v" data-k="fps">–</div><div class="l">fps</div></div>
            <div><div class="v" data-k="p95">–</div><div class="l">p95 frame</div></div>
            <div><div class="v" data-k="max">–</div><div class="l">worst</div></div>
          </div>
          <canvas width="496" height="92"></canvas>
          <div class="grid">
            <div><div class="l">draw calls</div><div class="v" data-k="calls">–</div></div>
            <div><div class="l">triangles</div><div class="v" data-k="tris">–</div></div>
            <div><div class="l">heap</div><div class="v" data-k="heap">–</div></div>
            <div><div class="l">geometries</div><div class="v" data-k="geo">–</div></div>
            <div><div class="l">textures</div><div class="v" data-k="tex">–</div></div>
            <div><div class="l">shaders</div><div class="v" data-k="prog">–</div></div>
            <div><div class="l">hitches</div><div class="v" data-k="hitches">0</div></div>
            <div><div class="l">errors</div><div class="v" data-k="errors">0</div></div>
            <div><div class="l">level</div><div class="v" data-k="level">–</div></div>
          </div>
          <div class="ctx"></div>
          ${gd.opts.bugReports ? `<button class="bug" type="button">Report a bug${bugHotkey(gd) ? ` (${escapeHtml(bugHotkey(gd))})` : ''}</button>` : ''}
          <div class="ftr"><span data-k="dest"></span><span data-k="mcp"></span></div>
        </div>
        <div class="pill" title="Glitchless — press \` to expand"><img src="${LOGO_DATA_URI}" alt=""><span data-k="pill">–</span></div>
      </div>`;
    this.root = root;
    this.el = root.querySelector('.gd');
    this.canvas = root.querySelector('canvas');
    this.ctx2d = this.canvas.getContext('2d');
    this.fields = Object.fromEntries([...root.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));
    root.querySelector('.svc').textContent = `${gd.opts.service} ${gd.opts.version}`;
    root.querySelector('.hdr').addEventListener('click', () => this.toggle());
    root.querySelector('.pill').addEventListener('click', () => this.toggle());
    root.querySelector('.bug')?.addEventListener('click', () => gd.openBugReport());
    window.addEventListener('keydown', (e) => {
      if (e.key === '`' || e.code === 'Backquote') this.toggle();
    });
    let collapsed = false;
    try {
      collapsed = localStorage.getItem('glitchless.overlay') === 'collapsed';
    } catch {}
    if (collapsed) this.el.classList.add('collapsed');
    const mount = () => document.body.appendChild(this.host);
    document.body ? mount() : addEventListener('DOMContentLoaded', mount);
    this.lastErrors = 0;
    setInterval(() => this.update(), 250);
    setInterval(() => this.draw(), 66);
  }

  toggle() {
    this.el.classList.toggle('collapsed');
    try {
      localStorage.setItem('glitchless.overlay', this.el.classList.contains('collapsed') ? 'collapsed' : 'open');
    } catch {}
  }

  set(k, text, cls) {
    const n = this.fields[k];
    if (!n) return;
    if (n.textContent !== text) n.textContent = text;
    if (cls !== undefined) n.className = `v ${cls}`;
  }

  update() {
    const gd = this.gd;
    const s = gd.liveStats();
    if (!s) return;
    const b = s.budget;
    const grade = (ms) => (ms <= b * 1.15 ? 'good' : ms <= 33.4 ? 'warn' : 'bad');
    this.set('fps', s.fps.toFixed(0), s.fps >= gd.hz * 0.9 ? 'good' : s.fps >= 30 ? 'warn' : 'bad');
    this.set('p95', `${s.p95.toFixed(1)}ms`, grade(s.p95));
    this.set('max', `${s.max.toFixed(0)}ms`, grade(s.max));
    this.set('calls', fmt(s.render?.calls));
    this.set('tris', fmt(s.render?.triangles));
    this.set('heap', s.heap != null ? `${s.heap.toFixed(0)}MB` : 'n/a');
    this.set('geo', fmt(s.memory?.geometries));
    this.set('tex', fmt(s.memory?.textures));
    this.set('prog', fmt(s.memory?.programs));
    this.set('hitches', String(gd.stats.hitches), gd.stats.hitches ? 'warn' : '');
    this.set('errors', String(gd.stats.errors), gd.stats.errors ? 'bad' : '');
    this.set('level', gd.level ?? '–');
    if (gd.stats.errors > this.lastErrors) {
      this.lastErrors = gd.stats.errors;
      const n = this.fields.errors.parentElement;
      n.classList.remove('flash');
      void n.offsetWidth;
      n.classList.add('flash');
    }
    const ctx = Object.entries(gd.ctx)
      .map(([k, v]) => `<span>${escapeHtml(k)} <b>${fmt(v)}</b></span>`)
      .join('');
    const ctxEl = this.root.querySelector('.ctx');
    if (ctxEl.innerHTML !== ctx) ctxEl.innerHTML = ctx;
    const status = !gd.opts.intake ? 'offline' : gd.stats.lastStatus;
    this.root.querySelector('.dot').className = `dot ${status}`;
    const dest = gd.opts.intake ? `→ ${gd.opts.intake.replace(/^https?:\/\//, '').slice(0, 26)} · ${fmt(gd.stats.sent)}` : 'offline · overlay only';
    this.set('dest', dest);
    this.set('mcp', gd.webmcp ? `WebMCP ${gd.webmcp.status()}` : '');
    this.set('pill', `${s.fps.toFixed(0)} fps · ${s.p95.toFixed(0)}ms`);
  }

  draw() {
    if (this.el.classList.contains('collapsed')) return;
    const c = this.ctx2d;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const hist = this.gd.frameHistory();
    const maxMs = 66.7;
    const budget = this.gd.budgetMs;
    c.clearRect(0, 0, W, H);
    const bw = W / 240;
    for (let i = 0; i < hist.length; i++) {
      const ms = hist[i];
      const h = Math.min(H, (ms / maxMs) * H);
      c.fillStyle = ms <= budget * 1.15 ? '#2ee6a6' : ms <= 33.4 ? '#f0b429' : '#ff6b57';
      c.fillRect(W - (hist.length - i) * bw, H - h, Math.max(1, bw - 0.5), h);
    }
    c.strokeStyle = 'rgba(46,230,166,.7)';
    c.setLineDash([4, 4]);
    c.beginPath();
    const by = H - (budget / maxMs) * H;
    c.moveTo(0, by);
    c.lineTo(W, by);
    c.stroke();
    c.strokeStyle = 'rgba(255,107,87,.5)';
    c.beginPath();
    const jy = H - (33.4 / maxMs) * H;
    c.moveTo(0, jy);
    c.lineTo(W, jy);
    c.stroke();
    c.setLineDash([]);
  }
}

function fmt(v) {
  if (v == null) return '–';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

// The key that opens the bug report form, as the overlay names it (F8 unless the game picked another or none).
function bugHotkey(gd) {
  const o = gd.opts.bugReports;
  return o && typeof o === 'object' && 'hotkey' in o ? o.hotkey : 'F8';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

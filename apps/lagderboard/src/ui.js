// The page around the scene: title, HUD, the end card and the leaderboard sheet.
import { HOLD_S } from './judge.js';
import { classLabel } from './device.js';
import { clock } from './share.js';
import { LIVE_STATS_URL, LIVE_STATS_IS_PLACEHOLDER } from './config.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const RING = 414.7; // the melt ring's circumference (r = 66)

export function createUI(handlers) {
  const screens = { title: $('title'), end: $('end'), board: $('board') };
  const hud = $('hud');
  let toastTimer = 0;
  let boardClass = 'desktop';
  let myDevice = null;

  for (const id of ['t-live', 'e-live', 'b-live']) {
    const a = $(id);
    a.href = LIVE_STATS_URL;
    if (LIVE_STATS_IS_PLACEHOLDER) a.title = 'Placeholder until the public board is shared';
    a.addEventListener('click', () => handlers.onLive(id.split('-')[0]));
  }

  $('start').addEventListener('click', () => handlers.onStart());
  // A tap anywhere on the title that isn't a button or a link starts too: the game plays from the first touch.
  screens.title.addEventListener('pointerup', (e) => {
    if (!e.target.closest('button, a')) handlers.onStart();
  });
  $('e-again').addEventListener('click', () => handlers.onStart());
  $('t-board').addEventListener('click', () => handlers.onBoard('title'));
  $('e-board').addEventListener('click', () => handlers.onBoard('end'));
  $('b-close').addEventListener('click', () => closeBoard());
  $('t-privacy').addEventListener('click', () => $('privacy').classList.add('on'));
  $('p-close').addEventListener('click', () => $('privacy').classList.remove('on'));
  $('privacy').addEventListener('pointerup', (e) => {
    if (e.target === $('privacy')) $('privacy').classList.remove('on');
  });
  screens.board.addEventListener('pointerup', (e) => {
    if (e.target === screens.board) closeBoard();
  });
  for (const tab of document.querySelectorAll('.tabs button')) tab.addEventListener('click', () => openBoard(tab.dataset.class));

  const more = $('more');
  more.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handlers.onMore();
  });
  $('game').addEventListener('pointerdown', (e) => handlers.onTap(e.clientX, e.clientY));
  $('e-share').addEventListener('click', () => handlers.onShare('native'));
  $('e-save').addEventListener('click', () => handlers.onShare('image'));
  $('e-x').addEventListener('click', () => handlers.onShare('x'));
  if (!navigator.share) $('e-share').hidden = true;

  function show(name) {
    screens.title.classList.toggle('on', name === 'title');
    screens.end.classList.toggle('on', name === 'end');
    hud.classList.toggle('on', name === 'hud');
  }

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 1100);
  }

  let lastCount = -1;
  let lastVerdict = null;
  function frame({ cubes, verdict, lights, explosions, seconds, tier, melt }) {
    if (cubes !== lastCount) {
      $('h-count').textContent = fmt(cubes);
      lastCount = cubes;
    }
    $('h-stats').textContent = `${lights} ${lights === 1 ? 'light' : 'lights'} · ${explosions} explosions · ${clock(seconds)}`;
    $('h-tier').textContent = `×${tier}`;
    if (verdict !== lastVerdict) {
      lastVerdict = verdict;
      const bar = $('h-bar');
      if (!verdict) {
        $('h-p95').textContent = 'measuring…';
        $('h-fps').textContent = '';
        bar.style.width = '0';
      } else {
        const p95 = Number.isFinite(verdict.p95) ? verdict.p95 : 999;
        $('h-p95').textContent = `p95 ${p95 > 200 ? '>200' : p95.toFixed(1)} ms`;
        $('h-p95').className = verdict.over ? 'warn' : '';
        $('h-fps').textContent = `${Math.round(verdict.fps)} fps`;
        bar.style.width = `${Math.min(100, (p95 / 50) * 100)}%`;
        bar.style.background = verdict.over ? 'var(--coral)' : p95 > verdict.limit * 0.75 ? 'var(--gold)' : 'var(--mint)';
        bar.nextElementSibling.style.left = `${Math.min(98, (verdict.limit / 50) * 100)}%`;
      }
    }
    document.body.classList.toggle('melting', melt > 0);
    if (melt > 0) {
      $('h-ring').setAttribute('stroke-dashoffset', String(RING * (1 - melt)));
      $('h-melt').textContent = `under 30 fps · ${Math.max(0, HOLD_S * (1 - melt)).toFixed(1)} s`;
    }
  }

  function startRun() {
    lastCount = -1;
    lastVerdict = undefined;
    $('h-hint').classList.remove('gone');
    show('hud');
  }

  function tapped() {
    $('h-hint').classList.add('gone');
  }

  function pressMore() {
    more.classList.add('pressed');
    setTimeout(() => more.classList.remove('pressed'), 90);
  }

  function setDevice(device) {
    myDevice = device;
    boardClass = device.deviceClass;
    $('t-device').textContent = device.label;
  }

  function showEnd(r) {
    document.body.classList.remove('melting');
    $('e-short').textContent = r.device.short;
    $('e-score').textContent = fmt(r.score);
    $('e-device').textContent = r.device.label;
    $('e-measured').textContent =
      r.reason === 'unbreakable'
        ? `Glitchless never measured this device under 30 fps, even at ${fmt(r.score)} cubes, the most the game makes. Unbreakable.`
        : r.reason === 'context_lost'
          ? `The browser dropped the GPU (WebGL context lost) at ${fmt(r.peak)} cubes. The last time Glitchless measured 30 fps there were ${fmt(r.score)} cubes on screen.`
          : `Glitchless measured p95 frame time (the slowest 5% of frames) over ${r.limitMs.toFixed(1)} ms, slower than ${Math.round(1000 / r.limitMs)} fps, for ${Math.round(r.heldS)} s in a row. The last time it held 30 fps there were ${fmt(r.score)} cubes on screen.`;
    const chips = [`${r.lights} lights`, `${r.explosions} explosions`, clock(r.seconds), `${r.hz} Hz screen`, `peak ${fmt(r.peak)} cubes`];
    $('e-chips').replaceChildren(...chips.map((c) => Object.assign(document.createElement('span'), { textContent: c })));
    rank(r);
    $('e-x').removeAttribute('href');
    show('end');
    fitText($('e-score').parentElement);
  }

  function rank(r) {
    const el = $('e-rank');
    const what = `${classLabel(r.device.deviceClass).toLowerCase()} runs`;
    if (!r.placed) {
      el.textContent = r.synthetic
        ? 'Bot run: kept off the leaderboard.'
        : r.assisted
          ? 'The load was set by hand (an agent tool), so this run stays off the leaderboard.'
          : r.score < 1
            ? 'Nothing measured at 30 fps, so there is no score to save.'
            : 'Saving to the leaderboard…';
    } else {
      const p = r.placed;
      const where = p.offline ? "in this browser (the shared board couldn't be reached)" : p.approximate ? 'on the leaderboard (about)' : 'on the leaderboard';
      el.innerHTML = `<b>#${fmt(p.rank)}</b> of ${fmt(p.total)} ${what} ${where}${p.deviceRuns > 1 ? ` · best on ${escape(r.device.name)}: ${fmt(p.deviceBest)}` : ''}`;
    }
  }

  function shareReady(xUrl) {
    $('e-x').href = xUrl;
  }

  async function openBoard(cls = boardClass) {
    boardClass = cls;
    for (const tab of document.querySelectorAll('.tabs button')) tab.setAttribute('aria-selected', String(tab.dataset.class === cls));
    screens.board.classList.add('on');
    const rows = await handlers.devices(cls);
    const list = $('b-list');
    if (!rows.length) {
      list.innerHTML = `<li class="empty" style="display:block">No ${classLabel(cls).toLowerCase()} runs here yet.${myDevice?.deviceClass === cls ? ' Yours can be the first.' : ''}</li>`;
    } else {
      list.innerHTML = rows
        .map(
          (r, i) =>
            `<li class="${r.deviceName === myDevice?.name ? 'me' : ''}"><span class="n">${i + 1}</span><span class="name">${escape(r.deviceName)}<small>${r.runs} ${r.runs === 1 ? 'run' : 'runs'}${r.deviceName === myDevice?.name ? ' · your device' : ''}</small></span><span class="best">${fmt(r.best)}</span></li>`,
        )
        .join('');
    }
    $('b-note').textContent = handlers.boardNote();
  }

  function closeBoard() {
    screens.board.classList.remove('on');
  }

  return { show, toast, frame, startRun, tapped, pressMore, setDevice, showEnd, rank, shareReady, openBoard, closeBoard };
}

// Shrink a one-line number until it fits its box (an 8-digit score on a phone).
function fitText(el) {
  el.style.fontSize = '';
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > el.clientWidth && size > 24) {
    size -= 2;
    el.style.fontSize = `${size}px`;
  }
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

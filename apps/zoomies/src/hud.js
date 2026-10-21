// DOM HUD + screens. Only touches the DOM when a value actually changes.
const $ = (id) => document.getElementById(id);

const PAW = `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="#E0457B"><ellipse cx="12" cy="15.5" rx="5.2" ry="4.4"/><ellipse cx="5.6" cy="10.2" rx="2.1" ry="2.6"/><ellipse cx="9.6" cy="6.4" rx="2.1" ry="2.6"/><ellipse cx="14.4" cy="6.4" rx="2.1" ry="2.6"/><ellipse cx="18.4" cy="10.2" rx="2.1" ry="2.6"/></g></svg>`;

const cache = {};
function set(id, value) {
  if (cache[id] === value) return false;
  cache[id] = value;
  $(id).textContent = value;
  return true;
}

function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

export function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

let toastTimer = 0;
const SCREENS = ['title', 'pause', 'complete', 'win', 'halted'];

export const hud = {
  show(visible) {
    $('hud').classList.toggle('hidden', !visible);
  },
  screen(name) {
    for (const s of SCREENS) $(s).classList.toggle('on', s === name);
  },
  initTitle(footer) {
    const logo = $('logo');
    logo.innerHTML = [...logo.textContent].map((ch, i) => `<span style="animation-delay:${i * 0.08}s">${ch}</span>`).join('');
    $('footer').textContent = footer;
  },
  level(num, name, totalBones) {
    set('hud-level-num', String(num));
    set('hud-level-name', name);
    set('hud-bones-total', String(totalBones));
  },
  bones(n) {
    if (set('hud-bones', String(n)) && n > 0) bump($('hud-bones-chip'));
  },
  score(n) {
    set('hud-score', String(n));
  },
  timer(s) {
    set('hud-timer', formatTime(s));
  },
  lives(n, max) {
    const key = `${n}/${max}`;
    if (cache.lives === key) return;
    cache.lives = key;
    const el = $('hud-lives');
    el.innerHTML = Array.from({ length: max }, (_, i) => PAW.replace('<svg', `<svg class="${i < n ? '' : 'lost'}"`)).join('');
  },
  deaths(n) {
    set('hud-deaths', String(n));
  },
  zoomies(frac) {
    const el = $('hud-zoomies');
    const on = frac > 0;
    if (cache.zoomOn !== on) {
      cache.zoomOn = on;
      el.classList.toggle('on', on);
    }
    if (on) el.querySelector('i').style.transform = `scaleX(${frac.toFixed(3)})`;
  },
  bot(text) {
    const el = $('hud-bot');
    el.hidden = !text;
    el.innerHTML = text || '';
  },
  toast(text, kind = '', ms = 1300) {
    const el = $('toast');
    el.textContent = text;
    el.className = `on ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = kind), ms);
  },
  hint(visible) {
    $('hint').classList.toggle('gone', !visible);
  },
  complete(name, stats) {
    $('complete-name').textContent = name;
    $('c-bones').textContent = `${stats.bones}/${stats.total}`;
    $('c-time').textContent = formatTime(stats.time);
    $('c-score').textContent = String(stats.score);
    $('c-deaths').textContent = String(stats.deaths);
  },
  win(stats) {
    $('w-bones').textContent = String(stats.bones);
    $('w-time').textContent = formatTime(stats.time);
    $('w-score').textContent = String(stats.score);
    $('w-deaths').textContent = String(stats.deaths);
  },
  halted(ribbon, title, text) {
    $('halted-ribbon').textContent = ribbon;
    $('halted-title').textContent = title;
    $('halted-text').textContent = text;
  },
};

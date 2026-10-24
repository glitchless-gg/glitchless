// The player's progress on this device: levels unlocked and fewest tries. localStorage can be blocked
// (private windows) or throw, so every read and write is guarded and the game works without it.
const KEY = 'dead-reckoning';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function write(v) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // fine: progress just won't outlive the page
  }
}

export const store = {
  get unlocked() {
    return Math.max(1, Math.min(5, read().unlocked || 1));
  },
  unlock(n) {
    const v = read();
    v.unlocked = Math.max(v.unlocked || 1, Math.min(5, n));
    write(v);
  },
  best(id) {
    return read().best?.[id] ?? null;
  },
  setBest(id, tries) {
    const v = read();
    v.best = v.best || {};
    if (!v.best[id] || tries < v.best[id]) v.best[id] = tries;
    write(v);
  },
  get muted() {
    return !!read().muted;
  },
  set muted(m) {
    const v = read();
    v.muted = m;
    write(v);
  },
};

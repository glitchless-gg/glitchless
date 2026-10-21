// Keyboard input → { left, right, jump } + one-shot "pressed" edges for menu keys.
const held = new Set();
const pressedQueue = new Set();

const MAP = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Space: 'jump',
  KeyW: 'jump',
  ArrowUp: 'jump',
  KeyR: 'restart',
  Escape: 'pause',
  KeyP: 'pause',
  KeyM: 'mute',
  Enter: 'confirm',
};

window.addEventListener('keydown', (e) => {
  const action = MAP[e.code];
  if (!action) return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (!held.has(e.code)) pressedQueue.add(action);
  held.add(e.code);
});
window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => held.clear());

function isHeld(action) {
  for (const code of held) if (MAP[code] === action) return true;
  return false;
}

export const keyboard = {
  state() {
    return { left: isHeld('left'), right: isHeld('right'), jump: isHeld('jump') };
  },
  /** consume a one-shot press (jump/confirm/pause/restart/mute) */
  consume(action) {
    if (pressedQueue.has(action)) {
      pressedQueue.delete(action);
      return true;
    }
    return false;
  },
  clearPresses() {
    pressedQueue.clear();
  },
};

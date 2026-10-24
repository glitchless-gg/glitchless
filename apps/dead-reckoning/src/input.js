// Keyboard and touch → { left, right, jump }, plus one-shot presses for menu keys.
// On a phone the left thumb rests on one pad split into ◀ and ▶ (slide between them without lifting);
// the right thumb has JUMP. Each pointer is tracked on its own, so running and jumping work together.
const held = new Set();
const pressed = new Set();
const touch = { left: false, right: false, jump: false };

const KEYS = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Space: 'jump',
  KeyW: 'jump',
  ArrowUp: 'jump',
  KeyZ: 'jump',
  KeyR: 'restart',
  KeyM: 'mute',
  Enter: 'confirm',
  Escape: 'back',
};

window.addEventListener('keydown', (e) => {
  const action = KEYS[e.code];
  if (!action || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, button, a') && action === 'confirm') return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (!held.has(e.code)) pressed.add(action);
  held.add(e.code);
});
window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => {
  held.clear();
  touch.left = touch.right = touch.jump = false;
});

function keyHeld(action) {
  for (const code of held) if (KEYS[code] === action) return true;
  return false;
}

/** Wire the on-screen pad: `move` is the ◀▶ zone, `jump` the jump button. */
export function bindTouch({ move, jump, onFirstTouch }) {
  const movers = new Map(); // pointerId → -1 | 1
  const jumpers = new Set();
  let first = true;
  const sync = () => {
    const dirs = [...movers.values()];
    touch.left = dirs.includes(-1);
    touch.right = dirs.includes(1);
    touch.jump = jumpers.size > 0;
    move.dataset.dir = touch.left && !touch.right ? 'left' : touch.right && !touch.left ? 'right' : '';
    jump.classList.toggle('down', touch.jump);
  };
  const dirAt = (e) => {
    const r = move.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? -1 : 1;
  };
  // Capture keeps a thumb that slides off the button pressed; it throws for a pointer the browser no longer
  // tracks, which mustn't lose the press.
  const capture = (el, id) => {
    try {
      el.setPointerCapture(id);
    } catch {
      // keep going without capture
    }
  };
  const firstTouch = () => {
    if (!first) return;
    first = false;
    onFirstTouch?.();
  };
  move.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    firstTouch();
    capture(move, e.pointerId);
    movers.set(e.pointerId, dirAt(e));
    sync();
  });
  move.addEventListener('pointermove', (e) => {
    if (!movers.has(e.pointerId)) return;
    movers.set(e.pointerId, dirAt(e));
    sync();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    move.addEventListener(type, (e) => {
      movers.delete(e.pointerId);
      sync();
    });
  }
  jump.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    firstTouch();
    capture(jump, e.pointerId);
    if (!jumpers.size) pressed.add('jump');
    jumpers.add(e.pointerId);
    sync();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    jump.addEventListener(type, (e) => {
      jumpers.delete(e.pointerId);
      sync();
    });
  }
  // A long press on a phone would otherwise open the text-selection or context menu.
  for (const el of [move, jump]) el.addEventListener('contextmenu', (e) => e.preventDefault());
}

export const input = {
  state() {
    return {
      left: keyHeld('left') || touch.left,
      right: keyHeld('right') || touch.right,
      jump: keyHeld('jump') || touch.jump,
    };
  },
  /** Consume a one-shot press (jump, restart, confirm, back, mute). */
  consume(action) {
    if (!pressed.has(action)) return false;
    pressed.delete(action);
    return true;
  },
  clearPresses() {
    pressed.clear();
  },
};

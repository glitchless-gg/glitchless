// ?autoplay=1: a bot that plays like an eager player, for hands-free screen recordings and playtest traffic. It
// taps the mound every half second or so, presses MORE every few seconds, and starts a new run 6 s after each
// meltdown. Its sessions are tagged synthetic and its runs stay off the leaderboard.
export function startAutoplay(api) {
  let lastMore = 0;
  let endedAt = 0;
  setInterval(() => {
    const s = api.state();
    const now = performance.now();
    if (s.phase === 'title' && s.device) api.start();
    else if (s.phase === 'run') {
      endedAt = 0;
      if (Math.random() < 0.6) api.tapAt(window.innerWidth * (0.25 + Math.random() * 0.5), window.innerHeight * (0.45 + Math.random() * 0.3));
      if (now - lastMore > 2600) {
        lastMore = now;
        api.more(1);
      }
    } else if (s.phase === 'end') {
      endedAt ||= now;
      if (now - endedAt > 6000) api.start();
    }
  }, 450);
}

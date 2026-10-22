// A game's dashboard (server/src/board.js): its pages, each a board of panels or a built-in view. These change
// it; every change sends the whole dashboard, and the automatic one becomes a saved one the first time.
import { apiSend } from './api.js';

// The built-in views a page can be, as server/src/board.js names them.
export const VIEWS = {
  events: { title: 'Events', icon: 'events', about: 'every event the game sends, breakdowns and funnels' },
  performance: { title: 'Performance', icon: 'perf', about: 'frame time, hitches and their causes' },
  errors: { title: 'Errors', icon: 'errors', about: 'errors grouped into issues' },
  players: { title: 'Players', icon: 'players', about: 'devices, levels and where players stop' },
  heatmaps: { title: 'Heatmaps', icon: 'heatmap', about: 'where players go and die, for games that send positions' },
  sessions: { title: 'Sessions', icon: 'sessions', about: 'every session, with its replay' },
  versions: { title: 'Versions', icon: 'versions', about: 'releases compared on the stats of every board' },
  live: { title: 'Live Tail', icon: 'live', about: 'events as they arrive' },
};

// The pages of a game that has sent nothing yet.
export const EMPTY_PAGES = [{ id: 'overview', title: 'Overview', icon: 'overview', panels: 0 }, ...['errors', 'sessions', 'live'].map((v) => ({ id: v, title: VIEWS[v].title, icon: VIEWS[v].icon, view: v }))];

// `f` is the filters context: its service, and its dashboard ({ spec, reload }).
export async function saveDashboard(f, spec) {
  await apiSend('PUT', `/v1/dashboard?service=${encodeURIComponent(f.service)}`, spec);
  f.dashboard.reload();
}

export async function resetDashboard(f) {
  await apiSend('DELETE', `/v1/dashboard?service=${encodeURIComponent(f.service)}`);
  f.dashboard.reload();
}

// The dashboard with one page changed.
export function withPage(spec, id, change) {
  return { pages: spec.pages.map((p) => (p.id === id ? { ...p, ...change } : p)) };
}

// Adds a panel to a board (`id`, or the first board; a new "Board" page when the dashboard has none) and
// returns that page's id.
export async function addToBoard(f, panel, id = null) {
  const pages = f.dashboard.spec.pages;
  const target = pages.find((p) => p.id === id && p.panels) || pages.find((p) => p.panels);
  const next = target ? pages.map((p) => (p === target ? { ...p, panels: [...p.panels, panel] } : p)) : [{ id: 'board', title: 'Board', panels: [panel] }, ...pages];
  await saveDashboard(f, { pages: next });
  return target?.id || 'board';
}

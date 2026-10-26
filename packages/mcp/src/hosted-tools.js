// The tools that work from a server anywhere: they read and write through the Glitchless API. http.js serves these;
// index.js (stdio) adds the ones that act on the computer the agent runs on (playtests, the Steam Deck).
import './tools/core.js';
import './tools/analytics.js';
import './tools/dashboard.js';
import './tools/reports.js';
import './tools/store-reviews.js';
import './tools/revenue.js';
import './tools/multiplayer.js';
import './tools/workspace.js';

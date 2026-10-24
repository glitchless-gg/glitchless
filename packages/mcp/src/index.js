#!/usr/bin/env node
// Glitchless MCP server — gives coding agents (Claude Code, Codex, Cursor…) read access to a game's
// production telemetry: ranked findings, frame-time breakdowns, errors, player funnels, death
// hotspots and version comparisons. Pair it with WebMCP (live tools exposed by the running game)
// and the agent can go from "players are rage quitting" to a verified fix.
//
//   claude mcp add glitchless -e GLITCHLESS_URL=http://localhost:7777 -- npx -y glitchless-mcp
//
// On Glitchless Cloud, sign in once to reach every game in a workspace (it shows a code to approve in the browser):
//
//   npx -y glitchless-mcp login      (also: whoami, logout)
//
// The shared server and helpers are in context.js; each area's tools are in tools/<area>.js, and a new
// area is one more file imported here.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

if (['login', 'logout', 'whoami'].includes(process.argv[2])) {
  const { cli } = await import('./login.js');
  process.exit(await cli(process.argv.slice(2)));
}

const { server } = await import('./context.js');
await import('./tools/core.js');
await import('./tools/analytics.js');
await import('./tools/dashboard.js');
await import('./tools/playtest.js');
await import('./tools/reports.js');
await import('./tools/deck.js');
await import('./tools/store-reviews.js');
await import('./tools/workspace.js');

await server.connect(new StdioServerTransport());

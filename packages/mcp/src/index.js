#!/usr/bin/env node
// Glitchless MCP server — gives coding agents (Claude Code, Codex, Cursor…) read access to a game's
// production telemetry: ranked findings, frame-time breakdowns, errors, player funnels, death
// hotspots and version comparisons. Pair it with WebMCP (live tools exposed by the running game)
// and the agent can go from "players are rage quitting" to a verified fix.
//
//   claude mcp add glitchless -e GLITCHLESS_URL=http://localhost:7777 -- npx -y glitchless-mcp
//
// The shared server and helpers are in context.js; each area's tools are in tools/<area>.js, and a new
// area is one more file imported here.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './context.js';
import './tools/core.js';
import './tools/analytics.js';
import './tools/dashboard.js';
import './tools/playtest.js';
import './tools/reports.js';
import './tools/deck.js';

await server.connect(new StdioServerTransport());

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
// Or serve it over Streamable HTTP, for clients that connect to a URL (http.js):
//
//   npx -y glitchless-mcp serve [--port 3001] [--host 127.0.0.1]
//
// The connection and the list of tools are in context.js; each area's tools are in tools/<area>.js, and a new area
// is one more file imported in hosted-tools.js (or here, for a tool that acts on this computer).

if (['login', 'logout', 'whoami'].includes(process.argv[2])) {
  const { cli } = await import('./login.js');
  process.exit(await cli(process.argv.slice(2)));
}

if (process.argv[2] === 'serve') {
  const { serve } = await import('./http.js');
  await serve(process.argv.slice(3)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else {
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  const { createServer } = await import('./context.js');
  await import('./hosted-tools.js');
  await import('./tools/playtest.js');
  await import('./tools/deck.js');
  serveStdio(() => createServer());
}

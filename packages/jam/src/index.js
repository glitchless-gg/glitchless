#!/usr/bin/env node
// glitchless-jam: Glitchless jam rooms for coding agents. A maker's agent joins a room by its code, publishes the
// game's build in one call and gets a link and a QR code to play it on a phone, and reads how the room's games are
// doing. It is its own package, apart from glitchless-mcp (the MCP server for the games developers ship), and signs in
// the same way: the same saved sign-in, or GLITCHLESS_URL and GLITCHLESS_API_KEY for a self-hosted server.
//
//   claude mcp add glitchless-jam -- npx -y glitchless-jam     the MCP server on stdio: glitchless_jam for makers and
//                                                              glitchless_jam_host for the organiser (tool.js)
//   npx -y glitchless-jam publish dist --room K7Q2M            the same publish from a terminal (cli.js)
//   npx -y glitchless-jam host create "Title"                  the organiser's commands (cli.js, host.js)
//   npx -y glitchless-jam login                                sign in to Glitchless Cloud (login.js)

if (process.argv.length > 2) {
  const { cli } = await import('./cli.js');
  // exitCode, not exit(): a report piped to a file is written out in full first.
  process.exitCode = await cli(process.argv.slice(2));
} else {
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  const { createServer } = await import('./tool.js');
  serveStdio(() => createServer());
}

#!/usr/bin/env node
// End-to-end check of the WebMCP loop, exactly as a coding agent sees it:
//   MCP client ⇄ webmcp bridge (npx @jason.today/webmcp --mcp) ⇄ websocket ⇄ the running game.
// 1) asks the bridge for a registration token, 2) opens the game in Chrome and pairs it through the
// widget, 3) lists the tools the game exposes and calls a few of them.
//
//   node scripts/webmcp-smoke.js [--game http://localhost:5173/] [--level level-2] [--headed]
//   node scripts/webmcp-smoke.js --game http://localhost:5175/ --level level-2     (the Phaser demo)
//
// The game's own tools are found by name: <game>_load_level, <game>_get_state, and the tool that
// sets off the expensive effect (<game>_trigger_zoomies or <game>_throw_ball).

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const GAME = flag('game', 'http://localhost:5173/');
const LEVEL = flag('level', 'level-2');

const client = new Client({ name: 'glitchless-smoke', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', '@jason.today/webmcp@latest', '--mcp'], stderr: 'ignore' }));
const tokenText = (await client.callTool({ name: '_webmcp_get-token', arguments: {} })).content[0].text;
const token = tokenText.trim().split('\n').pop().trim();
console.log('✓ bridge up, got registration token');

const browser = await chromium.launch({ headless: !flag('headed', false), channel: 'chrome', args: ['--use-angle=metal', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await page.goto(GAME);
await page.waitForFunction(() => window.__GLITCHLESS__?.webmcp?.bridge, null, { timeout: 15000 });
await page.click('.webmcp-trigger');
await page.fill('.webmcp-token-input', token);
await page.click('.webmcp-connect-btn');
await page.waitForFunction(() => window.__GLITCHLESS__.webmcp.bridge.isConnected, null, { timeout: 15000 });
await page.keyboard.press('Space'); // leave the title screen
console.log('✓ game paired with the bridge');

await new Promise((r) => setTimeout(r, 1500));
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log(`✓ ${names.length} tools visible to the agent:\n  ${names.join('\n  ')}`);
const find = (suffix) => names.find((n) => n.endsWith(suffix));
const call = async (suffix, a = {}) => {
  const name = find(suffix);
  if (!name) return console.log(`… ${suffix} not registered`);
  const res = await client.callTool({ name, arguments: a });
  const first = res.content?.[0];
  const text = first?.type === 'image' ? `[image ${first.mimeType}, ${Math.round(first.data.length / 1024)} KB]` : first?.text;
  console.log(`\n→ ${name} ${JSON.stringify(a)}\n${String(text).slice(0, 900)}`);
  return res;
};

const trigger = ['_trigger_zoomies', '_throw_ball'].find((s) => find(s)) || '_trigger_zoomies';
await call('glitchless_session');
await call('_load_level', { level: LEVEL });
await new Promise((r) => setTimeout(r, 1500));
await call('glitchless_measure', { seconds: 3 });
await call('_get_state');
await Promise.all([call('glitchless_measure', { seconds: 6 }), (async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    await call(trigger);
  }
})()]);
await call('glitchless_inspect_scene', { top: 5 });
await call('glitchless_screenshot');
await call('glitchless_annotate', { note: 'webmcp smoke test' });

await browser.close();
await client.close();
process.exit(0);

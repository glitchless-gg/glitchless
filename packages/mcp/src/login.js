// Signing in to a Glitchless Cloud workspace, for an agent: `npx -y glitchless-mcp login` in a terminal, or the
// glitchless_sign_in tool from inside the agent. Glitchless shows a code and a link; the person approves it in
// the dashboard; the workspace key it hands back is saved to CREDENTIALS_FILE (only readable by you), where the MCP
// server finds it.
//
//   npx -y glitchless-mcp login [--url https://api.glitchless.gg] [--no-browser]
//   npx -y glitchless-mcp whoami
//   npx -y glitchless-mcp logout
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CREDENTIALS_FILE, readCredentials } from './context.js';

export const CLOUD_URL = 'https://api.glitchless.gg';

async function call(url, p, body) {
  const res = await fetch(`${url}/v1/agent${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && p === '/connect') throw new Error(`${url} has no agent sign-in. A self-hosted Glitchless server needs no key; set GLITCHLESS_URL to it instead.`);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// → { verification_url, user_code, wait() }: wait() resolves with the saved credentials, or rejects when the
// person turns it down or the code expires.
export async function startSignIn({ url = CLOUD_URL, client = `glitchless-mcp on ${os.hostname()}` } = {}) {
  url = url.replace(/\/$/, '');
  const start = await call(url, '/connect', { client });
  const deadline = Date.now() + start.expires_in * 1000;
  let interval = (start.interval || 2) * 1000;
  async function wait() {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const poll = await call(url, '/connect/poll', { device_code: start.device_code });
      if (poll.status === 'slow_down') interval += 1000;
      else if (poll.status === 'denied') throw new Error('The sign-in was turned down in the dashboard.');
      else if (poll.status === 'expired') throw new Error('The sign-in code expired. Start again.');
      else if (poll.status === 'approved') return saveCredentials({ url, token: poll.token, workspace: poll.workspace, scopes: poll.scopes });
    }
    throw new Error('The sign-in code expired before it was approved. Start again.');
  }
  return { verification_url: start.verification_url, user_code: start.user_code, wait };
}

export function saveCredentials(c) {
  const credentials = { ...c, savedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  return credentials;
}

function openBrowser(link) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [link]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : ['xdg-open', [link]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

// The command line: login, whoami, logout. → the exit code.
export async function cli(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : null;
  };
  if (command === 'logout') {
    fs.rmSync(CREDENTIALS_FILE, { force: true });
    console.log('Signed out: the saved workspace key is deleted. Revoke it in Settings → Keys & access if it may have leaked.');
    return 0;
  }
  if (command === 'whoami') {
    const c = readCredentials();
    if (!c) {
      console.log('Not signed in. Run: npx -y glitchless-mcp login');
      return 1;
    }
    console.log(`Signed in to ${c.workspace?.name ?? c.workspace?.id} on ${c.url} (${(c.scopes || []).join(', ')}), since ${c.savedAt}.`);
    return 0;
  }
  const url = flag('url') || process.env.GLITCHLESS_URL || CLOUD_URL;
  const { verification_url, user_code, wait } = await startSignIn({ url });
  console.log(`To connect this agent to Glitchless, open:\n\n  ${verification_url}\n\nand check the page shows the code ${user_code}. Waiting for approval…`);
  if (!rest.includes('--no-browser')) openBrowser(verification_url);
  try {
    const c = await wait();
    console.log(`\nConnected to ${c.workspace?.name ?? 'your workspace'} (${c.scopes.join(', ')}). The key is saved in ${CREDENTIALS_FILE}.\nRestart your agent's Glitchless MCP server (or start a new session) to use it.`);
    return 0;
  } catch (err) {
    console.error(`\n${err.message}`);
    return 1;
  }
}

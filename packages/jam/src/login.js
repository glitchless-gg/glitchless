// Signing in to a Glitchless Cloud workspace from a terminal: glitchless-mcp's own sign-in (its login.js), copied so
// this package needs nothing else. Glitchless shows a code and a link, the person approves it in the dashboard, and
// the workspace key it hands back goes in the same file glitchless-mcp reads, so signing in to either signs in both.
//
//   npx -y glitchless-jam login [--url https://api.glitchless.gg] [--no-browser]
//   npx -y glitchless-jam whoami
//   npx -y glitchless-jam logout
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { credentialsFile, readCredentials, saveCredentials } from './context.js';

export const CLOUD_URL = 'https://api.glitchless.gg';

async function call(url, p, body) {
  const res = await fetch(`${url}/v1/agent${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && p === '/connect') throw new Error(`${url} has no agent sign-in. A self-hosted Glitchless server needs no sign-in: set GLITCHLESS_URL to it (and GLITCHLESS_API_KEY, if it has a key) instead.`);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// → { verification_url, user_code, wait() }: wait() resolves with the saved credentials, or rejects when the person
// turns it down or the code expires.
export async function startSignIn({ url = CLOUD_URL, client = `glitchless-jam on ${os.hostname()}` } = {}) {
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

function openBrowser(link) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [link]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : ['xdg-open', [link]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

// login, whoami, logout. → the exit code.
export async function signInCli(command, rest, { out = console.log, err = console.error, env = process.env } = {}) {
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : null;
  };
  if (command === 'logout') {
    fs.rmSync(credentialsFile(), { force: true });
    out('Signed out of Glitchless on this computer (glitchless-mcp too: they share the sign-in). Revoke the key in Settings → Keys & access if it may have leaked.');
    return 0;
  }
  if (command === 'whoami') {
    if (env.GLITCHLESS_API_KEY) {
      out(`Using GLITCHLESS_API_KEY on ${env.GLITCHLESS_URL || 'http://localhost:7777'}.`);
      return 0;
    }
    const c = readCredentials();
    if (!c) {
      out(`Not signed in. Run: npx -y glitchless-jam login${env.GLITCHLESS_URL ? ` (or, for ${env.GLITCHLESS_URL}, set GLITCHLESS_API_KEY if it has a key)` : ''}`);
      return 1;
    }
    out(`Signed in to ${c.workspace?.name ?? c.workspace?.id} on ${c.url} (${(c.scopes || []).join(', ')}), since ${c.savedAt}.`);
    const origin = (u) => URL.canParse(u) && new URL(u).origin;
    if (env.GLITCHLESS_URL && origin(env.GLITCHLESS_URL) !== origin(c.url)) out(`GLITCHLESS_URL points at ${env.GLITCHLESS_URL}, which this sign-in's key is never sent to.`);
    return 0;
  }
  const url = flag('url') || env.GLITCHLESS_URL || CLOUD_URL;
  try {
    const { verification_url, user_code, wait } = await startSignIn({ url });
    out(`To connect this computer to Glitchless, open:\n\n  ${verification_url}\n\nand check the page shows the code ${user_code}. Waiting for approval…`);
    if (!rest.includes('--no-browser')) openBrowser(verification_url);
    const c = await wait();
    out(`\nConnected to ${c.workspace?.name ?? 'your workspace'} (${(c.scopes || []).join(', ')}). The key is saved in ${credentialsFile()}, for glitchless-jam and glitchless-mcp alike.`);
    return 0;
  } catch (e) {
    err(`\n${e.message}`);
    return 1;
  }
}

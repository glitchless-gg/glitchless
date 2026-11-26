// The state a tool hands a client with a question (MCP's requestState, on an input_required answer), sealed so the
// client can't make it up: the answer comes back as a call of its own with the state echoed, and the tool acts on it
// only when the seal holds, it hasn't expired and it's for this same request. On stdio the seal's key is a secret of
// this process, which the client's next call reaches; over HTTP, where each request gets a server of its own, it's
// derived from the connection's workspace key, which the hosted server holds and its OAuth clients never see.
import crypto from 'node:crypto';
import { apiKey, isRemote } from './context.js';

const PROCESS_SECRET = crypto.randomBytes(32);
export const STATE_LIMITS = { ttlMs: 10 * 60_000 };

const keyNow = () => (isRemote() && apiKey() ? crypto.createHmac('sha256', apiKey()).update('glitchless-mcp requestState v1').digest() : PROCESS_SECRET);
const sign = (body) => crypto.createHmac('sha256', keyNow()).update(body).digest('base64url');

// payload (JSON) → the state string: its body, then its seal. It carries kind, an expiry and a one-time nonce.
export function sealState(kind, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, k: kind, exp: Date.now() + STATE_LIMITS.ttlMs, n: crypto.randomBytes(12).toString('base64url') })).toString('base64url');
  return `${body}.${sign(body)}`;
}

// The state a call carries → its payload, or null when it's missing, made up, for another kind or expired.
export function openState(kind, state) {
  if (typeof state !== 'string') return null;
  const [body, seal, extra] = state.split('.');
  if (!body || !seal || extra !== undefined) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(seal);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload?.k !== kind || !(payload.exp > Date.now())) return null;
  return payload;
}

// A yes counts once: a nonce, once acted on, is spent until its state would have expired anyway. Kept in this
// process's memory, so over HTTP it holds per server instance; the short expiry bounds the rest.
const spent = new Map();
export function spend(payload) {
  for (const [n, exp] of spent) if (exp <= Date.now()) spent.delete(n);
  if (spent.has(payload.n)) return false;
  spent.set(payload.n, payload.exp);
  return true;
}

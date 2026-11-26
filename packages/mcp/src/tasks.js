// Tasks: MCP's io.modelcontextprotocol/tasks extension (protocol 2026-07-28), for a tool call that takes minutes. A
// client that says it handles tasks on the call itself (the extension in the request's _meta clientCapabilities) gets
// a task at once instead of waiting: { resultType: "task", taskId, status: "working", … }. It then polls tasks/get,
// which carries the latest step in statusMessage and, once the work is done, the tool's result; tasks/cancel stops the
// work. Any other client waits for the result as before: a task goes only to a call that declared the extension.
//
// Only glitchless_playtest runs as a task (its game checks too), and only on stdio: the work runs in this process after
// the call has answered, which a server over HTTP (a serverless function on Glitchless Cloud) can't do. A call that
// finishes within TASK_LIMITS.graceMs answers directly, so a call that fails at once (no saved baseline, no command)
// reads as it always did. Tasks live in memory, for one connection: the stdio server is one process per agent.
import crypto from 'node:crypto';
import { z } from 'zod';
import { CLIENT_CAPABILITIES_META_KEY, MissingRequiredClientCapabilityError, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

export const TASKS = 'io.modelcontextprotocol/tasks';

// graceMs: how long a call may take and still answer directly. pollMs: how often a client should ask (Claude Code
// keeps to 250 to 30,000 ms). keepMs: how long a finished task's result stays readable (Claude Code wants an hour).
export const TASK_LIMITS = { graceMs: 1500, pollMs: 2000, keepMs: 3600e3 };

const tasks = new Map();

// Whether this request's client takes a task in place of the tool's result: a request on the 2026-07-28 protocol (as
// server, the low-level Server answering it, serves it) whose own capabilities name the extension.
export const declaresTasks = (ctx, server) => String(server?.getNegotiatedProtocolVersion?.() ?? '') >= '2026-07-28' && ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY]?.extensions?.[TASKS] !== undefined;

const now = () => new Date().toISOString();

// A task as tasks/get shows it (the Task shape, with result once it's completed). ttlMs runs from creation to an hour
// after the work ended, or from now while it's still working.
function view(t) {
  const until = (t.endedAt ?? Date.now()) + TASK_LIMITS.keepMs;
  return {
    taskId: t.taskId,
    status: t.status,
    ...(t.statusMessage ? { statusMessage: t.statusMessage } : {}),
    createdAt: t.createdAt,
    lastUpdatedAt: t.lastUpdatedAt,
    ttlMs: Math.max(0, Math.round(until - Date.parse(t.createdAt))),
    pollIntervalMs: TASK_LIMITS.pollMs,
    ...(t.status === 'completed' ? { result: t.result } : {}),
  };
}

// A task ends once: completed with the tool's result (an error the tool reports is a result too, isError and all), or
// cancelled. Whatever the work does after it was cancelled is dropped.
function end(t, status, result) {
  if (t.status !== 'working') return;
  Object.assign(t, { status, endedAt: Date.now(), lastUpdatedAt: now() });
  if (status === 'completed') {
    t.result = result;
    t.statusMessage = result?.isError ? 'Finished with an error: the result says what went wrong.' : 'Finished.';
  } else t.statusMessage = t.stops ? 'Cancelled: the run was stopped.' : "Cancelled: asked the run to stop, but the glitchless-playtest installed here (older than 0.5.0) can't stop part-way, so it plays to the end in the background and saves its run (latest, and save_as) as usual. Update glitchless-playtest to stop runs at once.";
}

// Finished tasks an hour after they ended are let go.
function sweep() {
  for (const [id, t] of tasks) if (t.endedAt && Date.now() - t.endedAt > TASK_LIMITS.keepMs) tasks.delete(id);
}

/**
 * Runs work as a task. work({ signal, update, cantStop }) → the tool's result: signal fires when the client cancels
 * (the call itself, while it hasn't answered, or the task), update(message) is the latest step, for statusMessage, and
 * cantStop() says the work ignores signal, so a cancel says it only asked.
 * → the tool's result when work finishes within TASK_LIMITS.graceMs, else a CreateTaskResult while work goes on.
 */
export async function runAsTask(work, { signal: call } = {}) {
  const at = now();
  const t = { taskId: crypto.randomUUID(), status: 'working', statusMessage: 'Started.', createdAt: at, lastUpdatedAt: at, result: null, endedAt: null, stop: new AbortController(), stops: true };
  // Until it answers, cancelling the call stops the work; after that, only tasks/cancel does.
  const cancelCall = () => t.stop.abort(new Error('The call was cancelled.'));
  call?.addEventListener('abort', cancelCall, { once: true });
  const update = (message) => {
    if (t.status !== 'working' || !message) return;
    t.statusMessage = String(message).slice(0, 500);
    t.lastUpdatedAt = now();
  };
  const finished = Promise.resolve()
    .then(() => work({ signal: t.stop.signal, update, cantStop: () => (t.stops = false) }))
    .then(
      (result) => end(t, 'completed', result),
      // The tools catch their own errors (context.js's fail); this is a backstop, so nothing rejects unhandled.
      (err) => end(t, 'completed', { content: [{ type: 'text', text: `Glitchless error: ${err?.message ?? err}` }], isError: true }),
    );
  let timer;
  const quick = await Promise.race([finished.then(() => true), new Promise((r) => (timer = setTimeout(() => r(false), TASK_LIMITS.graceMs)))]);
  clearTimeout(timer);
  call?.removeEventListener('abort', cancelCall);
  if (quick && t.status === 'completed') return t.result;
  sweep();
  tasks.set(t.taskId, t);
  return { resultType: 'task', ...view(t) };
}

// tasks/get, tasks/cancel and tasks/update on a server (its low-level Server): only a request that declares the
// extension may ask (-32021 otherwise), and a task this process doesn't have is -32602.
export function serveTasks(server) {
  const params = z.looseObject({ taskId: z.string() });
  const find = (method, { taskId }, ctx) => {
    if (!declaresTasks(ctx, server)) throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [TASKS]: {} } } }, 'Missing required client capability');
    sweep();
    const t = tasks.get(taskId);
    if (!t) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Failed to ${method === 'tasks/get' ? 'retrieve' : method === 'tasks/cancel' ? 'cancel' : 'update'} task: Task not found`);
    return t;
  };
  server.setRequestHandler('tasks/get', { params }, (p, ctx) => view(find('tasks/get', p, ctx)));
  server.setRequestHandler('tasks/cancel', { params }, (p, ctx) => {
    const t = find('tasks/cancel', p, ctx);
    if (t.status === 'working') {
      t.stop.abort(new Error('The task was cancelled.'));
      end(t, 'cancelled');
    }
    return {};
  });
  // No Glitchless task asks the client for anything (input_required), so there is never an answer to take.
  server.setRequestHandler('tasks/update', { params: z.looseObject({ taskId: z.string(), inputResponses: z.unknown().optional() }) }, (p, ctx) => {
    find('tasks/update', p, ctx);
    return {};
  });
}

// For tests: the tasks this process holds.
export const heldTasks = () => tasks;

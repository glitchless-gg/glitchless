// A query's budget: how long it may run, and how its work is told to stop.
//
// app.js runs each query inside one (runWithin). A store finds it from wherever it is in that query's work (budget(),
// kept in an AsyncLocalStorage so nothing is passed down through every call):
//
//   checkpoint()   between steps of a long read: throws once the time is up, so no further step starts
//   signal         aborts what is already waiting on a network or a database
//   hold()         keeps one of something scarce (a store's limit on heavy reads) for the whole query, given back
//                  when its work has stopped
//   notes          what the answer's Server-Timing header says about it (app.js)
//   caller         who asked (a key, a person, a share link), so a store can share what is scarce out fairly
//   inLine         set by a store while the query waits in line for a heavy read: the refusal it gets if its time runs
//                  out there, since it was kept waiting, not too big
//
// A read is refused in two ways (ReadRefused): `busy`, a 429 with Retry-After, the server is doing as many heavy reads
// as it takes on at once, so try again shortly (the server working as designed, not a fault, so not a 5xx);
// `deadline`, a 503, this one took too long and was stopped, so ask for less.
// A timer can't fire while synchronous work holds the event loop, so checkpoints read the clock themselves, and the
// answer is checked against it once more before it goes out.

import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_QUERY_DEADLINE_MS = 25_000;
// How long work that was told to stop may keep what it holds: a step with no checkpoint in it mustn't keep a heavy
// read's slot from everyone else for good.
const GRACE_MS = 5_000;

export class ReadRefused extends Error {
  // reason: 'busy' (429) or 'deadline' (503); retryAfter: seconds, when trying again soon is the thing to do.
  constructor(reason, message, { retryAfter = null } = {}) {
    super(message);
    this.reason = reason;
    this.status = reason === 'busy' ? 429 : 503;
    this.retryAfter = retryAfter;
  }
}

// "25 seconds", "1 second", "0.2 seconds".
export function seconds(ms) {
  const s = ms / 1000;
  const n = s >= 10 ? Math.round(s) : Math.round(s * 10) / 10 || Math.round(s * 100) / 100;
  return `${n} second${n === 1 ? '' : 's'}`;
}

export const tooLong = (deadlineMs) => new ReadRefused('deadline', `This took more than ${seconds(deadlineMs)} to read, so it was stopped. Ask for a shorter range.`);
export const tooBusy = (retryAfter) => new ReadRefused('busy', `Glitchless is busy with other large reads. Try again in ${seconds(retryAfter * 1000)}, or ask for a shorter range.`, { retryAfter });

const current = new AsyncLocalStorage();

// The budget of the query being answered, or null outside one (a host's own reads, tests of a store).
export const budget = () => current.getStore() ?? null;

// Between steps of a long read: throws ReadRefused once the query's time is up.
export function checkpoint() {
  current.getStore()?.check();
}

// deadlineMs: 0 (or less) for no deadline. graceMs: how long stopped work may keep what it holds. caller: who asked.
export function newBudget({ deadlineMs = DEFAULT_QUERY_DEADLINE_MS, graceMs = GRACE_MS, now = Date.now, caller = null } = {}) {
  const controller = new AbortController();
  const holds = new Map();
  const ends = [];
  let ended = false;
  const b = {
    now,
    startedAt: now(),
    deadlineMs,
    graceMs,
    deadlineAt: deadlineMs > 0 ? now() + deadlineMs : Infinity,
    signal: controller.signal,
    notes: {},
    caller,
    inLine: null,
    stop() {
      if (!controller.signal.aborted) controller.abort(tooLong(deadlineMs));
    },
    check() {
      if (!controller.signal.aborted && now() >= b.deadlineAt) b.stop();
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    // The query's one hold on `key`: `acquire()` → a function that gives it back, called at the first ask only. Every
    // later ask in the same query waits on that one (or gets its refusal).
    hold(key, acquire) {
      if (!holds.has(key)) {
        holds.set(
          key,
          acquire().then((release) => {
            if (ended) release();
            else ends.push(release);
          }),
        );
      }
      return holds.get(key);
    },
    end() {
      ended = true;
      for (const release of ends.splice(0)) release();
    },
  };
  return b;
}

// fn's answer, or ReadRefused at the deadline, when the work is told to stop (it carries on to its next checkpoint,
// and what it held goes back once it has stopped, or after a few seconds if it doesn't).
export function runWithin(b, fn) {
  const work = current.run(b, async () => fn());
  work.then(b.end, b.end);
  if (b.deadlineAt === Infinity) return work;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        const waiting = b.inLine;
        b.stop();
        reject(waiting ?? b.signal.reason);
        setTimeout(b.end, b.graceMs).unref?.();
      },
      Math.max(0, b.deadlineAt - b.now()),
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        // The work may have finished late with the timer still waiting for its turn.
        try {
          b.check();
          resolve(value);
        } catch (err) {
          reject(err);
        }
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// A deadline setting from the environment (milliseconds; 0 turns it off), or the default.
export function deadlineFrom(value) {
  const ms = Number(value);
  return value != null && value !== '' && Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_QUERY_DEADLINE_MS;
}

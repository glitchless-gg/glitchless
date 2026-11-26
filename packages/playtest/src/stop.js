// Stopping a playtest or a game check part-way, with an AbortSignal (signal): an MCP client cancelling its task, or a
// script giving up. Each runner closes its browser, kills its build or stops Studio's play test when the signal fires,
// and the run ends with the signal's reason instead of whatever closing the browser made the step in hand throw.

// Calls stop() once the signal fires (at once if it already has). → a function that forgets it.
export function onStop(signal, stop) {
  if (!signal) return () => {};
  if (signal.aborted) {
    stop();
    return () => {};
  }
  signal.addEventListener('abort', stop, { once: true });
  return () => signal.removeEventListener('abort', stop);
}

// The error a run ends with: the signal's reason once it has fired, else err.
export function stopped(signal, err) {
  if (!signal?.aborted) return err;
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'The playtest was stopped.'));
}

// Throws the signal's reason once it has fired.
export function checkStop(signal) {
  if (signal?.aborted) throw stopped(signal);
}

// A pause that ends early, with the signal's reason, once the signal fires.
export function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (forget(), resolve()), ms);
    const forget = onStop(signal, () => {
      clearTimeout(timer);
      reject(stopped(signal));
    });
  });
}

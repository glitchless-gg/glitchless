// Error grouping key: kind + normalized message + the function that threw.
// File names are left out on purpose: the same bug is "popups.js" under a dev server and
// "index-3f9a.js" in a production bundle, and it should still be one issue.

export function normalizeMessage(msg = '') {
  return String(msg)
    .replace(/^Uncaught\s+/, '')
    .replace(/\d{3,}/g, 'N')
    .replace(/0x[0-9a-f]+/gi, 'X')
    .slice(0, 200);
}

export function fingerprint(kind, message, fn = '') {
  return hash(`${kind}|${normalizeMessage(message)}|${fn}`);
}

export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

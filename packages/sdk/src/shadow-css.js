// The CSS of the SDK's own UI (the overlay, the bug report form) in the shadow root it draws in. A stylesheet made in
// script where the browser can (adoptedStyleSheets): a page whose Content-Security-Policy refuses inline styles, as a
// game in a Reddit post has (SPEC §5g), drops a <style> element but takes a constructed stylesheet. Elsewhere, the
// <style> element this returns, for the caller to put first in the root's markup.
export function styleRoot(root, css) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
    return '';
  } catch {
    return `<style>${css}</style>`;
  }
}

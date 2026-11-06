// The browser, version, OS and phone flag session_start.device takes from the user agent (parseUserAgent, device.js),
// as players' browsers send them. The Unity SDK reads its page by the same rules (unity/test/make-fixtures.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUserAgent } from '../src/device.js';

const read = (ua, mobile) => {
  const r = parseUserAgent({ userAgent: ua, userAgentData: mobile == null ? undefined : { mobile } });
  return [r.browser, r.browserVersion, r.os, r.mobile];
};

test('each browser by its own name and version, wherever its token sits', () => {
  const cases = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', false, ['Chrome', '141', 'macOS', false]],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', null, ['Safari', '26', 'macOS', false]],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0', null, ['Firefox', '144', 'Windows', false]],
    // Edge and Opera say Chrome/ first: the leftmost token named them Chrome 141.
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', false, ['Edge', '141', 'Windows', false]],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0', false, ['Opera', '125', 'Windows', false]],
    ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0', true, ['Edge', '141', 'Android', true]],
    ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 OPR/92.0.0.0', true, ['Opera', '92', 'Android', true]],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19041', null, ['Edge', '18', 'Windows', false]],
    // On iOS every browser is WebKit and says Safari/; Firefox read as Safari 605.
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15', null, ['Firefox', '144', 'iOS', true]],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.3537.71 Mobile/15E148 Safari/605.1.15', null, ['Edge', '141', 'iOS', true]],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1', null, ['Chrome', '141', 'iOS', true]],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', null, ['Safari', '18', 'iOS', true]],
    ['Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', null, ['Safari', '18', 'iOS', true]],
  ];
  for (const [ua, mobile, want] of cases) assert.deepEqual(read(ua, mobile), want, ua);
});

test('other Chromium browsers are Chrome with Chromium\'s version', () => {
  // Samsung Internet, which SPEC's list of browsers doesn't name, and Android's web view, which says Version/4.0 first.
  assert.deepEqual(read('Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36'), ['Chrome', '122', 'Android', true]);
  assert.deepEqual(read('Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36', true), ['Chrome', '141', 'Android', true]);
  // A playtest bot's headless Chrome.
  assert.deepEqual(read('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36'), ['Chrome', '141', 'Linux', false]);
  assert.deepEqual(read('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', false), ['Chrome', '141', 'ChromeOS', false]);
});

test('userAgentData decides a phone where the browser gives it, and an unknown agent is Other', () => {
  const tablet = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  assert.equal(read(tablet, false)[3], false, 'an Android tablet');
  assert.equal(read(tablet)[3], true, 'no userAgentData: Android is a phone');
  assert.deepEqual(read(''), ['Other', '', 'Other', false]);
  assert.deepEqual(read('curl/8.7.1'), ['Other', '', 'Other', false]);
});

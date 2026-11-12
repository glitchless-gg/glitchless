// Glitchless for Unity's side of the page in a WebGL build (Runtime/WebPage.cs calls it; nothing else is built with
// it). Two things only the page knows:
//   - what the browser says about itself (its user agent, whether it is a phone, the pixel ratio and the screen), raw:
//     WebPage.cs reads it the way the browser SDK does (packages/sdk/src/device.js), so a Unity web game and a
//     Three.js game split by browser and OS alike;
//   - the page's lifecycle. WebGL has one thread, so a request the game waits on as the page goes can never move:
//     the last batches go by navigator.sendBeacon instead, which the browser sends after the page has gone, the way
//     the browser SDK sends its own (core.js installLifecycle). In a Reddit post (SPEC §5g) they go by the page's own
//     fetch with keepalive, which the browser also finishes after the page has gone: the app's /api/ routes take only
//     requests with the app's token, which Reddit's script on the page adds to its fetches and a beacon can't carry.
var GlitchlessPage = {
  // A JSON string: { ua, mobile, dpr, screen }. mobile is userAgentData's (Chromium, on https) or null.
  GlitchlessPageFacts: function () {
    var facts = { ua: '', mobile: null, dpr: null, screen: null };
    try {
      var nav = typeof navigator !== 'undefined' ? navigator : {};
      facts.ua = nav.userAgent || '';
      if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean') facts.mobile = nav.userAgentData.mobile;
      if (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) facts.dpr = devicePixelRatio;
      if (typeof screen !== 'undefined' && screen.width > 0) facts.screen = [screen.width, screen.height];
    } catch (e) {
      // A locked-down page: whatever was read so far.
    }
    var text = JSON.stringify(facts);
    var size = lengthBytesUTF8(text) + 1;
    var buffer = _malloc(size);
    stringToUTF8(text, buffer, size);
    return buffer;
  },

  // Queues a POST of length bytes at body with navigator.sendBeacon. 1 when the browser took it; 0 when there is no
  // sendBeacon or the browser turned it down (it takes about 64 KB at a time, for the whole page).
  GlitchlessPageBeacon: function (url, body, length) {
    try {
      var bytes = HEAPU8.slice(body, body + length);
      var devvit = typeof globalThis !== 'undefined' ? globalThis.devvit : null;
      if (devvit && typeof devvit.token === 'string' && typeof fetch === 'function') {
        fetch(UTF8ToString(url), { method: 'POST', body: bytes, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(function () {});
        return 1;
      }
      if (typeof navigator === 'undefined' || !navigator.sendBeacon) return 0;
      // text/plain is safelisted, so the beacon needs no CORS preflight; the server reads the JSON whatever it says.
      return navigator.sendBeacon(UTF8ToString(url), new Blob([bytes], { type: 'text/plain' })) ? 1 : 0;
    } catch (e) {
      return 0;
    }
  },

  // Calls back with what the page did: 0 hidden (another tab or app, the phone locked), 1 shown again, 2 going away
  // (pagehide: closed, another page, or into the back-forward cache), 3 back from the back-forward cache.
  GlitchlessPageListen: function (callback) {
    var call = function (what) {
      {{{ makeDynCall('vi', 'callback') }}}(what);
    };
    document.addEventListener('visibilitychange', function () {
      call(document.visibilityState === 'hidden' ? 0 : 1);
    });
    window.addEventListener('pagehide', function () {
      call(2);
    });
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) call(3);
    });
  },
};

mergeInto(LibraryManager.library, GlitchlessPage);

// Glitchless for Unity's side of the page in a WebGL build (Runtime/WebPage.cs calls it; nothing else is built with
// it). Two things only the page knows:
//   - what the browser says about itself (its user agent, whether it is a phone, the pixel ratio and the screen), raw:
//     WebPage.cs reads it the way the browser SDK does (packages/sdk/src/device.js), so a Unity web game and a
//     Three.js game split by browser and OS alike;
//   - the page's lifecycle. WebGL has one thread, so a request the game waits on as the page goes can never move:
//     the last batches go by navigator.sendBeacon instead, which the browser sends after the page has gone, the way
//     the browser SDK sends its own (core.js installLifecycle).
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
      if (typeof navigator === 'undefined' || !navigator.sendBeacon) return 0;
      // text/plain is safelisted, so the beacon needs no CORS preflight; the server reads the JSON whatever it says.
      var blob = new Blob([HEAPU8.slice(body, body + length)], { type: 'text/plain' });
      return navigator.sendBeacon(UTF8ToString(url), blob) ? 1 : 0;
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

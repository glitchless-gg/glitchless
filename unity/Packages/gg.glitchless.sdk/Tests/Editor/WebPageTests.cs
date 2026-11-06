using NUnit.Framework;

namespace GlitchlessSdk.Tests
{
    /// <summary>
    /// What a WebGL build's device says, from what its page told the jslib (WebPage.FromJson, DeviceInfo.Collect). The
    /// jslib itself, the beacons and the page's events only run in a browser: a Web build shows those (the package
    /// README's WebGL paragraph). ParityTests checks the user agents against the browser SDK.
    /// </summary>
    public class WebPageTests
    {
        const string MacChrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
        const string AndroidChrome = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
        const string DeckChrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

        static string Page(string ua, string mobile = "null", string dpr = "2", string screen = "[1512,982]") =>
            $"{{\"ua\":{Json.Serialize(ua)},\"mobile\":{mobile},\"dpr\":{dpr},\"screen\":{screen}}}";

        [Test]
        public void ThePageSaysTheBrowserOsPixelRatioAndScreen()
        {
            var f = WebPage.FromJson(Page(MacChrome), "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)");
            Assert.AreEqual("Chrome", f.Browser);
            Assert.AreEqual("141", f.BrowserVersion, "the major version, as the browser SDK sends it");
            Assert.AreEqual("macOS", f.Os);
            Assert.IsFalse(f.Mobile);
            Assert.AreEqual(2.0, f.Dpr);
            CollectionAssert.AreEqual(new[] { 1512, 982 }, f.Screen);
            Assert.IsFalse(f.SteamDeck);
        }

        [Test]
        public void UserAgentDataSaysWhetherItIsAPhone()
        {
            Assert.IsTrue(WebPage.FromJson(Page(AndroidChrome), "Adreno (TM) 740").Mobile, "the user agent, without userAgentData");
            Assert.IsFalse(WebPage.FromJson(Page(AndroidChrome, "false"), "Adreno (TM) 740").Mobile, "userAgentData wins: a tablet asking for the desktop site");
            Assert.IsTrue(WebPage.FromJson(Page(MacChrome, "true"), "").Mobile);
        }

        [Test]
        public void PixelRatioRoundsAsJavaScriptRoundsIt()
        {
            Assert.AreEqual(1.13, WebPage.FromJson(Page(MacChrome, dpr: "1.125"), "").Dpr, "half up, not to even");
            Assert.AreEqual(2.63, WebPage.FromJson(Page(MacChrome, dpr: "2.625"), "").Dpr);
            Assert.AreEqual(1.0, WebPage.FromJson(Page(MacChrome, dpr: "1"), "").Dpr);
            Assert.IsNull(WebPage.FromJson(Page(MacChrome, dpr: "null"), "").Dpr);
            Assert.IsNull(WebPage.FromJson(Page(MacChrome, screen: "null"), "").Screen);
            Assert.IsNull(WebPage.FromJson(Page(MacChrome, screen: "[0,0]"), "").Screen, "a page with no screen to speak of");
        }

        [Test]
        public void ASteamDeckFromItsGpu()
        {
            var f = WebPage.FromJson(Page(DeckChrome), "AMD Custom GPU 0405 (vangogh, LLVM 15.0.7, DRM 3.54, 6.5.0-valve22-1-neptune-65)");
            Assert.IsTrue(f.SteamDeck);
            Assert.AreEqual("Linux", f.Os, "the browser SDK's OS; the server's platform split says Steam Deck from steam_deck");
            var device = DeviceInfo.Collect(false, f);
            Assert.AreEqual(true, device["steam_deck"]);
            Assert.AreEqual("low", device["gpu_tier"], "a Deck's GPU is low, as every SDK has it");
        }

        [Test]
        public void NothingReadableIsNoPage()
        {
            Assert.IsNull(WebPage.FromJson(null, ""));
            Assert.IsNull(WebPage.FromJson("", ""));
            Assert.IsNull(WebPage.FromJson("not json", ""));
            Assert.IsNull(WebPage.FromJson("[1,2]", ""));
            var f = WebPage.FromJson("{}", "");
            Assert.AreEqual("Other", f.Browser);
            Assert.IsNull(f.BrowserVersion);
            Assert.AreEqual("Other", f.Os);
        }

        [Test]
        public void AWebBuildsDeviceIsTheBrowsers()
        {
            var device = DeviceInfo.Collect(false, WebPage.FromJson(Page(AndroidChrome, "true", "2.625", "[412,915]"), "Adreno (TM) 740"));
            Assert.AreEqual("Chrome", device["browser"]);
            Assert.AreEqual("141", device["browser_version"]);
            Assert.AreEqual("Android", device["os"]);
            Assert.AreEqual(true, device["mobile"]);
            Assert.AreEqual(2.63, device["dpr"]);
            CollectionAssert.AreEqual(new[] { 412, 915 }, (int[])device["screen"]);
            Assert.AreEqual(device["device_tier"], device["gpu_tier"], "a phone's GPU tier is its device tier");
            Assert.IsFalse(device.ContainsKey("gpu"), "anonymous mode has no GPU name");
        }

        [Test]
        public void OutsideABrowserTheDeviceIsUnitys()
        {
            Assert.IsFalse(WebPage.InPage, "the Editor is no page");
            Assert.IsNull(WebPage.Read());
            Assert.IsFalse(WebPage.Beacon("http://localhost:7777/v1/intake", new byte[] { 1 }), "no beacon outside a page");
            var device = DeviceInfo.Collect(false);
            Assert.AreEqual("Unity", device["browser"]);
            Assert.AreEqual(UnityEngine.Application.unityVersion, device["browser_version"]);
            Assert.AreEqual("macOS", device["os"], "this Mac's Editor");
            Assert.IsNull(device["dpr"]);
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;

namespace GlitchlessSdk.Tests
{
    /// <summary>Steamworks.NET as of SDK 1.65, as far as SteamInfo reads it: static methods that throw before SteamAPI.Init.</summary>
    public static class FakeNet
    {
        public static bool Initialized = true;
        public static int Build = 18231;
        public static string Beta;
        public static int Hardware;
        public static int Controllers;
        public static int OwnerCalls;

        static void Check()
        {
            if (!Initialized) throw new InvalidOperationException("Steamworks is not initialized.");
        }

        public enum ESteamHardwareType { k_ESteamHardwareTypeNone, k_ESteamHardwareTypeSteamDeck, k_ESteamHardwareTypeSteamMachine, k_ESteamHardwareTypeSteamFrame }

        public enum ESteamInputType { k_ESteamInputType_Unknown, k_ESteamInputType_SteamController, k_ESteamInputType_XBox360Controller, k_ESteamInputType_XBoxOneController, k_ESteamInputType_GenericGamepad, k_ESteamInputType_PS4Controller, k_ESteamInputType_AppleMFiController, k_ESteamInputType_AndroidController, k_ESteamInputType_SwitchJoyConPair, k_ESteamInputType_SwitchJoyConSingle, k_ESteamInputType_SwitchProController, k_ESteamInputType_MobileTouch, k_ESteamInputType_PS3Controller, k_ESteamInputType_PS5Controller, k_ESteamInputType_SteamDeckController }

        public struct InputHandle_t
        {
            public ulong m_InputHandle;
        }

        public static class SteamApps
        {
            public static int GetAppBuildId() { Check(); return Build; }

            public static bool GetCurrentBetaName(out string pchName, int cchNameBufferSize) { Check(); pchName = Beta ?? ""; return Beta != null; }

            public static bool BIsSubscribedFromFamilySharing() { Check(); return true; }

            public static bool BIsTimedTrial(out uint punSecondsAllowed, out uint punSecondsPlayed) { Check(); punSecondsAllowed = 3600; punSecondsPlayed = 60; return false; }

            public static string GetCurrentGameLanguage() { Check(); return "schinese"; }

            public static ulong GetAppOwner() { OwnerCalls++; return 76561197960287930UL; }
        }

        public static class SteamUtils
        {
            public static ESteamHardwareType IsRunningOnSteamHardware() { Check(); return (ESteamHardwareType)Hardware; }

            public static bool IsRunningUnderProton() { Check(); return Hardware == 1; }

            public static bool IsSteamInBigPictureMode() { Check(); return Hardware == 1; }

            public static bool IsSteamRunningOnSteamDeck() { Check(); return Hardware == 1; }
        }

        public static class SteamInput
        {
            public static int GetConnectedControllers(InputHandle_t[] handlesOut)
            {
                Check();
                for (var i = 0; i < Controllers; i++) handlesOut[i] = new InputHandle_t { m_InputHandle = (ulong)(100 + i) };
                return Controllers;
            }

            public static ESteamInputType GetInputTypeForHandle(InputHandle_t inputHandle) { Check(); return inputHandle.m_InputHandle == 100 ? ESteamInputType.k_ESteamInputType_PS5Controller : ESteamInputType.k_ESteamInputType_XBoxOneController; }
        }
    }

    /// <summary>An older Steamworks.NET: no IsRunningOnSteamHardware, Proton or Steam Input.</summary>
    public static class FakeNetOld
    {
        public static class SteamApps
        {
            public static int GetAppBuildId() => 0;

            public static bool GetCurrentBetaName(out string pchName, int cchNameBufferSize) { pchName = ""; return false; }
        }

        public static class SteamUtils
        {
            public static bool IsSteamRunningOnSteamDeck() => true;
        }
    }

    /// <summary>Facepunch.Steamworks: properties, valid after SteamClient.Init.</summary>
    public static class FakeFacepunch
    {
        public static bool Valid = true;

        public enum InputType { Unknown, SteamController, XBox360Controller, XBoxOneController, GenericGamepad, PS4Controller, AppleMFiController, AndroidController, SwitchJoyConPair, SwitchJoyConSingle, SwitchProController, MobileTouch, PS3Controller, PS5Controller, SteamDeckController }

        public class Controller
        {
            public InputType InputType => InputType.SteamDeckController;
        }

        public static class SteamClient
        {
            public static bool IsValid => Valid;

            public static ulong SteamId => throw new InvalidOperationException("SteamInfo must never read a Steam ID");
        }

        public static class SteamApps
        {
            public static int BuildId => Valid ? 9001 : throw new NullReferenceException();

            public static string CurrentBetaName => "playtest";

            public static bool IsSubscribedFromFamilySharing => false;

            public static string GameLanguage => "english";

            public static bool IsTimedTrial(out int secondsAllowed, out int secondsPlayed) { secondsAllowed = 0; secondsPlayed = 0; return true; }
        }

        public static class SteamUtils
        {
            public static bool IsRunningOnSteamDeck => true;

            public static bool IsSteamInBigPictureMode => false;
        }

        public static class SteamInput
        {
            public static IEnumerable<Controller> Controllers => new[] { new Controller() };
        }
    }

    public class SteamTests
    {
        double now;
        FakeTransport transport;
        string dir;

        static Func<string, Type> In(Type wrapper) => name => wrapper.GetNestedType(name);

        [SetUp]
        public void SetUp()
        {
            now = 1000;
            transport = new FakeTransport();
            dir = Path.Combine(Path.GetTempPath(), "glitchless-tests-" + Guid.NewGuid().ToString("N"));
            FakeNet.Initialized = true;
            FakeNet.Build = 18231;
            FakeNet.Beta = null;
            FakeNet.Hardware = 0;
            FakeNet.Controllers = 0;
            FakeNet.OwnerCalls = 0;
            FakeFacepunch.Valid = true;
        }

        [TearDown]
        public void TearDown()
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }

        GlitchlessCore NewCore(Func<Dictionary<string, object>> steam) => new GlitchlessCore
        {
            Transport = transport,
            SaveDir = dir,
            Clock = () => now,
            UnixNow = () => 1_761_000_000_000L + (long)now,
            Args = () => new string[0],
            Log = _ => { },
            Device = DeviceInfo.Collect,
            Steam = steam,
            AppVersion = "1.2.3",
            IsDebugBuild = true,
        };

        static GlitchlessOptions Options(string version = "") => new GlitchlessOptions { Service = "skyline", Intake = "http://localhost:7777/", Version = version };

        Dictionary<string, object> SentDevice() => (Dictionary<string, object>)transport.Events().First(e => (string)e["type"] == "session_start")["device"];

        string SentVersion() => (string)((Dictionary<string, object>)Json.Parse(transport.Sent[0]))["version"];

        [Test]
        public void SteamworksNetAnswersEveryFact()
        {
            FakeNet.Beta = "beta";
            FakeNet.Hardware = 1;
            FakeNet.Controllers = 2;
            var facts = SteamInfo.ReadFrom(In(typeof(FakeNet)));
            Assert.AreEqual(18231L, facts["steam_build"]);
            Assert.AreEqual("beta", facts["steam_branch"]);
            Assert.AreEqual("deck", facts["steam_hardware"]);
            Assert.AreEqual(true, facts["proton"]);
            Assert.AreEqual(true, facts["big_picture"]);
            Assert.AreEqual(true, facts["family_shared"]);
            Assert.AreEqual(false, facts["timed_trial"]);
            Assert.AreEqual("ps5", facts["steam_controller"], "the first controller");
            Assert.AreEqual("schinese", facts["steam_language"]);
            Assert.AreEqual(0, FakeNet.OwnerCalls, "the owner's Steam ID is never read");
        }

        [Test]
        public void DefaultBranchIsPublicAndNonSteamBuildsSendNoBuild()
        {
            FakeNet.Build = 0;
            FakeNet.Hardware = 2;
            var facts = SteamInfo.ReadFrom(In(typeof(FakeNet)));
            Assert.IsFalse(facts.ContainsKey("steam_build"), "GetAppBuildId is 0 outside a Steam build");
            Assert.AreEqual("public", facts["steam_branch"]);
            Assert.AreEqual("machine", facts["steam_hardware"]);
            Assert.IsFalse(facts.ContainsKey("steam_controller"), "no controller until the game starts Steam Input");
        }

        [Test]
        public void NothingBeforeSteamworksIsInitialised()
        {
            FakeNet.Initialized = false;
            Assert.IsNull(SteamInfo.ReadFrom(In(typeof(FakeNet))));
            FakeNet.Initialized = true;
            Assert.IsNull(SteamInfo.ReadFrom(In(typeof(FakeNet)), () => false), "SteamManager.Initialized says not yet");
            Assert.IsNotNull(SteamInfo.ReadFrom(In(typeof(FakeNet)), () => true));
            FakeFacepunch.Valid = false;
            Assert.IsNull(SteamInfo.ReadFrom(In(typeof(FakeFacepunch))));
            Assert.IsNull(SteamInfo.ReadFrom(_ => null), "no wrapper");
            Assert.IsNull(SteamInfo.Read(), "the Editor has no Steamworks loaded");
        }

        [Test]
        public void OlderWrappersSendWhatTheyHave()
        {
            var facts = SteamInfo.ReadFrom(In(typeof(FakeNetOld)));
            CollectionAssert.AreEquivalent(new[] { "steam_branch", "steam_hardware" }, facts.Keys.ToList());
            Assert.AreEqual("deck", facts["steam_hardware"], "IsSteamRunningOnSteamDeck before SDK 1.65");
        }

        [Test]
        public void FacepunchAnswersFromItsProperties()
        {
            var facts = SteamInfo.ReadFrom(In(typeof(FakeFacepunch)));
            Assert.AreEqual(9001L, facts["steam_build"]);
            Assert.AreEqual("playtest", facts["steam_branch"]);
            Assert.AreEqual("deck", facts["steam_hardware"]);
            Assert.AreEqual(false, facts["big_picture"]);
            Assert.AreEqual(false, facts["family_shared"]);
            Assert.AreEqual(true, facts["timed_trial"]);
            Assert.AreEqual("steam_deck", facts["steam_controller"]);
            Assert.AreEqual("english", facts["steam_language"]);
            Assert.IsFalse(facts.ContainsKey("proton"), "Facepunch has no Proton call");
        }

        [Test]
        public void ControllerAndHardwareNames()
        {
            Assert.AreEqual("xbox_one", SteamInfo.ControllerName(3));
            Assert.AreEqual("steam_frame_controllers", SteamInfo.ControllerName(18));
            Assert.AreEqual("other", SteamInfo.ControllerName(99));
            Assert.AreEqual("frame", SteamInfo.HardwareName(3));
            Assert.AreEqual("none", SteamInfo.HardwareName(7));
        }

        [Test]
        public void SessionStartCarriesTheFactsAndTheBuildIsTheVersion()
        {
            FakeNet.Beta = "beta";
            FakeNet.Hardware = 1;
            var core = NewCore(() => SteamInfo.ReadFrom(In(typeof(FakeNet))));
            core.Init(Options());
            core.Flush();
            var device = SentDevice();
            Assert.AreEqual(18231L, device["steam_build"]);
            Assert.AreEqual("beta", device["steam_branch"]);
            Assert.AreEqual(true, device["steam_deck"], "Steamworks' Steam Deck is a Steam Deck");
            Assert.AreEqual("low", device["gpu_tier"]);
            Assert.AreEqual("steam-18231", SentVersion(), "no version given: the Steam build");
            foreach (var body in transport.Sent) StringAssert.DoesNotContain("76561197960287930", body);
        }

        [Test]
        public void TheGamesVersionWinsAndNoSteamworksMeansNoFacts()
        {
            var core = NewCore(() => SteamInfo.ReadFrom(In(typeof(FakeNet))));
            core.Init(Options("2.0.0"));
            core.Flush();
            Assert.AreEqual("2.0.0", SentVersion());
            Assert.AreEqual("public", SentDevice()["steam_branch"]);

            transport = new FakeTransport();
            var plain = NewCore(() => null);
            plain.Init(Options());
            plain.Flush();
            Assert.AreEqual("1.2.3", SentVersion(), "Application.version without Steam");
            Assert.IsFalse(SentDevice().Keys.Any(k => k.StartsWith("steam_") && k != "steam_deck"));
        }

        [Test]
        public void SteamInitialisedAfterGlitchlessStillCounts()
        {
            FakeNet.Initialized = false;
            var core = NewCore(() => SteamInfo.ReadFrom(In(typeof(FakeNet))));
            core.Init(Options());
            FakeNet.Initialized = true; // the game's SteamManager.Awake ran after Glitchless.Init
            core.Flush();
            Assert.AreEqual(18231L, SentDevice()["steam_build"]);
            Assert.AreEqual("steam-18231", SentVersion());
        }
    }
}

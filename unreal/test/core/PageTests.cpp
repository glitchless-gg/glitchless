// A web build's page (Private/Core/GlitchlessPage.cpp) must read user agents, GPUs and the Steam Deck as the
// browser SDK's device.js does, so an Unreal web game splits by browser, OS and GPU like every other web game.
// fixtures/js-fixture.json holds device.js's answers (unreal/test/make-fixtures.mjs). The rest is the web
// build's own rules: which pages are the developer's, which flags a page's address may carry, and the device.

#include "GlitchlessPage.h"
#include "GlitchlessText.h"
#include "TestMain.h"

#include <cstdio>

using namespace Glitchless;

namespace
{
	const FValue& Fixture()
	{
		static FValue Data;
		static bool Loaded = false;
		if (!Loaded)
		{
			Loaded = true;
			std::FILE* F = std::fopen(GlitchlessTest::FixturePath.c_str(), "rb");
			if (!F)
			{
				return Data;
			}
			std::string Text;
			char Buf[65536];
			size_t N;
			while ((N = std::fread(Buf, 1, sizeof(Buf), F)) > 0)
			{
				Text.append(Buf, N);
			}
			std::fclose(F);
			FValue::Parse(Text, Data);
		}
		return Data;
	}

	const std::vector<FValue>& Rows(const char* Key)
	{
		static const std::vector<FValue> None;
		const FValue* V = Fixture().Find(Key);
		return V ? V->GetItems() : None;
	}
}

TEST(PageUserAgentsMatchDeviceJs)
{
	EXPECT(Rows("user_agents").size() > 20);
	for (const FValue& Row : Rows("user_agents"))
	{
		const FValue* Uad = Row.Find("uad_mobile");
		const int UadMobile = Uad && Uad->GetType() == FValue::EType::Bool ? (Uad->AsBool() ? 1 : 0) : -1;
		const Page::FUserAgent U = Page::ParseUserAgent(Row.Find("ua")->AsString(), UadMobile);
		EXPECT_EQ(U.Browser, Row.Find("browser")->AsString());
		EXPECT_EQ(U.BrowserVersion, Row.Find("browser_version")->AsString());
		EXPECT_EQ(U.Os, Row.Find("os")->AsString());
		EXPECT_EQ(U.Mobile, Row.Find("mobile")->AsBool());
	}
}

TEST(PageSteamDecksMatchDeviceJs)
{
	EXPECT(Rows("steam_decks").size() > 5);
	for (const FValue& Row : Rows("steam_decks"))
	{
		EXPECT_EQ(Page::IsSteamDeck(Row.Find("ua")->AsString(), Row.Find("gpu")->AsString()), Row.Find("steam_deck")->AsBool());
	}
}

TEST(PageGpusMatchDeviceJs)
{
	EXPECT(Rows("gpus").size() > 20);
	for (const FValue& Row : Rows("gpus"))
	{
		const std::string Name = Page::CleanGpu(Row.Find("renderer")->AsString());
		EXPECT_EQ(Name, Row.Find("name")->AsString());
		EXPECT_EQ(Page::CleanVendor(Row.Find("vendor")->AsString(), Row.Find("renderer")->AsString()), Row.Find("gpu_vendor")->AsString());
		EXPECT_EQ(DeviceFacts::GpuTier(Name), Row.Find("tier")->AsString());
	}
}

TEST(PageOnTheDevelopersMachineIsLocal)
{
	for (const char* Host : {"localhost", "127.0.0.1", "[::1]", "game.localhost", "mac.local", "10.0.0.5", "192.168.1.20", "169.254.3.4", "172.16.0.1", "172.31.255.255", "LOCALHOST", ""})
	{
		EXPECT(Page::IsLocal("http:", Host));
	}
	EXPECT(Page::IsLocal("file:", "anything.example.com"));
	for (const char* Host : {"html-classic.itch.zone", "game.test", "172.15.0.1", "172.32.0.1", "11.0.0.1", "192.169.0.1", "localhost.example.com", "1270.0.0.1"})
	{
		EXPECT(!Page::IsLocal("https:", Host));
	}
}

TEST(PageFlagsAreOnlyGlitchlessOnes)
{
	EXPECT(Page::Flags("").empty());
	EXPECT(Page::Flags("?").empty());
	const std::vector<std::string> F = Page::Flags("?glitchless&x=1&glitchless-synthetic=1&glitchless-intake=https://evil.example&%67litchless-debug");
	EXPECT_EQ(F.size(), static_cast<size_t>(3));
	if (F.size() == 3)
	{
		EXPECT_EQ(F[0], "-glitchless");
		EXPECT_EQ(F[1], "-glitchless-synthetic");
		EXPECT_EQ(F[2], "-glitchless-debug");
	}
	EXPECT(Page::Flags("?args=-glitchless&glitchlessx").empty());
}

TEST(PageFactsBecomeTheBrowserSdksDevice)
{
	Page::FFacts P;
	EXPECT(Page::ParseFacts(R"J({"ua":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36","mobile":false,"dpr":2.625,"screen":[1512,982],"cores":12,"memory":8,"gpu":"ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)","vendor":"Google Inc. (Apple)","protocol":"https:","host":"html-classic.itch.zone","search":"?glitchless"})J", P));
	EXPECT_EQ(P.UadMobile, 0);
	EXPECT_EQ(P.ScreenWidth, 1512);
	EXPECT_EQ(P.Host, "html-classic.itch.zone");

	const FValue Anon = Page::Device(P, false);
	EXPECT_EQ(Anon.Serialize(), R"J({"browser":"Chrome","browser_version":"141","os":"macOS","mobile":false,"device_tier":"high","gpu_tier":"high","screen":[1512,982],"dpr":2.63,"refresh_hz":null,"steam_deck":false})J");
	const FValue Full = Page::Device(P, true);
	EXPECT_EQ(Full.Find("gpu")->AsString(), "Apple M3 Pro");
	EXPECT_EQ(Full.Find("gpu_vendor")->AsString(), "Apple");
	EXPECT_EQ(Full.Find("cores")->AsNumber(), 12);
	EXPECT_EQ(Full.Find("memory_gb")->AsNumber(), 8);

	// Safari and Firefox keep the memory and userAgentData to themselves; a page that says nothing says nothing.
	Page::FFacts Safari;
	EXPECT(Page::ParseFacts(R"J({"ua":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1","mobile":null,"dpr":3,"screen":[393,852],"cores":4,"memory":null,"gpu":"Apple GPU","vendor":"Apple Inc."})J", Safari));
	EXPECT_EQ(Safari.UadMobile, -1);
	EXPECT_EQ(Page::Device(Safari, true).Serialize(), R"J({"browser":"Safari","browser_version":"18","os":"iOS","mobile":true,"device_tier":"unknown","gpu_tier":"low","screen":[393,852],"dpr":3,"refresh_hz":null,"steam_deck":false,"gpu":"Apple GPU","gpu_vendor":"Apple","cores":4,"memory_gb":null})J");

	Page::FFacts Empty;
	EXPECT(Page::ParseFacts("{}", Empty));
	EXPECT_EQ(Page::Device(Empty, false).Serialize(), R"J({"browser":"Other","browser_version":null,"os":"Other","mobile":false,"device_tier":"unknown","gpu_tier":"unknown","screen":null,"dpr":null,"refresh_hz":null,"steam_deck":false})J");
	EXPECT(!Page::ParseFacts("not json", Empty));

	Page::FFacts Deck;
	EXPECT(Page::ParseFacts(R"J({"ua":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36","gpu":"AMD Custom GPU 0405 (vangogh, LLVM 15.0.7)"})J", Deck));
	const FValue D = Page::Device(Deck, false);
	EXPECT(D.Find("steam_deck")->AsBool());
	EXPECT_EQ(D.Find("gpu_tier")->AsString(), "low");
}

// Steam facts through Steam's flat C API (GlitchlessSteam.h), with fake functions where the steam_api library's
// would be: what each call answers, what a library without a call leaves out, and nothing before SteamAPI_Init.

#include "GlitchlessSteam.h"
#include "TestMain.h"

#include <cstring>

using namespace Glitchless;

namespace
{
	/** What the fake library answers; reset by each test. */
	struct FFakeSteam
	{
		int Build = 18231;
		const char* Beta = nullptr;
		int Hardware = 0;
		int Controllers = 0;
		int Calls = 0;
	};
	FFakeSteam Fake;
	int AppsObject, UtilsObject, InputObject; // the interfaces' addresses, all the flat functions see

	int GetAppBuildId(void* Apps) { Fake.Calls++; return Apps == &AppsObject ? Fake.Build : -1; }
	bool GetCurrentBetaName(void*, char* Name, int Size)
	{
		std::strncpy(Name, Fake.Beta ? Fake.Beta : "", static_cast<size_t>(Size));
		return Fake.Beta != nullptr;
	}
	bool FamilySharing(void*) { return true; }
	bool TimedTrial(void*, uint32_t* Allowed, uint32_t* Played)
	{
		*Allowed = 3600;
		*Played = 60;
		return false;
	}
	const char* Language(void*) { return "german"; }
	int SteamHardware(void* Utils) { return Utils == &UtilsObject ? Fake.Hardware : -1; }
	bool OnSteamDeck(void*) { return true; }
	bool Proton(void*) { return Fake.Hardware == 1; }
	bool BigPicture(void*) { return Fake.Hardware == 1; }
	int ConnectedControllers(void*, uint64_t* Handles)
	{
		for (int I = 0; I < Fake.Controllers; I++)
		{
			Handles[I] = 900 + static_cast<uint64_t>(I);
		}
		return Fake.Controllers;
	}
	int InputType(void*, uint64_t Handle) { return Handle == 900 ? 13 : 3; } // the first is a PS5 controller

	/** A library of SDK 1.65: every call there. */
	Steam::FApi Sdk165()
	{
		Steam::FApi A;
		A.Apps = &AppsObject;
		A.Utils = &UtilsObject;
		A.Input = &InputObject;
		A.GetAppBuildId = GetAppBuildId;
		A.GetCurrentBetaName = GetCurrentBetaName;
		A.BIsSubscribedFromFamilySharing = FamilySharing;
		A.BIsTimedTrial = TimedTrial;
		A.GetCurrentGameLanguage = Language;
		A.IsRunningOnSteamHardware = SteamHardware;
		A.IsSteamRunningOnSteamDeck = OnSteamDeck;
		A.IsRunningUnderProton = Proton;
		A.IsSteamInBigPictureMode = BigPicture;
		A.GetConnectedControllers = ConnectedControllers;
		A.GetInputTypeForHandle = InputType;
		return A;
	}

	std::string Str(const FValue& F, const char* Key)
	{
		const FValue* V = F.Find(Key);
		return V && V->IsString() ? V->AsString() : std::string("(none)");
	}
}

TEST(SteamFactsFromEveryCall)
{
	Fake = FFakeSteam();
	Fake.Beta = "beta";
	Fake.Hardware = 1;
	Fake.Controllers = 2;
	const FValue F = Steam::Facts(Sdk165());
	EXPECT_EQ(F.Find("steam_build")->AsInt(), 18231);
	EXPECT_EQ(Str(F, "steam_branch"), "beta");
	EXPECT_EQ(Str(F, "steam_hardware"), "deck");
	EXPECT(F.Find("proton")->AsBool());
	EXPECT(F.Find("big_picture")->AsBool());
	EXPECT(F.Find("family_shared")->AsBool());
	EXPECT(!F.Find("timed_trial")->AsBool() && F.Find("timed_trial")->GetType() == FValue::EType::Bool);
	EXPECT_EQ(Str(F, "steam_controller"), "ps5"); // the first controller
	EXPECT_EQ(Str(F, "steam_language"), "german");
}

TEST(SteamDefaultBranchIsPublicAndBuildZeroIsNoBuild)
{
	Fake = FFakeSteam();
	Fake.Build = 0;
	Fake.Hardware = 3;
	const FValue F = Steam::Facts(Sdk165());
	EXPECT(!F.Has("steam_build")); // GetAppBuildId is 0 outside a Steam build
	EXPECT_EQ(Str(F, "steam_branch"), "public");
	EXPECT_EQ(Str(F, "steam_hardware"), "frame");
	EXPECT(!F.Has("steam_controller")); // no controllers until the game starts Steam Input
}

TEST(SteamNothingBeforeSteamApiInit)
{
	Fake = FFakeSteam();
	Steam::FApi A = Sdk165();
	A.Apps = nullptr; // SteamAPI_SteamApps_v009() answers null before SteamAPI_Init
	const FValue F = Steam::Facts(A);
	EXPECT(F.IsObject() && F.Size() == 0);
	EXPECT_EQ(Fake.Calls, 0);
	EXPECT_EQ(Steam::Facts(Steam::FApi()).Size(), 0u);
}

TEST(SteamOlderLibrariesSendWhatTheyHave)
{
	Fake = FFakeSteam();
	// SDK 1.64, as Unreal 5.8 ships it: no IsRunningOnSteamHardware or IsRunningUnderProton.
	Steam::FApi A = Sdk165();
	A.IsRunningOnSteamHardware = nullptr;
	A.IsRunningUnderProton = nullptr;
	A.Input = nullptr;
	const FValue F = Steam::Facts(A);
	EXPECT_EQ(Str(F, "steam_hardware"), "deck"); // IsSteamRunningOnSteamDeck
	EXPECT(!F.Has("proton"));
	EXPECT(!F.Has("steam_controller"));
	EXPECT_EQ(F.Find("steam_build")->AsInt(), 18231);
}

TEST(SteamNamesAndTheDeviceTheyRefine)
{
	EXPECT_EQ(Steam::ControllerName(14), "steam_deck");
	EXPECT_EQ(Steam::ControllerName(18), "steam_frame_controllers");
	EXPECT_EQ(Steam::ControllerName(42), "other");
	EXPECT_EQ(Steam::HardwareName(2), "machine");
	EXPECT_EQ(Steam::HardwareName(9), "none");
	FValue Device = FValue::Object();
	Device.Set("os", "Windows");
	Device.Set("gpu_tier", "mid");
	Device.Set("steam_deck", false);
	FValue Facts = FValue::Object();
	Facts.Set("steam_hardware", "deck");
	Facts.Set("steam_build", 7);
	Steam::AddTo(Device, Facts);
	EXPECT(Device.Find("steam_deck")->AsBool()); // Steamworks' Steam Deck is a Steam Deck
	EXPECT_EQ(Str(Device, "gpu_tier"), "low");
	EXPECT_EQ(Device.Find("steam_build")->AsInt(), 7);
}

// The core's behaviour, ported from the Unity SDK's CoreTests.cs, plus what only Unreal has: maps as
// levels, hitches timed by the slowest thread, crashes kept for the next launch, bug reports.

#include "CoreHarness.h"
#include "GlitchlessCore.h"
#include "TestMain.h"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <random>

using namespace Glitchless;

TEST(KeepsEverythingUntilInitThenSendsSessionStartFirst)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->OnMapLoaded("ThirdPersonMap", 1);
	H.Frames(*Core, 30);
	Core->ReportError("log_error", "Something broke", "", FValue(), false, "LogTemp");
	EXPECT(H.Transport->Sent.empty());
	Core->Init(FHarness::Options());
	Core->Flush();
	const std::vector<FValue> Events = H.Transport->Events();
	EXPECT_EQ(Type(Events.at(0)), "session_start");
	for (const char* T : {"level_start", "error", "frame_window", "load"})
	{
		EXPECT(!OfType(Events, T).empty());
	}
	const FValue Env = H.Envelope();
	EXPECT_EQ(Env.Find("service")->AsString(), "fetch"); // service is lowercased
	EXPECT_EQ(Env.Find("version")->AsString(), "1.2.3"); // the project's version
	EXPECT_EQ(Env.Find("env")->AsString(), "dev"); // dev in the editor and development builds
	EXPECT_EQ(Env.Find("sdk")->AsString(), "glitchless-unreal/0.4.0");
	EXPECT(Env.Find("player_id")->IsNull()); // anonymous mode has no player ID
	EXPECT(Text::StartsWith(Env.Find("session_id")->AsString(), "s_"));
	EXPECT_EQ(OfType(Events, "error").at(0).Find("fn")->AsString(), "LogTemp");
}

TEST(AnonymousDeviceInfoIsCoarse)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->Flush();
	const FValue Start = OfType(H.Transport->Events(), "session_start").at(0);
	EXPECT_EQ(Start.Find("privacy")->AsString(), "anonymous");
	EXPECT(!Start.Find("device")->Has("gpu"));
	EXPECT_EQ(Start.Find("device")->Find("browser")->AsString(), "Unreal");
	EXPECT(Start.Find("page")->IsNull());
}

// Steam facts (GlitchlessSteam.h) go in session_start's device, and the Steam build is the version a game gives none.
TEST(SessionStartCarriesSteamFactsAndTheBuildIsTheVersion)
{
	FHarness H;
	auto Core = H.NewCore();
	int Reads = 0;
	Core->SteamFacts = [&Reads]() {
		FValue F = FValue::Object();
		if (++Reads < 2)
		{
			return F; // Steamworks initialised after Glitchless.Init
		}
		F.Set("steam_build", 18231);
		F.Set("steam_branch", "beta");
		F.Set("steam_hardware", "deck");
		return F;
	};
	Core->Init(FHarness::Options());
	Core->Flush();
	const FValue Device = *OfType(H.Transport->Events(), "session_start").at(0).Find("device");
	EXPECT_EQ(Device.Find("steam_build")->AsInt(), 18231);
	EXPECT_EQ(Device.Find("steam_branch")->AsString(), "beta");
	EXPECT(Device.Find("steam_deck")->AsBool());
	EXPECT_EQ(Device.Find("gpu_tier")->AsString(), "low");
	EXPECT_EQ(H.Envelope().Find("version")->AsString(), "steam-18231");
	EXPECT_EQ(Reads, 2); // read until it answers, then kept
	Core->Flush();
	EXPECT_EQ(Reads, 2);
}

TEST(TheGamesVersionWinsOverTheSteamBuild)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->SteamFacts = []() {
		FValue F = FValue::Object();
		F.Set("steam_build", 18231);
		return F;
	};
	FOptions O = FHarness::Options();
	O.Version = "2.0.0";
	Core->Init(O);
	Core->Flush();
	EXPECT_EQ(H.Envelope().Find("version")->AsString(), "2.0.0");
	FHarness Plain;
	auto NoSteam = Plain.NewCore();
	NoSteam->Init(FHarness::Options());
	NoSteam->Flush();
	EXPECT_EQ(Plain.Envelope().Find("version")->AsString(), "1.2.3"); // no Steamworks: the project's version
	EXPECT(!OfType(Plain.Transport->Events(), "session_start").at(0).Find("device")->Has("steam_branch"));
}

TEST(MapsAreLevelsExceptMenusAndLobbies)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->OnMapLoaded("Entry", 1);
	Core->OnMapLoaded("MainMenu", 2);
	Core->OnMapLoaded("L_LyraFrontEnd", 3);
	EXPECT(!Core->GetLevel());
	Core->OnMapLoaded("Lvl_ThirdPerson", 4);
	Core->OnMapLoaded("Lvl_ThirdPerson", 4); // the same load reported twice: one start
	EXPECT_EQ(*Core->GetLevel(), "Lvl_ThirdPerson");
	Core->OnMapUnloaded(4);
	EXPECT(!Core->GetLevel());
	Core->OnMapLoaded("GameOverScreen", 5);
	Core->OnMapLoaded("Level_02", 6);
	EXPECT_EQ(*Core->GetLevel(), "Level_02");
	Core->LevelStart("world-1"); // the game's own levels win from here on
	Core->OnMapLoaded("Level_03", 7);
	EXPECT_EQ(*Core->GetLevel(), "world-1");
	Core->Flush();
	std::vector<std::string> Starts;
	for (const FValue& E : OfType(H.Transport->Events(), "level_start"))
	{
		Starts.push_back(E.Find("level")->AsString());
	}
	EXPECT_EQ(Starts.size(), static_cast<size_t>(3));
	EXPECT_EQ(Starts.at(0), "Lvl_ThirdPerson");
	EXPECT_EQ(Starts.at(1), "Level_02");
	EXPECT_EQ(Starts.at(2), "world-1");
}

TEST(LevelForMapWords)
{
	for (const char* NotALevel : {"MainMenu", "Main_Menu", "L_MainMenu", "UIScene", "Boot", "Loading", "LoadingScreen", "GameOver", "Game_Over", "FrontEnd", "L_Frontend", "Lobby", "TransitionMap", "Credits", "TitleScreen", "Empty"})
	{
		EXPECT_EQ(Levels::LevelForMap(NotALevel), "");
	}
	for (const char* Level : {"ThirdPersonMap", "Lvl_FirstPerson", "Level1", "Arena", "Gameplay", "Overworld", "Untitled", "Downloadable", "Dungeon_03"})
	{
		EXPECT_EQ(Levels::LevelForMap(Level), Level);
	}
}

TEST(LevelForMapOption)
{
	FHarness H;
	auto Core = H.NewCore();
	FOptions O = FHarness::Options();
	O.LevelForMap = [](const std::string& Name) { return Text::StartsWith(Name, "Stage") ? "stage-" + Name.substr(5) : std::string(); };
	Core->Init(O);
	Core->OnMapLoaded("Level1", 1);
	EXPECT(!Core->GetLevel());
	Core->OnMapLoaded("Stage4", 2);
	EXPECT_EQ(*Core->GetLevel(), "stage-4");
}

TEST(HitchesCarryTheirCauses)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->OnMapLoaded("Arena", 1);
	Core->SetContext("enemies", 12);
	H.Frames(*Core, 60);
	FValue Attrs = FValue::Object();
	Attrs.Set("kind", "magnet");
	Core->Track("powerup", Attrs);
	FFrameCost Slow = FHarness::Cost(110, 6, 3, 8);
	Slow.GcCollections = 1;
	Slow.GcMs = 70;
	Slow.PsoCompiles = 2;
	H.Now += 120;
	Core->Frame(120, Slow);
	H.Frames(*Core, 10);
	Core->Flush();
	const std::vector<FValue> Events = H.Transport->Events();
	const std::vector<FValue> Hitches = OfType(Events, "hitch");
	EXPECT_EQ(Hitches.size(), static_cast<size_t>(1));
	const FValue& Hitch = Hitches.at(0);
	EXPECT_EQ(Hitch.Find("duration_ms")->AsNumber(), 120.0);
	EXPECT_EQ(Hitch.Find("bound")->AsString(), "game"); // the thread that held it up
	EXPECT_EQ(Hitch.Find("causes")->Serialize(), "[\"pso_compile\",\"gc\",\"script\"]");
	EXPECT_EQ(Hitch.Find("game_ms")->AsNumber(), 110.0);
	EXPECT_EQ(Hitch.Find("gc_ms")->AsNumber(), 70.0);
	EXPECT_EQ(Hitch.Find("pso_compiles")->AsInt(), 2);
	EXPECT_EQ(Hitch.Find("ctx")->Find("enemies")->AsNumber(), 12.0);
	EXPECT(Contains(*Hitch.Find("recent"), "powerup"));
	EXPECT_EQ(Hitch.Find("level")->AsString(), "Arena");
	const FValue Fw = OfType(Events, "frame_window").at(0);
	EXPECT_EQ(Fw.Find("level")->AsString(), "Arena");
	EXPECT_EQ(Fw.Find("draw_calls")->AsNumber(), 40.0);
	EXPECT(Fw.Find("game_ms")->IsNumber());
	EXPECT(Fw.Find("render_ms")->IsNumber());
	EXPECT(Fw.Find("rhi_ms")->IsNumber());
	EXPECT(Fw.Find("gpu_ms")->IsNumber());
	EXPECT_EQ(Fw.Find("process_ms")->AsNumber(), Fw.Find("game_ms")->AsNumber());
	EXPECT_EQ(Fw.Find("gc_collections")->AsInt(), 1);
	EXPECT_EQ(Fw.Find("pso_compiles")->AsInt(), 2);
	EXPECT_EQ(Fw.Find("ft")->Find("n")->AsInt(), Fw.Find("frames")->AsInt());
	EXPECT_EQ(Fw.Find("hitches")->AsInt(), 1);
}

TEST(TheFramesRightAfterAMapLoadAreItsLoad)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 60);
	FFrameCost Load = FHarness::Cost(30, 3, 2, 5);
	Load.MapLoaded = true;
	H.Now += 40;
	Core->Frame(40, Load); // the map loaded quickly...
	FFrameCost FirstDraw = FHarness::Cost(5, 900, 1000, 20);
	FirstDraw.PsoCompiles = 30;
	H.Now += 1100;
	Core->Frame(1100, FirstDraw); // ...and its first draw compiled pipeline states for a second
	H.Frames(*Core, 60);
	H.Now += 400;
	Core->Frame(400, FirstDraw); // the same, long after the load, is play's
	H.Frames(*Core, 20);
	Core->Flush();
	const std::vector<FValue> Hitches = OfType(H.Transport->Events(), "hitch");
	EXPECT_EQ(Hitches.size(), static_cast<size_t>(2));
	auto Has = [](const FValue& Hitch, const std::string& Cause) {
		for (const FValue& C : Hitch.Find("causes")->GetItems())
		{
			if (C.AsString() == Cause)
			{
				return true;
			}
		}
		return false;
	};
	EXPECT(Has(Hitches.at(0), "map_load"));
	EXPECT(Has(Hitches.at(0), "pso_compile"));
	EXPECT(!Has(Hitches.at(1), "map_load"));
}

TEST(HitchesSayWhichThreadHeldThemUp)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 60);
	// The game thread waited 300 ms for the GPU: Unreal counts the wait as idle, the clock doesn't.
	H.Now += 300;
	Core->Frame(300, FHarness::Cost(4, 3, 2, 290));
	H.Frames(*Core, 20);
	// A map load: blocking loads, mostly waiting on the disk.
	FFrameCost Load = FHarness::Cost(30, 3, 2, 5);
	Load.MapLoaded = true;
	Load.PackagesLoaded = 340;
	H.Now += 900;
	Core->Frame(900, Load);
	H.Frames(*Core, 20);
	// A level streamed in, and the render thread waited for pipeline states.
	FFrameCost Stream = FHarness::Cost(9, 85, 40, 30);
	Stream.LevelStreamed = true;
	Stream.PsoCompiles = 12;
	H.Now += 95;
	Core->Frame(95, Stream);
	H.Frames(*Core, 20);
	Core->Flush();
	const std::vector<FValue> Hitches = OfType(H.Transport->Events(), "hitch");
	EXPECT_EQ(Hitches.size(), static_cast<size_t>(3));
	// Sent longest first.
	EXPECT_EQ(Hitches.at(0).Find("duration_ms")->AsNumber(), 900.0);
	EXPECT_EQ(Hitches.at(0).Find("causes")->Serialize(), "[\"map_load\",\"asset_load\",\"frozen\"]");
	EXPECT(Hitches.at(0).Find("frozen")->AsBool());
	EXPECT_EQ(Hitches.at(1).Find("duration_ms")->AsNumber(), 300.0);
	EXPECT_EQ(Hitches.at(1).Find("bound")->AsString(), "gpu");
	EXPECT_EQ(Hitches.at(1).Find("causes")->Serialize(), "[\"render\"]");
	EXPECT_EQ(Hitches.at(2).Find("duration_ms")->AsNumber(), 95.0);
	EXPECT_EQ(Hitches.at(2).Find("bound")->AsString(), "render");
	EXPECT_EQ(Hitches.at(2).Find("causes")->Serialize(), "[\"pso_compile\",\"level_stream\",\"render\"]");
}

TEST(ALongFrameIsAFreezeButARunOfThemIsThrottling)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 40);
	const FFrameCost Busy = FHarness::Cost(880, 3, 2, 5);
	H.Frames(*Core, 1, 900, &Busy); // one long frame between normal ones: a real freeze
	H.Frames(*Core, 5);
	H.Frames(*Core, 4, 1000); // a hidden window ticking once a second
	H.Frames(*Core, 5);
	Core->SkipNextFrame(); // the game was paused: the gap is not a frame
	H.Frames(*Core, 1, 3000);
	Core->Flush();
	double Frozen = 0;
	double Frames = 0;
	for (const FValue& E : OfType(H.Transport->Events(), "frame_window"))
	{
		Frozen += E.Find("frozen")->AsNumber();
		Frames += E.Find("frames")->AsNumber();
	}
	EXPECT_EQ(Frozen, 1.0);
	EXPECT_EQ(Frames, 51.0);
}

TEST(ErrorsAreGroupedScrubbedAndCapped)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Scrubber.AddPath("/Users/dev/Library/Application Support/Epic/Fetch/Saved/", "saved:");
	Core->Init(FHarness::Options());
	const std::string Stack =
		"[Callstack] 0x00000001045a3b2c libUnrealEditor-Core.dylib!FDebug::EnsureFailed(char const*, char const*, int, void*, char16_t const*) [/Users/build/UE/Engine/Source/Runtime/Core/Private/Misc/AssertionMacros.cpp:565]\n"
		"[Callstack] 0x00000001045a3c00 libUnrealEditor-Fetch.dylib!UHealthComponent::ApplyDamage(float) [/Users/dev/Fetch/Source/Fetch/HealthComponent.cpp:120]\n"
		"[Callstack] 0x00000001045a3d00 libUnrealEditor-Engine.dylib!AActor::TakeDamage(float, FDamageEvent const&, AController*, AActor*) [/Users/build/UE/Engine/Source/Runtime/Engine/Private/Actor.cpp:2010]\n";
	for (int I = 0; I < 30; I++)
	{
		Core->ReportError("ensure", "Ensure condition failed: Health > 0 [File:/Users/dev/Library/Application Support/Epic/Fetch/Saved/x.cpp] [Line: 120]", Stack);
	}
	Core->ReportError("log_error", "send failed", "[Callstack] 0x1 libUnrealEditor-Glitchless.dylib!Glitchless::FCore::SendNext() [/Users/dev/Fetch/Plugins/Glitchless/Source/Glitchless/Private/Core/GlitchlessCore.cpp:1]");
	Core->ReportError("script", "Accessed None trying to read property Target", "Script call stack:\n\tFunction /Game/AI/BP_Enemy.BP_Enemy_C:ExecuteUbergraph_BP_Enemy\n\tFunction /Game/AI/BP_Enemy.BP_Enemy_C:ReceiveTick\n");
	Core->Flush();
	const std::vector<FValue> Errors = OfType(H.Transport->Events(), "error");
	EXPECT_EQ(Errors.size(), static_cast<size_t>(26)); // 25 of a kind, then one more kind; Glitchless's own error is dropped
	const FValue& E0 = Errors.at(0);
	EXPECT_EQ(E0.Find("message")->AsString(), "Ensure condition failed: Health > 0 [File:saved:/x.cpp] [Line: 120]");
	EXPECT_EQ(E0.Find("fn")->AsString(), "UHealthComponent::ApplyDamage");
	EXPECT_EQ(E0.Find("source")->AsString(), "HealthComponent.cpp");
	EXPECT_EQ(E0.Find("line")->AsInt(), 120);
	EXPECT_EQ(E0.Find("fingerprint")->AsString(), Fingerprint::Of("ensure", E0.Find("message")->AsString(), "UHealthComponent::ApplyDamage"));
	const std::string& StackText = E0.Find("stack")->AsString();
	EXPECT(Text::StartsWith(StackText, "ensure: Ensure condition failed"));
	EXPECT(StackText.find("FDebug::EnsureFailed") == std::string::npos); // the assert plumbing is left out
	EXPECT(StackText.find("/Users/~/Fetch/Source/Fetch/HealthComponent.cpp:120") != std::string::npos); // the user name is not sent
	EXPECT_EQ(Errors.at(25).Find("fn")->AsString(), "BP_Enemy_C.ExecuteUbergraph_BP_Enemy");
	EXPECT_EQ(Core->GetStats().Errors, 31);
}

TEST(StacksUnrealWrites)
{
	const std::vector<FStackFrame> Win = StackParser::Parse(
		"Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000028\n\n"
		"Fetch!AMyCharacter::Tick() [D:\\Fetch\\Source\\Fetch\\MyCharacter.cpp:57]\n"
		"Fetch!AActor::TickActor() [D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\Engine\\Private\\Actor.cpp:1460]\n"
		"Fetch!UnknownFunction []\n"
		"kernel32\n");
	EXPECT_EQ(Win.at(1).Fn, "AMyCharacter::Tick");
	EXPECT_EQ(Win.at(1).File, "D:\\Fetch\\Source\\Fetch\\MyCharacter.cpp");
	EXPECT_EQ(Win.at(1).Line, 57);
	EXPECT(StackParser::IsEngine(Win.at(2)));
	EXPECT(Win.at(3).File.empty());
	EXPECT_EQ(StackParser::TopIndex(Win), 1);

	const std::vector<FStackFrame> Mac = StackParser::Parse("0x0000000104a3b2c0 Fetch!UnknownFunction (0x0000000104a3b2c0) + 0 bytes [UnknownFile:0]\n0x00000001\n");
	EXPECT_EQ(Mac.at(0).Fn, "UnknownFunction");
	EXPECT(Mac.at(0).File.empty());
	EXPECT_EQ(Mac.size(), static_cast<size_t>(2));

	const std::vector<FStackFrame> Templ = StackParser::Parse("[Callstack] 0x00007ff6 Game.exe!TArray<int,TSizedDefaultAllocator<32> >::RangeCheck(int) const [C:\\UE\\Engine\\Source\\Runtime\\Core\\Public\\Containers\\Array.h:771]");
	EXPECT_EQ(Templ.at(0).Fn, "TArray<int,TSizedDefaultAllocator<32> >::RangeCheck");

	FScrubber S;
	EXPECT_EQ(S.Scrub("/home/sam/game/save.json"), "/home/~/game/save.json");
	EXPECT_EQ(S.Scrub("C:\\Users\\Sam\\AppData\\Local\\Fetch"), "C:\\Users\\~\\AppData\\Local\\Fetch");
	EXPECT_EQ(S.Scrub("C:/Users/Sam Smith/AppData"), "C:/Users/~ Smith/AppData");
	EXPECT_EQ(S.Scrub("/var/mobile/Containers/Data/Application/0B7C1A2E-1111-4A2B-9C3D-0123456789AB/Documents"), "/var/mobile/Containers/Data/Application/<id>/Documents");
}

TEST(BatchesAreGzippedAndRetriedWithBackoff)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	for (int I = 0; I < 40; I++)
	{
		FValue A = FValue::Object();
		A.Set("n", I);
		Core->Track("bone_collected", A);
	}
	H.Transport->Status = 503;
	Core->Flush();
	EXPECT_EQ(H.Transport->Sent.size(), static_cast<size_t>(1));
	EXPECT_EQ(static_cast<int>(H.Transport->Raw.at(0).at(0)), 0x1f); // gzipped
	EXPECT_EQ(Core->GetStats().LastStatus, "error");
	H.Frames(*Core, 10); // within the 5 s backoff: no new attempt
	EXPECT_EQ(H.Transport->Sent.size(), static_cast<size_t>(1));
	H.Transport->Status = 202;
	H.Frames(*Core, 1, 5000 - 100);
	H.Frames(*Core, 2);
	EXPECT_EQ(H.Transport->Sent.size(), static_cast<size_t>(2)); // sent again after the backoff
	EXPECT_EQ(Core->GetStats().LastStatus, "ok");
	EXPECT_EQ(Core->OutboxEvents(), 0);
}

TEST(ABatchTheServerRejectsIsDropped)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Transport->Status = 400;
	Core->Track("x");
	Core->Flush();
	EXPECT_EQ(Core->OutboxEvents(), 0);
	EXPECT(Text::StartsWith(Core->GetStats().LastStatus, "rejected"));
}

TEST(OfflineBatchesAreSavedWithoutIdsInAnonymousMode)
{
	FHarness H;
	auto First = H.NewCore();
	First->Init(FHarness::Options());
	H.Transport->Status = 0; // no network
	First->Track("bone_collected");
	First->Shutdown("quit");
	const std::string File = ReadAll(H.Dir + "/outbox.json");
	EXPECT(File.find("bone_collected") != std::string::npos);
	EXPECT(File.find(First->GetSessionId()) == std::string::npos);
	EXPECT(File.find("\"sid\"") == std::string::npos);
	EXPECT(!Exists(H.Dir + "/player_id"));

	H.Transport->Status = 202;
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	Second->Flush();
	bool Found = false;
	for (const std::string& Body : H.Transport->Sent)
	{
		FValue Env;
		FValue::Parse(Body, Env);
		for (const FValue& E : Env.Find("events")->GetItems())
		{
			if (Type(E) == "custom")
			{
				Found = true;
				EXPECT(Env.Find("session_id")->AsString() != First->GetSessionId()); // the earlier session goes under a new random ID
				EXPECT(Env.Find("session_id")->AsString() != Second->GetSessionId()); // and not this launch's
			}
		}
	}
	EXPECT(Found);
	EXPECT(!Exists(H.Dir + "/outbox.json")); // deleted once everything is sent
}

TEST(OldSavedEventsAreDropped)
{
	FHarness H;
	auto First = H.NewCore();
	First->Init(FHarness::Options());
	H.Transport->Status = 0;
	First->Track("old");
	First->Shutdown("quit");
	H.Now += 7.0 * 86400 * 1000; // a week later
	H.Transport->Status = 202;
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	EXPECT_EQ(Second->OutboxEvents(), 0);
}

TEST(InstallAndFullModesKeepAnId)
{
	FHarness H;
	auto First = H.NewCore();
	First->Init(FHarness::Options(EPrivacy::Install));
	EXPECT(Text::StartsWith(First->GetPlayerId(), "p_"));
	First->Death(1.234, 5.678, 0, "fell");
	First->Flush();
	const std::vector<FValue> Events = H.Transport->Events();
	EXPECT(!OfType(Events, "death").at(0).Has("x")); // install mode has no positions
	EXPECT(!OfType(Events, "session_start").at(0).Find("device")->Has("gpu")); // nor detailed device fields
	EXPECT_EQ(OfType(Events, "session_start").at(0).Find("privacy")->AsString(), "install");
	EXPECT_EQ(H.Envelope().Find("player_id")->AsString(), First->GetPlayerId());

	auto Full = H.NewCore();
	Full->Init(FHarness::Options(EPrivacy::Full));
	EXPECT_EQ(Full->GetPlayerId(), First->GetPlayerId());
	Full->Death(1.234, 5.678, 0, "fell");
	Full->Flush();
	const FValue Death = OfType(H.Transport->Events(), "death").back();
	EXPECT_EQ(Death.Find("x")->AsNumber(), 1.23);
	EXPECT(OfType(H.Transport->Events(), "session_start").back().Find("device")->Has("gpu"));

	auto Anon = H.NewCore();
	Anon->Init(FHarness::Options());
	EXPECT(!Exists(H.Dir + "/player_id")); // anonymous mode deletes an ID another mode left
}

TEST(DeathsHaveNoPlaceUnlessPositionsAreOn)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->SetPosition(1, 2, 3);
	H.Frames(*Core, 30);
	Core->Death(3, 4, 0, "squirrel");
	Core->Flush();
	const FValue Death = OfType(H.Transport->Events(), "death").at(0);
	EXPECT(!Death.Has("x"));
	EXPECT_EQ(Death.Find("cause")->AsString(), "squirrel");
	EXPECT(OfType(H.Transport->Events(), "pos").empty());
}

TEST(PositionsAreSampled)
{
	FHarness H;
	auto Core = H.NewCore();
	FOptions O = FHarness::Options();
	O.Positions = true;
	Core->Init(O);
	for (int I = 0; I < 120; I++)
	{
		Core->SetPosition(I, 0, 100.456);
		H.Frames(*Core, 1);
	}
	Core->Flush();
	const std::vector<FValue> Pos = OfType(H.Transport->Events(), "pos");
	EXPECT_EQ(Pos.size(), static_cast<size_t>(1));
	EXPECT_EQ(Pos.at(0).Find("pts")->Size(), static_cast<size_t>(8)); // 4 a second for 2 s, on 60 Hz frames: every 16th frame
	EXPECT_EQ((*Pos.at(0).Find("pts"))[0][3].AsNumber(), 100.46);
}

TEST(GoingToTheBackgroundEndsTheSessionAndSendsAtOnce)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 30);
	const std::string First = Core->GetSessionId();
	H.Transport->Status = 503; // the timer's send fails, so SendNow has something to send
	Core->Flush();
	H.Transport->Status = 202;
	Core->OnBackground();
	bool Ended = false;
	for (const FValue& E : H.Transport->Events(&H.Transport->SentNow))
	{
		Ended |= Type(E) == "session_end" && E.Find("reason")->AsString() == "background";
	}
	EXPECT(Ended);
	H.Now += 10000;
	Core->OnForeground();
	EXPECT_EQ(Core->GetSessionId(), First); // a short trip away resumes the session
	Core->OnBackground();
	H.Now += 400000;
	Core->OnForeground();
	EXPECT(Core->GetSessionId() != First); // a long one starts a new session
}

TEST(AQuitWithABatchOnItsWaySendsEachEventOnce)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 30);
	Core->LevelComplete("Gallery", 4200, std::nullopt);
	H.Transport->Hold = true;
	Core->Flush(); // on its way, and already at the server, when the game quits
	Core->Shutdown("quit");
	std::vector<std::string> Delivered = H.Transport->Sent;
	Delivered.insert(Delivered.end(), H.Transport->SentNow.begin(), H.Transport->SentNow.end());
	std::map<std::string, int> Times;
	for (const FValue& E : H.Transport->Events(&Delivered))
	{
		Times[Type(E) + "@" + std::to_string(E.Find("ts")->AsInt())]++;
	}
	for (const auto& T : Times)
	{
		EXPECT_EQ(T.first + " x" + std::to_string(T.second), T.first + " x1");
	}
	EXPECT_EQ(OfType(H.Transport->Events(&Delivered), "level_complete").size(), static_cast<size_t>(1));
	EXPECT_EQ(OfType(H.Transport->Events(&Delivered), "session_end").size(), static_cast<size_t>(1));
	EXPECT_EQ(H.Transport->Aborts, 0);
}

TEST(AnUnansweredRequestAtQuitWaitsForTheNextLaunch)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 30);
	Core->LevelComplete("Gallery", 4200, std::nullopt);
	H.Transport->Hold = true;
	H.Transport->AnswerOnWait = false; // the server never answers
	Core->Flush();
	Core->Shutdown("quit");
	EXPECT_EQ(H.Transport->Aborts, 1);
	EXPECT_EQ(OfType(H.Transport->Events(&H.Transport->SentNow), "level_complete").size(), static_cast<size_t>(0));
	EXPECT_EQ(OfType(H.Transport->Events(&H.Transport->SentNow), "session_end").size(), static_cast<size_t>(1));
	EXPECT(ReadAll(H.Dir + "/outbox.json").find("level_complete") != std::string::npos);
}

TEST(MeasureReportsTheNextSeconds)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 130);
	FValue Result;
	bool Done = false;
	Core->Measure(1, [&](const FValue& R) {
		Result = R;
		Done = true;
	});
	H.Frames(*Core, 59);
	EXPECT(!Done);
	H.Frames(*Core, 2);
	EXPECT(Done);
	EXPECT_EQ(Result.Find("frames")->AsInt(), 60);
	EXPECT_EQ(Result.Find("frame_budget_ms")->AsNumber(), 16.67);
	EXPECT_EQ(Result.Find("draw_calls")->Find("avg")->AsInt(), 40);
	EXPECT_EQ(Result.Find("sdk")->AsString(), "glitchless-unreal/0.4.0");
	EXPECT_EQ(Result.Find("session_id")->AsString(), Core->GetSessionId());
	EXPECT_EQ(Result.Find("update_cpu_ms")->Find("p50")->AsNumber(), 4.0);
	EXPECT_EQ(Result.Find("render_cpu_ms")->Find("p50")->AsNumber(), 3.0);
	EXPECT_EQ(Result.Find("rhi_cpu_ms")->Find("p50")->AsNumber(), 2.0);
	EXPECT_EQ(Result.Find("gpu_ms")->Find("p50")->AsNumber(), 6.0);
	for (const char* Key : {"seconds", "level_start", "level_end", "fps", "frame_ms", "pct_frames_over_budget", "physics_ms", "gc_collections", "hitches", "hitch_count", "triangles_avg", "peak_context", "memory", "memory_delta", "new_errors", "errors"})
	{
		EXPECT(Result.Has(Key));
	}
	EXPECT(Result.Serialize().find("\"frame_ms\":{\"p50\":16.7") != std::string::npos);
}

TEST(RageInputAndTimeToFirstInput)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 3);
	for (int I = 0; I < 4; I++)
	{
		H.Now += 100;
		Core->OnInput("SpaceBar");
	}
	Core->Flush();
	int Loads = 0;
	for (const FValue& E : OfType(H.Transport->Events(), "load"))
	{
		Loads += E.Has("ttp_ms") ? 1 : 0;
	}
	EXPECT_EQ(Loads, 1);
	int Rage = 0;
	for (const FValue& E : OfType(H.Transport->Events(), "custom"))
	{
		if (E.Find("name")->AsString() == "rage_input")
		{
			Rage++;
			EXPECT_EQ(E.Find("attrs")->Find("key")->AsString(), "SpaceBar");
		}
	}
	EXPECT_EQ(Rage, 1);
}

TEST(FlagsOverrideTheIntakeAndMarkBots)
{
	FHarness H;
	auto Core = H.NewCore({"Fetch", "-autoplay", "-glitchless-intake=http://127.0.0.1:9999"});
	Core->Init(FHarness::Options());
	Core->Flush();
	EXPECT_EQ(H.Transport->Events().at(0).Find("session_type")->AsString(), "synthetic");
	auto Off = H.NewCore({"-glitchless-off"});
	Off->Init(FHarness::Options());
	EXPECT(!Off->IsEnabled());
	auto Double = H.NewCore({"--glitchless-measure=5"});
	EXPECT(Double->HasFlag("glitchless-measure"));
	EXPECT_EQ(*Double->FlagValue("glitchless-measure"), "5");
	EXPECT(!Double->HasFlag("glitchless"));
}

TEST(DevelopmentBuildsSendOnlyWhenTold)
{
	FHarness H;
	FOptions O = FHarness::Options();
	O.SendInDevelopmentBuilds = false;
	auto Dev = H.NewCore();
	Dev->Init(O);
	EXPECT(!Dev->IsEnabled());
	auto Told = H.NewCore({"-glitchless"});
	Told->Init(O);
	EXPECT(Told->IsEnabled());
	auto Shipping = H.NewCore();
	Shipping->IsDevelopmentBuild = false;
	Shipping->Init(O);
	EXPECT(Shipping->IsEnabled());
	EXPECT_EQ(Shipping->GetEnv(), "prod");
	auto NoIntake = H.NewCore();
	FOptions Empty = FHarness::Options();
	Empty.Intake = "";
	NoIntake->Init(Empty);
	EXPECT(!NoIntake->IsEnabled());
}

TEST(ACrashIsSavedAndSentOnTheNextLaunch)
{
	FHarness H;
	auto First = H.NewCore();
	First->Init(FHarness::Options());
	H.Frames(*First, 200);
	First->Flush();
	const size_t SentBefore = H.Transport->Sent.size();
	H.Frames(*First, 30);
	First->ReportCrash("crash", "Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000028",
		"Fetch!AMyCharacter::Tick() [D:\\Fetch\\Source\\Fetch\\MyCharacter.cpp:57]\nFetch!AActor::TickActor() [D:\\UE\\Engine\\Source\\Runtime\\Engine\\Private\\Actor.cpp:1460]");
	EXPECT_EQ(H.Transport->Sent.size(), SentBefore); // nothing is sent from a dying game
	const std::string File = ReadAll(H.Dir + "/outbox.json");
	EXPECT(File.find("EXCEPTION_ACCESS_VIOLATION") != std::string::npos);
	EXPECT(File.find("\"reason\":\"crash\"") != std::string::npos);
	EXPECT(File.find("frame_window") != std::string::npos); // the last frames before it
	EXPECT(File.find(First->GetSessionId()) == std::string::npos); // anonymous: no ID on disk

	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	Second->Flush();
	const std::vector<FValue> Events = H.Transport->Events();
	bool Crash = false;
	for (const FValue& E : OfType(Events, "error"))
	{
		if (E.Find("kind")->AsString() == "crash")
		{
			Crash = true;
			EXPECT_EQ(E.Find("fn")->AsString(), "AMyCharacter::Tick");
			EXPECT_EQ(E.Find("line")->AsInt(), 57);
		}
	}
	EXPECT(Crash);
}

TEST(ACrashInFullModeJoinsItsSession)
{
	FHarness H;
	auto First = H.NewCore();
	First->Init(FHarness::Options(EPrivacy::Full));
	H.Frames(*First, 30);
	First->ReportCrash("crash", "Assertion failed: Ptr", "");
	const std::string Sid = First->GetSessionId();
	auto Second = H.NewCore();
	Second->Init(FHarness::Options(EPrivacy::Full));
	Second->Flush();
	bool Joined = false;
	for (const std::string& Body : H.Transport->Sent)
	{
		FValue Env;
		FValue::Parse(Body, Env);
		Joined |= Env.Find("session_id")->AsString() == Sid && Body.find("\"kind\":\"crash\"") != std::string::npos;
	}
	EXPECT(Joined);
}

TEST(BugReportsGoOnARequestOfTheirOwn)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->OnMapLoaded("Arena", 1);
	H.Frames(*Core, 400); // a closed window, and one open
	FValue Attrs = FValue::Object();
	Attrs.Set("which", "north");
	Core->Track("door_opened", Attrs);
	FFrameCost Slow = FHarness::Cost(120, 3, 2, 5);
	H.Now += 130;
	Core->Frame(130, Slow);
	H.Frames(*Core, 5);
	// The player opens the box: the moment is taken then; the note comes when they press Send.
	FValue Report = Core->MakeBugReport("data:image/jpeg;base64,/9j/4AAQ");
	H.Now += 8000;
	Core->SendBugReport(Report, "  The door won't open  ");
	const std::string Last = H.Transport->Sent.back();
	FValue Env;
	EXPECT(FValue::Parse(Last, Env));
	EXPECT_EQ(Env.Find("events")->Size(), static_cast<size_t>(1)); // a request of its own
	const FValue& R = (*Env.Find("events"))[0];
	EXPECT_EQ(Type(R), "bug_report");
	EXPECT_EQ(R.Find("note")->AsString(), "  The door won't open  ");
	EXPECT_EQ(R.Find("screenshot")->AsString(), "data:image/jpeg;base64,/9j/4AAQ");
	EXPECT_EQ(R.Find("level")->AsString(), "Arena");
	EXPECT(R.Find("ts")->AsInt() < H.Transport->Events().back().Find("ts")->AsInt() + 1); // when the box opened
	EXPECT(!R.Has("x")); // positions are off
	EXPECT(R.Find("device")->IsObject() && !R.Find("device")->Has("gpu"));
	const FValue& Recent = *R.Find("recent");
	bool Door = false;
	bool Hitch = false;
	for (const FValue& E : Recent.GetItems())
	{
		Door |= Type(E) == "custom" && E.Find("name")->AsString() == "door_opened" && E.Find("attrs")->Find("which")->AsString() == "north";
		Hitch |= Type(E) == "hitch" && E.Find("duration_ms")->AsNumber() == 130.0;
	}
	EXPECT(Door);
	EXPECT(Hitch);
	EXPECT_EQ(Type(Recent[0]), "level_start"); // oldest first
	const FValue& Frames = *R.Find("frames");
	EXPECT_EQ(Frames.Size(), static_cast<size_t>(2));
	EXPECT(Frames[0].Find("fps")->IsNumber() && Frames[0].Find("p95")->IsNumber());
	// The session's own events went first, in the batches before it.
	bool Before = false;
	for (size_t I = 0; I + 1 < H.Transport->Sent.size(); I++)
	{
		Before |= H.Transport->Sent[I].find("door_opened") != std::string::npos;
	}
	EXPECT(Before);
}

TEST(BugReportsGoFromUnsampledSessionsToo)
{
	FHarness H;
	auto Core = H.NewCore();
	FOptions O = FHarness::Options();
	O.SampleRate = 0;
	Core->Init(O);
	H.Frames(*Core, 30);
	Core->Flush();
	EXPECT(H.Transport->Sent.empty());
	Core->BugReport("it froze", "");
	EXPECT_EQ(H.Transport->Sent.size(), static_cast<size_t>(1));
	EXPECT_EQ(Type(H.Transport->Events().at(0)), "bug_report");
	EXPECT(!H.Transport->Events().at(0).Has("screenshot"));
}

TEST(EverythingIsSafeBeforeInitAndWhenOff)
{
	FHarness H;
	auto Core = H.NewCore({"-glitchless-off"});
	Core->LevelStart("a");
	Core->Death(1, 2, 3, "");
	Core->Track("x");
	Core->ReportCrash("crash", "boom", "");
	H.Frames(*Core, 400);
	Core->Init(FHarness::Options());
	Core->Flush();
	Core->BugReport("note", "");
	Core->Shutdown("quit");
	EXPECT(H.Transport->Sent.empty());
	EXPECT(!Exists(H.Dir + "/outbox.json"));
}

TEST(DeviceTiersAndSteamDecks)
{
	EXPECT_EQ(DeviceFacts::DeviceTier(4, 8), "low");
	EXPECT_EQ(DeviceFacts::DeviceTier(6, 4), "mid");
	EXPECT_EQ(DeviceFacts::DeviceTier(8, 8), "high");
	EXPECT_EQ(DeviceFacts::DeviceTier(8, -1), "unknown");
	EXPECT_EQ(DeviceFacts::GpuTier("Apple M3 Max"), "high");
	EXPECT_EQ(DeviceFacts::GpuTier("Apple M2"), "mid");
	EXPECT_EQ(DeviceFacts::GpuTier("Apple A17 Pro GPU"), "low");
	EXPECT_EQ(DeviceFacts::GpuTier("NVIDIA GeForce RTX 4070"), "high");
	EXPECT_EQ(DeviceFacts::GpuTier("NVIDIA GeForce GTX 1060 6GB"), "high");
	EXPECT_EQ(DeviceFacts::GpuTier("NVIDIA GeForce GTX 960"), "mid");
	EXPECT_EQ(DeviceFacts::GpuTier("Intel(R) UHD Graphics 620"), "low");
	EXPECT_EQ(DeviceFacts::GpuTier("Intel(R) Iris(R) Xe Graphics"), "mid");
	EXPECT_EQ(DeviceFacts::GpuTier("Microsoft Basic Render Driver"), "software");
	EXPECT_EQ(DeviceFacts::GpuTier("AMD Custom GPU 0405"), "unknown");

	DeviceFacts::FSteamDeckFacts Deck;
	EXPECT(!DeviceFacts::IsSteamDeck(Deck));
	Deck.Env = "1"; // Proton on a Deck: only the variable
	EXPECT(DeviceFacts::IsSteamDeck(Deck));
	EXPECT(!DeviceFacts::IsSteamOS(Deck));
	DeviceFacts::FSteamDeckFacts Native;
	Native.BoardVendor = "Valve\n";
	Native.BoardName = "Galileo\n";
	Native.OsRelease = "NAME=\"SteamOS\"\nID=steamos\nID_LIKE=arch\n";
	EXPECT(DeviceFacts::IsSteamDeck(Native));
	EXPECT(DeviceFacts::IsSteamOS(Native));
	EXPECT_EQ(DeviceFacts::SteamDeckModel(Native), "Steam Deck OLED");
	DeviceFacts::FSteamDeckFacts Desktop;
	Desktop.OsRelease = "ID=\"ubuntu\"\n";
	Desktop.BoardVendor = "ASUSTeK COMPUTER INC.";
	EXPECT(!DeviceFacts::IsSteamDeck(Desktop));
}

TEST(WhereAnIosBuildCameFromIsReadFromItsReceiptAndProfile)
{
	const std::string Phone = "/private/var/mobile/Containers/Data/Application/BE5EB9FD-3704-488D-96E8-ADB805300ED7";
	const std::string Mac = "/Users/dev/Library/Containers/AB12/Data";
	auto Where = [](const std::string& Home, bool Receipt, bool SandboxReceipt, bool Provisioned) {
		DeviceFacts::FIosInstallFacts F;
		F.Home = Home;
		F.Receipt = Receipt;
		F.SandboxReceipt = SandboxReceipt;
		F.Provisioned = Provisioned;
		return DeviceFacts::IosDistribution(F);
	};
	EXPECT_EQ(Where(Phone, true, false, false), "app_store");
	EXPECT_EQ(Where(Phone, false, false, false), "testflight"); // Apple writes a receipt with every App Store install
	EXPECT_EQ(Where(Phone.substr(8), false, false, false), "testflight");
	EXPECT_EQ(Where(Phone, false, true, false), "testflight"); // a sandbox receipt, after a TestFlight purchase
	EXPECT_EQ(Where(Phone, false, true, true), "development"); // a provisioning profile in the bundle
	EXPECT_EQ(Where("/Users/dev/Library/Developer/CoreSimulator/Devices/1F2E/data/Containers/Data/Application/AB12", false, false, false), "development");
	EXPECT_EQ(Where(Mac, false, false, false), ""); // an iPad app on a Mac without a receipt can't tell
	EXPECT_EQ(Where("", false, false, false), "");
	EXPECT_EQ(Where(Mac, true, false, false), "app_store");
	EXPECT_EQ(Where(Mac, false, true, false), "testflight");
	EXPECT(DeviceFacts::IsSandbox("testflight") && DeviceFacts::IsSandbox("development"));
	EXPECT(!DeviceFacts::IsSandbox("app_store") && !DeviceFacts::IsSandbox(""));
}

TEST(TestFlightSessionsAreTestersAndTheirPurchasesSayTheyreSandboxOnes)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Distribution = []() { return std::string("testflight"); };
	Core->Init(FHarness::Options());
	FValue Buy = FValue::Object();
	Buy.Set("amount", 4.99);
	Buy.Set("currency", "USD");
	Buy.Set("item", "full_version");
	Core->Track("purchase", Buy);
	FValue Unlock = FValue::Object();
	Unlock.Set("price", 2);
	Unlock.Set("currency", "EUR");
	Core->Track("unlock", Unlock);
	FValue Pick = FValue::Object();
	Pick.Set("what", "forge");
	Core->Track("level_pick", Pick);
	FValue Set = FValue::Object();
	Set.Set("sandbox", false);
	Core->Track("purchase", Set);
	Core->Flush();
	const std::vector<FValue> Events = H.Transport->Events();
	EXPECT_EQ(Events.at(0).Find("session_type")->AsString(), "tester");
	const std::vector<FValue> Custom = OfType(Events, "custom");
	EXPECT(Custom.at(0).Find("attrs")->Find("sandbox")->AsBool());
	EXPECT(Custom.at(1).Find("attrs")->Find("sandbox")->AsBool()); // any event with a currency
	EXPECT(!Custom.at(2).Find("attrs")->Has("sandbox"));
	EXPECT(!Custom.at(3).Find("attrs")->Find("sandbox")->AsBool()); // a sandbox the game set stays

	FHarness Store;
	auto App = Store.NewCore();
	App->Distribution = []() { return std::string("app_store"); };
	App->Init(FHarness::Options());
	App->Track("purchase", Buy);
	App->Flush();
	const std::vector<FValue> Sold = Store.Transport->Events();
	EXPECT_EQ(Sold.at(0).Find("session_type")->AsString(), "user");
	EXPECT(!OfType(Sold, "custom").at(0).Find("attrs")->Has("sandbox"));

	FHarness Bot;
	auto Autoplay = Bot.NewCore({"-autoplay"});
	Autoplay->Distribution = []() { return std::string("testflight"); };
	Autoplay->Init(FHarness::Options());
	Autoplay->Flush();
	EXPECT_EQ(Bot.Transport->Events().at(0).Find("session_type")->AsString(), "synthetic"); // a bot on a TestFlight build is a bot

	FHarness Chosen;
	auto Player = Chosen.NewCore();
	Player->Distribution = []() { return std::string("testflight"); };
	FOptions O = FHarness::Options();
	O.SessionType = "user";
	Player->Init(O);
	Player->Flush();
	EXPECT_EQ(Chosen.Transport->Events().at(0).Find("session_type")->AsString(), "user"); // a type the game set wins
}

TEST(LiveSaysWhatIsGoingOn)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->OnMapLoaded("Arena", 1);
	Core->SetContext("enemies", 7);
	H.Frames(*Core, 400);
	FFrameCost Slow = FHarness::Cost(120, 3, 2, 5);
	H.Now += 130;
	Core->Frame(130, Slow);
	H.Frames(*Core, 1); // the frame that finishes the hitch
	Core->ReportError("log_error", "boom", "", FValue(), false, "LogTemp");
	const FValue L = Core->Live();
	EXPECT_EQ(L.Find("sdk")->AsString(), "glitchless-unreal/0.4.0");
	EXPECT_EQ(L.Find("level")->AsString(), "Arena");
	EXPECT_EQ(L.Find("session_id")->AsString(), Core->GetSessionId());
	EXPECT(L.Find("frames")->Size() >= 2);
	EXPECT_EQ(L.Find("hitches")->Size(), static_cast<size_t>(1));
	EXPECT_EQ(L.Find("ctx")->Find("enemies")->AsNumber(), 7.0);
	EXPECT_EQ((*L.Find("errors"))[0].Find("location")->AsString(), "LogTemp");
	EXPECT_EQ(L.Find("stats")->Find("hitches")->AsInt(), 1);
}

TEST(AMeasureCutShortStillAnswers)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 10);
	FValue Result;
	Core->Measure(10, [&](const FValue& R) { Result = R; });
	H.Frames(*Core, 10);
	Core->Shutdown("quit");
	EXPECT(Result.Has("error"));
}

TEST(AMeasureMayEndTheSession)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 10);
	int Answers = 0;
	Core->Measure(0.5, [&](const FValue& R) {
		Answers++;
		EXPECT(R.Has("frames"));
		Core->Shutdown("measure"); // what -glitchless-measure does
	});
	Core->Measure(5, [&](const FValue& R) {
		Answers++;
		EXPECT(R.Has("error"));
	});
	H.Frames(*Core, 60);
	EXPECT_EQ(Answers, 2);
	bool Ended = false;
	for (const FValue& E : H.Transport->Events(&H.Transport->SentNow))
	{
		Ended |= Type(E) == "session_end" && E.Find("reason")->AsString() == "measure";
	}
	EXPECT(Ended);
}

TEST(CrashesAreDescribedFromWhatUnrealLeft)
{
	std::string Message;
	std::string Stack;
	// An assert: its message, a blank line, the callstack.
	StackParser::DescribeCrash("Assertion failed: Ptr != nullptr [File:D:\\Game\\Source\\A.cpp] [Line: 42] \r\n\r\nGame!AMyActor::Tick() [D:\\Game\\Source\\A.cpp:42]\r\n", "", Message, Stack);
	EXPECT_EQ(Message, "Assertion failed: Ptr != nullptr [File:D:\\Game\\Source\\A.cpp] [Line: 42]");
	EXPECT_EQ(StackParser::Parse(Stack).at(0).Fn, "AMyActor::Tick");
	// A signal on a Mac: only the callstack; what happened is in the description.
	StackParser::DescribeCrash("0x0000000104a3b2c0 GlitchlessTest!UGlitchlessTestScript::Step(float) [/Users/me/Game/Source/S.cpp:120]\n0x0000000104a3b300 GlitchlessTest!FTSTicker::Tick(float) [/Users/build/UE/Engine/Source/Runtime/Core/Private/Containers/Ticker.cpp:100]\n",
		"SIGSEGV: invalid attempt to access memory at address 0x0", Message, Stack);
	EXPECT_EQ(Message, "SIGSEGV: invalid attempt to access memory at address 0x0");
	const std::vector<FStackFrame> Frames = StackParser::Parse(Stack);
	EXPECT_EQ(Frames.size(), static_cast<size_t>(2));
	EXPECT_EQ(Frames.at(StackParser::TopIndex(Frames)).Fn, "UGlitchlessTestScript::Step");
	// Nothing at all.
	StackParser::DescribeCrash("", "", Message, Stack);
	EXPECT_EQ(Message, "Crash");
	EXPECT(Stack.empty());
	// Windows, after the plugin walked the exception it kept: an access violation...
	StackParser::DescribeCrash("0x00007ff6c1b01234 GlitchlessTest.exe!UGlitchlessTestScript::Step() [C:\\work\\Game\\Source\\GlitchlessTestScript.cpp:176]\r\n"
		"0x00007ff6c1b05678 GlitchlessTest.exe!FTSTicker::Tick() []\r\n",
		"Unhandled Exception: EXCEPTION_ACCESS_VIOLATION writing address 0x0000000000000000", Message, Stack);
	EXPECT_EQ(Message, "Unhandled Exception: EXCEPTION_ACCESS_VIOLATION writing address 0x0000000000000000");
	const std::vector<FStackFrame> Av = StackParser::Parse(Stack);
	EXPECT_EQ(Av.at(StackParser::TopIndex(Av)).Fn, "UGlitchlessTestScript::Step");
	EXPECT_EQ(Av.at(StackParser::TopIndex(Av)).Line, 176);
	// ...and a fatal error, its message from GErrorHist and its callstack from RaiseException down.
	StackParser::DescribeCrash("Fatal error: [File:C:\\work\\Game\\Source\\GlitchlessTestScript.cpp] [Line: 168] \r\nPlanted fatal error: the save file is corrupt\r\n\r\n\r\n\r\n"
		"0x00007ff92e1a0000 KERNELBASE.dll!RaiseException() []\r\n"
		"0x00007ff6c1b0aaaa GlitchlessTest.exe!UE::Logging::Private::BasicFatalLog() []\r\n"
		"0x00007ff6c1b0bbbb GlitchlessTest.exe!UGlitchlessTestScript::Step() [C:\\work\\Game\\Source\\GlitchlessTestScript.cpp:168]\r\n",
		"", Message, Stack);
	EXPECT_EQ(Message, "Fatal error: [File:C:\\work\\Game\\Source\\GlitchlessTestScript.cpp] [Line: 168] Planted fatal error: the save file is corrupt");
	const std::vector<FStackFrame> Fatal = StackParser::Parse(Stack);
	EXPECT_EQ(Fatal.at(StackParser::TopIndex(Fatal)).Fn, "UGlitchlessTestScript::Step");
}

TEST(WorkAfterTheDrawCountsOnTheNextFrame)
{
	// Unreal sets the threads' times as the frame draws; the core ticker runs after it, so its work
	// shows in the next frame's times.
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 60);
	H.Now += 160;
	Core->Frame(160, FHarness::Cost(4, 3, 2, 5));
	const FFrameCost Late = FHarness::Cost(150, 3, 2, 5);
	H.Now += 16.7;
	Core->Frame(16.7, Late);
	H.Frames(*Core, 10);
	Core->Flush();
	const std::vector<FValue> Hitches = OfType(H.Transport->Events(), "hitch");
	EXPECT_EQ(Hitches.size(), static_cast<size_t>(1));
	EXPECT_EQ(Hitches.at(0).Find("duration_ms")->AsNumber(), 160.0);
	EXPECT_EQ(Hitches.at(0).Find("causes")->Serialize(), "[\"script\"]");
	EXPECT_EQ(Hitches.at(0).Find("bound")->AsString(), "game");
}

TEST(ALoadAndTheFramesAfterItAreFramesNotThrottling)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 60);
	FFrameCost Load = FHarness::Cost(900, 3, 2, 5);
	Load.MapLoaded = true;
	H.Now += 2400;
	Core->Frame(2400, Load);
	H.Now += 1100;
	Core->Frame(1100, FHarness::Cost(1000, 3, 2, 5)); // the new map's first draw, long too
	H.Frames(*Core, 10);
	Core->Flush();
	const std::vector<FValue> Hitches = OfType(H.Transport->Events(), "hitch");
	EXPECT_EQ(Hitches.size(), static_cast<size_t>(2));
	EXPECT(Contains(*Hitches.at(0).Find("causes"), "map_load"));
	double Frames = 0;
	for (const FValue& E : OfType(H.Transport->Events(), "frame_window"))
	{
		Frames += E.Find("frames")->AsNumber();
	}
	EXPECT_EQ(Frames, 72.0);
}

TEST(FatalErrorsKeepTheirMessage)
{
	std::string Message;
	std::string Stack;
	StackParser::DescribeCrash("Fatal error: [File:/Game/Source/S.cpp] [Line: 118] \nPlanted fatal error: the save file is corrupt\n\n\n0x00000001 Game!UGame::Save()  [UnknownFile]) \n", "", Message, Stack);
	EXPECT_EQ(Message, "Fatal error: [File:/Game/Source/S.cpp] [Line: 118] Planted fatal error: the save file is corrupt");
	const std::vector<FStackFrame> Frames = StackParser::Parse(Stack);
	EXPECT_EQ(Frames.at(0).Fn, "UGame::Save");
	EXPECT(!StackParser::IsGlitchless(FStackFrame{"UGlitchlessTestScript::Step", "", 0})); // a game's class named like ours
	EXPECT(StackParser::IsGlitchless(FStackFrame{"FGlitchlessRuntime::OnSignal", "", 0}));
}

TEST(ACrashCaughtByOurSignalHandlerIsTheGamesCrash)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 10);
	Core->ReportCrash("crash", "SIGSEGV: invalid attempt to access memory at address 0x0",
		"0x0ab32a20 GlitchlessTest!GlitchlessSignals::SignalHandler(int, __siginfo*, void*)  [UnknownFile]) \n"
		"0x8ab3e09c libsystem_platform.dylib!_sigtramp()  [UnknownFile]) \n"
		"0x0ab33bd4 GlitchlessTest!UGlitchlessTestScript::Step(float)  [UnknownFile]) \n"
		"0x0ab3a000 GlitchlessTest!FTSTicker::Tick(float)  [UnknownFile]) \n");
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	Second->Flush();
	bool Found = false;
	for (const FValue& E : OfType(H.Transport->Events(), "error"))
	{
		if (E.Find("kind")->AsString() == "crash")
		{
			Found = true;
			EXPECT_EQ(E.Find("fn")->AsString(), "UGlitchlessTestScript::Step");
		}
	}
	EXPECT(Found);
}

TEST(OnAnIPhoneTheRedactedTrampolineIsNotTheCrash)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 10);
	Core->ReportCrash("crash", "SIGSEGV: invalid attempt to access memory at address 0x0",
		"0x0000000104b32a20 GlitchlessTest!GlitchlessSignals::SignalHandler(int, __siginfo*, void*)  [UnknownFile]) \n"
		"0x00000001e2a5b5c4 libsystem_platform.dylib!<redacted>  [UnknownFile]) \n"
		"0x0000000104b33bd4 GlitchlessTest!UGlitchlessTestScript::Step(float)  [UnknownFile]) \n"
		"0x0000000104b3a000 GlitchlessTest!-[IOSAppDelegate MainAppThread:]  [UnknownFile]) \n");
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	Second->Flush();
	bool Found = false;
	for (const FValue& E : OfType(H.Transport->Events(), "error"))
	{
		if (E.Find("kind")->AsString() == "crash")
		{
			Found = true;
			EXPECT_EQ(E.Find("fn")->AsString(), "UGlitchlessTestScript::Step");
		}
	}
	EXPECT(Found);
}

TEST(LambdasAreTheirFunctions)
{
	EXPECT_EQ(StackParser::Parse("0x1 Game!UGlitchlessTestScript::Step(float)::$_0::operator()() const  [UnknownFile]) ").at(0).Fn, "UGlitchlessTestScript::Step");
	EXPECT_EQ(StackParser::Parse("Game!`AFoo::Bar'::`2'::<lambda_1>::operator()() [C:\\Game\\Source\\Foo.cpp:12]").at(0).Fn, "AFoo::Bar");
	EXPECT_EQ(StackParser::Parse("Game!AFoo::Bar(int) [C:\\Game\\Source\\Foo.cpp:12]").at(0).Fn, "AFoo::Bar");
}

// ───────────── batch IDs (SPEC §2 batch_id): the server stores a batch once, however often it arrives ─────────────

TEST(EveryBatchHasItsOwnIdAndKeepsItWhenTriedAgain)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->Track("first");
	H.Transport->Status = 503;
	Core->Flush();
	H.Transport->Status = 202;
	H.Frames(*Core, 1, 5000 - 100);
	H.Frames(*Core, 10); // past the 5 s backoff: tried again
	EXPECT_EQ(H.Transport->Sent.size(), static_cast<size_t>(2));
	const std::string First = BatchId(H.Transport->Sent.at(0));
	EXPECT(IsBatchId(First));
	EXPECT_EQ(BatchId(H.Transport->Sent.at(1)), First); // the same batch, under the same ID
	Core->Track("second");
	Core->Flush();
	const std::string Second = BatchId(H.Transport->Sent.back());
	EXPECT(IsBatchId(Second));
	EXPECT(Second != First);
	Core->BugReport("it froze", "");
	EXPECT(IsBatchId(BatchId(H.Transport->Sent.back()))); // a bug report's request has one too
	EXPECT(BatchId(H.Transport->Sent.back()) != Second);
}

TEST(SavedBatchesKeepTheirIdsInEveryMode)
{
	FHarness H;
	auto First = H.NewCore();
	First->Init(FHarness::Options());
	H.Transport->Status = 0; // no network
	First->Track("bone_collected");
	First->Flush();
	const std::string Tried = BatchId(H.Transport->Sent.at(0));
	First->Shutdown("quit");
	FValue Saved;
	EXPECT(FValue::Parse(ReadAll(H.Dir + "/outbox.json"), Saved));
	const FValue& Batches = *Saved.Find("batches");
	EXPECT(Batches.Size() >= 2);
	for (const FValue& B : Batches.GetItems())
	{
		EXPECT(IsBatchId(B.Find("bid")->AsString()));
		EXPECT(!B.Has("sid") && !B.Has("pid")); // anonymous: the batch's ID, never the session's or the player's
	}
	EXPECT_EQ(Batches[0].Find("bid")->AsString(), Tried);

	H.Transport->Status = 202;
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	Second->Flush();
	bool Again = false;
	for (const std::string& Body : H.Transport->Sent)
	{
		FValue Env;
		FValue::Parse(Body, Env);
		Again |= BatchId(Body) == Tried && Body.find("bone_collected") != std::string::npos && Env.Find("session_id")->AsString() != First->GetSessionId();
	}
	EXPECT(Again); // under a new session ID, but the ID the server may have seen it under before

	FHarness Install;
	auto Kept = Install.NewCore();
	Kept->Init(FHarness::Options(EPrivacy::Install));
	Install.Transport->Status = 0;
	Kept->Track("x");
	Kept->Shutdown("quit");
	FValue SavedInstall;
	EXPECT(FValue::Parse(ReadAll(Install.Dir + "/outbox.json"), SavedInstall));
	for (const FValue& B : SavedInstall.Find("batches")->GetItems())
	{
		EXPECT(IsBatchId(B.Find("bid")->AsString()));
		EXPECT_EQ(B.Find("sid")->AsString(), Kept->GetSessionId());
	}
}

TEST(ABatchSavedBeforeBatchIdsGetsOne)
{
	FHarness H;
	// What a build from before batch IDs left.
	const std::string Old = "{\"v\":1,\"batches\":[{\"service\":\"fetch\",\"env\":\"dev\",\"version\":\"1.0.0\",\"group\":1761000000000,"
		"\"events\":[{\"type\":\"custom\",\"ts\":1761000000500,\"level\":null,\"name\":\"from_an_old_build\",\"attrs\":{}}]}]}";
	std::FILE* F = std::fopen((H.Dir + "/outbox.json").c_str(), "wb");
	EXPECT(F != nullptr);
	if (F)
	{
		std::fwrite(Old.data(), 1, Old.size(), F);
		std::fclose(F);
	}
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->Flush();
	bool Found = false;
	for (const std::string& Body : H.Transport->Sent)
	{
		if (Body.find("from_an_old_build") != std::string::npos)
		{
			Found = true;
			EXPECT(IsBatchId(BatchId(Body)));
		}
	}
	EXPECT(Found);
}

TEST(ClosingSavesTheOutboxAfterEachBatchTheServerTakes)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->Track("first");
	H.Transport->Status = 503; // the timer's send fails, so closing has more than one batch to send
	Core->Flush();
	const std::string First = BatchId(H.Transport->Sent.at(0));
	Core->Track("second");
	Core->Flush(); // waits out the backoff in the outbox
	H.Transport->Status = 202;
	std::vector<std::string> OnDisk;
	H.Transport->BeforeSendNow = [&]() { OnDisk.push_back(ReadAll(H.Dir + "/outbox.json")); };
	Core->Shutdown("quit");
	EXPECT_EQ(OnDisk.size(), static_cast<size_t>(3)); // first, second and the session's end
	EXPECT(OnDisk.at(0).find(First) != std::string::npos);
	EXPECT(OnDisk.at(1).find(First) == std::string::npos); // gone from the file as soon as the server took it
	EXPECT(!Exists(H.Dir + "/outbox.json"));
}

TEST(ARequestGivenUpOnAtQuitGoesAgainUnderItsId)
{
	FHarness H;
	auto First = H.NewCore();
	First->Init(FHarness::Options());
	H.Frames(*First, 30);
	First->LevelComplete("Gallery", 4200, std::nullopt);
	H.Transport->Hold = true;
	H.Transport->AnswerOnWait = false; // it reached the server, but the answer never came back
	First->Flush();
	const std::string Held = BatchId(H.Transport->Sent.at(0));
	First->Shutdown("quit");
	H.Transport->Hold = false;
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	Second->Flush();
	int Tries = 0;
	for (const std::string& Body : H.Transport->Sent)
	{
		Tries += BatchId(Body) == Held ? 1 : 0;
	}
	EXPECT_EQ(Tries, 2); // the server keeps the first and answers the second as a duplicate
}

TEST(TheBatchesACrashWritesHaveIdsToo)
{
	FHarness H;
	auto First = H.NewCore();
	First->Init(FHarness::Options());
	H.Frames(*First, 30);
	First->ReportCrash("crash", "boom", "");
	FValue Saved;
	EXPECT(FValue::Parse(ReadAll(H.Dir + "/outbox.json"), Saved));
	std::vector<std::string> Ids;
	for (const FValue& B : Saved.Find("batches")->GetItems())
	{
		Ids.push_back(B.Find("bid")->AsString());
		EXPECT(IsBatchId(Ids.back()));
	}
	EXPECT(!Ids.empty());
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	Second->Flush();
	for (const std::string& Id : Ids)
	{
		EXPECT(std::any_of(H.Transport->Sent.begin(), H.Transport->Sent.end(), [&](const std::string& Body) { return BatchId(Body) == Id; }));
	}
}

// ───────────── level_abandon (SPEC §2): leaving a level is not losing it ─────────────

namespace
{
	// The level outcomes and session ends that went, in order: "level_abandon:quit", "level_fail:left".
	std::vector<std::string> Outcomes(const std::vector<FValue>& Events)
	{
		std::vector<std::string> Out;
		for (const FValue& E : Events)
		{
			const std::string T = Type(E);
			if (T != "level_start" && T != "level_complete" && T != "level_fail" && T != "level_abandon" && T != "session_end")
			{
				continue;
			}
			const FValue* Why = E.Find("reason");
			if (!Why || !Why->IsString())
			{
				Why = E.Find("cause");
			}
			Out.push_back(T + (Why && Why->IsString() ? ":" + Why->AsString() : ""));
		}
		return Out;
	}
}

TEST(LeavingALevelIsAnAbandonNeverAFail)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->LevelStart("forest-2");
	H.Frames(*Core, 60); // a second
	Core->LevelAbandon();
	Core->Shutdown("quit");
	const std::vector<FValue> Events = H.AllEvents();
	const std::vector<FValue> Abandons = OfType(Events, "level_abandon");
	EXPECT_EQ(Abandons.size(), static_cast<size_t>(1)); // none from Glitchless at the quit: the level has its outcome
	EXPECT_EQ(Abandons.at(0).Find("level")->AsString(), "forest-2");
	EXPECT_NEAR(Abandons.at(0).Find("duration_s")->AsNumber(), 1.0, 0.01);
	EXPECT(!Abandons.at(0).Has("reason")); // the game's own
	EXPECT(OfType(Events, "level_fail").empty());
	EXPECT(Core->MakeBugReport("").Serialize().find("\"type\":\"level_abandon\"") != std::string::npos); // and it is in a bug report's recent events
}

TEST(ALevelPlayedToAnEndIsNotAbandonedAtTheQuit)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->LevelStart("a");
	Core->LevelComplete();
	Core->LevelStart("b");
	Core->LevelFail(std::nullopt, "lost");
	Core->Shutdown("quit");
	EXPECT(OfType(H.AllEvents(), "level_abandon").empty());
}

TEST(QuittingMidLevelAbandonsItBeforeTheSessionEnds)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->LevelStart("forest-2");
	H.Frames(*Core, 60);
	Core->Shutdown("quit");
	// The game ends its level as it closes, after Glitchless has: dropped, the attempt has its outcome.
	Core->LevelFail("forest-2", "left");
	Core->LevelAbandon();
	Core->LevelFail("cave-1", "lost"); // another level's is kept
	const std::vector<std::string> Order = Outcomes(H.AllEvents());
	EXPECT_EQ(Order.size(), static_cast<size_t>(3));
	EXPECT_EQ(Order.at(1), "level_abandon:quit");
	EXPECT_EQ(Order.at(2), "session_end:quit");
	const std::vector<FValue> Abandon = OfType(H.AllEvents(), "level_abandon");
	EXPECT(Abandon.at(0).Find("ts")->AsInt() <= OfType(H.AllEvents(), "session_end").at(0).Find("ts")->AsInt());
	const std::vector<std::string> After = Outcomes(Core->Queued());
	EXPECT_EQ(After.size(), static_cast<size_t>(1));
	EXPECT_EQ(After.at(0), "level_fail:lost");
	EXPECT_EQ(OfType(Core->Queued(), "level_fail").at(0).Find("level")->AsString(), "cave-1");
}

TEST(GoingToTheBackgroundMidLevelAbandonsItUntilTheGameComesBack)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->LevelStart("forest-2");
	H.Frames(*Core, 60);
	Core->OnBackground();
	Core->LevelFail("forest-2", "left"); // the game tears its level down as it goes: dropped
	H.Now += 10000;
	Core->OnForeground(); // back in the same session: the level goes on
	H.Frames(*Core, 30);
	Core->OnBackground(); // so going away again abandons it again
	H.Now += 400000;
	Core->OnForeground(); // a new session: that attempt is over, and the new one has no level started
	H.Frames(*Core, 30);
	Core->Shutdown("quit");
	const std::vector<std::string> Order = Outcomes(H.AllEvents());
	const std::vector<std::string> Expected = {"level_start", "level_abandon:background", "session_end:background", "level_abandon:background", "session_end:background", "session_end:quit"};
	EXPECT_EQ(Order.size(), Expected.size());
	for (size_t I = 0; I < std::min(Order.size(), Expected.size()); I++)
	{
		EXPECT_EQ(Order[I], Expected[I]);
	}
}

TEST(AMapLevelLeftByQuittingIsAbandonedButNotOneItsMapTookAway)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->OnMapLoaded("Arena", 1);
	H.Frames(*Core, 30);
	Core->OnMapUnloaded(1); // back to the menu: the level ended with its map
	Core->OnMapLoaded("Level_02", 2);
	H.Frames(*Core, 30);
	Core->Shutdown("quit");
	const std::vector<FValue> Abandons = OfType(H.AllEvents(), "level_abandon");
	EXPECT_EQ(Abandons.size(), static_cast<size_t>(1));
	EXPECT_EQ(Abandons.at(0).Find("level")->AsString(), "Level_02");
	EXPECT_EQ(Abandons.at(0).Find("reason")->AsString(), "quit");
}

TEST(ACrashMidLevelIsNoAbandon)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->LevelStart("forest-2");
	H.Frames(*Core, 30);
	Core->ReportCrash("crash", "boom", "");
	const std::string File = ReadAll(H.Dir + "/outbox.json");
	EXPECT(File.find("\"reason\":\"crash\"") != std::string::npos);
	EXPECT(File.find("level_abandon") == std::string::npos);
}

// ───────────── hitches, load and the refresh rate ─────────────

TEST(AHitchNothingMeasuredExplainsIsGpuOrOs)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 60);
	// 120 ms on the clock, and the threads and the GPU busy for a few of them: presenting, the compositor, the OS.
	H.Now += 120;
	Core->Frame(120, FHarness::Cost(4, 3, 2, 6));
	H.Frames(*Core, 20);
	// Each part under 40% of the frame, but together most of it: nothing to name.
	H.Now += 110;
	Core->Frame(110, FHarness::Cost(30, 25, 5, 20));
	H.Frames(*Core, 20);
	// A collection, and little else measured: the collection is the cause.
	FFrameCost Gc = FHarness::Cost(4, 3, 2, 6);
	Gc.GcCollections = 1;
	Gc.GcMs = 90;
	H.Now += 100;
	Core->Frame(100, Gc);
	H.Frames(*Core, 20);
	Core->Flush();
	std::vector<FValue> Hitches = OfType(H.Transport->Events(), "hitch");
	EXPECT_EQ(Hitches.size(), static_cast<size_t>(3));
	if (Hitches.size() == 3)
	{
		EXPECT_EQ(Hitches[0].Find("duration_ms")->AsNumber(), 120.0);
		EXPECT_EQ(Hitches[0].Find("causes")->Serialize(), "[\"gpu_or_os\"]");
		EXPECT_EQ(Hitches[0].Find("bound")->AsString(), "gpu"); // still the largest part measured
		EXPECT_EQ(Hitches[1].Find("causes")->Serialize(), "[]");
		EXPECT_EQ(Hitches[2].Find("causes")->Serialize(), "[\"gc\"]");
	}
	// A frozen frame is frozen, whatever was measured of it.
	H.Frames(*Core, 60);
	H.Now += 900;
	Core->Frame(900, FHarness::Cost(4, 3, 2, 6));
	H.Frames(*Core, 20);
	Core->Flush();
	Hitches = OfType(H.Transport->Events(), "hitch");
	EXPECT_EQ(Hitches.back().Find("duration_ms")->AsNumber(), 900.0);
	EXPECT_EQ(Hitches.back().Find("causes")->Serialize(), "[\"frozen\"]");
}

TEST(TheLoadIsPlacedAtTheFirstFrameNotTheFirstBatch)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->LevelStart("intro");
	Core->Flush(); // a batch before any frame: no load yet
	EXPECT(OfType(H.Transport->Events(), "load").empty());
	H.Now += 1500; // the first frame is slow to come
	H.Frames(*Core, 1);
	const double FirstFrameClock = H.Now;
	const int64_t FirstFrame = 1761000000000LL + static_cast<int64_t>(H.Now);
	Core->LevelStart("level-1");
	H.Frames(*Core, 200);
	Core->Flush();
	const std::vector<FValue> Loads = OfType(H.Transport->Events(), "load");
	EXPECT_EQ(Loads.size(), static_cast<size_t>(1));
	EXPECT_EQ(Loads.at(0).Find("ts")->AsInt(), FirstFrame); // when it happened, not when it was sent
	EXPECT_EQ(Loads.at(0).Find("level")->AsString(), "intro");
	EXPECT_EQ(Loads.at(0).Find("ttff_ms")->AsInt(), static_cast<int64_t>(FirstFrameClock)); // from the app's start (here, the clock's zero)
}

TEST(TheFirstWindowsAreJudgedAgainstTheMeasuredRate)
{
	FHarness H;
	auto Phone = H.NewCore();
	Phone->Init(FHarness::Options());
	H.Frames(*Phone, 20, 33.3); // a game capped at 30 fps
	EXPECT_NEAR(Phone->GetBudgetMs(), 1000.0 / 60, 0.01); // nothing measured yet
	H.Frames(*Phone, 25, 33.3);
	Phone->LevelStart("level-1"); // closes the first window 1.5 s in
	Phone->Flush();
	const FValue First = OfType(H.Transport->Events(), "frame_window").at(0);
	EXPECT_EQ(First.Find("hz")->AsInt(), 30);
	EXPECT_EQ(First.Find("budget_ms")->AsNumber(), 33.33);

	auto Fast = H.NewCore();
	Fast->Init(FHarness::Options());
	H.Frames(*Fast, 40, 8.33); // a 120 Hz screen
	EXPECT_NEAR(Fast->GetBudgetMs(), 1000.0 / 120, 0.01);
}

TEST(AWindowsGaugesAreTheirHighestAndItsCountsTheLast)
{
	FHarness H;
	int64_t Objects = 5000;
	auto Core = H.NewCore();
	Core->Engine = [&Objects]() {
		FValue E = FValue::Object();
		E.Set("objects", Objects);
		return E;
	};
	Core->Init(FHarness::Options());
	Core->SetContext("enemies", 12);
	H.Frames(*Core, 30); // the engine counts are sampled every 30 frames
	Core->SetContext("enemies", 4);
	Objects = 4200;
	Core->Flush(); // and as the window closes
	const FValue W = OfType(H.Transport->Events(), "frame_window").at(0);
	EXPECT_EQ(W.Find("ctx")->Find("enemies")->AsNumber(), 12.0);
	EXPECT_EQ(W.Find("ctx")->Find("objects")->AsNumber(), 5000.0);
	EXPECT_EQ(W.Find("objects")->AsInt(), 4200);
}

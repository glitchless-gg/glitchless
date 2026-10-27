#include "GlitchlessTestScript.h"

#include "Glitchless.h"

#include "Blueprint/BlueprintExceptionInfo.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/PlatformTime.h"
#include "Kismet/GameplayStatics.h"
#include "Misc/CommandLine.h"
#include "Misc/CoreDelegates.h"
#include "Misc/Parse.h"
#include "UObject/Package.h"
#include "UObject/Script.h"
#include "UObject/Stack.h"
#include "UObject/UObjectArray.h"
#include "UObject/UObjectGlobals.h"

DEFINE_LOG_CATEGORY_STATIC(LogGlitchlessTest, Log, All);

namespace
{
	// Work on the game thread, the way slow game code takes time (a sleep would count as idle).
	void Spin(double Ms)
	{
		const double Until = FPlatformTime::Seconds() + Ms / 1000.0;
		volatile double X = 0;
		while (FPlatformTime::Seconds() < Until)
		{
			X = X + 1;
		}
	}
}

void UGlitchlessTestScript::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	bMultiplayer = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-mp"));
	if ((!bMultiplayer && !FParse::Param(FCommandLine::Get(), TEXT("autoplay"))) || FCString::Strifind(FCommandLine::Get(), TEXT("glitchless-measure")))
	{
		return;
	}
	bCrash = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-crash"));
	bFatal = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-fatal"));
	bDialog = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-dialog"));
	bLeave = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-leave"));
	bGenre = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-genre"));
	bSwitch = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-switch"));
	bSwitchCrash = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-switch-crash"));
	FParse::Value(FCommandLine::Get(), TEXT("glitchless-test-quit="), QuitAfter);
	bSolo = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-solo"));
	StartedAt = FPlatformTime::Seconds();
	Ticker = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateUObject(this, &UGlitchlessTestScript::Step));
	FCoreUObjectDelegates::PostLoadMapWithWorld.AddUObject(this, &UGlitchlessTestScript::OnMapLoaded);
}

// The second map is slow to start, as a map with a heavy BeginPlay is: a hitch with the map load as its cause.
void UGlitchlessTestScript::OnMapLoaded(UWorld* World)
{
	if (World && World->GetMapName().Contains(TEXT("TimeOfDay")))
	{
		Spin(120);
	}
}

void UGlitchlessTestScript::Deinitialize()
{
	FCoreUObjectDelegates::PostLoadMapWithWorld.RemoveAll(this);
	FTSTicker::GetCoreTicker().RemoveTicker(Ticker);
	Super::Deinitialize();
}

void UGlitchlessTestScript::PlantedScript()
{
}

bool UGlitchlessTestScript::Step(float DeltaTime)
{
	const double T = FPlatformTime::Seconds() - StartedAt;
	UWorld* World = GetGameInstance()->GetWorld();
	// One step a second, each once.
	const int32 Due = static_cast<int32>(T);
	if (Due <= Done)
	{
		return true;
	}
	Done = Due;
	if (bMultiplayer)
	{
		return StepMultiplayer(World);
	}
	if (bGenre)
	{
		return StepGenre(World);
	}
	if (bSwitch || bSwitchCrash)
	{
		return StepSwitch();
	}
	if (bDialog)
	{
		// The bug report box, driven the way a player would: through Slate's own input.
		if (Done == 2)
		{
			FGlitchless::ShowBugReportDialog();
		}
		else if (Done == 3)
		{
			FGlitchless::ReportBug(TEXT("Planted report with the box open")); // its screenshot shows the box
		}
		else if (Done == 4 && FSlateApplication::IsInitialized())
		{
			const FModifierKeysState None;
			for (const TCHAR* C = TEXT("Door stuck"); *C; C++)
			{
				FSlateApplication::Get().ProcessKeyCharEvent(FCharacterEvent(*C, None, 0, false));
			}
			const FModifierKeysState Ctrl(false, false, true, false, false, false, false, false, false);
			FSlateApplication::Get().ProcessKeyDownEvent(FKeyEvent(EKeys::Enter, Ctrl, 0, false, 0, 0));
			FSlateApplication::Get().ProcessKeyUpEvent(FKeyEvent(EKeys::Enter, Ctrl, 0, false, 0, 0));
		}
		else if (Done == 7)
		{
			FPlatformMisc::RequestExit(false, TEXT("GlitchlessTest dialog"));
			return false;
		}
		return true;
	}
	if (bLeave)
	{
		switch (Done)
		{
		case 2:
			FGlitchless::LevelStart(TEXT("arena-1"));
			break;
		case 3:
			// What iOS and Android say as the app goes to the background. Glitchless ends the session there, with
			// the level abandoned; the game failing it as "left" afterwards is dropped.
			FCoreDelegates::ApplicationWillEnterBackgroundDelegate.Broadcast();
			FGlitchless::LevelFail(TEXT("arena-1"), TEXT("left"));
			break;
		case 5:
			FCoreDelegates::ApplicationHasEnteredForegroundDelegate.Broadcast(); // back soon: the same session, the level goes on
			FGlitchless::Track(TEXT("coins"), 1.0);
			break;
		case 7:
			FPlatformMisc::RequestExit(false, TEXT("GlitchlessTest leave")); // quits mid-level
			return false;
		default:
			break;
		}
		return true;
	}
	switch (Done)
	{
	case 2:
	{
		TMap<FString, FString> Attributes;
		Attributes.Add(TEXT("kind"), TEXT("magnet"));
		FGlitchless::Track(TEXT("powerup"), Attributes);
		FGlitchless::Track(TEXT("coins"), 3.0);
		FGlitchless::SetContext(TEXT("enemies"), 12);
		break;
	}
	case 3:
		FGlitchless::Track(TEXT("door_opened"), TEXT("north"));
		Spin(150); // a hitch from game code
		break;
	case 4:
	{
		// A hitch from garbage collection: a lot of objects to collect at once, though no more than half the
		// room left for objects (a phone has room for 131,072 in all, and running out is a fatal error).
		const int32 Room = GUObjectArray.GetObjectArrayCapacity() - GUObjectArray.GetObjectArrayNumMinusAvailable();
		const int32 Count = FMath::Min(300000, Room / 2);
		for (int32 I = 0; I < Count; I++)
		{
			Garbage.Add(NewObject<UGlitchlessTestGarbage>(GetTransientPackage()));
		}
		Garbage.Reset();
		CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS, true);
		break;
	}
	case 5:
		UE_LOG(LogGlitchlessTest, Error, TEXT("Planted error: the door at %d has no key"), 12345);
		break;
	case 6:
		ensureMsgf(false, TEXT("Planted ensure: health went below zero"));
		break;
	case 7:
	{
		// What the Blueprint VM reports for an Accessed None, from a frame in a real function.
		UFunction* Function = FindFunction(TEXT("PlantedScript"));
		FFrame Frame(this, Function, nullptr);
		FBlueprintCoreDelegates::ThrowScriptException(this, Frame, FBlueprintExceptionInfo(EBlueprintExceptionType::AccessViolation, FText::FromString(TEXT("Accessed None trying to read property Target"))));
		break;
	}
	case 8:
		FGlitchless::SetPosition(FVector(1250, -300, 90));
		FGlitchless::Death(FVector(1250, -300, 90), TEXT("spikes"));
		FGlitchless::LevelFail(FString(), TEXT("spikes"));
		break;
	case 9:
		UGameplayStatics::OpenLevel(World, TEXT("/Engine/Maps/Templates/TimeOfDay_Default"));
		break;
	case 12:
		FGlitchless::LevelComplete(FString(), 4200.0);
		FGlitchless::ReportBug(TEXT("Planted bug report: the sky is the wrong colour"));
		break;
	case 14:
		if (bFatal)
		{
			UE_LOG(LogGlitchlessTest, Fatal, TEXT("Planted fatal error: the save file is corrupt"));
		}
		if (bCrash)
		{
			UE_LOG(LogGlitchlessTest, Display, TEXT("Planted crash"));
			volatile int32* Nowhere = nullptr;
			*Nowhere = 1;
		}
		// The game quits with a batch on its way, as a game does that quits right after LevelComplete: each of
		// its events must reach the server once.
		FGlitchless::Track(TEXT("quit_requested"), TEXT("menu"));
		FGlitchless::Flush();
		FPlatformMisc::RequestExit(false, TEXT("GlitchlessTest autoplay"));
		return false;
	default:
		break;
	}
	return true;
}

// The genre additions, one second at a time, so unreal/test/e2e.mjs can check what each sends.
bool UGlitchlessTestScript::StepGenre(UWorld* World)
{
	switch (Done)
	{
	case 2:
	{
		FGlitchless::SetProperty(TEXT("mode"), TEXT("squads"));
		FGlitchless::SetProperty(TEXT("level_band"), 30);
		FGlitchless::SetProperty(TEXT("email"), TEXT("someone@example.com")); // dropped: it names who someone is
		FGlitchless::SetGroup(EGlitchlessGroup::Party, TEXT("party-0001"));
		FGlitchlessAttributes Attempt;
		Attempt.Add(TEXT("tier"), TEXT("pit_80"));
		Attempt.Add(TEXT("party_size"), 3);
		Attempt.Add(TEXT("build"), TArray<FString>{TEXT("blood_surge"), TEXT("corpse_explosion")});
		FGlitchless::LevelStart(TEXT("nmd_ghoa"), Attempt);
		FGlitchless::SetZone(TEXT("crypt"));
		break;
	}
	case 3:
	{
		FGlitchlessAttributes Match;
		Match.Add(TEXT("mode"), TEXT("squads"));
		FGlitchless::SetGroup(EGlitchlessGroup::Match, TEXT("e2e-match-0001"), Match);
		for (int32 I = 0; I < 37; I++)
		{
			FGlitchless::Count(TEXT("kill"), FGlitchlessAttributes().Add(TEXT("monster"), TEXT("elite")));
		}
		FGlitchless::Count(TEXT("gold"), FGlitchlessAttributes().Add(TEXT("source"), TEXT("loot")).Add(TEXT("amount"), 35.0), 3);
		FGlitchlessAttributes Battle;
		Battle.Add(TEXT("won"), true);
		Battle.Add(TEXT("deck"), TArray<FString>{TEXT("hog_rider"), TEXT("fireball")});
		Battle.Add(TEXT("duration_s"), 184.0);
		FGlitchless::Track(TEXT("battle_end"), Battle);
		FGlitchless::NetSample(40, 1, 3);
		break;
	}
	case 4:
		FGlitchless::NetSample(55, 0, 2);
		FGlitchless::SetProperty(TEXT("mode"), TEXT("duos"));
		for (int32 I = 0; I < 30; I++)
		{
			FGlitchless::Track(TEXT("shot")); // a stream: a development build says to count it
		}
		break;
	case 5:
		FGlitchless::Disconnect(TEXT("timeout"));
		break;
	case 7:
		FGlitchless::NetSample(45, 0, 2); // connected again: the level goes on
		FGlitchless::SetZone(FString());
		FGlitchless::ClearGroup(EGlitchlessGroup::Match);
		FGlitchless::SetGroup(EGlitchlessGroup::Run);
		break;
	case 8:
		FGlitchless::LevelComplete(TEXT("nmd_ghoa"), 9100.0);
		FGlitchless::Flush();
		FPlatformMisc::RequestExit(false, TEXT("GlitchlessTest genre"));
		return false;
	default:
		break;
	}
	return true;
}

// The player's off switch, as a settings screen's "Share performance data" toggle calls it.
bool UGlitchlessTestScript::StepSwitch()
{
	if (bSwitchCrash)
	{
		if (Done == 2)
		{
			FGlitchless::SetEnabled(false);
			FGlitchless::Track(TEXT("never"));
		}
		else if (Done == 3)
		{
			UE_LOG(LogGlitchlessTest, Display, TEXT("Planted crash with Glitchless off"));
			volatile int32* Nowhere = nullptr;
			*Nowhere = 1; // with Glitchless off, nothing is written to the outbox for the next launch
		}
		return true;
	}
	switch (Done)
	{
	case 2:
		FGlitchless::SetProperty(TEXT("mode"), TEXT("squads"));
		FGlitchless::LevelStart(TEXT("arena-2"));
		FGlitchless::Track(TEXT("before_off"));
		break;
	case 3:
		FGlitchless::Flush();
		break;
	case 4:
		FGlitchless::SetEnabled(false); // mid-level: no abandon, no session_end
		FGlitchless::Track(TEXT("while_off"));
		UE_LOG(LogGlitchlessTest, Error, TEXT("Planted error while off"));
		FGlitchless::ReportBug(TEXT("Planted bug report while off"));
		FGlitchless::SetProperty(TEXT("difficulty"), TEXT("hard")); // kept for the next session
		Spin(150);
		break;
	case 5:
		FGlitchless::SetEnabled(false); // changes nothing
		break;
	case 6:
		FGlitchless::SetEnabled(true); // a new session
		FGlitchless::Track(TEXT("back_on"));
		break;
	case 7:
		FGlitchless::LevelComplete(TEXT("arena-2"), 10.0); // its start was in the other session: dropped
		FGlitchless::LevelStart(TEXT("arena-3"));
		FGlitchless::LevelComplete(TEXT("arena-3"), 20.0);
		break;
	case 8:
		FGlitchless::Flush();
		FPlatformMisc::RequestExit(false, TEXT("GlitchlessTest switch"));
		return false;
	default:
		break;
	}
	return true;
}

// A part in a multiplayer match on Unreal's own replication: a dedicated server (-server), a listen server (a map
// opened with ?listen) or a client. Everyone joins the same match ID, which each hashes alike.
bool UGlitchlessTestScript::StepMultiplayer(UWorld* World)
{
	const ENetMode Mode = World ? World->GetNetMode() : NM_Standalone;
	const bool bServer = Mode == NM_DedicatedServer || Mode == NM_ListenServer;
	if (!bJoined && (bServer || Mode == NM_Client))
	{
		bJoined = true;
		FGlitchlessAttributes Match;
		Match.Add(TEXT("mode"), TEXT("squads"));
		FGlitchless::SetGroup(EGlitchlessGroup::Match, TEXT("mp-match-0001"), Match);
		FGlitchless::SetProperty(TEXT("mode"), TEXT("squads"));
		FGlitchless::Track(bServer ? TEXT("match_hosted") : TEXT("match_joined"));
	}
	if (bJoined && bServer)
	{
		FGlitchless::Count(TEXT("replicated_hit"), FGlitchlessAttributes().Add(TEXT("weapon"), TEXT("ar")).Add(TEXT("damage"), 23.0), 4);
	}
	if (bServer && bCrash && Done == 6)
	{
		UE_LOG(LogGlitchlessTest, Display, TEXT("Planted server crash"));
		volatile int32* Nowhere = nullptr;
		*Nowhere = 1;
	}
	// A listen server's host is one of its players.
	if (PlayersAt < 0 && ((bServer && World->GetNumPlayerControllers() >= (Mode == NM_ListenServer ? 2 : 1)) || Mode == NM_Client))
	{
		PlayersAt = Done;
		UE_LOG(LogGlitchlessTest, Display, TEXT("Multiplayer: %s"), bServer ? TEXT("a client joined") : TEXT("connected"));
	}
	if (PlayersAt >= 0 && LostAt < 0 && !bServer && Mode != NM_Client)
	{
		LostAt = Done;
		UE_LOG(LogGlitchlessTest, Display, TEXT("Multiplayer: the connection went"));
	}
	const bool bQuit = bServer ? (bSolo ? Done >= QuitAfter : PlayersAt >= 0 && Done >= PlayersAt + QuitAfter) : LostAt >= 0 && Done >= LostAt + 5;
	if (QuitAfter > 0 && bQuit)
	{
		FGlitchless::Flush();
		FPlatformMisc::RequestExit(false, TEXT("GlitchlessTest multiplayer"));
		return false;
	}
	return true;
}

#include "GlitchlessTestScript.h"

#include "Glitchless.h"

#include "Blueprint/BlueprintExceptionInfo.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/PlatformTime.h"
#include "Kismet/GameplayStatics.h"
#include "Misc/CommandLine.h"
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
	if (!FParse::Param(FCommandLine::Get(), TEXT("autoplay")) || FCString::Strifind(FCommandLine::Get(), TEXT("glitchless-measure")))
	{
		return;
	}
	bCrash = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-crash"));
	bFatal = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-fatal"));
	bDialog = FParse::Param(FCommandLine::Get(), TEXT("glitchless-test-dialog"));
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

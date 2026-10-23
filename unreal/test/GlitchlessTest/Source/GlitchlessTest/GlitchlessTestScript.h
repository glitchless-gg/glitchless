#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "GlitchlessTestScript.generated.h"

/**
 * With -autoplay, plays a short scripted run with planted problems, so unreal/test/e2e.mjs can check
 * what the Glitchless plugin sends: events, context, a hitch from game code, one from garbage
 * collection, a log error, an ensure, a Blueprint runtime error, a death, a map change, a bug report,
 * and with -glitchless-test-crash a crash (a null write) or -glitchless-test-fatal a UE_LOG Fatal. Then it quits.
 * With -glitchless-test-dialog it opens the bug report box instead, types a note and presses Ctrl+Enter.
 */
/** Objects made only to be collected. */
UCLASS()
class UGlitchlessTestGarbage : public UObject
{
	GENERATED_BODY()
};

UCLASS()
class UGlitchlessTestScript : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	/** A function for the planted Blueprint error to have happened in. */
	UFUNCTION()
	void PlantedScript();

private:
	bool Step(float DeltaTime);
	void OnMapLoaded(UWorld* World);

	FTSTicker::FDelegateHandle Ticker;
	double StartedAt = 0;
	int32 Done = 0;
	bool bCrash = false;
	bool bFatal = false;
	bool bDialog = false;
	UPROPERTY()
	TArray<TObjectPtr<UObject>> Garbage;
};

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
 * With -glitchless-test-leave it starts a level, goes to the background mid-level as a phone game would (and
 * fails the level as "left" there, as games that tear their level down do), comes back, and quits mid-level.
 * With -glitchless-test-genre it plays the genre additions instead: properties, a match, a party and a run, a
 * level with attributes, a zone, counts, flags and lists, and a connection (NetSample) that drops and comes back.
 * With -glitchless-test-switch the player turns Glitchless off mid-level (Set Enabled), plays on, and turns it back
 * on; with -glitchless-test-switch-crash they turn it off and the game crashes.
 * With -glitchless-test-mp (no -autoplay needed) it plays its part in a multiplayer match: a dedicated or listen
 * server, or a client. Each joins the match "mp-match-0001". A server quits -glitchless-test-quit=S seconds after a
 * client joined (with -glitchless-test-solo, S seconds after it started), and a client 5 seconds after its
 * connection went; -glitchless-test-crash crashes a server after 6 seconds.
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
	bool bLeave = false;
	bool bGenre = false;
	bool bSwitch = false;
	bool bSwitchCrash = false;
	bool bMultiplayer = false;
	bool bJoined = false;
	bool bSolo = false;
	int32 QuitAfter = 0;
	int32 PlayersAt = -1; // when a server first had a client, or a client first connected
	int32 LostAt = -1; // when a client's connection went
	bool StepGenre(UWorld* World);
	bool StepSwitch();
	bool StepMultiplayer(UWorld* World);
	UPROPERTY()
	TArray<TObjectPtr<UObject>> Garbage;
};

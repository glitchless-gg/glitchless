// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "InputCoreTypes.h"
#include "GlitchlessSettings.generated.h"

/** What Glitchless keeps and sends. PRIVACY.md beside the plugin lists every field each mode sends. */
UENUM(BlueprintType)
enum class EGlitchlessPrivacy : uint8
{
	/** The default: nothing with an ID is kept on the device, device facts are coarse, no positions. */
	Anonymous,
	/** Adds a random install ID kept on the device, so returning players can be counted. Device facts stay coarse. */
	Install,
	/** Adds the install ID, detailed device fields (model, GPU, cores, memory) and positions for heatmaps. */
	Full,
};

/**
 * Project Settings > Plugins > Glitchless. A service and an intake are all the setup a game needs:
 * the game instance starts Glitchless with these when it starts, and nothing else has to call Init.
 * Saved in Config/DefaultGame.ini under [/Script/Glitchless.GlitchlessSettings].
 */
UCLASS(config = Game, defaultconfig, meta = (DisplayName = "Glitchless"))
class GLITCHLESS_API UGlitchlessSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	UGlitchlessSettings();

	/** The game's id in Glitchless, lowercase and stable, for example my-game. Empty: Glitchless waits for the game to call Init. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless")
	FString Service;

	/** The Glitchless server, for example https://api.glitchless.gg or http://localhost:7777. -glitchless-intake=URL overrides it. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless")
	FString Intake;

	/** The public client token. It can only send data, so it may ship inside the game. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless")
	FString ClientToken = TEXT("gl_pub_dev");

	/** Anonymous keeps no ID on the device. Install and Full add a random install ID; Full adds detailed device fields and positions. Your privacy policy must say what you choose. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless")
	EGlitchlessPrivacy Privacy = EGlitchlessPrivacy::Anonymous;

	/** Send from Play In Editor and development builds too (as env "dev"). Off keeps your own play out of the numbers; -glitchless turns it on for one run. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless")
	bool bSendInDevelopmentBuilds = true;

	/** Off sends nothing at all. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless")
	bool bEnabled = true;

	/** Empty: the Steam build ("steam-18231") when the game runs one from Steam with Steamworks, else Project Settings >
	 * Description > Project Version. Bump it on every release, so versions can be compared. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless|Advanced", AdvancedDisplay)
	FString Version;

	/** Empty: dev in the editor and development builds, prod in shipping builds. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless|Advanced", AdvancedDisplay)
	FString Env;

	/** Death places and movement samples for heatmaps, in Anonymous and Install mode too (Full always sends them). */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless|Advanced", AdvancedDisplay)
	bool bPositions = false;

	/** Report each map as a level, except maps that read as a menu, lobby, loader or end screen. A Level Start call turns this off. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless|Advanced", AdvancedDisplay)
	bool bMapLevels = true;

	/** Report UE_LOG errors and Blueprint runtime errors, not only crashes and ensures. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless|Advanced", AdvancedDisplay)
	bool bCaptureLogErrors = true;

	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless|Advanced", AdvancedDisplay)
	bool bCaptureWarnings = false;

	/** The share of sessions to record, 0 to 1. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless|Advanced", AdvancedDisplay, meta = (ClampMin = "0", ClampMax = "1"))
	float SampleRate = 1;

	/** A key that opens the bug report box (a screenshot and a note) in game: F8, as in the other Glitchless SDKs. None (the default): only Show Bug Report Dialog opens it. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless|Advanced", AdvancedDisplay)
	FKey BugReportKey;

	/** Pause the game while the bug report box is open (a game paused already stays paused; a network client can't pause). Off: pause it yourself from On Bug Report Dialog, if at all. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless|Advanced", AdvancedDisplay)
	bool bPauseForBugReport = true;

	/** Log each batch as it is sent (LogGlitchless). -glitchless-debug does the same for one run. */
	UPROPERTY(config, EditAnywhere, BlueprintReadOnly, Category = "Glitchless|Advanced", AdvancedDisplay)
	bool bDebug = false;
};

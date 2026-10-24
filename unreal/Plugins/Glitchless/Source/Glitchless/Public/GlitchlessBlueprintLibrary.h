// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "GlitchlessSettings.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "GlitchlessBlueprintLibrary.generated.h"

/** Glitchless for Blueprints. The same calls as FGlitchless in C++; each is safe before Init. */
UCLASS()
class GLITCHLESS_API UGlitchlessBlueprintLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** Says who the game is and where to send. Not needed when Project Settings > Plugins > Glitchless has a service. Only the first call counts. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Glitchless Init", AdvancedDisplay = "Version"))
	static void Init(const FString& Service, const FString& Intake, const FString& ClientToken = TEXT("gl_pub_dev"), EGlitchlessPrivacy Privacy = EGlitchlessPrivacy::Anonymous, const FString& Version = TEXT(""));

	/** A game event: pickups, purchases, checkpoints. Attributes and Numbers say more about it. Use the game's own words, never anything the player typed. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Track Event", AutoCreateRefTerm = "Attributes,Numbers"))
	static void Track(const FString& Name, const TMap<FString, FString>& Attributes, const TMap<FString, float>& Numbers);

	/** A game event with one word about it, such as the powerup's name, sent as the attribute "what". */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Track Event (What)"))
	static void TrackWhat(const FString& Name, const FString& What);

	/** A level starts (a restart counts too). Calling this turns automatic map levels off. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void LevelStart(const FString& Level);

	/** The level is beaten. Empty Level: the current one. Score below 0: none. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void LevelComplete(const FString& Level = TEXT(""), float Score = -1);

	/** The player lost the level. Cause is a short word: fell, timeout. Leaving it is Level Abandon. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void LevelFail(const FString& Level = TEXT(""), const FString& Cause = TEXT(""));

	/** The player left the level before it ended: went to the menu, restarted it, quit. Never counted as a fail. Empty Level: the current one. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void LevelAbandon(const FString& Level = TEXT(""));

	/** A death at a place in the world. The place is sent only when positions are on. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void Death(FVector Location, const FString& Cause = TEXT("unknown"));

	/** A number that describes what is going on (enemies, particles). Its largest value in each frame window is sent, and it goes with each hitch. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void SetContext(const FString& Key, float Value);

	/** The player's place, sampled for heatmaps. Ignored unless positions are on. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void SetPosition(FVector Location);

	/** Reports a problem the game noticed itself. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Report Error", AutoCreateRefTerm = "Attributes"))
	static void Error(const FString& Message, const TMap<FString, FString>& Attributes);

	/** Sends a bug report now: a screenshot of the game and the note. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void ReportBug(const FString& Note);

	/** Takes a screenshot and opens a small box over the game where the player writes what went wrong. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void ShowBugReportDialog();

	/** Closes the current frame window and sends what is waiting. It also runs by itself every few seconds. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void Flush();

	UFUNCTION(BlueprintPure, Category = "Glitchless")
	static bool IsEnabled();

	/** This session's random ID (it is never kept on the device in Anonymous mode). */
	UFUNCTION(BlueprintPure, Category = "Glitchless")
	static FString GetSessionId();
};

// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "GlitchlessAttributes.h"
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

	/** A game event with words, numbers, flags and lists: send an outcome as a flag (won) and a deck or a build as a list, so boards can show win rates by each. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Track Event (Attributes)", AutoCreateRefTerm = "Attributes"))
	static void TrackAttributes(const FString& Name, const FGlitchlessAttributes& Attributes);

	/** Something that happens too often to send each time (shots, kills, gold, taps): counted here and sent once every 5 seconds. Words and flags say which count; numbers (an amount) are summed. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Count Event", AutoCreateRefTerm = "Attributes"))
	static void Count(const FString& Name, const FGlitchlessAttributes& Attributes, int32 N = 1);

	/** A level starts (a restart counts too). Attributes say what the attempt is (difficulty, party size, the build). Calling this turns automatic map levels off. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (AutoCreateRefTerm = "Attributes"))
	static void LevelStart(const FString& Level, const FGlitchlessAttributes& Attributes);

	/** What holds for this session (mode, rank tier, class, region): boards can split by it. Never who the player is: what looks like an email address, a phone number, a link or an ID is dropped. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Set Glitchless Property"))
	static void SetProperty(const FString& Key, const FString& Value);

	/** A whole number that holds for this session. Prefer a band (Set Glitchless Property with "30-39") to an exact level. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Set Glitchless Property (Number)"))
	static void SetPropertyNumber(const FString& Key, int64 Value);

	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Set Glitchless Property (Flag)"))
	static void SetPropertyFlag(const FString& Key, bool Value);

	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Clear Glitchless Property"))
	static void ClearProperty(const FString& Key);

	/** Marks every event with a match, party or run until Clear Group. Match and party IDs come from your server (sent hashed); leave Id empty for a new run. Returns the ID that is sent. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (AutoCreateRefTerm = "Attributes"))
	static FString SetGroup(EGlitchlessGroup Kind, const FString& Id, const FGlitchlessAttributes& Attributes);

	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void ClearGroup(EGlitchlessGroup Kind);

	/** Where the player is in an open world (a region, a room): events and frame windows are marked with it, as with the level. Empty leaves the zone. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless")
	static void SetZone(const FString& Zone);

	/** For a game on another network library than Unreal's replication: the connection this second. Below 0 is not known. */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Report Net Sample"))
	static void NetSample(float RttMs, float LossPct = -1, float JitterMs = -1);

	/** For a game on another network library: the connection failed (timeout, connection_lost, kicked, server_closed, failed_to_connect, other). */
	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Report Disconnect"))
	static void Disconnect(const FString& Reason);

	UFUNCTION(BlueprintCallable, Category = "Glitchless", meta = (DisplayName = "Report Reconnect"))
	static void Reconnect();

	/** Adds a word to a set of attributes. */
	UFUNCTION(BlueprintPure, Category = "Glitchless|Attributes", meta = (DisplayName = "Add Word", AutoCreateRefTerm = "Attributes"))
	static FGlitchlessAttributes AddWord(const FGlitchlessAttributes& Attributes, const FString& Key, const FString& Value);

	UFUNCTION(BlueprintPure, Category = "Glitchless|Attributes", meta = (DisplayName = "Add Number", AutoCreateRefTerm = "Attributes"))
	static FGlitchlessAttributes AddNumber(const FGlitchlessAttributes& Attributes, const FString& Key, double Value);

	/** Adds a flag: true or false, such as won or overtime. */
	UFUNCTION(BlueprintPure, Category = "Glitchless|Attributes", meta = (DisplayName = "Add Flag", AutoCreateRefTerm = "Attributes"))
	static FGlitchlessAttributes AddFlag(const FGlitchlessAttributes& Attributes, const FString& Key, bool Value);

	/** Adds a list of words, such as a deck or a build. */
	UFUNCTION(BlueprintPure, Category = "Glitchless|Attributes", meta = (DisplayName = "Add List", AutoCreateRefTerm = "Attributes,Value"))
	static FGlitchlessAttributes AddList(const FGlitchlessAttributes& Attributes, const FString& Key, const TArray<FString>& Value);

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

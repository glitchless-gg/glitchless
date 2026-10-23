// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "GlitchlessSettings.h"

GLITCHLESS_API DECLARE_LOG_CATEGORY_EXTERN(LogGlitchless, Log, All);

/** What FGlitchless::Init takes. The project settings fill the same fields when the game doesn't call it. */
struct GLITCHLESS_API FGlitchlessOptions
{
	/** The game's id in Glitchless, lowercase and stable, for example "my-game". */
	FString Service;
	/** The Glitchless server, for example https://api.glitchless.gg or http://localhost:7777. */
	FString Intake;
	/** The public client token. It can only send data, so it may ship inside the game. */
	FString ClientToken = TEXT("gl_pub_dev");
	/** Empty: Project Settings > Description > Project Version. */
	FString Version;
	/** Empty: "dev" in the editor and development builds, "prod" in shipping builds. */
	FString Env;
	EGlitchlessPrivacy Privacy = EGlitchlessPrivacy::Anonymous;
	/** Death places and movement samples. Unset: on in Full mode only. */
	TOptional<bool> Positions;
	bool bMapLevels = true;
	bool bSendInDevelopmentBuilds = true;
	bool bCaptureLogErrors = true;
	bool bCaptureWarnings = false;
	float SampleRate = 1;
	/** Unset: on whenever there is an intake. */
	TOptional<bool> Enabled;
	bool bDebug = false;

	static FGlitchlessOptions FromSettings(const UGlitchlessSettings& Settings);
};

/**
 * Glitchless for Unreal: frame times and hitches with their likely causes, errors, ensures and
 * crashes, maps as levels, deaths, bug reports and where players quit, sent to a Glitchless server in
 * the same shape as the browser, Unity and Godot SDKs.
 *
 *   FGlitchless::Init(TEXT("my-game"), TEXT("https://api.glitchless.gg"), TEXT("gl_pub_..."));  // or Project Settings > Plugins > Glitchless
 *   FGlitchless::Death(Character->GetActorLocation(), TEXT("fell"));
 *   FGlitchless::Track(TEXT("powerup"), TEXT("magnet"));
 *   FGlitchless::SetContext(TEXT("enemies"), Enemies.Num());
 *
 * Maps are levels on their own. Every call is safe before Init and from any thread, and does nothing
 * in the editor outside Play In Editor. Positions are taken in Unreal units (centimetres, Z up) and
 * sent as the other SDKs send them: metres with y up.
 */
class GLITCHLESS_API FGlitchless
{
public:
	static const TCHAR* SdkVersion();

	/** Says who the game is and where to send. Call it once, as early as you can; only the first call counts. */
	static void Init(const FGlitchlessOptions& Options);
	static void Init(const FString& Service, const FString& Intake, const FString& ClientToken = TEXT("gl_pub_dev"));

	/** A level starts (a restart counts too). Calling this turns automatic map levels off. */
	static void LevelStart(const FString& Level);
	/** Empty Level: the current one. Unset Duration: the time since its LevelStart. */
	static void LevelComplete(const FString& Level = FString(), TOptional<double> Score = {}, TOptional<double> DurationSeconds = {});
	/** The player gave up or lost the level. Cause is a short word: "fell", "timeout", "restart". */
	static void LevelFail(const FString& Level = FString(), const FString& Cause = FString());

	/** A death at a place in the world. The place is sent only when positions are on (Full mode, or Positions). */
	static void Death(const FVector& Location, const FString& Cause = TEXT("unknown"));
	static void Death(const FString& Cause = TEXT("unknown"));

	/** A game event: pickups, purchases, checkpoints. Use the game's own words, never anything the player typed. */
	static void Track(const FString& Name);
	/** A game event with one word about it ("magnet"), sent as the attribute "what". */
	static void Track(const FString& Name, const FString& What);
	static void Track(const FString& Name, double What);
	static void Track(const FString& Name, const TMap<FString, FString>& Attributes, const TMap<FString, double>& Numbers = TMap<FString, double>());

	/** A number that describes what is going on (enemies, particles, projectiles). The largest value in each
	 * frame window is sent, and the current ones go with each hitch, so the findings can say what was high
	 * when frames stuttered. Call it every frame or whenever the number changes. */
	static void SetContext(const FString& Key, double Value);
	/** The player's place, sampled 4 times a second for heatmaps. Ignored unless positions are on. */
	static void SetPosition(const FVector& Location);

	/** Reports a problem the game noticed itself. */
	static void Error(const FString& Message, const TMap<FString, FString>& Attributes = TMap<FString, FString>());

	/** Sends a bug report now: a screenshot of the game viewport and the player's note. */
	static void ReportBug(const FString& Note);
	/** Takes a screenshot and opens a small box over the game where the player writes what went wrong. The
	 * game gets no input while it is open. Project Settings > Plugins > Glitchless > Bug Report Key opens it too. */
	static void ShowBugReportDialog();
	/** True when the bug report box opens, false when it closes: pause the game here if it should. */
	static TMulticastDelegate<void(bool bOpen)>& OnBugReportDialog();

	/** Frame stats over the next Seconds, as one JSON object: the same numbers as the browser SDK's glitchless_measure. */
	static void Measure(float Seconds, TFunction<void(const FString& Json)> Done);
	/** Closes the current frame window and sends what is waiting. Runs by itself every few seconds. */
	static void Flush();

	static bool IsEnabled();
	static FString GetSessionId();
	static FString GetLevel();
	/** What Glitchless sees right now, as JSON: where it sends, its stats, the last frame windows and hitches,
	 * the gauges and this session's errors. Null JSON when it isn't running (the editor outside Play In Editor). */
	static FString GetLiveJson();
};

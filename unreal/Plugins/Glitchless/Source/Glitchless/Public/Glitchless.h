// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "GlitchlessAttributes.h"
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
	/** Unset: on whenever there is an intake. False sends nothing, whatever the player chose with SetEnabled. */
	TOptional<bool> Enabled;
	/** For a game that asks the player first: on a device where they haven't chosen yet, nothing is measured, kept
	 * or sent until FGlitchless::SetEnabled(true). Their saved choice wins over it. The project setting Opt In does
	 * the same from the first frame. */
	bool bOptIn = false;
	bool bDebug = false;
	/** What holds for the session from the start (mode, region): as SetProperty takes them, and checked the same way. */
	TMap<FString, FString> Properties;
	/** Match and party IDs go hashed with the service as the salt. Off sends them as they are, to look them up in your server's logs. */
	bool bHashGroupIds = true;
	/** A dedicated server's region in the game's own words ("eu-west"); -glitchless-region= sets it too. */
	FString ServerRegion;
	/** A dedicated server that hosts one match at a time: a session per match, ended when the match group is cleared. */
	bool bServerSessionPerMatch = false;

	static FGlitchlessOptions FromSettings(const UGlitchlessSettings& Settings);
};

/**
 * Glitchless for Unreal: frame times and hitches with their likely causes, errors, ensures and
 * crashes, maps as levels, deaths, bug reports and where players quit, sent to a Glitchless server in
 * the same shape as the browser, Unity and Godot SDKs.
 *
 *   FGlitchless::Init(TEXT("my-game"), TEXT("https://api.glitchless.gg"), TEXT("gl_pub_..."));  // or Project Settings > Plugins > Glitchless
 *   FGlitchless::LevelAbandon();  // the player went to the menu or restarted mid-level: not a fail
 *   FGlitchless::Death(Character->GetActorLocation(), TEXT("fell"));
 *   FGlitchless::Track(TEXT("powerup"), TEXT("magnet"));
 *   FGlitchless::Count(TEXT("kill"), FGlitchlessAttributes().Add(TEXT("monster"), TEXT("elite")));  // a stream, counted on the device
 *   FGlitchless::SetProperty(TEXT("rank"), TEXT("gold"));  // what holds for the session
 *   FGlitchless::SetGroup(EGlitchlessGroup::Match, MatchId);  // every event marked with the match, hashed
 *   FGlitchless::SetContext(TEXT("enemies"), Enemies.Num());
 *   FGlitchless::SetEnabled(Settings->bSharePerformanceData);  // the player's "Share performance data" toggle
 *
 * Maps are levels on their own. Every call is safe before Init and from any thread, and does nothing
 * in the editor outside Play In Editor. Positions are taken in Unreal units (centimetres, Z up) and
 * sent as the other SDKs send them: metres with y up. Unreal's own replication is read by itself: ping,
 * packet loss and disconnects on clients, and on a dedicated server, its own session (role "server",
 * filed under <service>.server) with its tick time, players and crashes.
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
	/** With what the attempt is: difficulty, party size, the build (a list). Boards can split clears by any of them. */
	static void LevelStart(const FString& Level, const FGlitchlessAttributes& Attributes);
	/** Empty Level: the current one. Unset Duration: the time since its LevelStart. */
	static void LevelComplete(const FString& Level = FString(), TOptional<double> Score = {}, TOptional<double> DurationSeconds = {});
	/** The player lost the level. Cause is a short word: "fell", "timeout". Leaving it is LevelAbandon. */
	static void LevelFail(const FString& Level = FString(), const FString& Cause = FString());
	/** The player left the level before it ended: went to the menu, restarted it, quit. Never counted as a fail.
	 * Empty Level: the current one. Going to the background or quitting mid-level sends one by itself. */
	static void LevelAbandon(const FString& Level = FString());

	/** A death at a place in the world. The place is sent only when positions are on (Full mode, or Positions). */
	static void Death(const FVector& Location, const FString& Cause = TEXT("unknown"));
	static void Death(const FString& Cause = TEXT("unknown"));

	/** A game event: pickups, purchases, checkpoints. Use the game's own words, never anything the player typed. */
	static void Track(const FString& Name);
	/** A game event with one word about it ("magnet"), sent as the attribute "what". */
	static void Track(const FString& Name, const FString& What);
	static void Track(const FString& Name, double What);
	static void Track(const FString& Name, const TMap<FString, FString>& Attributes, const TMap<FString, double>& Numbers = TMap<FString, double>());
	/** A game event with words, numbers, flags and lists: send an outcome as a flag (won = true) and a deck as a list. */
	static void Track(const FString& Name, const FGlitchlessAttributes& Attributes);

	/** Something that happens too often to send each time: shots, kills, gold, taps. Counted on the device and sent
	 * once every 5 seconds, so it never crowds out the frame windows. Words and flags (4 at most) say which count;
	 * numbers (4 at most, such as an amount) are summed; N adds to the count. Track a moment, count a stream. */
	static void Count(const FString& Name, const FGlitchlessAttributes& Attributes = FGlitchlessAttributes(), int32 N = 1);

	/** What holds for this session, in the game's words: the mode, a rank tier, the class, the server region. Boards
	 * can split any number by it. Keys are lowercase words ("rank", "level_band"); values a word, a whole number or
	 * a flag. Never who the player is: keys such as email or user_id, and values that look like an email address, a
	 * phone number, a link or an ID, are dropped. 12 a session. */
	static void SetProperty(const FString& Key, const FString& Value);
	static void SetProperty(const FString& Key, const TCHAR* Value);
	static void SetProperty(const FString& Key, int32 Value);
	static void SetProperty(const FString& Key, int64 Value);
	/** A whole number: send a band ("30-39") rather than an exact level. Fractions are dropped. */
	static void SetProperty(const FString& Key, double Value);
	static void SetProperty(const FString& Key, bool Value);
	static void ClearProperty(const FString& Key);

	/** Marks every event (and frame window) with a match, party or run until ClearGroup, so a match can be read from
	 * every side. Match and party IDs come from your game's server, shared by everyone in it; they are sent hashed
	 * unless bHashGroupIds is off. A run's ID is the plugin's: leave Id empty for a new run, or pass the one you saved
	 * to go on with it (in Install and Full mode; Anonymous mode starts a new one). Returns the ID that is sent. */
	static FString SetGroup(EGlitchlessGroup Kind, const FString& Id = FString(), const FGlitchlessAttributes& Attributes = FGlitchlessAttributes());
	static void ClearGroup(EGlitchlessGroup Kind);
	/** The ID sent for the group, or empty. */
	static FString GetGroup(EGlitchlessGroup Kind);

	/** Where the player is in an open world (an MMO region, a metroidvania room), which has no start or end as a level
	 * has: every event and frame window is marked with it, as with the level. Empty leaves the zone. */
	static void SetZone(const FString& Zone);

	/** For a game on another network library (Steam Networking Sockets, EOS): the connection this second. Unreal's
	 * own replication is read without these. Less than 0 is not known. */
	static void NetSample(float RttMs, float LossPct = -1, float JitterMs = -1);
	/** The connection failed: timeout, connection_lost, kicked, server_closed, failed_to_connect or other. */
	static void Disconnect(const FString& Reason);
	static void Reconnect();

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

	/** The player's "Share performance data" setting, for a toggle in the game's settings. Off stops Glitchless at
	 * once: nothing more is measured or sent, what was waiting (on the device too) is dropped, and the session ends
	 * without a word. On starts a new session. The choice is saved on the device (Saved/Glitchless/enabled) and read
	 * before anything is measured on the next launch, so a player who turned it off sends nothing at all. A call that
	 * changes nothing does nothing, so the game can pass its own saved setting every time it starts. It can't turn
	 * on a build that doesn't send (bEnabled, Enabled false, no intake, a development build without -glitchless). */
	static void SetEnabled(bool bOn);
	/** True while Glitchless is on: this build sends and the player hasn't turned it off. For a settings menu, show
	 * the game's own saved setting: in a build that sends nothing this is false whatever the player chose. */
	static bool IsEnabled();
	static FString GetSessionId();
	static FString GetLevel();
	/** What Glitchless sees right now, as JSON: where it sends, its stats, the last frame windows and hitches,
	 * the gauges and this session's errors. Null JSON when it isn't running (the editor outside Play In Editor). */
	static FString GetLiveJson();
};

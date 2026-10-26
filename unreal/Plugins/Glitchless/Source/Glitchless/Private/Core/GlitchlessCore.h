// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "GlitchlessJson.h"
#include "GlitchlessSketch.h"
#include "GlitchlessText.h"

#include <algorithm>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace Glitchless
{
	enum class EPrivacy : uint8_t
	{
		/** The default: no ID of any kind kept on the device, coarse device facts, no positions unless Positions is set. */
		Anonymous,
		/** Adds a random install ID saved on the device, so returning players can be counted. Device facts stay coarse. */
		Install,
		/** Adds the install ID, detailed device fields and positions. */
		Full,
	};

	const char* PrivacyName(EPrivacy Privacy);

	/** Whose session this is: a player's, or a game server's (a dedicated server, or a listen server's own session). */
	enum class ERole : uint8_t
	{
		Player,
		Server,
	};

	/** Everything Init() takes. PRIVACY.md says what each setting changes in what is sent. */
	struct FOptions
	{
		/** The game's id in Glitchless, lowercase and stable, for example "my-game". */
		std::string Service = "unknown-game";
		/** The game's version; empty uses the Steam build ("steam-18231") when the game runs one from Steam with
		 * Steamworks, else the project's version. Bump it on every release. */
		std::string Version;
		/** Empty: "dev" in the editor and development builds, "prod" in shipping builds. */
		std::string Env;
		/** The Glitchless server, for example https://api.glitchless.gg or http://localhost:7777. */
		std::string Intake;
		/** The public client token. It can only send data, so it may ship inside the game. */
		std::string ClientToken = "gl_pub_dev";
		EPrivacy Privacy = EPrivacy::Anonymous;
		/** Death places and movement samples. Unset: on in Full mode only. */
		std::optional<bool> Positions;
		/** The share of sessions to record, 0 to 1. */
		double SampleRate = 1;
		/** Frame stats are summed up per window: the dashboard's time resolution. */
		double WindowSeconds = 5;
		/** How often batches are sent, on a window boundary. The first goes after 2 s. */
		double FlushIntervalSeconds = 15;
		double PositionHz = 4;
		/** "user", "tester" or "synthetic" (bots). Empty: synthetic with -autoplay, -glitchless-synthetic or
		 * -glitchless-measure, tester on a TestFlight or development install on iOS. */
		std::string SessionType;
		/** Seconds in the background after which coming back starts a new session. */
		double SessionTimeoutSeconds = 300;
		/** Report each map as a level (level_start when it loads). A LevelStart() call turns this off. */
		bool MapLevels = true;
		/** Map name to level name, or empty when the map isn't a level. Unset: every map except those that read as a menu, lobby, loader or end screen. */
		std::function<std::string(const std::string&)> LevelForMap;
		/** Report UE_LOG errors and Blueprint runtime errors, not only crashes and ensures. */
		bool CaptureLogErrors = true;
		bool CaptureWarnings = false;
		/** UObject and actor counts in ctx, where the findings look for leaks. */
		bool EngineGauges = true;
		/** The same key four times in a second. Unset: on except on phones, where fast tapping is play. */
		std::optional<bool> RageInput;
		/** Unset: on whenever there is an intake URL (and, in a development build, SendInDevelopmentBuilds or -glitchless). */
		std::optional<bool> Enabled;
		/** Send from the editor and development builds. Off keeps your own play out of the numbers; -glitchless turns it on for one run. */
		bool SendInDevelopmentBuilds = true;
		/** Log each batch as it is sent. */
		bool Debug = false;
		/** What holds for the session (mode, rank band, region), as SetProperty takes them: an object. */
		FValue Properties;
		/** Match and party IDs go hashed (Rules::HashGroupId). Off sends them as the game gave them, to look up in its own server logs. */
		bool HashGroupIds = true;
		/** A server's region in the game's own words ("eu-west"); -glitchless-region= sets it too. */
		std::string ServerRegion;
		/** A server that hosts one match at a time: a session per match, ended when the match group is cleared. */
		bool ServerSessionPerMatch = false;
	};

	/** One network sample: what the connection to the game's server looked like this second. -1 is not known. */
	struct FNetSample
	{
		double RttMs = -1;
		double LossPct = -1;
		double JitterMs = -1;
		double InKbps = -1;
		double OutKbps = -1;
		/** The library: "unreal" (its own replication) or "custom" (the game's own calls). */
		std::string Transport = "custom";
		/** wifi, cellular, wired, or empty where the device doesn't say. */
		std::string Link;
		/** This player hosts a listen server, so their own round trip is zero. */
		bool Host = false;
	};

	/** A server's state, sampled about once a second. -1 is not known. */
	struct FServerSample
	{
		int Players = -1;
		int NetObjects = -1;
		/** The tick rate the server aims for (Unreal's NetServerMaxTickRate): a tick over 1000 / TickHz ms is late. */
		double TickHz = -1;
		double InKbps = -1;
		double OutKbps = -1;
		/** Percent of one core. */
		double CpuPct = -1;
		double MemMb = -1;
		/** Each connected player's round trip as the server sees it. */
		std::vector<double> RttMs;
	};

	/** What one frame cost, measured by the Unreal side. -1 means not measured on this platform or build. */
	struct FFrameCost
	{
		double Game = -1; // game thread, without its waits (GGameThreadTime)
		double Render = -1; // render thread (GRenderThreadTime)
		double Rhi = -1; // RHI thread, where the platform runs one (GRHIThreadTime)
		double Gpu = -1; // RHIGetGPUFrameCycles
		int64_t Calls = -1; // draw calls
		int64_t Triangles = -1; // primitives drawn
		int64_t PsoCompiles = -1; // pipeline states the frame had to wait for
		int64_t ShaderCompiles = -1; // shaders compiled (the editor, or a cooked build without a shader cache)
		int GcCollections = 0;
		double GcMs = -1;
		int64_t PackagesLoaded = -1;
		bool AssetFlush = false; // the game thread waited for loading (FlushAsyncLoading, a synchronous load)
		bool MapLoaded = false;
		bool LevelStreamed = false;
	};

	/** Sends batches. The Unreal side uses FHttpModule; tests use a stand-in. */
	class ITransport
	{
	public:
		virtual ~ITransport() = default;
		/** Starts a POST; Done(status) comes later on the game thread, with 0 for a network failure. */
		virtual void Send(const std::string& Url, std::vector<uint8_t> Body, const std::string& ContentType, std::function<void(int64_t)> Done) = 0;
		/** Starts a GET (the server's /v1/health); Done(status, body) comes later on the game thread. */
		virtual void Get(const std::string& /*Url*/, std::function<void(int64_t, const std::string&)> Done) { Done(0, ""); }
		/** Sends and waits at most TimeoutMs, for when the game is closing. Returns the status, or 0. */
		virtual int64_t SendNow(const std::string& Url, const std::vector<uint8_t>& Body, const std::string& ContentType, int TimeoutMs) = 0;
		/** Gives up on the request Send started, if it's still going. */
		virtual void Abort() = 0;
		/** For when the game is closing: waits at most TimeoutMs for the request Send started to be answered, its
		 *  Done running before this returns. False if it is still going (or this transport can't wait). */
		virtual bool Wait(int /*TimeoutMs*/) { return false; }
	};

	/** File access, so the Unreal side can use the platform file layer. Unset members use the C library. */
	struct FFileSystem
	{
		std::function<bool(const std::string& Path, std::string& Out)> Read;
		/** Replaces the file whole, or leaves it as it was. */
		std::function<bool(const std::string& Path, const std::string& Text)> Write;
		std::function<void(const std::string& Path)> Delete;
		std::function<void(const std::string& Dir)> MakeDir;
	};

	struct FStats
	{
		int64_t Sent = 0;
		int64_t Failed = 0;
		int64_t Errors = 0;
		int64_t Hitches = 0;
		int64_t Deaths = 0;
		std::string LastStatus = "idle";
	};

	/**
	 * The engine-independent part of the Unreal SDK, a port of the Unity SDK's GlitchlessCore.cs: the
	 * same events, in the same shape, as the browser, Unity and Godot SDKs, so the dashboard, findings
	 * and MCP tools take an Unreal game as they are. Everything runs on the game thread.
	 */
	class FCore
	{
	public:
		static constexpr const char* SdkVersion = "0.4.0";
		static constexpr const char* Sdk = "glitchless-unreal/0.4.0";
		static constexpr int SendDeadlineMs = 1500; // how long closing or going to the background may wait on the network

		FCore();
		~FCore();
		FCore(const FCore&) = delete;
		FCore& operator=(const FCore&) = delete;

		// ───────────── what the Unreal side (or a test) provides ─────────────

		std::function<int64_t()> UnixNow;
		/** Milliseconds, only ever compared with itself. */
		std::function<double()> Clock;
		std::shared_ptr<ITransport> Transport;
		/** Where the outbox and install ID live; empty writes nothing to disk. */
		std::string SaveDir;
		FFileSystem Files;
		std::function<FValue(bool Detailed)> Device;
		/** The game's Steam facts (GlitchlessSteam.h), an empty object until Steamworks answers. */
		std::function<FValue()> SteamFacts;
		/** Where an iOS build was installed from (DeviceFacts::IosDistribution); unset or "" elsewhere. */
		std::function<std::string()> Distribution;
		/** UObject and actor counts and memory, sampled every 30 frames. */
		std::function<FValue()> Engine;
		/** Time since the app started, for time to first frame. */
		std::function<double()> StartupMs;
		std::vector<std::string> Args;
		std::function<std::vector<int>()> ScreenSize;
		std::function<std::vector<int>()> WindowSize;
		std::function<void(const std::string&)> Log;
		/** Gzips a batch; unset or false sends it as it is. */
		std::function<bool(const std::string& In, std::vector<uint8_t>& Out)> Gzip;
		std::string AppVersion;
		bool IsDevelopmentBuild = false;
		bool IsMobile = false;
		bool IsHeadless = false;
		FScrubber Scrubber;
		/** Set before Init: a server's session sends server windows in place of frame windows, with role "server". */
		ERole Role = ERole::Player;
		/** A server's session_start.server: tick_hz, max_players, build ("dedicated", "listen") and host {os, cores, memory_gb}. */
		std::function<FValue()> ServerInfo;

		// ───────────── the game's calls ─────────────

		/** Says who the game is and where to send. Until this is called nothing is sent, but frame
		 * times, errors and events are kept, so a game may call it late. Only the first call counts. */
		void Init(const FOptions& InOptions);
		/** Attrs (an object) describe the attempt: difficulty, party size, the build. */
		void LevelStart(const std::string& LevelId, FValue Attrs = FValue());
		void LevelComplete(const std::optional<std::string>& LevelId = std::nullopt, std::optional<double> Score = std::nullopt, std::optional<double> DurationS = std::nullopt);
		/** The player lost the level (died, ran out of time). Leaving it is LevelAbandon. */
		void LevelFail(const std::optional<std::string>& LevelId = std::nullopt, const std::string& Cause = "");
		/** The player left the level before it ended: went to the menu, restarted it, closed the game. Never a
		 * fail. Going to the background or quitting mid-level sends one by itself (SPEC §2 level_abandon). */
		void LevelAbandon(const std::optional<std::string>& LevelId = std::nullopt);
		/** A death. The place is sent only when positions are on; the death and cause always are. */
		void Death(std::optional<double> X, std::optional<double> Y, std::optional<double> Z, const std::string& Cause);
		void Track(const std::string& Name, FValue Attrs = FValue());
		/** Something that happens too often to send each time (shots, kills, gold): counted on the device and sent
		 * once a window as a counts event. Its strings and booleans (4 at most) say which count, its numbers (4 at
		 * most) are summed, and N adds to the count. */
		void Count(const std::string& Name, const FValue& Attrs = FValue(), int64_t N = 1);
		/** What holds for the session (mode, rank band, class, region). Null removes it. Checked by Rules: what could
		 * identify someone is dropped, with one warning in a development build. */
		void SetProperty(const std::string& Key, const FValue& Value);
		/** Marks every event with a match, party or run until ClearGroup. Match and party IDs come from the game's
		 * server and go hashed; an empty run ID starts a new run. Returns the ID that is sent, or "" when it was dropped. */
		std::string SetGroup(const std::string& Kind, const std::string& Id, FValue Attrs = FValue());
		void ClearGroup(const std::string& Kind);
		/** A group as another session already sent it (hashed): a listen server's own session takes its host's match. */
		void AdoptGroup(const std::string& Kind, const std::string& SentId);
		/** Where the player is in an open world (a region, a room): stamped on events and windows as the level is.
		 * Empty leaves the zone. */
		void SetZone(const std::string& Zone);
		/** The connection this second. The Unreal side samples its net driver; a game on another library calls it. */
		void NetSample(const FNetSample& S);
		/** The connection closed the normal way (the player left the match): no disconnect. */
		void NetEnded();
		/** The connection failed: timeout, connection_lost, kicked, server_closed, failed_to_connect or other. Sends
		 * a disconnect with the last window's numbers, and abandons the level that was open. */
		void Disconnect(const std::string& Reason);
		/** Connected again after a disconnect; the next sample does this by itself. */
		void Reconnect();
		/** A server's players, traffic, CPU and memory, about once a second. */
		void ServerSample(const FServerSample& S);
		void SetContext(const std::string& Key, double Value);
		void SetPosition(double X, double Y, double Z);
		/** An error from Unreal's log, or one the game reported (Manual). */
		void ReportError(const std::string& Kind, const std::string& Message, const std::string& Stack, FValue Attrs = FValue(), bool Manual = false, const std::string& FnHint = "");
		/** The game is about to die: the error, the frames so far and the session's end are written to
		 * the outbox at once, without sending, and go out on the next launch. */
		void ReportCrash(const std::string& Kind, const std::string& Message, const std::string& Stack);
		/** What a bug report says about this moment: when, the level, where the player is, the last game
		 * events and hitches, the last frame windows and the device. Screenshot is a JPEG data URL (or empty).
		 * Made when the player opens the report box, so it describes what they saw. */
		FValue MakeBugReport(const std::string& Screenshot);
		/** Sends a report made by MakeBugReport with the player's note, on a request of its own, from every
		 * session, sampled or not. A failed send goes out with the next batch. */
		void SendBugReport(FValue Report, const std::string& Note);
		void BugReport(const std::string& Note, const std::string& Screenshot) { SendBugReport(MakeBugReport(Screenshot), Note); }
		/** Frame stats over the next Seconds, the same numbers as the browser SDK's glitchless_measure. */
		void Measure(double Seconds, std::function<void(const FValue&)> Done);
		/** Closes the frame window (unless told not to) and sends what is waiting. Runs by itself every
		 * FlushIntervalSeconds, and when the game goes to the background or closes. */
		void Flush(bool CloseWindow = true);

		// ───────────── what the Unreal side reports ─────────────

		/** A map finished loading: if it reads as a level, that level starts. */
		void OnMapLoaded(const std::string& MapName, int Handle);
		void OnMapUnloaded(int Handle);
		/** The frame that just ended took DtMs and cost what Cost says. */
		void Frame(double DtMs, const FFrameCost& Cost);
		/** The next frame's time is a gap (a pause, a breakpoint, focus coming back). */
		void SkipNextFrame() { SkipNextFrames(1); }
		/** The next Count frames are Glitchless's (a screenshot read back, the bug report box's first draw), not the game's. */
		void SkipNextFrames(int Count) { SkipFrames = std::max(SkipFrames, Count); }
		/** A key, button or touch went down. Code names it ("SpaceBar", "pointer", "Gamepad_FaceButton_Bottom"). */
		void OnInput(const std::string& Code);
		/** A phone app in the background is usually never seen again, so going there ends the session and sends at once. */
		void OnBackground();
		void OnForeground();
		void Shutdown(const std::string& Reason);
		/** Ends the session and sends what is waiting, without waiting on the network: a listen server that stopped hosting. */
		void EndSession(const std::string& Reason);
		/** A session again after EndSession, under a new ID. */
		void StartNewSession();
		/** Sends what is waiting before the game closes or goes to the background, blocking for at most BudgetMs. */
		void SendNow(int DeadlineMs);

		// ───────────── reading ─────────────

		bool HasFlag(const std::string& Flag) const;
		std::optional<std::string> FlagValue(const std::string& Flag) const;
		std::string LevelForMap(const std::string& MapName) const;
		bool IsInited() const { return Inited; }
		bool HasManualLevels() const { return ManualLevels; }
		bool IsEnded() const { return Ended; }
		bool IsEnabled() const { return Enabled; }
		bool IsSampled() const { return Sampled; }
		const std::string& GetSessionId() const { return SessionId; }
		const std::string& GetPlayerId() const { return PlayerId; }
		const std::optional<std::string>& GetLevel() const { return Level; }
		const std::optional<std::string>& GetZone() const { return Zone; }
		/** The ID sent for a match, party or run, or "". */
		std::string GetGroup(const std::string& Kind) const;
		ERole GetRole() const { return Role; }
		/** What the server says it takes (GET /v1/health features): counts, props, groups, net, server_mode. */
		bool HasFeature(const std::string& Name) const;
		bool FeaturesKnown() const { return FeaturesState == EFeatures::Known; }
		const std::string& GetService() const { return Service; }
		const std::string& GetEnv() const { return Env; }
		const std::string& GetVersion() const { return Version; }
		double GetBudgetMs() const { return BudgetMs; }
		int GetFrameCount() const { return FrameCount; }
		const FOptions& GetOptions() const { return Options; }
		const FStats& GetStats() const { return Stats; }
		/** Events waiting to be sent (for tests and the overlay). */
		const std::vector<FValue>& Queued() const { return Queue; }
		int OutboxEvents() const;
		/** The errors seen this session, grouped: message, kind, location, count. */
		std::vector<FValue> ErrorLog() const;
		/** What is going on right now, for agents: who and where it sends, the stats, the last frame windows
		 * and hitches, the gauges and this session's errors. */
		FValue Live();

	private:
		struct FBatch
		{
			int Id = 0;
			std::string Bid; // the batch's own random ID, sent as batch_id with every try of it (SPEC §2)
			std::string Service, Env, Version, Sid, Pid;
			int64_t Group = 0;
			std::vector<std::string> Events;
		};

		using FGauges = std::vector<std::pair<std::string, double>>;

		struct FWindow
		{
			int64_t StartedAt = 0;
			double StartedTicks = 0;
			int Frames = 0, Slow = 0, Jank = 0, Hitches = 0, Frozen = 0, Gc = 0;
			int GameFrames = 0, RenderFrames = 0, RhiFrames = 0, GpuFrames = 0, CallFrames = 0;
			FSketch Sketch;
			double Max = 0, Game = 0, Render = 0, Rhi = 0, Gpu = 0, GcMs = 0;
			int64_t Calls = 0, CallsMax = 0, Tris = 0, Pso = 0, Shaders = 0, Packages = 0;
			bool HasPso = false, HasShaders = false, HasPackages = false;
			FGauges Ctx;
			// The connection, while there is one (net on the window).
			bool NetSeen = false, Host = false;
			FSketch Rtt = FSketch(0.05);
			int NetSamples = 0, LossN = 0, JitterN = 0, InN = 0, OutN = 0;
			double RttMax = 0, LossSum = 0, JitterSum = 0, InSum = 0, OutSum = 0;
			// A server's ticks and state (server_window).
			int Ticks = 0, Late = 0, PlayersMax = -1, CpuN = 0;
			FSketch Tick;
			double TickMax = 0, CpuSum = 0;
			std::vector<double> PlayerRtt;
		};

		/** One count in this window: a name and the strings and booleans that say which (counts event). */
		struct FCountEntry
		{
			std::string Key, Name;
			FValue Attrs;
			int64_t N = 0;
			std::vector<std::pair<std::string, double>> Sums;
			int64_t FirstTs = 0;
		};

		enum class EFeatures : uint8_t
		{
			Unknown,
			Asking,
			Known,
		};

		struct FProbe
		{
			double EndAt = 0, Seconds = 0;
			std::function<void(const FValue&)> Done;
			FSketch Frames, Game, Render, Rhi, Gpu;
			int Count = 0, Gc = 0;
			double Max = 0;
			int64_t Calls = 0, CallsMax = 0, Tris = 0, CallFrames = 0;
			std::vector<FValue> Hitches;
			FGauges CtxMax;
			int64_t Errors = 0;
			std::map<std::string, int> Fingerprints;
			std::optional<std::string> Level;
			FValue Engine;
		};

		struct FErrorEntry
		{
			std::string Message, Kind;
			std::optional<std::string> Location;
			int Count = 0;
		};

		struct FUnfinishedHitch
		{
			double Dt = 0;
			FFrameCost Cost;
			int64_t Ts = 0;
			std::optional<std::string> Level;
			FValue Ctx;
			std::vector<std::string> Recent;
		};

		struct FRecent
		{
			std::string Name;
			double T = 0;
		};

		double Ticks() const { return Clock(); }
		void Begin();
		void StartLevel(const std::string& LevelId, bool FromMap, FValue Attrs = FValue());
		void LeaveLevel();
		void Abandon(const std::optional<std::string>& LevelId, const std::string& Reason);
		bool OutcomeSent(const std::optional<std::string>& LevelId) const;
		void EndLevel(const std::string& Reason);
		void Tick();
		void SetBudget(double TypicalDt);
		void OnFrame(double Dt, const FFrameCost& F);
		void FinishHitch(const FFrameCost* Next);
		static std::vector<std::string> Causes(double Dt, const FFrameCost& F);
		FWindow NewWindow() const;
		void CloseWindow(bool Fresh);
		void OnServerTick(double WorkMs);
		FValue ServerWindowEvent(const FWindow& W, double Secs) const;
		FValue NetJson(const FWindow& W) const;
		void QueueCounts(const FWindow& W, double Secs);
		void QueuePropChanges();
		/** The zone and the groups, on every event while they are set. */
		void Stamp(FValue& E) const;
		void AskFeatures();
		/** A server's batches wait until the Glitchless server says it takes them (server_mode). */
		bool MaySend() const;
		void OnHealth(int64_t Status, const std::string& Body);
		/** One warning a key, in a development build or with Debug on: for what the game sent that was dropped. */
		void WarnOnce(const std::string& Key, const std::string& Message);
		void PushGroupEvent(const std::string& Kind, const std::string& Id, FValue Attrs, bool Resumed);
		FValue Engine0(const char* Key) const;
		const FValue& SampleEngine();
		void CheckScreen();
		void Gauge(const std::string& Key, double V);
		std::vector<double> LastFrames(int Count) const;
		FValue ProbeResult(FProbe& P);
		void NewSession();
		FValue SessionEnd(const std::string& Reason);
		static FValue Ev(const char* Type);
		void Push(FValue E);
		void QueueEvent(FValue E);
		void Remember(const std::string& Name);
		void RememberEvent(const FValue& E);
		FValue RecentFrames();
		std::vector<std::string> RecentWithin(double Ms) const;
		std::vector<std::string> RecentNames(int Count) const;
		FValue SessionStartEvent();
		const FValue& ReadSteam();
		void Batch();
		void AddBatches(const std::vector<FValue>& Events);
		FBatch NewBatch(std::vector<std::string> Events);
		std::string Body(const FBatch& B) const;
		std::vector<uint8_t> Encode(const std::string& Json) const;
		std::string IntakeUrl() const;
		void SendNext();
		void OnSent(int Id, int64_t Status);
		void RetryLater(const std::string& Why);
		std::string OutboxPath() const;
		std::string PlayerPath() const;
		void SaveOutbox();
		void LoadOutbox();
		std::string LoadPlayerId();
		bool ReadFile(const std::string& Path, std::string& Out) const;
		bool WriteFile(const std::string& Path, const std::string& Contents) const;
		void RemoveFile(const std::string& Path) const;
		void Debug(const std::string& Msg) const;
		std::string NewId(const char* Prefix, int Length) const;
		double Random01() const;
		static double Median(std::vector<double> Values);
		static double Quantile(std::vector<double> Values, double Q);

		FOptions Options;
		bool Inited = false, Enabled = false, Sampled = true;
		std::string SessionId, PlayerId;
		std::optional<std::string> Level;
		bool LevelOpen = false; // a level started and not yet completed, failed or abandoned
		std::optional<std::string> LeftLevel; // the level abandoned for the game as the session ended
		int FrameCount = 0;
		double BudgetMs = 1000.0 / 60;
		FStats Stats;
		FGauges Ctx;

		std::string Service = "unknown-game", Version = "0.0.0", Env = "dev", Intake, SessionType = "user";
		bool Sandbox = false; // a TestFlight or development install on iOS: its purchases are Apple's free sandbox ones
		bool VersionGiven = false;
		bool Detailed = false, StoresId = false, PositionsOn = false, RageInputOn = false, DebugOn = false, ManualLevels = false, MapLevels = true;
		int64_t StartedAt = 0;
		double LevelStartedAt = 0;
		std::vector<FRecent> Recent;
		std::vector<FValue> History; // the last game events, slimmed, for bug reports
		std::vector<FValue> RecentHitches;
		std::vector<FValue> RecentWindows;
		std::vector<FValue> Queue;
		std::vector<FBatch> Outbox;
		int NextBatchId = 1, InFlight = -1;
		double RetryAt = 0, BackoffS = 0;
		bool Draining = false; // SendNow is sending what is left, so no new request starts behind it
		bool Begun = false, SessionStartSent = false, LoadSent = false, Ended = false, Shut = false, Crashed = false;
		double PausedAt = 0;
		std::map<std::string, int> ErrorCounts;
		std::vector<std::string> ErrorOrder;
		std::map<std::string, FErrorEntry> Errors;
		std::vector<std::unique_ptr<FProbe>> Probes;
		std::vector<FValue> PendingHitches;
		std::optional<FUnfinishedHitch> Unfinished;
		int FramesNearLoad = 0;
		int FramesAfterMapLoad = 0;
		FWindow Win;
		static constexpr int RingSize = 240;
		double Ring[RingSize] = {};
		int RingIdx = 0, RingCount = 0, Hz = 60;
		std::vector<double> Early;
		double RecentMedian = 0;
		std::optional<std::pair<double, FFrameCost>> PendingLong;
		bool Throttled = false;
		int SkipFrames = 0;
		double FirstFrameMs = 0, FirstInputAt = 0;
		int64_t FirstFrameAt = 0; // the wall clock at the first frame: the load event's ts
		std::optional<std::string> FirstFrameLevel;
		std::map<std::string, std::vector<double>> KeyHistory;
		std::optional<std::vector<double>> Position;
		std::vector<FValue> PosBuffer;
		double NextFlushAt = 0, NextPosAt = 0;
		FValue EngineCounts = FValue::Object();
		FValue DeviceInfo;
		FValue SteamInfo; // read once Steamworks answers
		int LevelMapHandle = 0;
		std::vector<int> Screen, Window;
		std::shared_ptr<bool> Alive; // the transport's callbacks check it, in case the core is gone

		// Counts, properties, groups and zones (docs/design/genre-coverage.md A5 to A7).
		std::vector<FCountEntry> Counts;
		int CountedNames = 0; // entries that count toward the 64 a window
		int64_t CountsDropped = 0;
		std::vector<FValue> HeldCounts; // counts events waiting for the server to say it takes them
		EFeatures FeaturesState = EFeatures::Unknown;
		std::vector<std::string> Features;
		std::vector<std::pair<std::string, FValue>> Props; // what holds for the session now
		std::vector<std::pair<std::string, FValue>> PropChanges; // since the last props event (null: removed)
		std::vector<std::string> PropKeys; // every key set this session: 12 at most
		std::vector<std::pair<std::string, std::string>> Groups; // kind, the ID sent
		std::optional<std::string> Zone;
		std::map<std::string, bool> Warned;
		std::map<std::string, std::vector<double>> TrackTimes; // a development build warns of a track() that wants to be a count()

		// The connection (A8).
		bool NetConnected = false, NetEverConnected = false, NetHost = false;
		std::string NetTransport, NetLink;
		double NetConnectedAt = 0, NetLostAt = 0, LastNetSampleAt = -1e18;
		int Disconnects = 0;
		FValue LastNet; // the last window's net, for a disconnect that comes before this window has numbers
		std::optional<std::string> DisconnectedLevel;

		// A server (A9).
		FServerSample LastServer;
		double TargetHz = 0;
		double SessionBeganAt = 0;
		bool ServerRefused = false;
	};
}

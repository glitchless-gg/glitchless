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
		/** "user" or "synthetic" (bots). Empty: synthetic with -autoplay, -glitchless-synthetic or -glitchless-measure. */
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
		static constexpr const char* SdkVersion = "0.1.0";
		static constexpr const char* Sdk = "glitchless-unreal/0.1.0";
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

		// ───────────── the game's calls ─────────────

		/** Says who the game is and where to send. Until this is called nothing is sent, but frame
		 * times, errors and events are kept, so a game may call it late. Only the first call counts. */
		void Init(const FOptions& InOptions);
		void LevelStart(const std::string& LevelId);
		void LevelComplete(const std::optional<std::string>& LevelId = std::nullopt, std::optional<double> Score = std::nullopt, std::optional<double> DurationS = std::nullopt);
		void LevelFail(const std::optional<std::string>& LevelId = std::nullopt, const std::string& Cause = "");
		/** A death. The place is sent only when positions are on; the death and cause always are. */
		void Death(std::optional<double> X, std::optional<double> Y, std::optional<double> Z, const std::string& Cause);
		void Track(const std::string& Name, FValue Attrs = FValue());
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
		/** Sends what is waiting before the game closes or goes to the background, blocking for at most BudgetMs. */
		void SendNow(int DeadlineMs);

		// ───────────── reading ─────────────

		bool HasFlag(const std::string& Flag) const;
		std::optional<std::string> FlagValue(const std::string& Flag) const;
		std::string LevelForMap(const std::string& MapName) const;
		bool IsInited() const { return Inited; }
		bool IsEnabled() const { return Enabled; }
		bool IsSampled() const { return Sampled; }
		const std::string& GetSessionId() const { return SessionId; }
		const std::string& GetPlayerId() const { return PlayerId; }
		const std::optional<std::string>& GetLevel() const { return Level; }
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
		void StartLevel(const std::string& LevelId, bool FromMap);
		void LeaveLevel();
		void Tick();
		void SetBudget(double MedianDt);
		void OnFrame(double Dt, const FFrameCost& F);
		void FinishHitch(const FFrameCost* Next);
		static std::vector<std::string> Causes(double Dt, const FFrameCost& F);
		FWindow NewWindow() const;
		void CloseWindow(bool Fresh);
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

		FOptions Options;
		bool Inited = false, Enabled = false, Sampled = true;
		std::string SessionId, PlayerId;
		std::optional<std::string> Level;
		int FrameCount = 0;
		double BudgetMs = 1000.0 / 60;
		FStats Stats;
		FGauges Ctx;

		std::string Service = "unknown-game", Version = "0.0.0", Env = "dev", Intake, SessionType = "user";
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
	};
}

// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessCore.h"
#include "GlitchlessSteam.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <limits>
#include <random>

namespace Glitchless
{
	namespace
	{
		constexpr double HitchMs = 50; // one frame over 50 ms is a stutter a player sees
		constexpr double JankMs = 33.4; // two missed 60 Hz frames
		constexpr double FrozenMs = 700; // Android vitals' "frozen frame"
		constexpr int MaxErrorsPerFingerprint = 25;
		constexpr size_t MaxQueue = 2000;
		constexpr size_t MaxHitchEventsPerWindow = 3; // frame_window.hitches still counts every one
		constexpr size_t RageInputCount = 4;
		constexpr double RageInputWindowMs = 1000;
		constexpr size_t BatchBytes = 60000;
		constexpr int MaxOutboxEvents = 4000;
		constexpr int64_t MaxOutboxAgeMs = 6LL * 86400 * 1000; // the server files anything over 7 days old under "now"
		constexpr const char* IdChars = "abcdefghijklmnopqrstuvwxyz0123456789";

		double Round(double V, int Digits) { return FSketch::Round(V, Digits); }
		FValue Round(const std::optional<double>& V, int Digits) { return V ? FValue(FSketch::Round(*V, Digits)) : FValue(); }

		FValue Ints(const std::vector<int>& V)
		{
			if (V.empty())
			{
				return FValue();
			}
			FValue A = FValue::Array();
			for (int I : V)
			{
				A.Push(I);
			}
			return A;
		}

		FValue GaugesJson(const std::vector<std::pair<std::string, double>>& Gauges)
		{
			FValue O = FValue::Object();
			for (const auto& G : Gauges)
			{
				O.Set(G.first, G.second);
			}
			return O;
		}

		void MaxGauge(std::vector<std::pair<std::string, double>>& Gauges, const std::string& Key, double V)
		{
			for (auto& G : Gauges)
			{
				if (G.first == Key)
				{
					G.second = std::max(G.second, V);
					return;
				}
			}
			Gauges.emplace_back(Key, V);
		}

		// Uri.EscapeDataString: everything but the unreserved characters is %XX.
		std::string Escape(const std::string& S)
		{
			static const char Hex[] = "0123456789ABCDEF";
			std::string Out;
			for (const char Ch : S)
			{
				const unsigned char C = static_cast<unsigned char>(Ch);
				if ((C >= 'A' && C <= 'Z') || (C >= 'a' && C <= 'z') || (C >= '0' && C <= '9') || C == '-' || C == '_' || C == '.' || C == '~')
				{
					Out += Ch;
				}
				else
				{
					Out += '%';
					Out += Hex[C >> 4];
					Out += Hex[C & 15];
				}
			}
			return Out;
		}

		std::string StripFlagDashes(const std::string& Arg)
		{
			size_t I = 0;
			while (I < Arg.size() && I < 2 && Arg[I] == '-')
			{
				I++;
			}
			return I == 0 ? std::string() : Arg.substr(I);
		}

		std::random_device& Entropy()
		{
			static std::random_device Device;
			return Device;
		}
	}

	const char* PrivacyName(EPrivacy Privacy)
	{
		switch (Privacy)
		{
		case EPrivacy::Full: return "full";
		case EPrivacy::Install: return "install";
		default: return "anonymous";
		}
	}

	FCore::FCore()
		: Alive(std::make_shared<bool>(true))
	{
		const auto Start = std::chrono::steady_clock::now();
		Clock = [Start]() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - Start).count(); };
		UnixNow = []() { return static_cast<int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count()); };
		Device = [](bool) { return FValue::Object(); };
		Log = [](const std::string& S) { std::fprintf(stderr, "%s\n", S.c_str()); };
		SessionId = NewId("s_", 16); // held in memory only; anonymous mode never writes it down
		NextFlushAt = std::numeric_limits<double>::max();
	}

	// The session and its first frame window start the first time anything happens, so they are
	// timed by the clocks the Unreal side (or a test) set after making the core.
	void FCore::Begin()
	{
		if (Begun)
		{
			return;
		}
		Begun = true;
		StartedAt = UnixNow();
		Win = NewWindow();
	}

	FCore::~FCore()
	{
		*Alive = false;
	}

	// ───────────────────────────── the game's calls ─────────────────────────────

	void FCore::Init(const FOptions& InOptions)
	{
		if (Inited)
		{
			return;
		}
		Begin();
		Inited = true;
		Options = InOptions;
		Service = Options.Service.empty() ? "unknown-game" : Text::Lower(Options.Service);
		VersionGiven = !Options.Version.empty();
		Version = VersionGiven ? Options.Version : !AppVersion.empty() ? AppVersion : "0.0.0";
		ReadSteam(); // Steamworks may be initialised only later: session_start asks again
		Env = !Options.Env.empty() ? Options.Env : IsDevelopmentBuild ? "dev" : "prod";
		const std::optional<std::string> FlagIntake = FlagValue("glitchless-intake");
		Intake = FlagIntake ? *FlagIntake : Options.Intake;
		while (!Intake.empty() && Intake.back() == '/')
		{
			Intake.pop_back();
		}
		Detailed = Options.Privacy == EPrivacy::Full;
		StoresId = Options.Privacy != EPrivacy::Anonymous;
		PositionsOn = Options.Positions.value_or(Detailed);
		RageInputOn = Options.RageInput.value_or(!IsMobile);
		MapLevels = Options.MapLevels;
		DebugOn = DebugOn || Options.Debug || HasFlag("glitchless-debug");
		if (!Options.SessionType.empty())
		{
			SessionType = Options.SessionType;
		}
		else if (IsHeadless || HasFlag("autoplay") || HasFlag("glitchless-synthetic") || HasFlag("glitchless-measure"))
		{
			SessionType = "synthetic";
		}
		// A development build sends only when told to, so the developer's own play can be kept out.
		const bool On = Options.Enabled.value_or(!IsDevelopmentBuild || Options.SendInDevelopmentBuilds || HasFlag("glitchless") || FlagIntake.has_value());
		Enabled = On && !HasFlag("glitchless-off") && !Intake.empty();
		Sampled = Random01() < Options.SampleRate;
		// The first batch goes soon, so a session that crashes early is still seen.
		NextFlushAt = Ticks() + std::min(2000.0, Options.FlushIntervalSeconds * 1000);
		if (!Enabled)
		{
			Queue.clear();
			Debug("off (no intake, turned off, or a development build without -glitchless)");
			return;
		}
		DeviceInfo = Device ? Device(Detailed) : FValue::Object();
		if (!SaveDir.empty())
		{
			if (Files.MakeDir)
			{
				Files.MakeDir(SaveDir);
			}
			if (StoresId)
			{
				PlayerId = LoadPlayerId();
			}
			else
			{
				RemoveFile(PlayerPath()); // left by an install- or full-mode build: anonymous mode keeps no ID
			}
			LoadOutbox();
		}
		Debug("on: " + Service + " " + Version + " " + Env + " -> " + Intake + " (" + PrivacyName(Options.Privacy) + ", " + SessionType + ")");
	}

	void FCore::LevelStart(const std::string& LevelId)
	{
		StartLevel(LevelId, false);
	}

	void FCore::StartLevel(const std::string& LevelId, bool FromMap)
	{
		if (!FromMap)
		{
			ManualLevels = true; // the game knows its levels better than the map names do
		}
		CloseWindow(false); // so a frame window never spans two levels
		Level = LevelId;
		LevelStartedAt = Ticks();
		LevelOpen = true;
		LeftLevel.reset();
		Push(Ev("level_start"));
		Remember("level_start");
	}

	void FCore::LevelComplete(const std::optional<std::string>& LevelId, std::optional<double> Score, std::optional<double> DurationS)
	{
		LevelOpen = false;
		LeftLevel.reset(); // completed: nothing to open again when the game comes back
		FValue E = Ev("level_complete");
		E.Set("level", LevelId ? FValue(*LevelId) : Level ? FValue(*Level) : FValue());
		E.Set("duration_s", Round(DurationS ? *DurationS : (Ticks() - LevelStartedAt) / 1000, 2));
		E.Set("score", Score ? FValue(*Score) : FValue());
		Push(std::move(E));
		Remember("level_complete");
	}

	void FCore::LevelFail(const std::optional<std::string>& LevelId, const std::string& Cause)
	{
		const std::optional<std::string> L = LevelId ? LevelId : Level;
		if (OutcomeSent(L))
		{
			return;
		}
		LevelOpen = false;
		FValue E = Ev("level_fail");
		E.Set("level", L ? FValue(*L) : FValue());
		E.Set("cause", Cause.empty() ? FValue() : FValue(Cause));
		Push(std::move(E));
		Remember("level_fail");
	}

	void FCore::LevelAbandon(const std::optional<std::string>& LevelId)
	{
		const std::optional<std::string> L = LevelId ? LevelId : Level;
		if (OutcomeSent(L))
		{
			return;
		}
		Abandon(L, "");
	}

	// Reason is the session_end's when Glitchless sends the abandon itself, and empty when the game calls it.
	void FCore::Abandon(const std::optional<std::string>& LevelId, const std::string& Reason)
	{
		LevelOpen = false;
		FValue E = Ev("level_abandon");
		E.Set("level", LevelId ? FValue(*LevelId) : FValue());
		E.Set("duration_s", Round((Ticks() - LevelStartedAt) / 1000, 2));
		if (!Reason.empty())
		{
			E.Set("reason", Reason);
		}
		Push(std::move(E));
		Remember("level_abandon");
	}

	// A game often ends its level as it closes or goes to the background (in EndPlay, say), after the session
	// ended and Glitchless already sent the abandon: that attempt has its outcome.
	bool FCore::OutcomeSent(const std::optional<std::string>& LevelId) const
	{
		return Ended && LeftLevel && LevelId && *LevelId == *LeftLevel;
	}

	// The session ends with a level still going: the player left it (SPEC §2 level_abandon).
	void FCore::EndLevel(const std::string& Reason)
	{
		if (LevelOpen)
		{
			LeftLevel = Level;
			Abandon(Level, Reason);
		}
	}

	void FCore::Death(std::optional<double> X, std::optional<double> Y, std::optional<double> Z, const std::string& InCause)
	{
		Stats.Deaths++;
		const std::string Cause = InCause.empty() ? "unknown" : InCause;
		FValue E = Ev("death");
		E.Set("cause", Cause);
		if (PositionsOn && X)
		{
			E.Set("x", Round(*X, 2));
			E.Set("y", Round(Y.value_or(0), 2));
			E.Set("z", Round(Z.value_or(0), 2));
		}
		Push(std::move(E));
		Remember("death:" + Cause);
	}

	void FCore::Track(const std::string& Name, FValue Attrs)
	{
		FValue E = Ev("custom");
		E.Set("name", Name);
		E.Set("attrs", Attrs.IsObject() ? std::move(Attrs) : FValue::Object());
		Push(std::move(E));
		Remember(Name);
	}

	void FCore::SetContext(const std::string& Key, double Value)
	{
		Gauge(Key, Value);
	}

	void FCore::SetPosition(double X, double Y, double Z)
	{
		if (PositionsOn)
		{
			Position = std::vector<double>{X, Y, Z};
		}
	}

	// ───────────────────────────── maps as levels ─────────────────────────────

	void FCore::OnMapLoaded(const std::string& MapName, int Handle)
	{
		if (ManualLevels || !MapLevels)
		{
			return;
		}
		const std::string LevelName = LevelForMap(MapName);
		if (LevelName.empty() || Handle == LevelMapHandle)
		{
			return; // a menu or lobby map: frames there have no level
		}
		LevelMapHandle = Handle;
		StartLevel(LevelName, true);
	}

	void FCore::OnMapUnloaded(int Handle)
	{
		if (!ManualLevels && Handle == LevelMapHandle && Handle != 0)
		{
			LeaveLevel();
		}
	}

	void FCore::LeaveLevel()
	{
		LevelMapHandle = 0;
		CloseWindow(false);
		Level.reset(); // back in a menu: frames there have no level
		LevelOpen = false; // a map level ends with its map, and nothing says whether it was beaten or left
	}

	std::string FCore::LevelForMap(const std::string& MapName) const
	{
		if (MapName.empty())
		{
			return "";
		}
		return Options.LevelForMap ? Options.LevelForMap(MapName) : Levels::LevelForMap(MapName);
	}

	// ───────────────────────────── frame timing ─────────────────────────────

	void FCore::Frame(double DtMs, const FFrameCost& Measured)
	{
		Begin();
		FrameCount++;
		// The new map's first draws (pipeline states compiled, textures streamed in) are its load as much as the
		// frame that loaded it: their hitches say map_load, so they stay out of play's.
		FFrameCost Cost = Measured;
		if (Cost.MapLoaded)
		{
			FramesAfterMapLoad = 3;
		}
		else if (FramesAfterMapLoad > 0)
		{
			Cost.MapLoaded = true;
		}
		if (FramesAfterMapLoad > 0)
		{
			FramesAfterMapLoad--;
		}
		// A map load or a blocking load is a freeze the player sees, and so are the frames right after it
		// (the new map's first draws): never the OS throttling a hidden window.
		if (Measured.MapLoaded || Measured.AssetFlush || Measured.LevelStreamed)
		{
			FramesNearLoad = 3;
		}
		const bool NearLoad = FramesNearLoad > 0;
		if (FramesNearLoad > 0)
		{
			FramesNearLoad--;
		}
		if (SkipFrames > 0)
		{
			SkipFrames--; // the gap was a pause or a trip to the background, not a frame
			PendingLong.reset();
		}
		else if (NearLoad && DtMs < 60000)
		{
			if (PendingLong)
			{
				const auto Long = *PendingLong;
				OnFrame(Long.first, Long.second);
			}
			PendingLong.reset();
			Throttled = false;
			OnFrame(DtMs, Cost);
		}
		else if (DtMs >= 5000)
		{
			PendingLong.reset();
		}
		else if (DtMs > FrozenMs)
		{
			// A run of long frames is the OS throttling a hidden window, not the game: a single long
			// frame between normal ones is a real freeze; a run is dropped.
			if (PendingLong || Throttled)
			{
				PendingLong.reset();
				Throttled = true;
			}
			else
			{
				PendingLong = std::make_pair(DtMs, Cost);
			}
		}
		else
		{
			if (PendingLong)
			{
				const auto Long = *PendingLong;
				OnFrame(Long.first, Long.second);
			}
			PendingLong.reset();
			Throttled = false;
			OnFrame(DtMs, Cost);
		}
		// The refresh rate (60 / 90 / 120 Hz, or a cap the game set) from the median early frame. Until then,
		// from the fastest of the first 30 (a frame can take longer than the screen's interval, never less), so
		// a session's first windows don't go out judged against 60 Hz while the median is still being counted.
		if (Early.size() < 120 && DtMs > 0 && DtMs < 100)
		{
			Early.push_back(DtMs);
			if (Early.size() == 30)
			{
				SetBudget(Quantile(Early, 0.2));
			}
			else if (Early.size() == 120)
			{
				SetBudget(Median(Early));
			}
		}
		Tick();
	}

	// Timers that run every frame: positions, windows, sends, Measure().
	void FCore::Tick()
	{
		const double Now = Ticks();
		if (PositionsOn && Position && Now >= NextPosAt)
		{
			NextPosAt = Now + 1000 / std::max(Options.PositionHz, 0.1);
			PosBuffer.push_back(FValue::List({UnixNow(), Round((*Position)[0], 2), Round((*Position)[1], 2), Round((*Position)[2], 2)}));
		}
		if (FrameCount % 30 == 0)
		{
			SampleEngine();
		}
		if (Now - Win.StartedTicks >= Options.WindowSeconds * 1000)
		{
			CloseWindow(true);
		}
		if (Now >= NextFlushAt)
		{
			Flush(false);
		}
		if (Inited && Enabled && InFlight < 0 && !Outbox.empty() && Now >= RetryAt)
		{
			SendNext();
		}
		// A hitch on a measure's last frame belongs in it.
		if (Unfinished && std::any_of(Probes.begin(), Probes.end(), [Now](const std::unique_ptr<FProbe>& P) { return Now >= P->EndAt; }))
		{
			FinishHitch(nullptr);
		}
		// Finished measures are taken out first: a callback may end the session (-glitchless-measure quits).
		std::vector<std::unique_ptr<FProbe>> Finished;
		for (size_t I = Probes.size(); I-- > 0;)
		{
			if (Now >= Probes[I]->EndAt)
			{
				Finished.push_back(std::move(Probes[I]));
				Probes.erase(Probes.begin() + static_cast<std::ptrdiff_t>(I));
			}
		}
		for (const std::unique_ptr<FProbe>& P : Finished)
		{
			const FValue Result = ProbeResult(*P);
			if (P->Done)
			{
				P->Done(Result);
			}
		}
	}

	void FCore::SetBudget(double TypicalDt)
	{
		const double Rate = 1000 / TypicalDt;
		int Best = 60;
		for (int R : {30, 60, 75, 90, 100, 120, 144, 165, 240})
		{
			if (std::abs(R - Rate) < std::abs(Best - Rate))
			{
				Best = R;
			}
		}
		Hz = Best;
		BudgetMs = 1000.0 / Hz;
	}

	namespace
	{
		// The thread that took longest: the one that held the frame up.
		const char* Bound(const FFrameCost& F, double& Ms)
		{
			const char* Name = nullptr;
			Ms = -1;
			const std::pair<const char*, double> Threads[] = {{"game", F.Game}, {"render", F.Render}, {"rhi", F.Rhi}, {"gpu", F.Gpu}};
			for (const auto& T : Threads)
			{
				if (T.second > Ms && T.second > 0)
				{
					Ms = T.second;
					Name = T.first;
				}
			}
			return Name;
		}

	}

	void FCore::OnFrame(double Dt, const FFrameCost& F)
	{
		FWindow& W = Win;
		W.Frames++;
		W.Sketch.Add(Dt);
		W.Max = std::max(W.Max, Dt);
		if (Dt > BudgetMs * 1.5) W.Slow++;
		if (Dt > JankMs) W.Jank++;
		if (Dt > FrozenMs) W.Frozen++;
		if (F.Game >= 0)
		{
			W.GameFrames++;
			W.Game += F.Game;
		}
		if (F.Render >= 0)
		{
			W.RenderFrames++;
			W.Render += F.Render;
		}
		if (F.Rhi >= 0)
		{
			W.RhiFrames++;
			W.Rhi += F.Rhi;
		}
		if (F.Gpu > 0)
		{
			W.GpuFrames++;
			W.Gpu += F.Gpu;
		}
		if (F.Calls >= 0)
		{
			W.CallFrames++;
			W.Calls += F.Calls;
			W.CallsMax = std::max(W.CallsMax, F.Calls);
			W.Tris += std::max<int64_t>(0, F.Triangles);
		}
		if (F.PsoCompiles >= 0)
		{
			W.HasPso = true;
			W.Pso += F.PsoCompiles;
		}
		if (F.ShaderCompiles >= 0)
		{
			W.HasShaders = true;
			W.Shaders += F.ShaderCompiles;
		}
		if (F.PackagesLoaded >= 0)
		{
			W.HasPackages = true;
			W.Packages += F.PackagesLoaded;
		}
		W.Gc += F.GcCollections;
		if (F.GcMs > 0)
		{
			W.GcMs += F.GcMs;
		}
		Ring[RingIdx] = Dt;
		RingIdx = (RingIdx + 1) % RingSize;
		RingCount = std::min(RingCount + 1, RingSize);
		if (FirstFrameMs <= 0)
		{
			// The load event is sent with the first batch, but it happened here.
			FirstFrameMs = StartupMs ? StartupMs() : Ticks();
			FirstFrameAt = UnixNow();
			FirstFrameLevel = Level;
		}
		if (FrameCount % 16 == 0 && RingCount >= 30)
		{
			RecentMedian = Median(LastFrames(60));
		}

		// A hitch is a stutter: over 50 ms and well above what this device usually does. A device that
		// is slow all the time shows in the percentiles instead. It is timed by the clock, as Unreal's own
		// hitch tracking does: Unreal leaves a thread's waits out of its time, so a frame spent waiting on
		// a pipeline state, the GPU or the disk would look short. The slowest thread says who held it up.
		const bool Hitch = Dt > HitchMs && Dt > 2 * RecentMedian;
		for (const std::unique_ptr<FProbe>& P : Probes)
		{
			P->Count++;
			P->Frames.Add(Dt);
			P->Max = std::max(P->Max, Dt);
			if (F.Game >= 0) P->Game.Add(F.Game);
			if (F.Render >= 0) P->Render.Add(F.Render);
			if (F.Rhi >= 0) P->Rhi.Add(F.Rhi);
			if (F.Gpu > 0) P->Gpu.Add(F.Gpu);
			if (F.Calls >= 0)
			{
				P->CallFrames++;
				P->Calls += F.Calls;
				P->CallsMax = std::max(P->CallsMax, F.Calls);
				P->Tris += std::max<int64_t>(0, F.Triangles);
			}
			P->Gc += F.GcCollections;
		}
		// The frame after a hitch says the rest about it (FinishHitch), so the last one is finished now.
		if (Unfinished)
		{
			FinishHitch(&F);
		}
		if (!Hitch)
		{
			return;
		}
		W.Hitches++;
		Stats.Hitches++;
		SampleEngine(); // the counts this frame ended with go in the hitch's ctx
		FUnfinishedHitch U;
		U.Dt = Dt;
		U.Cost = F;
		U.Ts = UnixNow();
		U.Level = Level;
		U.Ctx = GaugesJson(Ctx);
		U.Recent = RecentWithin(1500);
		Unfinished = std::move(U);
	}

	// Unreal sets the threads' times as the frame is drawn, so work done after the draw (the core
	// ticker, end-of-frame tasks) and the render thread a frame behind land in the next frame's times.
	// A hitch's causes and threads are the larger of its own frame's and the next one's.
	void FCore::FinishHitch(const FFrameCost* Next)
	{
		if (!Unfinished)
		{
			return;
		}
		FUnfinishedHitch U = std::move(*Unfinished);
		Unfinished.reset();
		FFrameCost F = U.Cost;
		if (Next)
		{
			F.Game = std::max(F.Game, Next->Game);
			F.Render = std::max(F.Render, Next->Render);
			F.Rhi = std::max(F.Rhi, Next->Rhi);
			F.Gpu = std::max(F.Gpu, Next->Gpu);
			if (F.PsoCompiles >= 0 || Next->PsoCompiles >= 0)
			{
				F.PsoCompiles = std::max<int64_t>(0, F.PsoCompiles) + std::max<int64_t>(0, Next->PsoCompiles);
			}
			if (F.ShaderCompiles >= 0 || Next->ShaderCompiles >= 0)
			{
				F.ShaderCompiles = std::max<int64_t>(0, F.ShaderCompiles) + std::max<int64_t>(0, Next->ShaderCompiles);
			}
		}
		const double T = U.Dt;
		const std::vector<std::string> HitchCauses = Causes(T, F);
		const FValue LevelValue = U.Level ? FValue(*U.Level) : FValue();
		for (const std::unique_ptr<FProbe>& P : Probes)
		{
			FValue H = FValue::Object();
			H.Set("ms", Round(T, 1));
			H.Set("level", LevelValue);
			H.Set("draw_calls", FValue::OrNull(F.Calls));
			H.Set("causes", FValue::Strings(HitchCauses));
			H.Set("ctx", U.Ctx);
			H.Set("recent", FValue::Strings(U.Recent));
			P->Hitches.push_back(std::move(H));
		}
		double BoundMs;
		const char* BoundName = Bound(F, BoundMs);
		FValue E = FValue::Object();
		E.Set("type", "hitch");
		E.Set("ts", U.Ts);
		E.Set("level", LevelValue);
		E.Set("duration_ms", Round(T, 1));
		E.Set("frozen", T > FrozenMs);
		E.Set("draw_calls", FValue::OrNull(F.Calls));
		E.Set("triangles", FValue::OrNull(F.Triangles));
		E.Set("programs", FValue());
		E.Set("ctx", U.Ctx);
		E.Set("recent", FValue::Strings(U.Recent));
		E.Set("causes", FValue::Strings(HitchCauses));
		E.Set("loaf", FValue::Array());
		E.Set("bound", BoundName ? FValue(BoundName) : FValue());
		E.Set("game_ms", F.Game >= 0 ? FValue(Round(F.Game, 1)) : FValue());
		E.Set("process_ms", F.Game >= 0 ? FValue(Round(F.Game, 1)) : FValue());
		E.Set("render_ms", F.Render >= 0 ? FValue(Round(F.Render, 1)) : FValue());
		E.Set("rhi_ms", F.Rhi >= 0 ? FValue(Round(F.Rhi, 1)) : FValue());
		E.Set("gpu_ms", F.Gpu > 0 ? FValue(Round(F.Gpu, 1)) : FValue());
		E.Set("gc_collections", F.GcCollections);
		E.Set("gc_ms", F.GcMs >= 0 ? FValue(Round(F.GcMs, 1)) : FValue());
		E.Set("pso_compiles", FValue::OrNull(F.PsoCompiles));
		E.Set("shader_compiles", FValue::OrNull(F.ShaderCompiles));
		E.Set("packages_loaded", FValue::OrNull(F.PackagesLoaded));
		FValue Slim = FValue::Object();
		Slim.Set("ts", U.Ts);
		Slim.Set("type", "hitch");
		Slim.Set("level", LevelValue);
		Slim.Set("duration_ms", *E.Find("duration_ms"));
		Slim.Set("causes", *E.Find("causes"));
		RecentHitches.push_back(std::move(Slim));
		if (RecentHitches.size() > 20)
		{
			RecentHitches.erase(RecentHitches.begin());
		}
		PendingHitches.push_back(std::move(E));
	}

	// Likely causes of one long frame, from what that frame measured.
	std::vector<std::string> FCore::Causes(double Dt, const FFrameCost& F)
	{
		const double Share = std::max(16.0, Dt * 0.4);
		std::vector<std::string> C;
		if (F.PsoCompiles > 0) C.push_back("pso_compile");
		if (F.ShaderCompiles > 0) C.push_back("shader_compile");
		if (F.GcCollections > 0) C.push_back("gc");
		if (F.MapLoaded) C.push_back("map_load");
		if (F.LevelStreamed) C.push_back("level_stream");
		if (F.AssetFlush || F.PackagesLoaded > 0) C.push_back("asset_load");
		if (F.Game >= Share) C.push_back("script");
		if (std::max({F.Render, F.Rhi, F.Gpu}) >= Share) C.push_back("render");
		if (Dt > FrozenMs) C.push_back("frozen");
		// None of those, and the parts of the frame that were measured (the game, render and RHI threads, and
		// the GPU where the RHI times it) add up to under that share: the time went where nothing here measures
		// it, such as waiting to present the frame, GPU work Unreal didn't time, or the OS.
		if (C.empty())
		{
			double Measured = 0;
			bool Any = false;
			for (const double Ms : {F.Game, F.Render, F.Rhi, F.Gpu})
			{
				if (Ms >= 0)
				{
					Measured += Ms;
					Any = true;
				}
			}
			if (Any && Measured < Share)
			{
				C.push_back("gpu_or_os");
			}
		}
		return C;
	}

	FCore::FWindow FCore::NewWindow() const
	{
		FWindow W;
		W.StartedAt = UnixNow();
		W.StartedTicks = Ticks();
		return W;
	}

	// Fresh: sample the engine counts now. Not when a level starts: whatever the game just did to
	// load the new level belongs to the new level.
	void FCore::CloseWindow(bool Fresh)
	{
		Begin();
		if (Fresh && Win.Frames > 0)
		{
			SampleEngine();
		}
		FWindow W = std::move(Win);
		Win = NewWindow();
		if (W.Frames > 0)
		{
			const double Secs = std::max((Ticks() - W.StartedTicks) / 1000, 0.001);
			const int N = W.Frames;
			const FSketch& S = W.Sketch;
			auto Avg = [](double Sum, int Frames) { return Frames > 0 ? FValue(Round(Sum / Frames, 2)) : FValue(); };
			auto AvgInt = [](int64_t Sum, int Frames) { return Frames > 0 ? FValue(static_cast<int64_t>(std::llround(static_cast<double>(Sum) / Frames))) : FValue(); };
			FValue E = FValue::Object();
			E.Set("type", "frame_window");
			E.Set("ts", W.StartedAt);
			E.Set("level", Level ? FValue(*Level) : FValue());
			E.Set("duration_s", Round(Secs, 2));
			E.Set("frames", N);
			E.Set("fps", Round(N / Secs, 1));
			E.Set("hz", Hz);
			E.Set("budget_ms", Round(BudgetMs, 2));
			E.Set("ft", S.ToJson());
			E.Set("ft_p50", Round(S.Quantile(0.5), 2));
			E.Set("ft_p95", Round(S.Quantile(0.95), 2));
			E.Set("ft_p99", Round(S.Quantile(0.99), 2));
			E.Set("ft_max", Round(W.Max, 1));
			E.Set("slow", W.Slow);
			E.Set("jank", W.Jank);
			E.Set("hitches", W.Hitches);
			E.Set("frozen", W.Frozen);
			E.Set("game_ms", Avg(W.Game, W.GameFrames));
			// process_ms is what the other SDKs call the game's own code: the playtest gate reads it.
			E.Set("process_ms", Avg(W.Game, W.GameFrames));
			E.Set("render_ms", Avg(W.Render, W.RenderFrames));
			E.Set("rhi_ms", Avg(W.Rhi, W.RhiFrames));
			E.Set("gpu_ms", Avg(W.Gpu, W.GpuFrames));
			E.Set("draw_calls", AvgInt(W.Calls, W.CallFrames));
			E.Set("draw_calls_max", W.CallFrames > 0 ? FValue(W.CallsMax) : FValue());
			E.Set("triangles", AvgInt(W.Tris, W.CallFrames));
			E.Set("geometries", FValue());
			E.Set("textures", FValue());
			E.Set("programs", FValue());
			// The UObject count climbs level after level when something leaks.
			E.Set("objects", Engine0("objects"));
			E.Set("actors", Engine0("actors"));
			E.Set("heap_mb", Engine0("heap_mb"));
			E.Set("texture_mb", Engine0("texture_mb"));
			E.Set("gc_collections", W.Gc);
			E.Set("gc_ms", W.Gc > 0 ? FValue(Round(W.GcMs, 1)) : FValue());
			E.Set("pso_compiles", W.HasPso ? FValue(W.Pso) : FValue());
			E.Set("shader_compiles", W.HasShaders ? FValue(W.Shaders) : FValue());
			E.Set("packages_loaded", W.HasPackages ? FValue(W.Packages) : FValue());
			E.Set("screen", Ints(Screen));
			E.Set("window", Ints(Window));
			E.Set("ctx", GaugesJson(W.Ctx));
			FValue Summary = FValue::Object();
			Summary.Set("ts", W.StartedAt);
			Summary.Set("level", Level ? FValue(*Level) : FValue());
			Summary.Set("fps", *E.Find("fps"));
			Summary.Set("p95", *E.Find("ft_p95"));
			RecentWindows.push_back(std::move(Summary));
			if (RecentWindows.size() > 6)
			{
				RecentWindows.erase(RecentWindows.begin());
			}
			QueueEvent(std::move(E));
		}
		if (!PosBuffer.empty())
		{
			FValue E = FValue::Object();
			E.Set("type", "pos");
			E.Set("ts", PosBuffer[0][0]);
			E.Set("level", Level ? FValue(*Level) : FValue());
			FValue Pts = FValue::Array();
			for (FValue& P : PosBuffer)
			{
				Pts.Push(std::move(P));
			}
			E.Set("pts", std::move(Pts));
			PosBuffer.clear();
			QueueEvent(std::move(E));
		}
		std::stable_sort(PendingHitches.begin(), PendingHitches.end(), [](const FValue& A, const FValue& B) {
			return A.Find("duration_ms")->AsNumber() > B.Find("duration_ms")->AsNumber();
		});
		for (size_t I = 0; I < std::min(MaxHitchEventsPerWindow, PendingHitches.size()); I++)
		{
			QueueEvent(std::move(PendingHitches[I]));
		}
		PendingHitches.clear();
	}

	FValue FCore::Engine0(const char* Key) const
	{
		const FValue* V = EngineCounts.Find(Key);
		return V ? *V : FValue();
	}

	// Engine counts: UObjects and actors climb level after level when something leaks. With
	// EngineGauges on they go in ctx too, where the findings compare a slow level's gauges with the
	// smoothest level's.
	const FValue& FCore::SampleEngine()
	{
		if (Engine)
		{
			FValue E = Engine();
			if (E.IsObject())
			{
				EngineCounts = std::move(E);
			}
		}
		if (Options.EngineGauges)
		{
			for (const char* K : {"objects", "actors"})
			{
				const FValue* V = EngineCounts.Find(K);
				if (V && V->IsNumber())
				{
					Gauge(K, V->AsNumber());
				}
			}
		}
		CheckScreen();
		return EngineCounts;
	}

	// The screen size changes when a window moves to another screen or a folding phone opens: a
	// breadcrumb for any stutter that follows.
	void FCore::CheckScreen()
	{
		if (!ScreenSize)
		{
			return;
		}
		const std::vector<int> S = ScreenSize();
		const std::vector<int> Wsz = WindowSize ? WindowSize() : std::vector<int>();
		if (S.size() < 2)
		{
			return;
		}
		if (Screen.empty())
		{
			Screen = S;
			Window = Wsz;
		}
		else if (S != Screen || Wsz != Window)
		{
			Screen = S;
			Window = Wsz;
			FValue Attrs = FValue::Object();
			Attrs.Set("screen", Ints(S));
			Attrs.Set("window", Ints(Wsz));
			Track("screen_change", std::move(Attrs));
		}
	}

	void FCore::Gauge(const std::string& Key, double V)
	{
		Begin();
		bool Found = false;
		for (auto& G : Ctx)
		{
			if (G.first == Key)
			{
				G.second = V;
				Found = true;
				break;
			}
		}
		if (!Found)
		{
			Ctx.emplace_back(Key, V);
		}
		MaxGauge(Win.Ctx, Key, V);
		for (const std::unique_ptr<FProbe>& P : Probes)
		{
			MaxGauge(P->CtxMax, Key, V);
		}
	}

	std::vector<double> FCore::LastFrames(int Count) const
	{
		const int N = std::min(Count, RingCount);
		std::vector<double> Out;
		Out.reserve(N);
		for (int I = N; I > 0; I--)
		{
			Out.push_back(Ring[(RingIdx - I + RingSize) % RingSize]);
		}
		return Out;
	}

	// ───────────────────────────── measure ─────────────────────────────

	void FCore::Measure(double Seconds, std::function<void(const FValue&)> Done)
	{
		std::unique_ptr<FProbe> P(new FProbe());
		P->EndAt = Ticks() + Seconds * 1000;
		P->Seconds = Seconds;
		P->Done = std::move(Done);
		P->Errors = Stats.Errors;
		for (const auto& E : Errors)
		{
			P->Fingerprints[E.first] = E.second.Count;
		}
		P->Level = Level;
		P->Engine = SampleEngine();
		Probes.push_back(std::move(P));
	}

	FValue FCore::ProbeResult(FProbe& P)
	{
		if (P.Count == 0)
		{
			FValue Err = FValue::Object();
			Err.Set("error", "No frames were drawn: the game was paused or in the background.");
			return Err;
		}
		const FValue Now = SampleEngine();
		FValue Delta = FValue::Object();
		for (size_t I = 0; I < Now.GetKeys().size(); I++)
		{
			const FValue& A = Now.ValueAt(I);
			const FValue* B = P.Engine.Find(Now.GetKeys()[I]);
			Delta.Set(Now.GetKeys()[I], A.IsNumber() && B && B->IsNumber() ? FValue(Round(A.AsNumber() - B->AsNumber(), 1)) : FValue());
		}
		FValue NewErrors = FValue::Array();
		for (const std::string& Fp : ErrorOrder)
		{
			const FErrorEntry& E = Errors.at(Fp);
			const auto Was = P.Fingerprints.find(Fp);
			const int Before = Was == P.Fingerprints.end() ? 0 : Was->second;
			if (E.Count > Before && NewErrors.Size() < 5)
			{
				FValue Item = FValue::Object();
				Item.Set("message", E.Message);
				Item.Set("kind", E.Kind);
				Item.Set("location", E.Location ? FValue(*E.Location) : FValue());
				Item.Set("count", E.Count - Before);
				NewErrors.Push(std::move(Item));
			}
		}
		auto Percentiles = [](const FSketch& S) {
			FValue O = FValue::Object();
			O.Set("p50", Round(S.Quantile(0.5), 2));
			O.Set("p95", Round(S.Quantile(0.95), 2));
			return O;
		};
		const double RenderP50 = P.Render.Quantile(0.5).value_or(0);
		FValue FrameMs = FValue::Object();
		FrameMs.Set("p50", Round(P.Frames.Quantile(0.5), 2));
		FrameMs.Set("p95", Round(P.Frames.Quantile(0.95), 2));
		FrameMs.Set("p99", Round(P.Frames.Quantile(0.99), 2));
		FrameMs.Set("worst", Round(P.Max, 1));
		FValue Render = FValue();
		if (P.Render.N > 0)
		{
			Render = Percentiles(P.Render);
			Render.Set("share_of_budget_pct", static_cast<int64_t>(std::llround(RenderP50 / BudgetMs * 100)));
		}
		FValue Hitches = FValue::Array();
		for (size_t I = 0; I < std::min<size_t>(10, P.Hitches.size()); I++)
		{
			Hitches.Push(P.Hitches[I]);
		}
		FValue DrawCalls;
		if (P.CallFrames > 0)
		{
			DrawCalls = FValue::Object();
			DrawCalls.Set("avg", static_cast<int64_t>(std::llround(static_cast<double>(P.Calls) / P.CallFrames)));
			DrawCalls.Set("max", P.CallsMax);
		}
		FValue R = FValue::Object();
		R.Set("seconds", P.Seconds);
		R.Set("level_start", P.Level ? FValue(*P.Level) : FValue());
		R.Set("level_end", Level ? FValue(*Level) : FValue());
		R.Set("frames", P.Count);
		R.Set("fps", Round(P.Count / P.Seconds, 1));
		R.Set("frame_budget_ms", Round(BudgetMs, 2));
		R.Set("frame_ms", std::move(FrameMs));
		R.Set("pct_frames_over_budget", Round(P.Frames.FractionAbove(BudgetMs * 1.15) * 100, 1));
		// The render thread's time: it rises with scene cost even while vsync hides it in frame time.
		R.Set("render_cpu_ms", std::move(Render));
		// The game thread: ticking, Blueprints, physics, animation.
		R.Set("update_cpu_ms", P.Game.N > 0 ? Percentiles(P.Game) : FValue());
		R.Set("rhi_cpu_ms", P.Rhi.N > 0 ? Percentiles(P.Rhi) : FValue());
		R.Set("physics_ms", FValue());
		R.Set("gpu_ms", P.Gpu.N > 0 ? Percentiles(P.Gpu) : FValue());
		R.Set("gc_collections", P.Gc);
		R.Set("hitches", std::move(Hitches));
		R.Set("hitch_count", static_cast<int64_t>(P.Hitches.size()));
		R.Set("draw_calls", std::move(DrawCalls));
		R.Set("triangles_avg", P.CallFrames > 0 ? FValue(static_cast<int64_t>(std::llround(static_cast<double>(P.Tris) / P.CallFrames))) : FValue());
		R.Set("peak_context", GaugesJson(P.CtxMax));
		R.Set("memory", Now);
		R.Set("memory_delta", std::move(Delta));
		R.Set("new_errors", Stats.Errors - P.Errors);
		R.Set("errors", std::move(NewErrors));
		R.Set("session_id", SessionId);
		R.Set("sdk", Sdk);
		return R;
	}

	// ───────────────────────────── errors ─────────────────────────────

	void FCore::ReportError(const std::string& Kind, const std::string& InMessage, const std::string& Stack, FValue Attrs, bool Manual, const std::string& FnHint)
	{
		std::vector<FStackFrame> Frames = StackParser::Parse(Stack);
		Frames.erase(std::remove_if(Frames.begin(), Frames.end(), StackParser::IsPlumbing), Frames.end());
		if (!Manual && Kind != "crash" && !Frames.empty() && StackParser::IsGlitchless(Frames[0]))
		{
			return; // raised inside Glitchless (a failed send, say): never report it, or it could feed itself
		}
		while (!Frames.empty() && StackParser::IsGlitchless(Frames[0]))
		{
			Frames.erase(Frames.begin());
		}
		for (FStackFrame& F : Frames)
		{
			if (!F.File.empty())
			{
				F.File = Scrubber.Scrub(F.File);
			}
		}
		std::string Message = Text::Truncate(Text::Trim(Scrubber.Scrub(InMessage)), 500);
		if (Message.empty())
		{
			Message = "Unknown error";
		}
		const int TopIndex = StackParser::TopIndex(Frames);
		const FStackFrame* Top = TopIndex >= 0 ? &Frames[TopIndex] : nullptr;
		const std::string Fn = Top ? Top->Fn : FnHint;
		const std::string File = Top ? Top->File : "";
		const std::string Fp = Fingerprint::Of(Kind, Message, Fn);
		const int Count = ++ErrorCounts[Fp];
		Stats.Errors++;
		const std::vector<std::string> RecentList = RecentNames(6);
		Remember("error:" + Text::Truncate(Message, 40));
		std::optional<std::string> Location;
		if (!File.empty())
		{
			Location = Fn + " (" + StackParser::BaseName(File) + ":" + std::to_string(Top->Line) + ")";
		}
		else if (!Fn.empty())
		{
			Location = Fn;
		}
		auto Logged = Errors.find(Fp);
		if (Logged != Errors.end())
		{
			Logged->second.Count = Count;
		}
		else
		{
			Errors[Fp] = FErrorEntry{Message, Kind, Location, Count};
			ErrorOrder.push_back(Fp);
		}
		if (Count > MaxErrorsPerFingerprint && Kind != "crash")
		{
			return;
		}
		FValue E = Ev("error");
		E.Set("kind", Kind);
		E.Set("message", Message);
		E.Set("stack", StackParser::Format(Kind, Message, Frames));
		E.Set("source", !File.empty() ? FValue(StackParser::BaseName(File)) : FValue());
		E.Set("line", !File.empty() ? FValue(Top->Line) : FValue());
		E.Set("col", FValue());
		E.Set("fn", !Fn.empty() ? FValue(Fn) : FValue());
		E.Set("fingerprint", Fp);
		E.Set("attrs", Attrs.IsObject() && Attrs.Size() > 0 ? std::move(Attrs) : FValue());
		E.Set("recent", FValue::Strings(RecentList));
		Push(std::move(E));
	}

	void FCore::ReportCrash(const std::string& Kind, const std::string& Message, const std::string& Stack)
	{
		if (Crashed)
		{
			return;
		}
		Crashed = true;
		ReportError(Kind, Message, Stack);
		if (Inited && Enabled && !Ended)
		{
			Ended = true; // no level_abandon: the player didn't leave, the game did, and the crash says so
			Push(SessionEnd("crash"));
		}
		FinishHitch(nullptr);
		CloseWindow(false); // the frames up to the crash, without asking the dying engine for counts
		if (!Inited || !Enabled)
		{
			return;
		}
		Batch(); // into the outbox file, sent on the next launch
	}

	FValue FCore::MakeBugReport(const std::string& Screenshot)
	{
		Begin();
		const int64_t Now = UnixNow();
		FValue E = Ev("bug_report");
		E.Set("ts", Now);
		E.Set("level", Level ? FValue(*Level) : FValue());
		E.Set("note", "");
		if (Text::StartsWith(Screenshot, "data:image/"))
		{
			E.Set("screenshot", Screenshot);
		}
		if (PositionsOn && Position)
		{
			E.Set("x", Round((*Position)[0], 2));
			E.Set("y", Round((*Position)[1], 2));
			E.Set("z", Round((*Position)[2], 2));
		}
		// The last 20 game events and the hitches of the last minute, oldest first.
		std::vector<FValue> Recent20 = History;
		for (const FValue& H : RecentHitches)
		{
			if (Now - H.Find("ts")->AsInt() < 60000)
			{
				Recent20.push_back(H);
			}
		}
		std::stable_sort(Recent20.begin(), Recent20.end(), [](const FValue& A, const FValue& B) { return A.Find("ts")->AsInt() < B.Find("ts")->AsInt(); });
		FValue RecentList = FValue::Array();
		for (size_t I = Recent20.size() > 20 ? Recent20.size() - 20 : 0; I < Recent20.size(); I++)
		{
			RecentList.Push(Recent20[I]);
		}
		E.Set("recent", std::move(RecentList));
		E.Set("frames", RecentFrames());
		if (DeviceInfo.IsObject())
		{
			E.Set("device", DeviceInfo);
		}
		return E;
	}

	// The last frame windows and the one still open, oldest first: {ts, level, fps, p95}.
	FValue FCore::RecentFrames()
	{
		std::vector<FValue> Frames = RecentWindows;
		if (Win.Frames > 0)
		{
			FValue Open = FValue::Object();
			Open.Set("ts", Win.StartedAt);
			Open.Set("level", Level ? FValue(*Level) : FValue());
			Open.Set("fps", Round(Win.Frames / std::max((Ticks() - Win.StartedTicks) / 1000, 0.001), 1));
			Open.Set("p95", Round(Win.Sketch.Quantile(0.95), 2));
			Frames.push_back(std::move(Open));
		}
		FValue List = FValue::Array();
		for (size_t I = Frames.size() > 6 ? Frames.size() - 6 : 0; I < Frames.size(); I++)
		{
			List.Push(Frames[I]);
		}
		return List;
	}

	FValue FCore::Live()
	{
		Begin();
		FValue L = FValue::Object();
		L.Set("sdk", Sdk);
		L.Set("inited", Inited);
		L.Set("enabled", Enabled);
		L.Set("service", Service);
		L.Set("version", Version);
		L.Set("env", Env);
		L.Set("intake", Intake);
		L.Set("session_id", SessionId);
		L.Set("level", Level ? FValue(*Level) : FValue());
		L.Set("frame_budget_ms", Round(BudgetMs, 2));
		FValue S = FValue::Object();
		S.Set("sent", Stats.Sent);
		S.Set("failed", Stats.Failed);
		S.Set("errors", Stats.Errors);
		S.Set("hitches", Stats.Hitches);
		S.Set("deaths", Stats.Deaths);
		S.Set("last_status", Stats.LastStatus);
		S.Set("outbox_events", OutboxEvents());
		L.Set("stats", std::move(S));
		L.Set("frames", RecentFrames());
		FValue Hitches = FValue::Array();
		for (const FValue& H : RecentHitches)
		{
			Hitches.Push(H);
		}
		L.Set("hitches", std::move(Hitches));
		L.Set("ctx", GaugesJson(Ctx));
		L.Set("memory", SampleEngine());
		FValue Errs = FValue::Array();
		for (FValue& E : ErrorLog())
		{
			Errs.Push(std::move(E));
		}
		L.Set("errors", std::move(Errs));
		return L;
	}

	void FCore::SendBugReport(FValue Report, const std::string& Note)
	{
		if (!Report.IsObject() || (Inited && !Enabled))
		{
			return;
		}
		Report.Set("note", Text::Truncate(Note, 2000));
		Remember("bug_report");
		if (!Inited)
		{
			QueueEvent(std::move(Report)); // goes with the first batch, once Init says where
			return;
		}
		if (!Report.Has("device") && DeviceInfo.IsObject())
		{
			Report.Set("device", DeviceInfo);
		}
		Flush(false); // the session's own events first, so the report's session is there when someone opens it
		// A batch of its own in the outbox, on disk before it goes: a failed send is retried like any
		// batch, on a later launch too, and there is only ever one request in flight, so closing can't
		// abort one request and leave another running (and sending twice).
		std::vector<std::string> Own;
		Own.push_back(Report.Serialize());
		Outbox.push_back(NewBatch(std::move(Own)));
		SaveOutbox();
		SendNext();
	}

	std::vector<FValue> FCore::ErrorLog() const
	{
		std::vector<FValue> Out;
		for (const std::string& Fp : ErrorOrder)
		{
			const FErrorEntry& E = Errors.at(Fp);
			FValue Item = FValue::Object();
			Item.Set("message", E.Message);
			Item.Set("kind", E.Kind);
			Item.Set("location", E.Location ? FValue(*E.Location) : FValue());
			Item.Set("count", E.Count);
			Out.push_back(std::move(Item));
		}
		return Out;
	}

	// ───────────────────────────── input ─────────────────────────────

	void FCore::OnInput(const std::string& Code)
	{
		const double Now = Ticks();
		if (FirstInputAt <= 0 && FirstFrameMs > 0)
		{
			FirstInputAt = Now;
			FValue E = Ev("load");
			E.Set("ttp_ms", static_cast<int64_t>(StartupMs ? StartupMs() : Now));
			Push(std::move(E));
		}
		if (!RageInputOn)
		{
			return;
		}
		std::vector<double>& Hist = KeyHistory[Code];
		Hist.erase(std::remove_if(Hist.begin(), Hist.end(), [&](double T) { return Now - T >= RageInputWindowMs; }), Hist.end());
		Hist.push_back(Now);
		if (Hist.size() == RageInputCount)
		{
			FValue Attrs = FValue::Object();
			Attrs.Set("key", Code);
			Attrs.Set("count", static_cast<int64_t>(Hist.size()));
			Track("rage_input", std::move(Attrs));
		}
	}

	// ───────────────────────────── lifecycle ─────────────────────────────

	void FCore::OnBackground()
	{
		PausedAt = Ticks();
		SkipNextFrame();
		PendingLong.reset();
		if (Inited && Enabled && !Ended)
		{
			EndLevel("background");
			Ended = true;
			Push(SessionEnd("background"));
		}
		if (Inited && Enabled)
		{
			Flush();
			SendNow(SendDeadlineMs);
		}
	}

	void FCore::OnForeground()
	{
		SkipNextFrame();
		if (!Ended)
		{
			return;
		}
		Ended = false;
		const double Away = (Ticks() - PausedAt) / 1000;
		if (Away > Options.SessionTimeoutSeconds)
		{
			LeftLevel.reset();
			NewSession();
		}
		else
		{
			// Back in the same session: the level goes on, and the server takes back the abandon sent on
			// the way out once anything else happens on it.
			if (LeftLevel)
			{
				LevelOpen = true;
			}
			LeftLevel.reset();
			FValue Attrs = FValue::Object();
			Attrs.Set("away_s", Round(Away, 1));
			Track("app_resume", std::move(Attrs));
		}
	}

	// Back after a long time away: a new session with a new random ID. In anonymous mode nothing joins it to the last one.
	void FCore::NewSession()
	{
		Flush();
		SessionId = NewId("s_", 16);
		StartedAt = UnixNow();
		SessionStartSent = false;
		Recent.clear();
		ErrorCounts.clear();
	}

	void FCore::Shutdown(const std::string& Reason)
	{
		if (Shut)
		{
			return;
		}
		Shut = true;
		// A measure still running gets an answer, so whoever waits on it isn't left waiting.
		std::vector<std::unique_ptr<FProbe>> Cut = std::move(Probes);
		Probes.clear();
		for (const std::unique_ptr<FProbe>& P : Cut)
		{
			if (P->Done)
			{
				FValue Err = FValue::Object();
				Err.Set("error", "The game stopped (" + Reason + ") before the measure finished.");
				P->Done(Err);
			}
		}
		if (Inited && Enabled && !Ended)
		{
			EndLevel(Reason);
			Ended = true;
			Push(SessionEnd(Reason));
		}
		if (Inited && Enabled)
		{
			Flush();
			SendNow(SendDeadlineMs);
		}
	}

	FValue FCore::SessionEnd(const std::string& Reason)
	{
		Begin();
		FValue E = Ev("session_end");
		E.Set("reason", Reason);
		E.Set("duration_s", Round((UnixNow() - StartedAt) / 1000.0, 1));
		return E;
	}

	// ───────────────────────────── events ─────────────────────────────

	FValue FCore::Ev(const char* Type)
	{
		FValue E = FValue::Object();
		E.Set("type", Type);
		return E;
	}

	void FCore::Push(FValue E)
	{
		if (Inited && !Enabled)
		{
			return;
		}
		if (!E.Has("ts"))
		{
			E.Set("ts", UnixNow());
		}
		if (!E.Has("level"))
		{
			E.Set("level", Level ? FValue(*Level) : FValue());
		}
		RememberEvent(E);
		QueueEvent(std::move(E));
	}

	// What a bug report's recent list keeps of an event: the browser SDK's slimEvent.
	void FCore::RememberEvent(const FValue& E)
	{
		const std::string& T = E.Find("type")->AsString();
		if (T != "level_start" && T != "level_complete" && T != "level_fail" && T != "level_abandon" && T != "death" && T != "custom" && T != "error")
		{
			return;
		}
		FValue Slim = FValue::Object();
		Slim.Set("ts", *E.Find("ts"));
		Slim.Set("type", T);
		Slim.Set("level", *E.Find("level"));
		for (const char* K : {"name", "cause", "kind", "reason", "duration_s", "score"})
		{
			const FValue* V = E.Find(K);
			if (V && !V->IsNull())
			{
				Slim.Set(K, *V);
			}
		}
		if (const FValue* M = E.Find("message"))
		{
			if (M->IsString() && !M->AsString().empty())
			{
				Slim.Set("message", Text::Truncate(M->AsString(), 200));
			}
		}
		for (const char* K : {"x", "y", "z"})
		{
			const FValue* V = E.Find(K);
			if (V && V->IsNumber())
			{
				Slim.Set(K, *V);
			}
		}
		if (const FValue* A = E.Find("attrs"))
		{
			if (A->IsObject() && A->Serialize().size() <= 300)
			{
				Slim.Set("attrs", *A);
			}
		}
		History.push_back(std::move(Slim));
		if (History.size() > 20)
		{
			History.erase(History.begin());
		}
	}

	void FCore::QueueEvent(FValue E)
	{
		Queue.push_back(std::move(E));
		if (Queue.size() > MaxQueue)
		{
			Queue.erase(Queue.begin(), Queue.begin() + static_cast<std::ptrdiff_t>(Queue.size() - MaxQueue));
		}
	}

	void FCore::Remember(const std::string& Name)
	{
		Recent.push_back(FRecent{Name, Ticks()});
		if (Recent.size() > 20)
		{
			Recent.erase(Recent.begin());
		}
	}

	std::vector<std::string> FCore::RecentWithin(double Ms) const
	{
		const double Cutoff = Ticks() - Ms;
		std::vector<std::string> Out;
		for (const FRecent& R : Recent)
		{
			if (R.T >= Cutoff && std::find(Out.begin(), Out.end(), R.Name) == Out.end())
			{
				Out.push_back(R.Name);
			}
		}
		return Out;
	}

	std::vector<std::string> FCore::RecentNames(int Count) const
	{
		std::vector<std::string> Out;
		for (size_t I = Recent.size() > static_cast<size_t>(Count) ? Recent.size() - Count : 0; I < Recent.size(); I++)
		{
			Out.push_back(Recent[I].Name);
		}
		return Out;
	}

	FValue FCore::SessionStartEvent()
	{
		FValue E = FValue::Object();
		E.Set("type", "session_start");
		E.Set("ts", StartedAt);
		E.Set("level", FValue());
		E.Set("session_type", SessionType);
		E.Set("privacy", PrivacyName(Options.Privacy));
		FValue Dev = DeviceInfo.IsObject() ? DeviceInfo : FValue::Object();
		Steam::AddTo(Dev, ReadSteam());
		E.Set("device", Dev);
		E.Set("page", FValue());
		E.Set("nav_ms", FValue());
		return E;
	}

	// The game's Steam facts, read until Steamworks answers: a game may initialise Steam after Glitchless. A game that
	// gives no version reports its Steam build, so versions compare build by build. The first batch is made after
	// session_start, so every batch of a session has the same version.
	const FValue& FCore::ReadSteam()
	{
		if ((!SteamInfo.IsObject() || SteamInfo.Size() == 0) && SteamFacts)
		{
			SteamInfo = SteamFacts();
		}
		const FValue* Build = SteamInfo.IsObject() ? SteamInfo.Find("steam_build") : nullptr;
		if (Build && !VersionGiven && Build->AsInt() > 0)
		{
			Version = "steam-" + std::to_string(Build->AsInt());
		}
		return SteamInfo;
	}

	// ───────────────────────────── sending ─────────────────────────────

	void FCore::Flush(bool CloseWin)
	{
		NextFlushAt = Ticks() + Options.FlushIntervalSeconds * 1000;
		if (CloseWin)
		{
			FinishHitch(nullptr);
			CloseWindow(true);
		}
		if (!Inited)
		{
			return; // kept until Init() says where it goes
		}
		if (!Enabled)
		{
			Queue.clear();
			return;
		}
		Batch();
		if (!Shut)
		{
			SendNext(); // while closing, SendNow() sends instead
		}
	}

	// Moves what is waiting into the outbox, and the outbox to disk.
	void FCore::Batch()
	{
		Begin();
		if (!SessionStartSent)
		{
			Queue.insert(Queue.begin(), SessionStartEvent());
			SessionStartSent = true;
		}
		if (FirstFrameMs > 0 && !LoadSent)
		{
			// Once a launch, timed and placed at the first frame, though it goes with the first batch after it.
			LoadSent = true;
			FValue E = FValue::Object();
			E.Set("type", "load");
			E.Set("ts", FirstFrameAt);
			E.Set("level", FirstFrameLevel ? FValue(*FirstFrameLevel) : FValue());
			E.Set("ttff_ms", static_cast<int64_t>(FirstFrameMs));
			E.Set("assets", FValue());
			Queue.push_back(std::move(E));
		}
		if (!Sampled)
		{
			Queue.clear();
			Stats.LastStatus = "unsampled";
			return;
		}
		if (!Queue.empty())
		{
			AddBatches(Queue);
			Queue.clear();
			SaveOutbox();
		}
	}

	void FCore::AddBatches(const std::vector<FValue>& Events)
	{
		std::vector<std::string> Chunk;
		size_t Size = 0;
		for (const FValue& E : Events)
		{
			std::string Line = E.Serialize();
			if (!Chunk.empty() && Size + Line.size() > BatchBytes * 9 / 10)
			{
				Outbox.push_back(NewBatch(std::move(Chunk)));
				Chunk.clear();
				Size = 0;
			}
			Size += Line.size();
			Chunk.push_back(std::move(Line));
		}
		if (!Chunk.empty())
		{
			Outbox.push_back(NewBatch(std::move(Chunk)));
		}
		int Total = OutboxEvents();
		while (Total > MaxOutboxEvents && Outbox.size() > 1 && Outbox[0].Id != InFlight)
		{
			Total -= static_cast<int>(Outbox[0].Events.size());
			Outbox.erase(Outbox.begin());
		}
	}

	// Bid is the batch's own random ID (SPEC §2 batch_id). It goes with every try of the batch and is saved with
	// it, so the server stores a batch once however many times it arrives: after a send that timed out, one given
	// up on when the game went to the background or closed, or a launch that sends what the last one saved
	// (a crash's batches too). It names the batch, not the player or the session, so anonymous mode saves it too.
	FCore::FBatch FCore::NewBatch(std::vector<std::string> Events)
	{
		FBatch B;
		B.Id = NextBatchId++;
		B.Bid = NewId("b_", 16);
		B.Service = Service;
		B.Env = Env;
		B.Version = Version;
		B.Sid = SessionId;
		B.Pid = PlayerId;
		B.Group = StartedAt;
		B.Events = std::move(Events);
		return B;
	}

	std::string FCore::Body(const FBatch& B) const
	{
		std::string S;
		S.reserve(1024);
		S += "{\"service\":";
		Json::WriteString(S, B.Service);
		S += ",\"env\":";
		Json::WriteString(S, B.Env);
		S += ",\"version\":";
		Json::WriteString(S, B.Version);
		S += ",\"session_id\":";
		Json::WriteString(S, B.Sid);
		S += ",\"player_id\":";
		if (B.Pid.empty())
		{
			S += "null"; // the server uses the session ID in its place
		}
		else
		{
			Json::WriteString(S, B.Pid);
		}
		S += ",\"sdk\":\"";
		S += Sdk;
		S += "\",\"batch_id\":";
		Json::WriteString(S, B.Bid);
		S += ",\"events\":[";
		for (size_t I = 0; I < B.Events.size(); I++)
		{
			if (I > 0)
			{
				S += ',';
			}
			S += B.Events[I];
		}
		S += "]}";
		return S;
	}

	// Batches are gzipped (about 5x smaller). Content-Type stays text/plain, as every SDK sends it;
	// the server spots gzip by its magic bytes.
	std::vector<uint8_t> FCore::Encode(const std::string& Json) const
	{
		if (Json.size() >= 1024 && Gzip)
		{
			std::vector<uint8_t> Out;
			if (Gzip(Json, Out) && !Out.empty())
			{
				return Out;
			}
		}
		return std::vector<uint8_t>(Json.begin(), Json.end());
	}

	std::string FCore::IntakeUrl() const
	{
		return Intake + "/v1/intake?token=" + Escape(Options.ClientToken);
	}

	void FCore::SendNext()
	{
		if (Draining || InFlight >= 0 || Outbox.empty() || Ticks() < RetryAt || !Transport)
		{
			return;
		}
		const FBatch& B = Outbox[0];
		std::vector<uint8_t> Bytes = Encode(Body(B));
		Debug("sending " + std::to_string(B.Events.size()) + " events (" + std::to_string(Bytes.size()) + " bytes)");
		InFlight = B.Id;
		const int Id = B.Id;
		std::weak_ptr<bool> Token = Alive;
		Transport->Send(IntakeUrl(), std::move(Bytes), "text/plain", [this, Id, Token](int64_t Status) {
			if (const std::shared_ptr<bool> Live = Token.lock())
			{
				if (*Live)
				{
					OnSent(Id, Status);
				}
			}
		});
	}

	void FCore::OnSent(int Id, int64_t Status)
	{
		if (Id != InFlight)
		{
			return; // given up on (SendNow sent it instead)
		}
		InFlight = -1;
		const auto It = std::find_if(Outbox.begin(), Outbox.end(), [Id](const FBatch& B) { return B.Id == Id; });
		const int64_t N = It != Outbox.end() ? static_cast<int64_t>(It->Events.size()) : 0;
		if (Status >= 200 && Status < 300)
		{
			Stats.Sent += N;
			Stats.LastStatus = "ok";
			BackoffS = 0;
		}
		else if (Status >= 400 && Status < 500 && Status != 408 && Status != 429)
		{
			Stats.Failed += N; // the server turned it away; sending it again would only fail again
			Stats.LastStatus = "rejected " + std::to_string(Status);
		}
		else
		{
			Stats.Failed += N;
			RetryLater(Status == 0 ? "network error" : "HTTP " + std::to_string(Status));
			return;
		}
		if (It != Outbox.end())
		{
			Outbox.erase(It);
		}
		SaveOutbox();
		SendNext();
	}

	void FCore::RetryLater(const std::string& Why)
	{
		Stats.LastStatus = "error";
		BackoffS = std::min(std::max(BackoffS * 2, 5.0), 300.0);
		RetryAt = Ticks() + BackoffS * 1000;
		Debug("send failed: " + Why + "; trying again in " + std::to_string(static_cast<int>(BackoffS)) + "s");
	}

	void FCore::SendNow(int DeadlineMs)
	{
		if (Outbox.empty() || !Sampled || !Transport)
		{
			return;
		}
		const double Deadline = Ticks() + DeadlineMs;
		Draining = true;
		int GivenUp = -1;
		if (InFlight >= 0)
		{
			// The request on its way may have reached the server already, and sending its batch again would
			// deliver every event in it twice: wait for its answer (OnSent runs from Wait). Given up on at the
			// deadline, its batch stays in the outbox for the next launch rather than going again now.
			if (!Transport->Wait(std::max(0, static_cast<int>(Deadline - Ticks()))))
			{
				Transport->Abort();
				GivenUp = InFlight;
				InFlight = -1;
			}
		}
		std::vector<int> Ids;
		for (const FBatch& B : Outbox)
		{
			if (B.Id != GivenUp)
			{
				Ids.push_back(B.Id);
			}
		}
		for (int Id : Ids)
		{
			const int Left = static_cast<int>(Deadline - Ticks());
			if (Left <= 0)
			{
				break;
			}
			const auto It = std::find_if(Outbox.begin(), Outbox.end(), [Id](const FBatch& B) { return B.Id == Id; });
			if (It == Outbox.end())
			{
				continue;
			}
			const int64_t Status = Transport->SendNow(IntakeUrl(), Encode(Body(*It)), "text/plain", Left);
			if (Status >= 200 && Status < 300)
			{
				Stats.Sent += static_cast<int64_t>(It->Events.size());
			}
			else if (Status == 0 || Status >= 500 || Status == 408 || Status == 429)
			{
				break;
			}
			Outbox.erase(It);
			SaveOutbox(); // at once: the OS may stop the game before the next answer comes
		}
		Draining = false;
		SaveOutbox();
	}

	int FCore::OutboxEvents() const
	{
		int N = 0;
		for (const FBatch& B : Outbox)
		{
			N += static_cast<int>(B.Events.size());
		}
		return N;
	}

	// ───────────────────────────── saved batches ─────────────────────────────

	std::string FCore::OutboxPath() const
	{
		return SaveDir + "/outbox.json";
	}

	std::string FCore::PlayerPath() const
	{
		return SaveDir + "/player_id";
	}

	// Batches that couldn't be sent are saved, so a game played offline is sent when the network is
	// back, and a crash is sent on the next launch. In anonymous mode they are saved without the
	// session ID; on the next launch each earlier session's batches go under a new random ID, so
	// nothing written to the device ties two sessions. Every mode saves each batch's own ID, so a batch
	// the server took just before the game closed is not stored twice when the next launch sends it.
	void FCore::SaveOutbox()
	{
		if (!Enabled || SaveDir.empty())
		{
			return;
		}
		if (Outbox.empty())
		{
			RemoveFile(OutboxPath());
			return;
		}
		std::string S = "{\"v\":1,\"batches\":[";
		for (size_t I = 0; I < Outbox.size(); I++)
		{
			const FBatch& B = Outbox[I];
			if (I > 0)
			{
				S += ',';
			}
			S += "{\"bid\":";
			Json::WriteString(S, B.Bid);
			S += ",\"service\":";
			Json::WriteString(S, B.Service);
			S += ",\"env\":";
			Json::WriteString(S, B.Env);
			S += ",\"version\":";
			Json::WriteString(S, B.Version);
			S += ",\"group\":" + std::to_string(B.Group);
			if (StoresId)
			{
				S += ",\"sid\":";
				Json::WriteString(S, B.Sid);
				S += ",\"pid\":";
				Json::WriteString(S, B.Pid);
			}
			S += ",\"events\":[";
			for (size_t K = 0; K < B.Events.size(); K++)
			{
				if (K > 0)
				{
					S += ',';
				}
				S += B.Events[K];
			}
			S += "]}";
		}
		S += "]}";
		if (!WriteFile(OutboxPath(), S))
		{
			Debug("could not write " + OutboxPath());
		}
	}

	void FCore::LoadOutbox()
	{
		std::string Saved;
		FValue Data;
		if (!ReadFile(OutboxPath(), Saved) || !FValue::Parse(Saved, Data))
		{
			return;
		}
		const FValue* Batches = Data.Find("batches");
		if (!Batches || !Batches->IsArray())
		{
			return;
		}
		const int64_t Oldest = UnixNow() - MaxOutboxAgeMs;
		std::map<int64_t, std::string> FreshIds;
		for (const FValue& SavedBatch : Batches->GetItems())
		{
			const FValue* Evs = SavedBatch.Find("events");
			if (!Evs || !Evs->IsArray())
			{
				continue;
			}
			std::vector<std::string> Events;
			for (const FValue& E : Evs->GetItems())
			{
				const FValue* Ts = E.Find("ts");
				if (E.IsObject() && Ts && Ts->IsNumber() && Ts->AsNumber() >= static_cast<double>(Oldest))
				{
					Events.push_back(E.Serialize());
				}
			}
			if (Events.empty())
			{
				continue;
			}
			auto Str = [&](const char* Key, const std::string& Fallback) {
				const FValue* V = SavedBatch.Find(Key);
				return V && V->IsString() ? V->AsString() : Fallback;
			};
			const FValue* GroupValue = SavedBatch.Find("group");
			const int64_t Group = GroupValue ? GroupValue->AsInt() : 0;
			std::string Sid = Str("sid", "");
			if (Sid.empty())
			{
				std::string& Fresh = FreshIds[Group];
				if (Fresh.empty())
				{
					Fresh = NewId("s_", 16);
				}
				Sid = Fresh;
			}
			FBatch B;
			B.Id = NextBatchId++;
			const std::string Bid = Str("bid", "");
			B.Bid = Text::StartsWith(Bid, "b_") ? Bid : NewId("b_", 16); // saved by a build from before batch IDs: a new one
			B.Service = Str("service", Service);
			B.Env = Str("env", Env);
			B.Version = Str("version", Version);
			B.Sid = Sid;
			B.Pid = StoresId ? Str("pid", "") : "";
			B.Group = Group;
			B.Events = std::move(Events);
			Outbox.push_back(std::move(B));
		}
		Debug(std::to_string(Outbox.size()) + " saved batches from earlier launches");
	}

	std::string FCore::LoadPlayerId()
	{
		std::string Saved;
		if (ReadFile(PlayerPath(), Saved))
		{
			Saved = Text::Trim(Saved);
			if (Text::StartsWith(Saved, "p_"))
			{
				return Saved;
			}
		}
		const std::string Id = NewId("p_", 12);
		WriteFile(PlayerPath(), Id);
		return Id;
	}

	bool FCore::ReadFile(const std::string& Path, std::string& Out) const
	{
		if (Files.Read)
		{
			return Files.Read(Path, Out);
		}
		std::FILE* F = Text::OpenFile(Path, "rb");
		if (!F)
		{
			return false;
		}
		char Buf[8192];
		size_t N;
		Out.clear();
		while ((N = std::fread(Buf, 1, sizeof(Buf), F)) > 0)
		{
			Out.append(Buf, N);
		}
		std::fclose(F);
		return true;
	}

	bool FCore::WriteFile(const std::string& Path, const std::string& Contents) const
	{
		if (Files.Write)
		{
			return Files.Write(Path, Contents);
		}
		const std::string Tmp = Path + ".tmp";
		std::FILE* F = Text::OpenFile(Tmp, "wb");
		if (!F)
		{
			return false;
		}
		const bool Ok = std::fwrite(Contents.data(), 1, Contents.size(), F) == Contents.size();
		std::fclose(F);
		if (!Ok)
		{
			std::remove(Tmp.c_str());
			return false;
		}
		std::remove(Path.c_str());
		return std::rename(Tmp.c_str(), Path.c_str()) == 0;
	}

	void FCore::RemoveFile(const std::string& Path) const
	{
		if (Files.Delete)
		{
			Files.Delete(Path);
		}
		else
		{
			std::remove(Path.c_str());
		}
	}

	// ───────────────────────────── helpers ─────────────────────────────

	void FCore::Debug(const std::string& Msg) const
	{
		if (DebugOn && Log)
		{
			Log("[glitchless] " + Msg);
		}
	}

	bool FCore::HasFlag(const std::string& Flag) const
	{
		for (const std::string& A : Args)
		{
			const std::string Name = StripFlagDashes(A);
			if (Name == Flag || Text::StartsWith(Name, Flag + "="))
			{
				return true;
			}
		}
		return false;
	}

	std::optional<std::string> FCore::FlagValue(const std::string& Flag) const
	{
		for (const std::string& A : Args)
		{
			const std::string Name = StripFlagDashes(A);
			if (Text::StartsWith(Name, Flag + "="))
			{
				return Name.substr(Flag.size() + 1);
			}
		}
		return std::nullopt;
	}

	std::string FCore::NewId(const char* Prefix, int Length) const
	{
		std::string Id(Prefix);
		std::random_device& Rng = Entropy();
		for (int I = 0; I < Length; I++)
		{
			Id += IdChars[Rng() % 36];
		}
		return Id;
	}

	double FCore::Random01() const
	{
		return static_cast<double>(Entropy()() % 1000000) / 1000000.0;
	}

	double FCore::Median(std::vector<double> Values)
	{
		return Quantile(std::move(Values), 0.5);
	}

	// The browser SDK's quantileOf: the value at that share of the sorted values.
	double FCore::Quantile(std::vector<double> Values, double Q)
	{
		if (Values.empty())
		{
			return 0;
		}
		std::sort(Values.begin(), Values.end());
		return Values[std::min(Values.size() - 1, static_cast<size_t>(std::floor(static_cast<double>(Values.size()) * Q)))];
	}
}

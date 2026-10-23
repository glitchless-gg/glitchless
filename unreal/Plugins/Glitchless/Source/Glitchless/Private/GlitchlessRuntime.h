// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "Core/GlitchlessCore.h"
#include "HAL/CriticalSection.h"
#include "Templates/UniquePtr.h"
// FWeakObjectPtr itself, for the TWeakObjectPtr member: CoreMinimal has only the template, and a build
// without a shared PCH (BuildPlugin's game target, so Fab's) doesn't get it from anywhere else.
#include "UObject/WeakObjectPtr.h"
#include "UObject/WeakObjectPtrTemplates.h"

struct FBlueprintExceptionInfo;
struct FFrame;
struct FGlitchlessOptions;
class FGlitchlessInputProcessor;
class FGlitchlessOutputDevice;
class ULevel;
class UPackage;
class UWorld;

/**
 * Feeds Glitchless::FCore from Unreal: frame times and where each frame's time went (the game, render
 * and RHI threads and the GPU), why a long frame was long (pipeline states compiled, garbage collected,
 * a map or streamed level loaded, assets loaded), errors (the log, ensures, Blueprint runtime errors,
 * crashes), maps as levels, input, and the app's lifecycle.
 *
 * A packaged game starts it when the module loads, so the first frames and errors are kept; nothing
 * is sent until Init. In the editor it runs only during Play In Editor.
 *
 * Flags (on the command line, - or --):
 *   -glitchless                 send from a development build too
 *   -glitchless-intake=URL      send to this server instead
 *   -glitchless-measure=S       print frame stats as one line of JSON after S seconds and quit
 *   -glitchless-warmup=S        with -glitchless-measure: wait this long after the first map first
 *   -glitchless-out=PATH        with -glitchless-measure: write the JSON to this file too
 *   -glitchless-synthetic       mark the session as a bot's (-autoplay does too)
 *   -glitchless-off             send nothing
 *   -glitchless-debug           log each batch as it is sent
 */
class FGlitchlessRuntime
{
public:
	/** The running instance, or null (in the editor outside Play In Editor, in a commandlet). */
	static FGlitchlessRuntime* Get();
	static FGlitchlessRuntime& Start();
	/** Ends the session and stops capturing. */
	static void Stop(const FString& Reason);

	~FGlitchlessRuntime();

	/** Runs Fn on the core with the lock held: every call into the core goes through here. */
	template <typename TFn>
	void With(TFn&& Fn)
	{
		FScopeLock Lock(&Mutex);
		Fn(*Core);
	}

	void Init(const FGlitchlessOptions& Options);
	/** Init from Project Settings > Plugins > Glitchless, if a service is set there. */
	void InitFromSettings();
	void Shutdown(const FString& Reason);
	/** The game world whose maps count as levels. In Play In Editor, the first instance's. */
	void WatchWorld(UWorld* World);
	void OnInput(const FString& Code);
	/** UE's error device is handling an assert or a fatal error ("appError called"): the game dies next. */
	static void OnAppError();
	/** A signal nobody else handles (a packaged Mac or Linux game without CrashReportClient). */
	static void OnSignal(int Signal, void* Address);
	/** The moment a bug report describes, with its screenshot (a JPEG data URL, or empty). */
	Glitchless::FValue MakeBugReport(const FString& Screenshot);
	void SendBugReport(Glitchless::FValue Report, const FString& Note);
	void SkipNextFrames(int32 Count);

private:
	FGlitchlessRuntime();

	void OnBeginFrame();
	void OnPreGarbageCollect();
	void OnPostGarbageCollect();
	void OnPreLoadMap(const FString& MapUrl);
	void OnPostLoadMap(UWorld* World);
	void OnLevelAdded(ULevel* Level, UWorld* World);
	void OnPackageLoaded(UPackage* Package);
	void OnEnsureFailed(const ANSICHAR* Expr, const ANSICHAR* File, int32 Line, const TCHAR* Msg, const TCHAR* CombinedErrorMsg);
	void OnScriptException(const UObject* Object, const FFrame& Frame, const FBlueprintExceptionInfo& Info);
	static void OnSystemError();
	/** Writes the crash and the frames before it to the outbox, from whichever thread is dying. */
	static void ReportCrashNow(const std::string& Message, const std::string& Stack);
	static void InstallSignalHandlers();
	void OnActivationChanged(bool bActive);
	void OnEnterBackground();
	void OnEnterForeground();
	void OnEnginePreExit();
	void RegisterInput();
	void DrainErrors();
	void CheckMeasure(double Now);
	void FinishMeasure(const Glitchless::FValue& Result);
	Glitchless::FValue SampleEngine() const;
	bool IsWatched(const UWorld* World) const;

	TUniquePtr<Glitchless::FCore> Core;
	FCriticalSection Mutex; // recursive on every platform

	TUniquePtr<FGlitchlessOutputDevice> LogDevice;
	TSharedPtr<FGlitchlessInputProcessor> InputProcessor;
	TArray<FDelegateHandle> Handles;
	FDelegateHandle ActivationHandle;
	FDelegateHandle EnsureHandle;
	FDelegateHandle SystemErrorHandle;

	// What happened since the last frame began, for that frame's cost and causes.
	double LastFrameAt = 0;
	double GcStartedAt = 0;
	int32 GcCount = 0;
	double GcMs = 0;
	int32 PackagesLoaded = 0;
	bool bMapLoaded = false;
	bool bLevelStreamed = false;
	uint32 LastPsoHitches = 0;
	uint32 LastLoadFlushes = 0;
	int32 LastShaderJobs = -1;

	TWeakObjectPtr<UWorld> WatchedWorld;
	int32 WatchedMapHandle = 0;
	int32 NextMapHandle = 1;
	bool bInitialized = false;
	bool bShutDown = false;

	// -glitchless-measure
	double MeasureSeconds = 0;
	double MeasureWarmup = 0;
	double MeasureStartAt = 0;
	bool bMeasureStarted = false;
};

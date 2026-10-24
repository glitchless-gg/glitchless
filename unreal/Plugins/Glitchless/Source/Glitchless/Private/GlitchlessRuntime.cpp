// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessRuntime.h"

#include "Glitchless.h"
#include "GlitchlessBugReport.h"
#include "GlitchlessDevice.h"
#include "GlitchlessSteamworks.h"
#include "GlitchlessInput.h"
#include "GlitchlessOutputDevice.h"
#include "GlitchlessSettings.h"
#include "GlitchlessStrings.h"
#include "GlitchlessTransport.h"

#include "Blueprint/BlueprintExceptionInfo.h"
#include "DynamicRHI.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "GeneralProjectSettings.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMemory.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformStackWalk.h"
#include "HAL/PlatformTime.h"
#include "Misc/App.h"
#include "Misc/CommandLine.h"
#include "Misc/Compression.h"
#include "Misc/CoreDelegates.h"
#include "Misc/EngineVersionComparison.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "PipelineStateCache.h"
#include "RenderTimer.h"
#include "RHICommandList.h"
#include "RHIStats.h"
#include "Serialization/AsyncPackageLoader.h"
#include "UObject/Package.h"
#include "UObject/Script.h"
#include "UObject/Stack.h"
#include "UObject/UObjectArray.h"
#include "UObject/UObjectGlobals.h"
#include "UnrealClient.h"
#if WITH_EDITOR
#include "ShaderCompiler.h"
#endif

#include <atomic>
#include <cstdio>
#if PLATFORM_MAC || PLATFORM_LINUX || PLATFORM_IOS || PLATFORM_ANDROID
#include <signal.h>
#define GLITCHLESS_SIGNALS 1
#else
#define GLITCHLESS_SIGNALS 0
#endif
#if PLATFORM_WINDOWS
#include "HAL/PlatformStackWalk.h"
#include "Windows/WindowsHWrapper.h"
#endif

using Glitchless::FValue;

#if PLATFORM_WINDOWS
// On Windows, Unreal's crash handler runs on a thread of its own and says a crash happened (OnHandleSystemError)
// before it has read the exception, and only an engine built from source logs the callstack after that. So the
// exception is kept as it happens, on the thread it happens on, and read once Unreal says it was a crash. Named,
// so the parser leaves these frames out.
namespace GlitchlessWindows
{
	struct FException
	{
		CONTEXT Context;
		DWORD Code = 0;
		DWORD ThreadId = 0;
		DWORD Params = 0;
		ULONG_PTR Info[2] = {};
		ULONGLONG At = 0;
	};
	FException Last;
	std::atomic<int32> Writing{0};
	PVOID Handler = nullptr;

	// Errors (0xC...), and the codes Unreal raises for an assert or fatal error, a GPU crash and running out of memory.
	bool MayBeFatal(DWORD Code)
	{
		return (Code & 0xF0000000u) == 0xC0000000u || Code == 0x4000 || Code == 0x8000 || Code == 0xc000;
	}

	// Every exception comes here first, whether something handles it later or not: this only keeps it.
	LONG CALLBACK OnException(PEXCEPTION_POINTERS Info)
	{
		if (Info && Info->ExceptionRecord && Info->ContextRecord && MayBeFatal(Info->ExceptionRecord->ExceptionCode) && Writing.exchange(1) == 0)
		{
			const EXCEPTION_RECORD& R = *Info->ExceptionRecord;
			Last.Context = *Info->ContextRecord;
			Last.Code = R.ExceptionCode;
			Last.Params = R.NumberParameters;
			Last.Info[0] = R.NumberParameters > 0 ? R.ExceptionInformation[0] : 0;
			Last.Info[1] = R.NumberParameters > 1 ? R.ExceptionInformation[1] : 0;
			Last.ThreadId = ::GetCurrentThreadId();
			Last.At = ::GetTickCount64();
			Writing.store(0);
		}
		return EXCEPTION_CONTINUE_SEARCH;
	}

	// The exception as Unreal words it: "Unhandled Exception: EXCEPTION_ACCESS_VIOLATION writing address 0x0000000000000000".
	std::string Describe(const FException& E)
	{
		char Out[160];
		const char* Name = nullptr;
		switch (E.Code)
		{
		case EXCEPTION_ACCESS_VIOLATION:
			std::snprintf(Out, sizeof(Out), "Unhandled Exception: EXCEPTION_ACCESS_VIOLATION %s address 0x%016llx", E.Info[0] == 1 ? "writing" : E.Info[0] == 8 ? "executing" : "reading", static_cast<unsigned long long>(E.Info[1]));
			return Out;
		case EXCEPTION_STACK_OVERFLOW: Name = "EXCEPTION_STACK_OVERFLOW"; break;
		case EXCEPTION_INT_DIVIDE_BY_ZERO: Name = "EXCEPTION_INT_DIVIDE_BY_ZERO"; break;
		case EXCEPTION_ILLEGAL_INSTRUCTION: Name = "EXCEPTION_ILLEGAL_INSTRUCTION"; break;
		case EXCEPTION_PRIV_INSTRUCTION: Name = "EXCEPTION_PRIV_INSTRUCTION"; break;
		case EXCEPTION_IN_PAGE_ERROR: Name = "EXCEPTION_IN_PAGE_ERROR"; break;
		case EXCEPTION_ARRAY_BOUNDS_EXCEEDED: Name = "EXCEPTION_ARRAY_BOUNDS_EXCEEDED"; break;
		case EXCEPTION_FLT_DIVIDE_BY_ZERO: Name = "EXCEPTION_FLT_DIVIDE_BY_ZERO"; break;
		default: break;
		}
		if (Name)
		{
			std::snprintf(Out, sizeof(Out), "Unhandled Exception: %s", Name);
		}
		else
		{
			std::snprintf(Out, sizeof(Out), "Unhandled Exception: 0x%08lx", static_cast<unsigned long>(E.Code));
		}
		return Out;
	}

	// Adds the kept exception to what Unreal left: the crashed thread's stack, walked
	// from the context it crashed with (that thread waits for Unreal's handler, so its stack is still there), and,
	// for anything but an assert (whose message is in GErrorHist already), what the exception was.
	bool AddException(std::string& Hist, std::string& Description)
	{
		if (Last.At == 0 || ::GetTickCount64() - Last.At > 10000 || Writing.load() != 0)
		{
			return false; // none, or one too old to be this crash
		}
		const FException E = Last;
		CONTEXT Context = E.Context;
		HANDLE Thread = ::OpenThread(THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION | THREAD_SUSPEND_RESUME, 0, E.ThreadId);
		void* Wrapper = FWindowsPlatformStackWalk::MakeThreadContextWrapper(&Context, Thread);
		const SIZE_T Size = 65536;
		ANSICHAR* Trace = static_cast<ANSICHAR*>(FMemory::SystemMalloc(Size));
		Trace[0] = 0;
#if defined(_M_ARM64)
		void* Pc = reinterpret_cast<void*>(Context.Pc);
#else
		void* Pc = reinterpret_cast<void*>(Context.Rip);
#endif
		FPlatformStackWalk::StackWalkAndDump(Trace, Size, Pc, Wrapper);
		FWindowsPlatformStackWalk::ReleaseThreadContextWrapper(Wrapper);
		if (Thread)
		{
			::CloseHandle(Thread);
		}
		Hist += (Hist.empty() ? "" : "\r\n\r\n") + std::string(Trace);
		FMemory::SystemFree(Trace);
		if (E.Code != 0x4000 && Description.empty())
		{
			Description = Describe(E);
		}
		return true;
	}
}
#endif

namespace
{
	FGlitchlessRuntime* Instance = nullptr;

	// The command line as separate arguments, quotes taken off: -glitchless-out="C:\My Runs\a.json".
	std::vector<std::string> CommandLineArgs()
	{
		std::vector<std::string> Args;
		const std::string Line = GlitchlessText::Utf8(FCommandLine::Get());
		std::string Arg;
		bool bQuoted = false;
		bool bAny = false;
		for (const char C : Line)
		{
			if (C == '"')
			{
				bQuoted = !bQuoted;
				bAny = true;
			}
			else if ((C == ' ' || C == '\t') && !bQuoted)
			{
				if (bAny)
				{
					Args.push_back(Arg);
				}
				Arg.clear();
				bAny = false;
			}
			else
			{
				Arg += C;
				bAny = true;
			}
		}
		if (bAny)
		{
			Args.push_back(Arg);
		}
		return Args;
	}

	double Ms(uint32 Cycles)
	{
		return Cycles > 0 ? FPlatformTime::ToMilliseconds(Cycles) : -1;
	}

	FString MapName(const UWorld* World)
	{
		return UWorld::RemovePIEPrefix(World->GetMapName());
	}
}

FGlitchlessRuntime* FGlitchlessRuntime::Get()
{
	return Instance;
}

FGlitchlessRuntime& FGlitchlessRuntime::Start()
{
	if (!Instance)
	{
		Instance = new FGlitchlessRuntime();
	}
	return *Instance;
}

void FGlitchlessRuntime::Stop(const FString& Reason)
{
	if (!Instance)
	{
		return;
	}
	Instance->Shutdown(Reason);
	FGlitchlessRuntime* Dying = Instance;
	Instance = nullptr;
	delete Dying;
}

FGlitchlessRuntime::FGlitchlessRuntime()
{
	Core = MakeUnique<Glitchless::FCore>();
	Glitchless::FCore& C = *Core;
	C.Clock = []() { return FPlatformTime::Seconds() * 1000.0; };
	C.UnixNow = []() { return static_cast<int64_t>((FDateTime::UtcNow() - FDateTime(1970, 1, 1)).GetTotalMilliseconds()); };
	C.Transport = std::make_shared<FGlitchlessHttpTransport>(&Mutex);
	// Where the platform really writes Saved: on a phone the engine's file layer moves writes into the app's
	// data container, and a crash writes the outbox with plain C calls that know nothing of that.
	const FString SavedDir = IFileManager::Get().ConvertToAbsolutePathForExternalAppForWrite(*FPaths::ProjectSavedDir());
	C.SaveDir = GlitchlessText::Utf8(SavedDir / TEXT("Glitchless"));
	C.Files.Read = [](const std::string& Path, std::string& Out) {
		TArray<uint8> Bytes;
		if (!FFileHelper::LoadFileToArray(Bytes, *GlitchlessText::Tchar(Path), FILEREAD_Silent))
		{
			return false;
		}
		Out.assign(reinterpret_cast<const char*>(Bytes.GetData()), Bytes.Num());
		return true;
	};
	C.Files.Write = [](const std::string& Path, const std::string& Contents) {
		const FString Dest = GlitchlessText::Tchar(Path);
		const FString Temp = Dest + TEXT(".tmp");
		if (!FFileHelper::SaveArrayToFile(TArrayView<const uint8>(reinterpret_cast<const uint8*>(Contents.data()), static_cast<int32>(Contents.size())), *Temp))
		{
			return false;
		}
		return IFileManager::Get().Move(*Dest, *Temp, true, true, false, true);
	};
	C.Files.Delete = [](const std::string& Path) { IFileManager::Get().Delete(*GlitchlessText::Tchar(Path), false, false, true); };
	C.Files.MakeDir = [](const std::string& Dir) { IFileManager::Get().MakeDirectory(*GlitchlessText::Tchar(Dir), true); };
	C.Device = [](bool bDetailed) { return GlitchlessDevice::Collect(bDetailed); };
	C.SteamFacts = []() { return GlitchlessSteamworks::Read(); };
	C.Engine = [this]() { return SampleEngine(); };
	C.StartupMs = []() { return (FPlatformTime::Seconds() - GStartTime) * 1000.0; };
	C.Args = CommandLineArgs();
	C.ScreenSize = []() { return GlitchlessDevice::ScreenSize(); };
	C.WindowSize = []() { return GlitchlessDevice::WindowSize(); };
	C.Log = [](const std::string& S) { UE_LOG(LogGlitchless, Log, TEXT("%s"), *GlitchlessText::Tchar(S)); };
	C.Gzip = [](const std::string& In, std::vector<uint8_t>& Out) {
		int32 Size = FCompression::CompressMemoryBound(NAME_Gzip, static_cast<int32>(In.size()));
		Out.resize(Size);
		if (!FCompression::CompressMemory(NAME_Gzip, Out.data(), Size, In.data(), static_cast<int32>(In.size())))
		{
			return false;
		}
		Out.resize(Size);
		return true;
	};
	C.IsDevelopmentBuild = GIsEditor || !(UE_BUILD_SHIPPING || UE_BUILD_TEST);
	C.IsMobile = PLATFORM_IOS || PLATFORM_ANDROID;
	C.IsHeadless = !FApp::CanEverRender();
	// Paths on the device, shortened to a name so they say nothing about whose device it is.
	C.Scrubber.AddPath(GlitchlessText::Utf8(SavedDir), "saved:");
	C.Scrubber.AddPath(GlitchlessText::Utf8(FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir())), "saved:");
	C.Scrubber.AddPath(GlitchlessText::Utf8(FPaths::ConvertRelativePathToFull(FPaths::ProjectDir())), "project:");
	C.Scrubber.AddPath(GlitchlessText::Utf8(FPaths::ConvertRelativePathToFull(FPaths::EngineDir())), "engine:");
	C.Scrubber.AddPath(GlitchlessText::Utf8(FPlatformProcess::UserSettingsDir()), "settings:");
	C.Scrubber.AddPath(GlitchlessText::Utf8(FPlatformProcess::UserDir()), "documents:");
#if PLATFORM_IOS || PLATFORM_ANDROID
	// A phone's app folders are named with a random ID for each install.
	C.Scrubber.AddPath(GlitchlessText::Utf8(FPlatformProcess::UserHomeDir()), "home:");
	C.Scrubber.AddPath(GlitchlessText::Utf8(FPlatformProcess::BaseDir()), "app:");
#endif

	LogDevice = MakeUnique<FGlitchlessOutputDevice>();
	GLog->AddOutputDevice(LogDevice.Get());

	FCoreDelegates::OnBeginFrame.AddRaw(this, &FGlitchlessRuntime::OnBeginFrame);
	FCoreDelegates::OnEnginePreExit.AddRaw(this, &FGlitchlessRuntime::OnEnginePreExit);
	FCoreDelegates::ApplicationWillEnterBackgroundDelegate.AddRaw(this, &FGlitchlessRuntime::OnEnterBackground);
	FCoreDelegates::ApplicationHasEnteredForegroundDelegate.AddRaw(this, &FGlitchlessRuntime::OnEnterForeground);
	EnsureHandle = FCoreDelegates::OnEnsureFailed.AddRaw(this, &FGlitchlessRuntime::OnEnsureFailed);
	SystemErrorHandle = FCoreDelegates::OnHandleSystemError.AddStatic(&FGlitchlessRuntime::OnSystemError);
	FCoreUObjectDelegates::GetPreGarbageCollectDelegate().AddRaw(this, &FGlitchlessRuntime::OnPreGarbageCollect);
	FCoreUObjectDelegates::GetPostGarbageCollect().AddRaw(this, &FGlitchlessRuntime::OnPostGarbageCollect);
	FCoreUObjectDelegates::PreLoadMap.AddRaw(this, &FGlitchlessRuntime::OnPreLoadMap);
	FCoreUObjectDelegates::PostLoadMapWithWorld.AddRaw(this, &FGlitchlessRuntime::OnPostLoadMap);
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
	PRAGMA_DISABLE_DEPRECATION_WARNINGS
	FCoreUObjectDelegates::OnPackageLoadCompleted.AddRaw(this, &FGlitchlessRuntime::OnPackageLoaded); // only counted: the package is never read
	PRAGMA_ENABLE_DEPRECATION_WARNINGS
#endif
	FWorldDelegates::LevelAddedToWorld.AddRaw(this, &FGlitchlessRuntime::OnLevelAdded);
	FBlueprintCoreDelegates::OnScriptException.AddRaw(this, &FGlitchlessRuntime::OnScriptException);

#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
	const FPSORuntimeCreationStats Pso = PipelineStateCache::GetPSORuntimeCreationStats();
	LastPsoHitches = Pso.GraphicsPSOHitches + Pso.ComputePSOHitches;
#endif
	LastLoadFlushes = GFlushAsyncLoadingCount + GSyncLoadCount;

	// The editor's Play In Editor is measured from the editor's own tools, not by quitting the editor.
	if (!GIsEditor)
	{
		if (const std::optional<std::string> Seconds = Core->FlagValue("glitchless-measure"))
		{
			MeasureSeconds = FCString::Atod(*GlitchlessText::Tchar(*Seconds));
			MeasureSeconds = MeasureSeconds > 0 ? MeasureSeconds : 5;
			MeasureWarmup = FMath::Max(0.0, FCString::Atod(*GlitchlessText::Tchar(Core->FlagValue("glitchless-warmup").value_or("0"))));
		}
	}
	RegisterInput();
	if (!GIsEditor)
	{
		InstallSignalHandlers();
	}
}

FGlitchlessRuntime::~FGlitchlessRuntime()
{
	if (GLog && LogDevice)
	{
		GLog->RemoveOutputDevice(LogDevice.Get());
	}
	FCoreDelegates::OnBeginFrame.RemoveAll(this);
	FCoreDelegates::OnEnginePreExit.RemoveAll(this);
	FCoreDelegates::ApplicationWillEnterBackgroundDelegate.RemoveAll(this);
	FCoreDelegates::ApplicationHasEnteredForegroundDelegate.RemoveAll(this);
	FCoreDelegates::OnEnsureFailed.Remove(EnsureHandle);
	FCoreDelegates::OnHandleSystemError.Remove(SystemErrorHandle);
#if PLATFORM_WINDOWS
	if (GlitchlessWindows::Handler)
	{
		::RemoveVectoredExceptionHandler(GlitchlessWindows::Handler);
		GlitchlessWindows::Handler = nullptr;
	}
#endif
	FCoreUObjectDelegates::GetPreGarbageCollectDelegate().RemoveAll(this);
	FCoreUObjectDelegates::GetPostGarbageCollect().RemoveAll(this);
	FCoreUObjectDelegates::PreLoadMap.RemoveAll(this);
	FCoreUObjectDelegates::PostLoadMapWithWorld.RemoveAll(this);
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
	PRAGMA_DISABLE_DEPRECATION_WARNINGS
	FCoreUObjectDelegates::OnPackageLoadCompleted.RemoveAll(this);
	PRAGMA_ENABLE_DEPRECATION_WARNINGS
#endif
	FWorldDelegates::LevelAddedToWorld.RemoveAll(this);
	FBlueprintCoreDelegates::OnScriptException.RemoveAll(this);
	if (FSlateApplication::IsInitialized())
	{
		FSlateApplication::Get().OnApplicationActivationStateChanged().Remove(ActivationHandle);
		if (InputProcessor)
		{
			FSlateApplication::Get().UnregisterInputPreProcessor(InputProcessor);
		}
	}
	GlitchlessBugReport::CloseDialog();
	FScopeLock Lock(&Mutex);
	if (Core->Transport)
	{
		Core->Transport->Abort();
	}
	Core.Reset();
}

// ───────────────────────────── the game's calls ─────────────────────────────

void FGlitchlessRuntime::Init(const FGlitchlessOptions& Options)
{
	Glitchless::FOptions O;
	O.Service = GlitchlessText::Utf8(Options.Service);
	O.Version = GlitchlessText::Utf8(Options.Version);
	O.Env = GlitchlessText::Utf8(Options.Env);
	O.Intake = GlitchlessText::Utf8(Options.Intake);
	O.ClientToken = GlitchlessText::Utf8(Options.ClientToken);
	O.Privacy = Options.Privacy == EGlitchlessPrivacy::Full ? Glitchless::EPrivacy::Full : Options.Privacy == EGlitchlessPrivacy::Install ? Glitchless::EPrivacy::Install : Glitchless::EPrivacy::Anonymous;
	if (Options.Positions.IsSet())
	{
		O.Positions = Options.Positions.GetValue();
	}
	O.MapLevels = Options.bMapLevels;
	O.SendInDevelopmentBuilds = Options.bSendInDevelopmentBuilds;
	O.CaptureLogErrors = Options.bCaptureLogErrors;
	O.CaptureWarnings = Options.bCaptureWarnings;
	O.SampleRate = Options.SampleRate;
	if (Options.Enabled.IsSet())
	{
		O.Enabled = Options.Enabled.GetValue();
	}
	O.Debug = Options.bDebug;
	LogDevice->Configure(Options.bCaptureLogErrors, Options.bCaptureWarnings);
	With([&](Glitchless::FCore& C) {
		if (C.AppVersion.empty())
		{
			C.AppVersion = GlitchlessText::Utf8(GetDefault<UGeneralProjectSettings>()->ProjectVersion);
		}
		C.Init(O);
		if (C.IsEnabled())
		{
			UE_LOG(LogGlitchless, Log, TEXT("Glitchless %s: sending %s %s (%s) to %s"), FGlitchless::SdkVersion(), *GlitchlessText::Tchar(C.GetService()),
				*GlitchlessText::Tchar(C.GetVersion()), *GlitchlessText::Tchar(C.GetEnv()), *Options.Intake);
		}
	});
	bInitialized = true;
}

void FGlitchlessRuntime::InitFromSettings()
{
	const UGlitchlessSettings* Settings = GetDefault<UGlitchlessSettings>();
	if (!Settings || Settings->Service.IsEmpty())
	{
		UE_LOG(LogGlitchless, Verbose, TEXT("No service in Project Settings > Plugins > Glitchless: waiting for Init"));
		return;
	}
	Init(FGlitchlessOptions::FromSettings(*Settings));
}

void FGlitchlessRuntime::Shutdown(const FString& Reason)
{
	if (bShutDown)
	{
		return;
	}
	bShutDown = true;
	DrainErrors();
	With([&](Glitchless::FCore& C) { C.Shutdown(GlitchlessText::Utf8(Reason)); });
}

void FGlitchlessRuntime::WatchWorld(UWorld* World)
{
	if (!World || !World->IsGameWorld())
	{
		return;
	}
	if (WatchedWorld.IsValid() && WatchedWorld.Get() == World)
	{
		return;
	}
	WatchedWorld = World;
	WatchedMapHandle = NextMapHandle++;
	const std::string Name = GlitchlessText::Utf8(MapName(World));
	const int32 Handle = WatchedMapHandle;
	With([&](Glitchless::FCore& C) { C.OnMapLoaded(Name, Handle); });
	if (MeasureSeconds > 0 && MeasureStartAt <= 0)
	{
		MeasureStartAt = FPlatformTime::Seconds() + MeasureWarmup;
	}
}

void FGlitchlessRuntime::OnInput(const FString& Code)
{
	const std::string Name = GlitchlessText::Utf8(Code);
	With([&](Glitchless::FCore& C) { C.OnInput(Name); });
}

Glitchless::FValue FGlitchlessRuntime::MakeBugReport(const FString& Screenshot)
{
	const std::string Shot = GlitchlessText::Utf8(Screenshot);
	FValue Report;
	With([&](Glitchless::FCore& C) { Report = C.MakeBugReport(Shot); });
	return Report;
}

void FGlitchlessRuntime::SkipNextFrames(int32 Count)
{
	With([Count](Glitchless::FCore& C) { C.SkipNextFrames(Count); });
}

void FGlitchlessRuntime::SendBugReport(Glitchless::FValue Report, const FString& Note)
{
	const std::string N = GlitchlessText::Utf8(Note);
	With([&](Glitchless::FCore& C) { C.SendBugReport(std::move(Report), N); });
}

// ───────────────────────────── frames ─────────────────────────────

// Runs first thing each frame, on the game thread: everything measured since the last call belongs
// to the frame that just ended. Unreal's thread times for it were set while it drew.
void FGlitchlessRuntime::OnBeginFrame()
{
	if (!InputProcessor)
	{
		RegisterInput();
	}
	DrainErrors();

	const double Now = FPlatformTime::Seconds();
	const bool bRenders = FApp::CanEverRender() && GDynamicRHI != nullptr;
	Glitchless::FFrameCost Cost;
	Cost.Game = Ms(GGameThreadTime);
	if (bRenders)
	{
		Cost.Render = Ms(GRenderThreadTime);
		Cost.Rhi = IsRunningRHIInSeparateThread() ? Ms(GRHIThreadTime) : -1;
		Cost.Gpu = Ms(RHIGetGPUFrameCycles(0));
		// The RHI fills these only while its GPU profiler collects draw stats: 0 means not counted, not none drawn.
		Cost.Calls = GNumDrawCallsRHI[0] > 0 ? GNumDrawCallsRHI[0] : -1;
		Cost.Triangles = GNumDrawCallsRHI[0] > 0 ? GNumPrimitivesDrawnRHI[0] : -1;
	}
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
	// Pipeline states the renderer had to create on the spot, and that took over r.PSO.RuntimeCreationHitchThreshold (20 ms).
	const FPSORuntimeCreationStats Pso = PipelineStateCache::GetPSORuntimeCreationStats();
	const uint32 PsoHitches = Pso.GraphicsPSOHitches + Pso.ComputePSOHitches;
	Cost.PsoCompiles = PsoHitches >= LastPsoHitches ? PsoHitches - LastPsoHitches : PsoHitches;
	LastPsoHitches = PsoHitches;
#endif
#if WITH_EDITOR
	// The editor compiles shaders as they are first needed, and applies them on the game thread.
	if (GShaderCompilingManager)
	{
		const int32 Jobs = GShaderCompilingManager->GetNumRemainingJobs();
		Cost.ShaderCompiles = LastShaderJobs >= 0 ? FMath::Max(0, LastShaderJobs - Jobs) : 0;
		LastShaderJobs = Jobs;
	}
#endif
	// FlushAsyncLoading and LoadObject stop the game thread until the disk has answered.
	const uint32 Flushes = GFlushAsyncLoadingCount + GSyncLoadCount;
	Cost.AssetFlush = Flushes != LastLoadFlushes;
	LastLoadFlushes = Flushes;
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
	Cost.PackagesLoaded = PackagesLoaded;
#endif
	Cost.GcCollections = GcCount;
	Cost.GcMs = GcCount > 0 ? GcMs : -1;
	Cost.MapLoaded = bMapLoaded;
	Cost.LevelStreamed = bLevelStreamed;
	GcCount = 0;
	GcMs = 0;
	PackagesLoaded = 0;
	bMapLoaded = false;
	bLevelStreamed = false;

	const double Dt = (Now - LastFrameAt) * 1000.0;
	const bool bFirst = LastFrameAt <= 0;
	LastFrameAt = Now;
	if (bFirst)
	{
		// Nothing is measured until there is a last frame to time from, and the startup map loaded before that:
		// the first frame measured is that load's.
		bMapLoaded = Cost.MapLoaded;
		bLevelStreamed = Cost.LevelStreamed;
	}
	if (!bFirst && !bShutDown)
	{
		With([&](Glitchless::FCore& C) { C.Frame(Dt, Cost); });
	}
	CheckMeasure(Now);
}

void FGlitchlessRuntime::OnPreGarbageCollect()
{
	GcStartedAt = FPlatformTime::Seconds();
}

void FGlitchlessRuntime::OnPostGarbageCollect()
{
	GcCount++;
	if (GcStartedAt > 0)
	{
		GcMs += (FPlatformTime::Seconds() - GcStartedAt) * 1000.0;
	}
	GcStartedAt = 0;
}

bool FGlitchlessRuntime::IsWatched(const UWorld* World) const
{
	if (!World || !World->IsGameWorld())
	{
		return false;
	}
	// Play In Editor with several players: the first instance is the one measured.
	return !GIsEditor || !WatchedWorld.IsValid() || World->GetOutermost()->GetPIEInstanceID() == WatchedWorld->GetOutermost()->GetPIEInstanceID();
}

void FGlitchlessRuntime::OnPreLoadMap(const FString&)
{
	if (WatchedMapHandle > 0)
	{
		const int32 Handle = WatchedMapHandle;
		With([&](Glitchless::FCore& C) { C.OnMapUnloaded(Handle); });
		WatchedMapHandle = 0;
	}
}

void FGlitchlessRuntime::OnPostLoadMap(UWorld* World)
{
	if (!IsWatched(World))
	{
		return;
	}
	bMapLoaded = true;
	WatchedWorld = nullptr;
	WatchWorld(World);
}

void FGlitchlessRuntime::OnLevelAdded(ULevel* Level, UWorld* World)
{
	if (Level && World && Level != World->PersistentLevel && IsWatched(World))
	{
		bLevelStreamed = true;
	}
}

void FGlitchlessRuntime::OnPackageLoaded(UPackage*)
{
	PackagesLoaded++;
}

Glitchless::FValue FGlitchlessRuntime::SampleEngine() const
{
	FValue E = FValue::Object();
	E.Set("objects", static_cast<int64_t>(GUObjectArray.GetObjectArrayNumMinusAvailable()));
	if (const UWorld* World = WatchedWorld.Get())
	{
		E.Set("actors", static_cast<int64_t>(World->GetActorCount()));
	}
	const FPlatformMemoryStats Memory = FPlatformMemory::GetStats();
	E.Set("heap_mb", Glitchless::FSketch::Round(static_cast<double>(Memory.UsedPhysical) / (1024.0 * 1024.0), 1));
	if (FApp::CanEverRender() && GDynamicRHI)
	{
		FTextureMemoryStats Textures;
		RHIGetTextureMemoryStats(Textures);
		const double Bytes = static_cast<double>(Textures.StreamingMemorySize + Textures.NonStreamingMemorySize);
		if (Bytes > 0)
		{
			E.Set("texture_mb", Glitchless::FSketch::Round(Bytes / (1024.0 * 1024.0), 1));
		}
	}
	return E;
}

// ───────────────────────────── errors ─────────────────────────────

void FGlitchlessRuntime::DrainErrors()
{
	TArray<FGlitchlessOutputDevice::FEntry> Taken = LogDevice->Take();
	if (Taken.Num() == 0)
	{
		return;
	}
	With([&](Glitchless::FCore& C) {
		for (const FGlitchlessOutputDevice::FEntry& E : Taken)
		{
			C.ReportError(GlitchlessText::Utf8(E.Kind), GlitchlessText::Utf8(E.Message), GlitchlessText::Utf8(E.Stack), FValue(), false, GlitchlessText::Utf8(E.Fn));
		}
	});
}

// Any thread. The ensure's message and callstack wait for the game thread like a log line.
void FGlitchlessRuntime::OnEnsureFailed(const ANSICHAR* Expr, const ANSICHAR* File, int32 Line, const TCHAR* Msg, const TCHAR* CombinedErrorMsg)
{
	FString Message = FString::Printf(TEXT("Ensure condition failed: %hs"), Expr ? Expr : "");
	if (Msg && *Msg)
	{
		Message += TEXT(": ");
		Message += Msg;
	}
	FString Stack;
	const FString Combined = CombinedErrorMsg ? FString(CombinedErrorMsg) : FString();
	const int32 At = Combined.Find(TEXT("Stack:"));
	if (At != INDEX_NONE)
	{
		Stack = Combined.Mid(At + 6);
	}
	if (!Stack.Contains(TEXT("!")))
	{
		// No symbols to walk the stack with: the ensure's own place is the stack.
		Stack = FString::Printf(TEXT("UnknownFunction [%hs:%d]\n"), File ? File : "", Line);
	}
	LogDevice->Add(TEXT("ensure"), Message, Stack, FString());
}

// Game thread only. Accessed None, infinite loops, array errors: Unreal stops that Blueprint's
// execution there, so they count like an uncaught exception.
void FGlitchlessRuntime::OnScriptException(const UObject* Object, const FFrame& Frame, const FBlueprintExceptionInfo& Info)
{
	switch (Info.GetType())
	{
	case EBlueprintExceptionType::Breakpoint:
	case EBlueprintExceptionType::Tracepoint:
	case EBlueprintExceptionType::WireTracepoint:
		return;
	default:
		break;
	}
	if (bInitialized && !LogDevice->CapturesErrors())
	{
		return;
	}
	const FString Message = Info.GetDescription().ToString();
	FString Fn;
	if (Frame.Node)
	{
		Fn = Frame.Node->GetOuter() ? FString::Printf(TEXT("%s.%s"), *Frame.Node->GetOuter()->GetName(), *Frame.Node->GetName()) : Frame.Node->GetName();
	}
	FString Stack = FFrame::GetScriptCallstack(true);
	if (Stack.IsEmpty() && !Fn.IsEmpty())
	{
		Stack = Fn;
	}
	FValue Attrs = FValue::Object();
	if (Object)
	{
		Attrs.Set("blueprint", GlitchlessText::Utf8(Object->GetClass()->GetName()));
	}
	const std::string Kind = "script";
	const std::string M = GlitchlessText::Utf8(Message);
	const std::string S = GlitchlessText::Utf8(Stack);
	const std::string F = GlitchlessText::Utf8(Fn);
	With([&](Glitchless::FCore& C) { C.ReportError(Kind, M, S, Attrs, false, F); });
}

// The crash handler, on whichever thread crashed, maybe while the game thread is inside the core: it
// waits a moment for the core, writes the crash and the frames before it to the outbox, and leaves.
void FGlitchlessRuntime::OnSystemError()
{
	FGlitchlessRuntime* R = Instance;
	if (!R || R->bShutDown)
	{
		return;
	}
	std::string Message;
	std::string Stack;
	std::string Hist = GlitchlessText::Utf8(GErrorHist);
	std::string Description = GlitchlessText::Utf8(GErrorExceptionDescription);
	Glitchless::StackParser::DescribeCrash(Hist, Description, Message, Stack);
#if PLATFORM_WINDOWS
	if (Glitchless::StackParser::Parse(Stack).empty() && GlitchlessWindows::AddException(Hist, Description))
	{
		Glitchless::StackParser::DescribeCrash(Hist, Description, Message, Stack);
	}
#endif
	const FString Fatal = R->LogDevice->LastFatal();
	if (Message == "Crash" && !Fatal.IsEmpty())
	{
		Message = GlitchlessText::Utf8(Fatal);
	}
	ReportCrashNow(Message, Stack);
}

// The assert or fatal error has written its message and callstack to GErrorHist by now. A packaged
// game without CrashReportClient dies right after this without calling OnHandleSystemError.
void FGlitchlessRuntime::OnAppError()
{
#if PLATFORM_WINDOWS
	// Windows logs the line before it raises the assert, and then always calls OnHandleSystemError, which
	// finds the assert's callstack in the exception kept from it.
	return;
#else
	OnSystemError();
#endif
}

#if GLITCHLESS_SIGNALS
// Named, so the crash's stack shows where it came from and the parser leaves this frame out.
namespace GlitchlessSignals
{
	const int CrashSignals[] = {SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT, SIGTRAP};

	void SignalHandler(int Signal, siginfo_t* Info, void*)
	{
		static std::atomic<bool> bOnce{false};
		if (!bOnce.exchange(true))
		{
			FGlitchlessRuntime::OnSignal(Signal, Info ? Info->si_addr : nullptr);
		}
		// Then the crash goes on as it would have, and the OS writes its own report: a fault happens
		// again on return, an abort is raised again.
		signal(Signal, SIG_DFL);
		if (Signal == SIGABRT || Signal == SIGTRAP)
		{
			raise(Signal);
		}
	}
}
#endif

void FGlitchlessRuntime::InstallSignalHandlers()
{
#if PLATFORM_WINDOWS
	if (!GlitchlessWindows::Handler)
	{
		GlitchlessWindows::Handler = ::AddVectoredExceptionHandler(1, GlitchlessWindows::OnException);
	}
#endif
#if GLITCHLESS_SIGNALS
	for (const int Signal : GlitchlessSignals::CrashSignals)
	{
		struct sigaction Old;
		if (sigaction(Signal, nullptr, &Old) != 0 || Old.sa_handler != SIG_DFL)
		{
			continue; // the engine (with CrashReportClient), the editor or the game handles it already
		}
		struct sigaction Action;
		FMemory::Memzero(&Action, sizeof(Action));
		Action.sa_sigaction = GlitchlessSignals::SignalHandler;
		sigemptyset(&Action.sa_mask);
		Action.sa_flags = SA_SIGINFO | SA_ONSTACK;
		sigaction(Signal, &Action, nullptr);
	}
#endif
}

void FGlitchlessRuntime::OnSignal(int Signal, void* Address)
{
#if GLITCHLESS_SIGNALS
	char Message[160];
	switch (Signal)
	{
	case SIGSEGV: std::snprintf(Message, sizeof(Message), "SIGSEGV: invalid attempt to access memory at address %p", Address); break;
	case SIGBUS: std::snprintf(Message, sizeof(Message), "SIGBUS: invalid attempt to access memory at address %p", Address); break;
	case SIGILL: std::snprintf(Message, sizeof(Message), "SIGILL: illegal instruction"); break;
	case SIGFPE: std::snprintf(Message, sizeof(Message), "SIGFPE: arithmetic error"); break;
	case SIGABRT: std::snprintf(Message, sizeof(Message), "SIGABRT: abort() was called"); break;
	default: std::snprintf(Message, sizeof(Message), "Signal %d", Signal); break;
	}
	// This thread is the one that crashed, so its stack is the crash's.
	const SIZE_T Size = 65536;
	ANSICHAR* Trace = static_cast<ANSICHAR*>(FMemory::SystemMalloc(Size));
	std::string Stack;
	if (Trace)
	{
		Trace[0] = 0;
		FPlatformStackWalk::StackWalkAndDump(Trace, Size, 0);
		Stack = Trace;
		FMemory::SystemFree(Trace);
	}
	ReportCrashNow(Message, Stack);
#endif
}

void FGlitchlessRuntime::ReportCrashNow(const std::string& Message, const std::string& Stack)
{
	FGlitchlessRuntime* R = Instance;
	if (!R || R->bShutDown)
	{
		return;
	}
	bool bLocked = false;
	for (int32 Try = 0; Try < 60 && !bLocked; Try++)
	{
		bLocked = R->Mutex.TryLock();
		if (!bLocked)
		{
			FPlatformProcess::SleepNoStats(0.005f);
		}
	}
	if (!bLocked)
	{
		return;
	}
	R->bShutDown = true;
	// No logging from here, and on POSIX plain C file calls: the engine's log and file layers may be what broke.
#if GLITCHLESS_SIGNALS
	R->Core->Files = Glitchless::FFileSystem();
#endif
	R->Core->Log = nullptr;
	R->Core->ReportCrash("crash", Message, Stack);
	R->Mutex.Unlock();
}

// ───────────────────────────── lifecycle ─────────────────────────────

void FGlitchlessRuntime::RegisterInput()
{
	if (InputProcessor || !FSlateApplication::IsInitialized())
	{
		return;
	}
	InputProcessor = MakeShared<FGlitchlessInputProcessor>();
	FSlateApplication::Get().RegisterInputPreProcessor(InputProcessor);
	ActivationHandle = FSlateApplication::Get().OnApplicationActivationStateChanged().AddRaw(this, &FGlitchlessRuntime::OnActivationChanged);
}

// A desktop game losing focus: send what is waiting, and the gap until it is back is not a frame.
void FGlitchlessRuntime::OnActivationChanged(bool bActive)
{
	if (PLATFORM_IOS || PLATFORM_ANDROID)
	{
		return; // phones go through the background delegates
	}
	With([&](Glitchless::FCore& C) {
		C.SkipNextFrame();
		if (!bActive && C.IsInited())
		{
			C.Flush();
		}
	});
}

// A phone app in the background is usually never seen again, so the session ends there.
void FGlitchlessRuntime::OnEnterBackground()
{
	DrainErrors();
	With([](Glitchless::FCore& C) { C.OnBackground(); });
}

void FGlitchlessRuntime::OnEnterForeground()
{
	With([](Glitchless::FCore& C) { C.OnForeground(); });
}

void FGlitchlessRuntime::OnEnginePreExit()
{
	Shutdown(TEXT("quit"));
}

// ───────────────────────────── -glitchless-measure ─────────────────────────────

void FGlitchlessRuntime::CheckMeasure(double Now)
{
	if (MeasureSeconds <= 0 || bMeasureStarted)
	{
		return;
	}
	if (MeasureStartAt <= 0 && Now - GStartTime > 20)
	{
		MeasureStartAt = Now + MeasureWarmup; // no map loaded: measure whatever is on screen
	}
	if (MeasureStartAt <= 0 || Now < MeasureStartAt)
	{
		return;
	}
	bMeasureStarted = true;
	const double Seconds = MeasureSeconds;
	With([&](Glitchless::FCore& C) { C.Measure(Seconds, [this](const FValue& Result) { FinishMeasure(Result); }); });
}

void FGlitchlessRuntime::FinishMeasure(const Glitchless::FValue& Result)
{
	FValue Wrapped = FValue::Object();
	Wrapped.Set("glitchless_measure", Result);
	const std::string Line = Wrapped.Serialize();
	std::printf("%s\n", Line.c_str());
	std::fflush(stdout);
	const FString Text = GlitchlessText::Tchar(Line);
	UE_LOG(LogGlitchless, Display, TEXT("%s"), *Text);
	if (const std::optional<std::string> Out = Core->FlagValue("glitchless-out"))
	{
		if (!FFileHelper::SaveStringToFile(Text + TEXT("\n"), *GlitchlessText::Tchar(*Out), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
		{
			UE_LOG(LogGlitchless, Warning, TEXT("Could not write %s"), *GlitchlessText::Tchar(*Out));
		}
	}
	Shutdown(TEXT("measure"));
	FPlatformMisc::RequestExit(false, TEXT("Glitchless -glitchless-measure"));
}

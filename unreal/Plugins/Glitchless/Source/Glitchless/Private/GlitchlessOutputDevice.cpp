// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessOutputDevice.h"

#include "GlitchlessRuntime.h"

namespace
{
	constexpr int32 MaxPending = 100;

	// Categories reported some other way, or Glitchless's own.
	bool Skipped(const FName& Category)
	{
		static const FName Own(TEXT("LogGlitchless"));
		static const FName OutputDevice(TEXT("LogOutputDevice")); // ensure and script stack dumps: OnEnsureFailed has them
		static const FName Script(TEXT("LogScript")); // Blueprint runtime errors: OnScriptException has them
		static const FName ScriptCore(TEXT("LogScriptCore"));
		return Category == Own || Category == OutputDevice || Category == Script || Category == ScriptCore;
	}
}

void FGlitchlessOutputDevice::Configure(bool bInErrors, bool bInWarnings)
{
	FScopeLock Guard(&Lock);
	bErrors = bInErrors;
	bWarnings = bInWarnings;
}

void FGlitchlessOutputDevice::SetIntake(const FString& InIntake)
{
	FScopeLock Guard(&Lock);
	Intake = InIntake;
}

void FGlitchlessOutputDevice::Add(const FString& Kind, const FString& Message, const FString& Stack, const FString& Fn)
{
	FScopeLock Guard(&Lock);
	if (Pending.Num() < MaxPending)
	{
		Pending.Add(FEntry{Kind, Message, Stack, Fn});
	}
}

FString FGlitchlessOutputDevice::LastFatal()
{
	FScopeLock Guard(&Lock);
	return Fatal;
}

TArray<FGlitchlessOutputDevice::FEntry> FGlitchlessOutputDevice::Take()
{
	FScopeLock Guard(&Lock);
	TArray<FEntry> Taken = MoveTemp(Pending);
	Pending.Reset();
	return Taken;
}

void FGlitchlessOutputDevice::Serialize(const TCHAR* V, ELogVerbosity::Type Verbosity, const FName& Category)
{
	const ELogVerbosity::Type Level = static_cast<ELogVerbosity::Type>(Verbosity & ELogVerbosity::VerbosityMask);
	if (Level == ELogVerbosity::Fatal && V)
	{
		// A fatal error is a crash: the crash handler reports it, with its callstack, as the game dies.
		FScopeLock Guard(&Lock);
		Fatal = FString::Printf(TEXT("%s: %s"), *Category.ToString(), V);
		return;
	}
	if (Level > ELogVerbosity::Warning || !V || Skipped(Category))
	{
		return;
	}
	// Every platform's error device says this as an assert or a fatal error takes the game down.
	if (Level == ELogVerbosity::Error && FCString::Strncmp(V, TEXT("appError called:"), 16) == 0)
	{
		FGlitchlessRuntime::OnAppError();
		return;
	}
	const bool bWarning = Level == ELogVerbosity::Warning;
	{
		FScopeLock Guard(&Lock);
		if ((bWarning && !bWarnings) || (!bWarning && !bErrors) || Pending.Num() >= MaxPending)
		{
			return;
		}
		// The HTTP module's word on a request of Glitchless's own (a send or the health check that failed while
		// offline): every such line names the URL, which starts with the server's.
		if (!Intake.IsEmpty() && FCString::Strstr(V, *Intake))
		{
			return;
		}
	}
	Add(bWarning ? TEXT("warning") : TEXT("log_error"), FString(V), FString(), Category.ToString());
}

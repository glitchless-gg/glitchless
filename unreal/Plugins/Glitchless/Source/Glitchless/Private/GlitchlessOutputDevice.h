// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "HAL/CriticalSection.h"
#include "Misc/OutputDevice.h"

/**
 * Takes UE_LOG errors (and warnings, when asked) from GLog. Unreal logs from any thread, so a line is
 * only written down here; the game thread takes the list every frame. Ensures come in through the
 * same list. Nothing here may log: that would come straight back in. Lines that name the Glitchless server are
 * the HTTP module's word on the plugin's own requests (a failed send or health check while offline), not the game's.
 */
class FGlitchlessOutputDevice : public FOutputDevice
{
public:
	struct FEntry
	{
		FString Kind;
		FString Message;
		FString Stack;
		FString Fn;
	};

	void Configure(bool bInErrors, bool bInWarnings);
	/** The server the plugin sends to: a line that names it is about the plugin's own requests. */
	void SetIntake(const FString& InIntake);
	bool CapturesErrors() const { return bErrors; }
	/** Queues an error found elsewhere (an ensure), to be reported on the game thread. */
	void Add(const FString& Kind, const FString& Message, const FString& Stack, const FString& Fn);
	TArray<FEntry> Take();
	/** The last UE_LOG Fatal line: what a crash was about, should Unreal's error history be empty. */
	FString LastFatal();

	virtual void Serialize(const TCHAR* V, ELogVerbosity::Type Verbosity, const FName& Category) override;
	virtual bool CanBeUsedOnAnyThread() const override { return true; }
	virtual bool CanBeUsedOnMultipleThreads() const override { return true; }

private:
	FCriticalSection Lock;
	TArray<FEntry> Pending;
	FString Fatal;
	FString Intake;
	bool bErrors = true;
	bool bWarnings = false;
};

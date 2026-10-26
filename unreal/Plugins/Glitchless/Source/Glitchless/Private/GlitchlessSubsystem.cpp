// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessSubsystem.h"

#include "Glitchless.h"
#include "GlitchlessRuntime.h"

#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "Misc/CoreMisc.h"

bool UGlitchlessSubsystem::ShouldCreateSubsystem(UObject* Outer) const
{
	return !IsRunningCommandlet();
}

void UGlitchlessSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	DialogHandle = FGlitchless::OnBugReportDialog().AddWeakLambda(this, [this](bool bOpen) { OnBugReportDialog.Broadcast(bOpen); });
	if (GIsEditor)
	{
		// Play In Editor with a dedicated server in the editor's process: the players' instances are the ones measured.
		const FWorldContext* Context = GetGameInstance()->GetWorldContext();
		if (Context && Context->RunAsDedicated)
		{
			return;
		}
		// Play In Editor: the first instance owns the capture; more players' instances leave it alone.
		if (FGlitchlessRuntime::Get())
		{
			return;
		}
		bOwnsRuntime = true;
	}
	FGlitchlessRuntime& Runtime = FGlitchlessRuntime::Start();
	Runtime.InitFromSettings();
	// A packaged game's first map loads after this, and is seen loading. In Play In Editor the world is already there.
	if (GIsEditor)
	{
		Runtime.WatchWorld(GetGameInstance()->GetWorld());
	}
}

void UGlitchlessSubsystem::Deinitialize()
{
	FGlitchless::OnBugReportDialog().Remove(DialogHandle);
	if (bOwnsRuntime)
	{
		FGlitchlessRuntime::Stop(TEXT("quit"));
		bOwnsRuntime = false;
	}
	else if (!GIsEditor)
	{
		if (FGlitchlessRuntime* Runtime = FGlitchlessRuntime::Get())
		{
			Runtime->Shutdown(TEXT("quit"));
		}
	}
	Super::Deinitialize();
}

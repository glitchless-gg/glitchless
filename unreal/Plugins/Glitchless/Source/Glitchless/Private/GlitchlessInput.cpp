// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessInput.h"

#include "GlitchlessBugReport.h"
#include "GlitchlessRuntime.h"
#include "GlitchlessSettings.h"

#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Input/Events.h"
#include "UnrealClient.h"

namespace
{
	// In the editor only keys pressed in the game's viewport are the player's.
	bool ForTheGame()
	{
		if (!GIsEditor)
		{
			return true;
		}
		return GEngine && GEngine->GameViewport && GEngine->GameViewport->Viewport && GEngine->GameViewport->Viewport->HasFocus();
	}
}

bool FGlitchlessInputProcessor::HandleKeyDownEvent(FSlateApplication& SlateApp, const FKeyEvent& InKeyEvent)
{
	FGlitchlessRuntime* Runtime = FGlitchlessRuntime::Get();
	if (!Runtime || InKeyEvent.IsRepeat())
	{
		return false;
	}
	const FKey Key = InKeyEvent.GetKey();
	const FKey& BugReportKey = GetDefault<UGlitchlessSettings>()->BugReportKey;
	// With Glitchless turned off by the player the key opens nothing, so the game has it.
	if (BugReportKey.IsValid() && Key == BugReportKey && (GlitchlessBugReport::IsDialogOpen() || (ForTheGame() && !Runtime->IsTurnedOff())))
	{
		if (GlitchlessBugReport::IsDialogOpen())
		{
			GlitchlessBugReport::CloseDialog();
		}
		else
		{
			GlitchlessBugReport::ShowDialog();
		}
		return true;
	}
	if (GlitchlessBugReport::IsDialogOpen() || !ForTheGame())
	{
		return false;
	}
	Runtime->OnInput(Key.GetFName().ToString());
	return false;
}

bool FGlitchlessInputProcessor::HandleMouseButtonDownEvent(FSlateApplication& SlateApp, const FPointerEvent& MouseEvent)
{
	FGlitchlessRuntime* Runtime = FGlitchlessRuntime::Get();
	if (Runtime && !GlitchlessBugReport::IsDialogOpen() && ForTheGame())
	{
		Runtime->OnInput(TEXT("pointer"));
	}
	return false;
}

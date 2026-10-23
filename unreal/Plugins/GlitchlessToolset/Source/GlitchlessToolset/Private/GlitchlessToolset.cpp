// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessToolset.h"

#include "Glitchless.h"

#include "Editor.h"
#include "Modules/ModuleManager.h"
#include "ToolsetRegistry/ToolCallAsyncResultString.h"
#include "UObject/StrongObjectPtr.h"

namespace
{
	bool IsPlaying()
	{
		return GEditor && GEditor->PlayWorld != nullptr && FGlitchless::GetLiveJson() != TEXT("null");
	}

	const TCHAR* NotPlaying = TEXT("The game isn't playing in the editor: start Play In Editor (PIE) first. Glitchless runs only while the game plays.");
}

FString UGlitchlessToolset::Status()
{
	if (!IsPlaying())
	{
		return FString::Printf(TEXT("{\"error\":\"%s\"}"), NotPlaying);
	}
	return FGlitchless::GetLiveJson();
}

UToolCallAsyncResultString* UGlitchlessToolset::Measure(float Seconds)
{
	UToolCallAsyncResultString* Result = NewObject<UToolCallAsyncResultString>();
	if (!IsPlaying())
	{
		Result->SetError(NotPlaying);
		return Result;
	}
	TStrongObjectPtr<UToolCallAsyncResultString> Pending(Result); // kept alive until the measure is done
	FGlitchless::Measure(FMath::Clamp(Seconds, 0.5f, 120.f), [Pending](const FString& Json) { Pending->SetValue(Json); });
	return Result;
}

IMPLEMENT_MODULE(FDefaultModuleImpl, GlitchlessToolset)

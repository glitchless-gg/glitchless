// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessToolset.h"

#include "Glitchless.h"

#include "Editor.h"
#include "Modules/ModuleManager.h"
#include "ToolsetRegistry/UToolsetRegistry.h"
#include "UObject/StrongObjectPtr.h"
#if UE_VERSION_OLDER_THAN(5, 9, 0)
#include "ToolsetRegistry/ToolCallAsyncResultString.h"
#endif

namespace
{
	bool IsPlaying()
	{
		return GEditor && GEditor->PlayWorld != nullptr && FGlitchless::GetLiveJson() != TEXT("null");
	}

	const TCHAR* NotPlaying = TEXT("The game isn't playing in the editor: start Play In Editor (PIE) first. Glitchless runs only while the game plays.");

	// Measure's result, by its name in this engine (GlitchlessToolset.h).
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 9, 0)
	using UMeasureResult = UAsyncFunctionResultString;
#else
	using UMeasureResult = UToolCallAsyncResultString;
#endif
}

FString UGlitchlessToolset::Status()
{
	if (!IsPlaying())
	{
		return FString::Printf(TEXT("{\"error\":\"%s\"}"), NotPlaying);
	}
	return FGlitchless::GetLiveJson();
}

UMeasureResult* UGlitchlessToolset::Measure(float Seconds)
{
	UMeasureResult* Result = NewObject<UMeasureResult>();
	if (!IsPlaying())
	{
		Result->SetError(NotPlaying);
		return Result;
	}
	TStrongObjectPtr<UMeasureResult> Pending(Result); // kept alive until the measure is done
	FGlitchless::Measure(FMath::Clamp(Seconds, 0.5f, 120.f), [Pending](const FString& Json) { Pending->SetValue(Json); });
	return Result;
}

// Unreal MCP lists a toolset only once it is registered with the Toolset Registry, which every engine toolset does as
// its module starts: neither 5.8 nor 5.9 finds toolset classes on its own, so without this the tools never showed.
class FGlitchlessToolsetModule : public IModuleInterface
{
	virtual void StartupModule() override
	{
		UToolsetRegistry::RegisterToolsetClass(UGlitchlessToolset::StaticClass());
	}

	virtual void ShutdownModule() override
	{
		if (UObjectInitialized())
		{
			UToolsetRegistry::UnregisterToolsetClass(UGlitchlessToolset::StaticClass());
		}
	}
};

IMPLEMENT_MODULE(FGlitchlessToolsetModule, GlitchlessToolset)

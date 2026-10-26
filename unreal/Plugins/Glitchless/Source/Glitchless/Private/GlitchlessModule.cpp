// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "Glitchless.h"
#include "GlitchlessRuntime.h"

#include "Misc/CoreMisc.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY(LogGlitchless);

/**
 * A packaged game (or -game) starts capturing as soon as the module loads, so the first frames and
 * errors are kept until Init says where to send them. A dedicated server starts too, as a server: its own
 * session, with its ticks and players (FGlitchlessRuntime). The editor starts only in Play In Editor (see
 * UGlitchlessSubsystem); cooks and commandlets never start.
 */
class FGlitchlessModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		if (!GIsEditor && !IsRunningCommandlet())
		{
			FGlitchlessRuntime::Start();
		}
	}

	virtual void ShutdownModule() override
	{
		FGlitchlessRuntime::Stop(TEXT("quit"));
	}
};

IMPLEMENT_MODULE(FGlitchlessModule, Glitchless)

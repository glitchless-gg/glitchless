// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "Core/GlitchlessCore.h"
#include "HAL/CriticalSection.h"

// UE 5.9's web target (Wasm). 5.8 doesn't define PLATFORM_WASM at all.
#if defined(PLATFORM_WASM) && PLATFORM_WASM
#define GLITCHLESS_WEB 1
#else
#define GLITCHLESS_WEB 0
#endif

#if GLITCHLESS_WEB

/**
 * Glitchless in a web build (UE 5.9's Wasm target), on top of Web/GlitchlessWebPage (the page: its fetch, facts and
 * events) and Core/GlitchlessPage (reading them as the browser SDK does):
 *  - batches go by the page's fetch, as text/plain, since Unreal's HTTP is off on the web (bUseNullHttp);
 *  - the device is the browser (Chrome, macOS, the GPU the page names), and session_start.engine names Unreal;
 *  - a page that isn't on the developer's machine is played by players, so a Development build sends there, and
 *    ?glitchless, ?glitchless-debug and ?glitchless-synthetic on the page's address are flags;
 *  - hidden, the page sends what waits and plays on, and holds the session's end to beacon if it goes (the
 *    runtime's TickWeb).
 * unreal/test/web.mjs runs the page layer and the core's rules in Chromium.
 */
namespace GlitchlessWeb
{
	/** Points the core at the page: its transport, device, engine, flags and the debug rule. Before Init. */
	void Configure(Glitchless::FCore& C, FCriticalSection* CoreLock);
	/** Runs the Done of requests that landed. Each frame, on the game thread. */
	void Poll();
}

#endif

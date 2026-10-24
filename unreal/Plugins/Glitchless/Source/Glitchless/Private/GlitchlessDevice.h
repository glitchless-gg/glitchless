// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "Core/GlitchlessJson.h"

#include <string>
#include <vector>

/**
 * What Glitchless says about the device in session_start.
 *
 * Anonymous and Install mode send only coarse facts that many thousands of devices share: the OS
 * name, a low / mid / high tier, the renderer and graphics API, the screen size, and whether it is a
 * Steam Deck. Full mode adds the model, OS version, GPU name, core count and memory. Never sent in any
 * mode: the computer's name, the user's name, or any hardware or advertising ID. PRIVACY.md lists
 * every field; keep the two in step.
 */
namespace GlitchlessDevice
{
	Glitchless::FValue Collect(bool bDetailed);
	FString OsName();
	bool IsSteamDeck();
	/** Where an iOS build was installed from: "app_store", "testflight", "development", or "" (can't tell, or not iOS). */
	const std::string& Distribution();
	std::vector<int> ScreenSize();
	std::vector<int> WindowSize();
}

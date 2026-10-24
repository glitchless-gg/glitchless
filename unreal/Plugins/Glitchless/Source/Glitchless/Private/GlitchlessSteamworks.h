// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "Core/GlitchlessJson.h"

/**
 * The game's Steam facts (Core/GlitchlessSteam.h), when it already uses Steamworks: only while Unreal's
 * SteamShared or OnlineSubsystemSteam module is loaded, from the steam_api library that module loaded. The plugin
 * links nothing of Steam's and never loads the library itself. Windows, Linux and Mac only.
 */
namespace GlitchlessSteamworks
{
	/** The facts, or an empty object: no Steam module, no library, or Steamworks not initialised yet. */
	Glitchless::FValue Read();
}

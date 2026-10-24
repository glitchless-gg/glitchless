// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "GlitchlessJson.h"

#include <cstdint>
#include <string>

namespace Glitchless
{
	/**
	 * Steam facts for session_start when the game already uses Steamworks (SPEC §4c): the Steam build and beta
	 * branch it runs, the Steam hardware (Steam Deck, Steam Machine, Steam Frame), Proton, Big Picture, the first
	 * controller's Steam Input type, Family Sharing, a timed trial and the game's Steam language.
	 *
	 * Read through Steam's flat C API (steam_api_flat.h), from the steam_api library the game has already loaded
	 * (GlitchlessSteamworks.cpp finds it), so the plugin links nothing of Steam's. A library without a call leaves
	 * that fact out. No Steam ID, owner or name is ever read. PRIVACY.md lists every field; keep the two in step.
	 */
	namespace Steam
	{
		/** The interfaces and functions the facts come from; null where the library has none. */
		struct FApi
		{
			/** From SteamAPI_SteamApps_v0xx(): null until SteamAPI_Init has run. Without it nothing is read. */
			void* Apps = nullptr;
			void* Utils = nullptr;
			void* Input = nullptr;
			int (*GetAppBuildId)(void* Apps) = nullptr;
			bool (*GetCurrentBetaName)(void* Apps, char* Name, int Size) = nullptr;
			bool (*BIsSubscribedFromFamilySharing)(void* Apps) = nullptr;
			bool (*BIsTimedTrial)(void* Apps, uint32_t* SecondsAllowed, uint32_t* SecondsPlayed) = nullptr;
			const char* (*GetCurrentGameLanguage)(void* Apps) = nullptr;
			/** ESteamHardwareType, SDK 1.65. */
			int (*IsRunningOnSteamHardware)(void* Utils) = nullptr;
			/** Deprecated in SDK 1.65 for IsRunningOnSteamHardware. */
			bool (*IsSteamRunningOnSteamDeck)(void* Utils) = nullptr;
			bool (*IsRunningUnderProton)(void* Utils) = nullptr;
			bool (*IsSteamInBigPictureMode)(void* Utils) = nullptr;
			/** Fills up to STEAM_INPUT_MAX_COUNT (16) handles; 0 until the game has called SteamInput()->Init. */
			int (*GetConnectedControllers)(void* Input, uint64_t* Handles) = nullptr;
			/** ESteamInputType. */
			int (*GetInputTypeForHandle)(void* Input, uint64_t Handle) = nullptr;
		};

		/** The facts the API answers, as an object; empty when Steamworks isn't initialised. */
		FValue Facts(const FApi& Api);

		/** Adds the facts to a session_start device: Steam hardware refines the plugin's own Steam Deck guess. */
		void AddTo(FValue& Device, const FValue& Facts);

		/** ESteamHardwareType → "none", "deck", "machine" or "frame". */
		std::string HardwareName(int Kind);

		/** ESteamInputType → the name every Glitchless SDK sends ("ps5", "steam_deck"…), "other" past the known ones. */
		std::string ControllerName(int Kind);
	}
}

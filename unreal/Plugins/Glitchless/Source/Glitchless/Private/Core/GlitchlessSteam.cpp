// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessSteam.h"

#include "GlitchlessText.h"

namespace Glitchless
{
	namespace Steam
	{
		namespace
		{
			const char* const Hardware[] = {"none", "deck", "machine", "frame"};
			const char* const Controllers[] = {
				"unknown", "steam_controller", "xbox_360", "xbox_one", "generic_xinput", "ps4", "apple_mfi", "android", "switch_joycon_pair",
				"switch_joycon_single", "switch_pro", "mobile_touch", "ps3", "ps5", "steam_deck", "steamos_handheld", "switch2_pro",
				"steam_controller_2026", "steam_frame_controllers",
			};
			constexpr int MaxControllers = 16; // STEAM_INPUT_MAX_COUNT

			void Word(FValue& Facts, const char* Key, const char* Value, size_t Max)
			{
				const std::string S = Text::Trim(Value ? Value : "");
				if (!S.empty())
				{
					Facts.Set(Key, Text::Truncate(S, Max));
				}
			}
		}

		std::string HardwareName(int Kind)
		{
			return Kind >= 0 && Kind < static_cast<int>(sizeof(Hardware) / sizeof(Hardware[0])) ? Hardware[Kind] : "none";
		}

		std::string ControllerName(int Kind)
		{
			return Kind >= 0 && Kind < static_cast<int>(sizeof(Controllers) / sizeof(Controllers[0])) ? Controllers[Kind] : "other";
		}

		FValue Facts(const FApi& Api)
		{
			FValue F = FValue::Object();
			if (!Api.Apps)
			{
				return F;
			}
			if (Api.GetAppBuildId)
			{
				const int Build = Api.GetAppBuildId(Api.Apps);
				if (Build > 0) // 0 outside a build downloaded from Steam
				{
					F.Set("steam_build", Build);
				}
			}
			if (Api.GetCurrentBetaName)
			{
				char Name[256] = {};
				const bool bBeta = Api.GetCurrentBetaName(Api.Apps, Name, sizeof(Name));
				Name[sizeof(Name) - 1] = 0;
				// false on the default branch, which Steam calls "public".
				const std::string Branch = bBeta ? Text::Trim(Name) : std::string();
				F.Set("steam_branch", Branch.empty() ? std::string("public") : Text::Truncate(Branch, 64));
			}
			if (Api.Utils && Api.IsRunningOnSteamHardware)
			{
				F.Set("steam_hardware", HardwareName(Api.IsRunningOnSteamHardware(Api.Utils)));
			}
			else if (Api.Utils && Api.IsSteamRunningOnSteamDeck)
			{
				F.Set("steam_hardware", Api.IsSteamRunningOnSteamDeck(Api.Utils) ? "deck" : "none");
			}
			if (Api.Utils && Api.IsRunningUnderProton)
			{
				F.Set("proton", Api.IsRunningUnderProton(Api.Utils));
			}
			if (Api.Utils && Api.IsSteamInBigPictureMode)
			{
				F.Set("big_picture", Api.IsSteamInBigPictureMode(Api.Utils));
			}
			if (Api.BIsSubscribedFromFamilySharing)
			{
				F.Set("family_shared", Api.BIsSubscribedFromFamilySharing(Api.Apps));
			}
			if (Api.BIsTimedTrial)
			{
				uint32_t Allowed = 0;
				uint32_t Played = 0;
				F.Set("timed_trial", Api.BIsTimedTrial(Api.Apps, &Allowed, &Played));
			}
			if (Api.Input && Api.GetConnectedControllers && Api.GetInputTypeForHandle)
			{
				uint64_t Handles[MaxControllers] = {};
				const int Count = Api.GetConnectedControllers(Api.Input, Handles);
				if (Count > 0)
				{
					F.Set("steam_controller", ControllerName(Api.GetInputTypeForHandle(Api.Input, Handles[0])));
				}
			}
			if (Api.GetCurrentGameLanguage)
			{
				Word(F, "steam_language", Api.GetCurrentGameLanguage(Api.Apps), 32);
			}
			return F;
		}

		void AddTo(FValue& Device, const FValue& Facts)
		{
			if (!Device.IsObject() || !Facts.IsObject())
			{
				return;
			}
			const std::vector<std::string>& Keys = Facts.GetKeys();
			for (size_t I = 0; I < Keys.size(); ++I)
			{
				Device.Set(Keys[I], Facts.ValueAt(I));
			}
			const FValue* Hw = Facts.Find("steam_hardware");
			if (Hw && Hw->IsString() && Hw->AsString() == "deck")
			{
				Device.Set("steam_deck", true);
				Device.Set("gpu_tier", "low");
			}
		}
	}
}

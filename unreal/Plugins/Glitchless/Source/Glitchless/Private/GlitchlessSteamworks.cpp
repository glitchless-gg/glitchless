// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessSteamworks.h"

#include "Core/GlitchlessSteam.h"

#include "Modules/ModuleManager.h"

#if PLATFORM_WINDOWS
#include "Windows/WindowsHWrapper.h"
#elif PLATFORM_LINUX || PLATFORM_MAC
#include <dlfcn.h>
#include <cstring>
#endif
#if PLATFORM_MAC
#include <mach-o/dyld.h>
#endif

namespace
{
#if PLATFORM_WINDOWS || PLATFORM_LINUX || PLATFORM_MAC
	/** The steam_api library, if it is already loaded: never loads it. */
	struct FSteamLibrary
	{
		void* Handle = nullptr;

		FSteamLibrary()
		{
#if PLATFORM_WINDOWS
			Handle = reinterpret_cast<void*>(::GetModuleHandleW(L"steam_api64.dll"));
#elif PLATFORM_LINUX
			Handle = dlopen("libsteam_api.so", RTLD_LAZY | RTLD_NOLOAD);
#else
			// SteamShared loads it by its full path, which a leaf name doesn't find: look for it among the loaded images.
			const uint32_t Count = _dyld_image_count();
			for (uint32_t I = 0; I < Count && !Handle; ++I)
			{
				const char* Name = _dyld_get_image_name(I);
				const size_t N = Name ? std::strlen(Name) : 0;
				static const char Leaf[] = "/libsteam_api.dylib";
				if (N >= sizeof(Leaf) - 1 && std::strcmp(Name + N - (sizeof(Leaf) - 1), Leaf) == 0)
				{
					Handle = dlopen(Name, RTLD_LAZY | RTLD_NOLOAD);
				}
			}
#endif
		}

		~FSteamLibrary()
		{
#if PLATFORM_LINUX || PLATFORM_MAC
			if (Handle)
			{
				dlclose(Handle); // RTLD_NOLOAD counted one more reference
			}
#endif
		}

		void* Symbol(const char* Name) const
		{
			if (!Handle)
			{
				return nullptr;
			}
#if PLATFORM_WINDOWS
			return reinterpret_cast<void*>(::GetProcAddress(static_cast<HMODULE>(Handle), Name));
#else
			return dlsym(Handle, Name);
#endif
		}

		template <typename T>
		void Get(T& Fn, const char* Name) const
		{
			Fn = reinterpret_cast<T>(Symbol(Name));
		}

		/** An interface from the newest accessor the library has: its flat functions are built for that version. */
		void* Interface(std::initializer_list<const char*> Accessors) const
		{
			for (const char* Name : Accessors)
			{
				if (void* (*Accessor)() = reinterpret_cast<void* (*)()>(Symbol(Name)))
				{
					return Accessor(); // null before SteamAPI_Init
				}
			}
			return nullptr;
		}
	};
#endif
}

namespace GlitchlessSteamworks
{
	Glitchless::FValue Read()
	{
#if PLATFORM_WINDOWS || PLATFORM_LINUX || PLATFORM_MAC
		FModuleManager& Modules = FModuleManager::Get();
		if (!Modules.IsModuleLoaded(TEXT("SteamShared")) && !Modules.IsModuleLoaded(TEXT("OnlineSubsystemSteam")))
		{
			return Glitchless::FValue::Object();
		}
		const FSteamLibrary Lib;
		Glitchless::Steam::FApi Api;
		// SDK 1.64 (Unreal 5.8's) has ISteamApps v009, ISteamUtils v010, ISteamInput v006; newer SDKs go up.
		Api.Apps = Lib.Interface({"SteamAPI_SteamApps_v010", "SteamAPI_SteamApps_v009", "SteamAPI_SteamApps_v008"});
		if (!Api.Apps)
		{
			return Glitchless::FValue::Object();
		}
		Api.Utils = Lib.Interface({"SteamAPI_SteamUtils_v012", "SteamAPI_SteamUtils_v011", "SteamAPI_SteamUtils_v010", "SteamAPI_SteamUtils_v009"});
		Api.Input = Lib.Interface({"SteamAPI_SteamInput_v007", "SteamAPI_SteamInput_v006", "SteamAPI_SteamInput_v005"});
		Lib.Get(Api.GetAppBuildId, "SteamAPI_ISteamApps_GetAppBuildId");
		Lib.Get(Api.GetCurrentBetaName, "SteamAPI_ISteamApps_GetCurrentBetaName");
		Lib.Get(Api.BIsSubscribedFromFamilySharing, "SteamAPI_ISteamApps_BIsSubscribedFromFamilySharing");
		Lib.Get(Api.BIsTimedTrial, "SteamAPI_ISteamApps_BIsTimedTrial");
		Lib.Get(Api.GetCurrentGameLanguage, "SteamAPI_ISteamApps_GetCurrentGameLanguage");
		Lib.Get(Api.IsRunningOnSteamHardware, "SteamAPI_ISteamUtils_IsRunningOnSteamHardware");
		Lib.Get(Api.IsSteamRunningOnSteamDeck, "SteamAPI_ISteamUtils_IsSteamRunningOnSteamDeck");
		Lib.Get(Api.IsRunningUnderProton, "SteamAPI_ISteamUtils_IsRunningUnderProton");
		Lib.Get(Api.IsSteamInBigPictureMode, "SteamAPI_ISteamUtils_IsSteamInBigPictureMode");
		Lib.Get(Api.GetConnectedControllers, "SteamAPI_ISteamInput_GetConnectedControllers");
		Lib.Get(Api.GetInputTypeForHandle, "SteamAPI_ISteamInput_GetInputTypeForHandle");
		return Glitchless::Steam::Facts(Api);
#else
		return Glitchless::FValue::Object();
#endif
	}
}

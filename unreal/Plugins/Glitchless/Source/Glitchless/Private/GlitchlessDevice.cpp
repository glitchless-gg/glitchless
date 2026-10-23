// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessDevice.h"

#include "Core/GlitchlessText.h"
#include "GlitchlessStrings.h"

#include "DynamicRHI.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Framework/Application/SlateApplication.h"
#include "GenericPlatform/GenericApplication.h"
#include "HAL/PlatformMemory.h"
#include "HAL/PlatformMisc.h"
#include "Misc/App.h"
#include "Misc/EngineVersion.h"
#include "RenderUtils.h"
#include "RHI.h"
#include "UnrealClient.h"

#include <cstdio>

namespace
{
	std::string ReadSmallFile(const char* Path)
	{
		std::string Out;
		if (std::FILE* F = std::fopen(Path, "rb"))
		{
			char Buf[2048];
			const size_t N = std::fread(Buf, 1, sizeof(Buf), F);
			Out.assign(Buf, N);
			std::fclose(F);
		}
		return Out;
	}

	// A Steam Deck running a Linux build reads /sys and /etc directly. A Windows build under Proton sees
	// the same files through Wine's Z: drive, and Steam's SteamDeck=1 either way.
	const Glitchless::DeviceFacts::FSteamDeckFacts& SteamDeckFacts()
	{
		static const Glitchless::DeviceFacts::FSteamDeckFacts Facts = []() {
			Glitchless::DeviceFacts::FSteamDeckFacts F;
			F.Env = GlitchlessText::Utf8(FPlatformMisc::GetEnvironmentVariable(TEXT("SteamDeck")));
#if PLATFORM_LINUX
			F.BoardVendor = ReadSmallFile("/sys/class/dmi/id/board_vendor");
			F.BoardName = ReadSmallFile("/sys/class/dmi/id/board_name");
			F.OsRelease = ReadSmallFile("/etc/os-release");
#elif PLATFORM_WINDOWS
			F.BoardVendor = ReadSmallFile("Z:/sys/class/dmi/id/board_vendor");
			F.BoardName = ReadSmallFile("Z:/sys/class/dmi/id/board_name");
			F.OsRelease = ReadSmallFile("Z:/etc/os-release");
#endif
			return F;
		}();
		return Facts;
	}

	FString RendererName()
	{
		if (!FApp::CanEverRender() || !GDynamicRHI)
		{
			return TEXT("null");
		}
		const EShaderPlatform Platform = GMaxRHIShaderPlatform;
		if (IsMobilePlatform(Platform))
		{
			return TEXT("mobile");
		}
		return IsForwardShadingEnabled(Platform) ? TEXT("forward") : TEXT("deferred");
	}
}

namespace GlitchlessDevice
{
	bool IsSteamDeck()
	{
		return Glitchless::DeviceFacts::IsSteamDeck(SteamDeckFacts());
	}

	FString OsName()
	{
		if (IsSteamDeck() && (Glitchless::DeviceFacts::IsSteamOS(SteamDeckFacts()) || !SteamDeckFacts().Env.empty()))
		{
			return TEXT("SteamOS");
		}
#if PLATFORM_WINDOWS
		return TEXT("Windows");
#elif PLATFORM_MAC
		return TEXT("macOS");
#elif PLATFORM_IOS
		return TEXT("iOS");
#elif PLATFORM_ANDROID
		return TEXT("Android");
#elif PLATFORM_LINUX
		return TEXT("Linux");
#else
		return FPlatformProperties::IniPlatformName();
#endif
	}

	std::vector<int> ScreenSize()
	{
		if (!FSlateApplication::IsInitialized())
		{
			return {};
		}
		FDisplayMetrics Metrics;
		FSlateApplication::Get().GetCachedDisplayMetrics(Metrics);
		if (Metrics.PrimaryDisplayWidth <= 0)
		{
			return {};
		}
		return {Metrics.PrimaryDisplayWidth, Metrics.PrimaryDisplayHeight};
	}

	std::vector<int> WindowSize()
	{
		if (!GEngine || !GEngine->GameViewport || !GEngine->GameViewport->Viewport)
		{
			return {};
		}
		const FIntPoint Size = GEngine->GameViewport->Viewport->GetSizeXY();
		return {Size.X, Size.Y};
	}

	Glitchless::FValue Collect(bool bDetailed)
	{
		const bool bMobile = PLATFORM_IOS || PLATFORM_ANDROID;
		const int32 Cores = FPlatformMisc::NumberOfCoresIncludingHyperthreads();
		const double MemoryGb = static_cast<double>(FPlatformMemory::GetConstants().TotalPhysical) / (1024.0 * 1024.0 * 1024.0);
		const std::string Tier = Glitchless::DeviceFacts::DeviceTier(Cores, MemoryGb);
		const bool bDeck = IsSteamDeck();
		const FString Adapter = GDynamicRHI ? GRHIAdapterName : FString();

		Glitchless::FValue D = Glitchless::FValue::Object();
		D.Set("browser", "Unreal"); // the runtime, in the field the dashboard groups by
		D.Set("browser_version", GlitchlessText::Utf8(FEngineVersion::Current().ToString(EVersionComponent::Patch)));
		D.Set("os", GlitchlessText::Utf8(OsName()));
		D.Set("mobile", bMobile);
		D.Set("device_tier", Tier);
		// Every phone GPU is "low" next to a desktop one, and so is a handheld's: their GPU tier is the device tier.
		D.Set("gpu_tier", bMobile ? Tier : bDeck ? std::string("low") : Glitchless::DeviceFacts::GpuTier(GlitchlessText::Utf8(Adapter)));
		D.Set("renderer", GlitchlessText::Utf8(RendererName()));
		D.Set("driver", GDynamicRHI ? GlitchlessText::Utf8(GDynamicRHI->GetName()) : std::string("null"));
		const std::vector<int> Screen = ScreenSize();
		if (Screen.size() == 2)
		{
			D.Set("screen", Glitchless::FValue::List({Screen[0], Screen[1]}));
		}
		else
		{
			D.Set("screen", Glitchless::FValue());
		}
		D.Set("dpr", Glitchless::FValue());
		const int32 Hz = bMobile ? FPlatformMisc::GetMaxRefreshRate() : 0;
		D.Set("refresh_hz", Hz > 0 ? Glitchless::FValue(Hz) : Glitchless::FValue());
		D.Set("steam_deck", bDeck);
		if (bDetailed)
		{
			const FString Model = bDeck ? GlitchlessText::Tchar(Glitchless::DeviceFacts::SteamDeckModel(SteamDeckFacts())) : FPlatformMisc::GetDeviceMakeAndModel();
			D.Set("model", GlitchlessText::Utf8(Model));
			D.Set("os_version", GlitchlessText::Utf8(FPlatformMisc::GetOSVersion()));
			D.Set("gpu", GlitchlessText::Utf8(Adapter));
			D.Set("gpu_vendor", GDynamicRHI ? GlitchlessText::Utf8(RHIVendorIdToString()) : std::string());
			D.Set("cores", Cores);
			D.Set("memory_gb", MemoryGb > 0 ? Glitchless::FValue(static_cast<int64_t>(FMath::RoundToInt(MemoryGb))) : Glitchless::FValue());
		}
		return D;
	}
}

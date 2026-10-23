// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
// What the engine-independent core can't test on its own: the Unreal side's gzip, JPEG, settings and
// device info, and the core itself built with Unreal's compiler flags.
//   UnrealEditor-Cmd GlitchlessTest.uproject -ExecCmds="Automation RunTests Glitchless; Quit" -unattended -nullrhi
// unreal/test/core.mjs runs the core's own tests, the JavaScript parity ones among them, without the engine.

#include "Glitchless.h"
#include "GlitchlessBugReport.h"
#include "GlitchlessDevice.h"
#include "GlitchlessSettings.h"
#include "GlitchlessStrings.h"
#include "Core/GlitchlessCore.h"

#include "Misc/AutomationTest.h"
#include "Misc/Base64.h"
#include "Misc/Compression.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	class FRecordingTransport : public Glitchless::ITransport
	{
	public:
		TArray<std::vector<uint8_t>> Bodies;

		virtual void Send(const std::string&, std::vector<uint8_t> Body, const std::string&, std::function<void(int64_t)> Done) override
		{
			Bodies.Add(Body);
			Done(202);
		}

		virtual int64_t SendNow(const std::string&, const std::vector<uint8_t>& Body, const std::string&, int) override
		{
			Bodies.Add(Body);
			return 202;
		}

		virtual void Abort() override {}
	};

	std::string Gunzip(const std::vector<uint8_t>& Body)
	{
		if (Body.size() < 18 || Body[0] != 0x1f || Body[1] != 0x8b)
		{
			return std::string(Body.begin(), Body.end());
		}
		// The gzip trailer ends with the uncompressed size.
		const uint32 Size = Body[Body.size() - 4] | (Body[Body.size() - 3] << 8) | (Body[Body.size() - 2] << 16) | (static_cast<uint32>(Body[Body.size() - 1]) << 24);
		std::string Out(Size, '\0');
		if (!FCompression::UncompressMemory(NAME_Gzip, Out.data(), static_cast<int32>(Size), Body.data(), static_cast<int32>(Body.size())))
		{
			return std::string();
		}
		return Out;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGlitchlessGzipTest, "Glitchless.Transport.GzippedBatchesReadBack", EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGlitchlessGzipTest::RunTest(const FString& Parameters)
{
	TSharedPtr<FRecordingTransport> Transport = MakeShared<FRecordingTransport>();
	Glitchless::FCore Core;
	std::shared_ptr<FRecordingTransport> Shared(Transport.Get(), [Keep = Transport](FRecordingTransport*) {});
	Core.Transport = Shared;
	Core.Gzip = [](const std::string& In, std::vector<uint8_t>& Out) {
		int32 Size = FCompression::CompressMemoryBound(NAME_Gzip, static_cast<int32>(In.size()));
		Out.resize(Size);
		if (!FCompression::CompressMemory(NAME_Gzip, Out.data(), Size, In.data(), static_cast<int32>(In.size())))
		{
			return false;
		}
		Out.resize(Size);
		return true;
	};
	Glitchless::FOptions Options;
	Options.Service = "gzip-test";
	Options.Intake = "http://127.0.0.1:1";
	Core.Init(Options);
	for (int32 I = 0; I < 60; I++)
	{
		Glitchless::FValue Attrs = Glitchless::FValue::Object();
		Attrs.Set("n", I);
		Core.Track("bone_collected", Attrs);
	}
	Core.Flush();
	if (!TestEqual(TEXT("one batch sent"), Transport->Bodies.Num(), 1))
	{
		return false;
	}
	const std::vector<uint8_t>& Body = Transport->Bodies[0];
	TestTrue(TEXT("the batch is gzip"), Body.size() > 2 && Body[0] == 0x1f && Body[1] == 0x8b);
	Glitchless::FValue Envelope;
	TestTrue(TEXT("it unpacks to JSON"), Glitchless::FValue::Parse(Gunzip(Body), Envelope));
	TestEqual(TEXT("sdk"), GlitchlessText::Tchar(Envelope.Find("sdk") ? Envelope.Find("sdk")->AsString() : ""), FString(TEXT("glitchless-unreal/0.1.0")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGlitchlessJpegTest, "Glitchless.BugReport.ScreenshotsAreSmallJpegs", EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGlitchlessJpegTest::RunTest(const FString& Parameters)
{
	const int32 Width = 2560;
	const int32 Height = 1440;
	TArray<FColor> Pixels;
	Pixels.SetNumUninitialized(Width * Height);
	for (int32 Y = 0; Y < Height; Y++)
	{
		for (int32 X = 0; X < Width; X++)
		{
			Pixels[Y * Width + X] = FColor(static_cast<uint8>(X * 255 / Width), static_cast<uint8>(Y * 255 / Height), static_cast<uint8>((X ^ Y) & 255), 0);
		}
	}
	int32 W = 0;
	int32 H = 0;
	const FString Url = GlitchlessBugReport::EncodeJpegDataUrl(Pixels, Width, Height, 200000, W, H);
	TestTrue(TEXT("a JPEG data URL"), Url.StartsWith(TEXT("data:image/jpeg;base64,/9j/")));
	TestTrue(TEXT("small enough for the server"), Url.Len() <= 200000);
	TestTrue(TEXT("made smaller, keeping its shape"), W <= 960 && W > 0 && FMath::Abs(static_cast<double>(W) / H - 16.0 / 9.0) < 0.01);
	TArray<FColor> Tall;
	Tall.Init(FColor(40, 90, 160, 255), 1170 * 2532);
	int32 TallW = 0;
	int32 TallH = 0;
	GlitchlessBugReport::EncodeJpegDataUrl(Tall, 1170, 2532, 200000, TallW, TallH);
	TestTrue(TEXT("a phone held upright is sized by its height"), TallH <= 960 && TallH > TallW);
	int32 TinyW = 0;
	int32 TinyH = 0;
	const FString Tiny = GlitchlessBugReport::EncodeJpegDataUrl(Pixels, Width, Height, 20000, TinyW, TinyH);
	TestTrue(TEXT("smaller still for a tighter limit"), Tiny.IsEmpty() || (Tiny.Len() <= 20000 && TinyW < W));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGlitchlessSettingsTest, "Glitchless.Settings.BecomeOptions", EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGlitchlessSettingsTest::RunTest(const FString& Parameters)
{
	UGlitchlessSettings* Settings = NewObject<UGlitchlessSettings>();
	Settings->Service = TEXT("my-game");
	Settings->Intake = TEXT("http://localhost:7777");
	Settings->Privacy = EGlitchlessPrivacy::Install;
	Settings->bEnabled = false;
	Settings->bPositions = true;
	const FGlitchlessOptions Options = FGlitchlessOptions::FromSettings(*Settings);
	TestEqual(TEXT("service"), Options.Service, FString(TEXT("my-game")));
	TestEqual(TEXT("privacy"), Options.Privacy, EGlitchlessPrivacy::Install);
	TestTrue(TEXT("off when the settings say off"), Options.Enabled.IsSet() && !Options.Enabled.GetValue());
	TestTrue(TEXT("positions"), Options.Positions.IsSet() && Options.Positions.GetValue());
	TestTrue(TEXT("development builds send by default"), Options.bSendInDevelopmentBuilds);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGlitchlessDeviceTest, "Glitchless.Device.CoarseUnlessDetailed", EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGlitchlessDeviceTest::RunTest(const FString& Parameters)
{
	const Glitchless::FValue Coarse = GlitchlessDevice::Collect(false);
	for (const char* Key : {"browser", "browser_version", "os", "mobile", "device_tier", "gpu_tier", "renderer", "driver", "steam_deck"})
	{
		TestTrue(FString::Printf(TEXT("has %hs"), Key), Coarse.Has(Key));
	}
	for (const char* Key : {"model", "os_version", "gpu", "gpu_vendor", "cores", "memory_gb"})
	{
		TestFalse(FString::Printf(TEXT("no %hs when coarse"), Key), Coarse.Has(Key));
	}
	TestEqual(TEXT("browser"), GlitchlessText::Tchar(Coarse.Find("browser")->AsString()), FString(TEXT("Unreal")));
	const Glitchless::FValue Detailed = GlitchlessDevice::Collect(true);
	TestTrue(TEXT("detailed has the core count"), Detailed.Has("cores") && Detailed.Find("cores")->AsInt() > 0);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGlitchlessCoreTest, "Glitchless.Core.FramesHitchesAndErrors", EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGlitchlessCoreTest::RunTest(const FString& Parameters)
{
	TSharedPtr<FRecordingTransport> Transport = MakeShared<FRecordingTransport>();
	double Now = 1000;
	Glitchless::FCore Core;
	Core.Transport = std::shared_ptr<FRecordingTransport>(Transport.Get(), [Keep = Transport](FRecordingTransport*) {});
	Core.Clock = [&Now]() { return Now; };
	Core.UnixNow = [&Now]() { return static_cast<int64_t>(1761000000000LL + static_cast<int64_t>(Now)); };
	Glitchless::FOptions Options;
	Options.Service = "core-test";
	Options.Intake = "http://127.0.0.1:1";
	Core.Init(Options);
	Core.OnMapLoaded("Arena", 1);
	Glitchless::FFrameCost Cost;
	Cost.Game = 4;
	Cost.Render = 3;
	for (int32 I = 0; I < 120; I++)
	{
		Now += 16.7;
		Core.Frame(16.7, Cost);
	}
	Glitchless::FFrameCost Slow = Cost;
	Slow.Game = 140;
	Slow.GcCollections = 1;
	Now += 150;
	Core.Frame(150, Slow);
	Core.ReportError("ensure", "Ensure condition failed: Health > 0", "[Callstack] 0x0000000100000000 MyGame!UHealth::Apply() [/Game/Source/Health.cpp:12]");
	Core.Flush();
	FString Sent;
	for (const std::vector<uint8_t>& Body : Transport->Bodies)
	{
		Sent += GlitchlessText::Tchar(std::string(Body.begin(), Body.end()));
	}
	TestTrue(TEXT("a frame window for the map's level"), Sent.Contains(TEXT("\"type\":\"frame_window\"")) && Sent.Contains(TEXT("\"level\":\"Arena\"")));
	TestTrue(TEXT("a hitch with its causes"), Sent.Contains(TEXT("\"causes\":[\"gc\",\"script\"]")));
	TestTrue(TEXT("the ensure, placed in the game's code"), Sent.Contains(TEXT("\"fn\":\"UHealth::Apply\"")));
	return true;
}

#endif

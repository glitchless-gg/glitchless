// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "Glitchless.h"

#include "GlitchlessBugReport.h"
#include "GlitchlessRuntime.h"
#include "GlitchlessStrings.h"

using Glitchless::FValue;

namespace
{
	template <typename TFn>
	void WithCore(TFn&& Fn)
	{
		if (FGlitchlessRuntime* Runtime = FGlitchlessRuntime::Get())
		{
			Runtime->With(Fn);
		}
	}

	// Unreal's centimetres with Z up, to the metres with y up that every other SDK sends, so heatmaps,
	// death hotspots and their 2 m bins read an Unreal game the same way.
	void ToWire(const FVector& Location, double& X, double& Y, double& Z)
	{
		X = Location.X / 100.0;
		Y = Location.Z / 100.0;
		Z = Location.Y / 100.0;
	}

	std::optional<std::string> LevelOrCurrent(const FString& Level)
	{
		return Level.IsEmpty() ? std::nullopt : std::optional<std::string>(GlitchlessText::Utf8(Level));
	}
}

FGlitchlessOptions FGlitchlessOptions::FromSettings(const UGlitchlessSettings& Settings)
{
	FGlitchlessOptions O;
	O.Service = Settings.Service;
	O.Intake = Settings.Intake;
	O.ClientToken = Settings.ClientToken;
	O.Version = Settings.Version;
	O.Env = Settings.Env;
	O.Privacy = Settings.Privacy;
	if (Settings.bPositions)
	{
		O.Positions = true;
	}
	O.bMapLevels = Settings.bMapLevels;
	O.bSendInDevelopmentBuilds = Settings.bSendInDevelopmentBuilds;
	O.bCaptureLogErrors = Settings.bCaptureLogErrors;
	O.bCaptureWarnings = Settings.bCaptureWarnings;
	O.SampleRate = Settings.SampleRate;
	if (!Settings.bEnabled)
	{
		O.Enabled = false;
	}
	O.bDebug = Settings.bDebug;
	return O;
}

const TCHAR* FGlitchless::SdkVersion()
{
	return TEXT("0.2.0");
}

void FGlitchless::Init(const FGlitchlessOptions& Options)
{
	if (FGlitchlessRuntime* Runtime = FGlitchlessRuntime::Get())
	{
		Runtime->Init(Options);
	}
}

void FGlitchless::Init(const FString& Service, const FString& Intake, const FString& ClientToken)
{
	FGlitchlessOptions Options;
	Options.Service = Service;
	Options.Intake = Intake;
	Options.ClientToken = ClientToken;
	Init(Options);
}

void FGlitchless::LevelStart(const FString& Level)
{
	const std::string L = GlitchlessText::Utf8(Level);
	WithCore([&](Glitchless::FCore& C) { C.LevelStart(L); });
}

void FGlitchless::LevelComplete(const FString& Level, TOptional<double> Score, TOptional<double> DurationSeconds)
{
	const std::optional<std::string> L = LevelOrCurrent(Level);
	const std::optional<double> S = Score.IsSet() ? std::optional<double>(Score.GetValue()) : std::nullopt;
	const std::optional<double> D = DurationSeconds.IsSet() ? std::optional<double>(DurationSeconds.GetValue()) : std::nullopt;
	WithCore([&](Glitchless::FCore& C) { C.LevelComplete(L, S, D); });
}

void FGlitchless::LevelFail(const FString& Level, const FString& Cause)
{
	const std::optional<std::string> L = LevelOrCurrent(Level);
	const std::string Why = GlitchlessText::Utf8(Cause);
	WithCore([&](Glitchless::FCore& C) { C.LevelFail(L, Why); });
}

void FGlitchless::LevelAbandon(const FString& Level)
{
	const std::optional<std::string> L = LevelOrCurrent(Level);
	WithCore([&](Glitchless::FCore& C) { C.LevelAbandon(L); });
}

void FGlitchless::Death(const FVector& Location, const FString& Cause)
{
	double X, Y, Z;
	ToWire(Location, X, Y, Z);
	const std::string Why = GlitchlessText::Utf8(Cause);
	WithCore([&](Glitchless::FCore& C) { C.Death(X, Y, Z, Why); });
}

void FGlitchless::Death(const FString& Cause)
{
	const std::string Why = GlitchlessText::Utf8(Cause);
	WithCore([&](Glitchless::FCore& C) { C.Death(std::nullopt, std::nullopt, std::nullopt, Why); });
}

void FGlitchless::Track(const FString& Name)
{
	Track(Name, TMap<FString, FString>());
}

void FGlitchless::Track(const FString& Name, const FString& What)
{
	TMap<FString, FString> Attributes;
	Attributes.Add(TEXT("what"), What);
	Track(Name, Attributes);
}

void FGlitchless::Track(const FString& Name, double What)
{
	TMap<FString, double> Numbers;
	Numbers.Add(TEXT("what"), What);
	Track(Name, TMap<FString, FString>(), Numbers);
}

void FGlitchless::Track(const FString& Name, const TMap<FString, FString>& Attributes, const TMap<FString, double>& Numbers)
{
	FValue Attrs = FValue::Object();
	for (const TPair<FString, FString>& A : Attributes)
	{
		Attrs.Set(GlitchlessText::Utf8(A.Key), GlitchlessText::Utf8(A.Value));
	}
	for (const TPair<FString, double>& N : Numbers)
	{
		Attrs.Set(GlitchlessText::Utf8(N.Key), N.Value);
	}
	const std::string N = GlitchlessText::Utf8(Name);
	WithCore([&](Glitchless::FCore& C) { C.Track(N, Attrs); });
}

void FGlitchless::SetContext(const FString& Key, double Value)
{
	const std::string K = GlitchlessText::Utf8(Key);
	WithCore([&](Glitchless::FCore& C) { C.SetContext(K, Value); });
}

void FGlitchless::SetPosition(const FVector& Location)
{
	double X, Y, Z;
	ToWire(Location, X, Y, Z);
	WithCore([&](Glitchless::FCore& C) { C.SetPosition(X, Y, Z); });
}

void FGlitchless::Error(const FString& Message, const TMap<FString, FString>& Attributes)
{
	FValue Attrs = FValue::Object();
	for (const TPair<FString, FString>& A : Attributes)
	{
		Attrs.Set(GlitchlessText::Utf8(A.Key), GlitchlessText::Utf8(A.Value));
	}
	const std::string M = GlitchlessText::Utf8(Message);
	WithCore([&](Glitchless::FCore& C) { C.ReportError("manual", M, "", Attrs, true); });
}

void FGlitchless::ReportBug(const FString& Note)
{
	GlitchlessBugReport::Report(Note);
}

void FGlitchless::ShowBugReportDialog()
{
	GlitchlessBugReport::ShowDialog();
}

TMulticastDelegate<void(bool bOpen)>& FGlitchless::OnBugReportDialog()
{
	static TMulticastDelegate<void(bool bOpen)> Event;
	return Event;
}

void FGlitchless::Measure(float Seconds, TFunction<void(const FString& Json)> Done)
{
	WithCore([&](Glitchless::FCore& C) {
		C.Measure(Seconds, [Done](const FValue& Result) {
			if (Done)
			{
				Done(GlitchlessText::Tchar(Result.Serialize()));
			}
		});
	});
}

void FGlitchless::Flush()
{
	WithCore([](Glitchless::FCore& C) { C.Flush(); });
}

bool FGlitchless::IsEnabled()
{
	bool bEnabled = false;
	WithCore([&](Glitchless::FCore& C) { bEnabled = C.IsEnabled(); });
	return bEnabled;
}

FString FGlitchless::GetSessionId()
{
	FString Id;
	WithCore([&](Glitchless::FCore& C) { Id = GlitchlessText::Tchar(C.GetSessionId()); });
	return Id;
}

FString FGlitchless::GetLiveJson()
{
	FString Json = TEXT("null");
	WithCore([&](Glitchless::FCore& C) { Json = GlitchlessText::Tchar(C.Live().Serialize()); });
	return Json;
}

FString FGlitchless::GetLevel()
{
	FString Level;
	WithCore([&](Glitchless::FCore& C) { Level = C.GetLevel() ? GlitchlessText::Tchar(*C.GetLevel()) : FString(); });
	return Level;
}

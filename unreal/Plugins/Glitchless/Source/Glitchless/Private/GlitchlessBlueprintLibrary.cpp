// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessBlueprintLibrary.h"

#include "Glitchless.h"

void UGlitchlessBlueprintLibrary::Init(const FString& Service, const FString& Intake, const FString& ClientToken, EGlitchlessPrivacy Privacy, const FString& Version)
{
	FGlitchlessOptions Options = FGlitchlessOptions::FromSettings(*GetDefault<UGlitchlessSettings>());
	Options.Service = Service;
	Options.Intake = Intake;
	Options.ClientToken = ClientToken;
	Options.Privacy = Privacy;
	Options.Version = Version;
	FGlitchless::Init(Options);
}

void UGlitchlessBlueprintLibrary::Track(const FString& Name, const TMap<FString, FString>& Attributes, const TMap<FString, float>& Numbers)
{
	TMap<FString, double> Doubles;
	for (const TPair<FString, float>& N : Numbers)
	{
		Doubles.Add(N.Key, N.Value);
	}
	FGlitchless::Track(Name, Attributes, Doubles);
}

void UGlitchlessBlueprintLibrary::TrackWhat(const FString& Name, const FString& What)
{
	FGlitchless::Track(Name, What);
}

void UGlitchlessBlueprintLibrary::TrackAttributes(const FString& Name, const FGlitchlessAttributes& Attributes)
{
	FGlitchless::Track(Name, Attributes);
}

void UGlitchlessBlueprintLibrary::Count(const FString& Name, const FGlitchlessAttributes& Attributes, int32 N)
{
	FGlitchless::Count(Name, Attributes, N);
}

void UGlitchlessBlueprintLibrary::LevelStart(const FString& Level, const FGlitchlessAttributes& Attributes)
{
	FGlitchless::LevelStart(Level, Attributes);
}

void UGlitchlessBlueprintLibrary::SetProperty(const FString& Key, const FString& Value)
{
	FGlitchless::SetProperty(Key, Value);
}

void UGlitchlessBlueprintLibrary::SetPropertyNumber(const FString& Key, int64 Value)
{
	FGlitchless::SetProperty(Key, Value);
}

void UGlitchlessBlueprintLibrary::SetPropertyFlag(const FString& Key, bool Value)
{
	FGlitchless::SetProperty(Key, Value);
}

void UGlitchlessBlueprintLibrary::ClearProperty(const FString& Key)
{
	FGlitchless::ClearProperty(Key);
}

FString UGlitchlessBlueprintLibrary::SetGroup(EGlitchlessGroup Kind, const FString& Id, const FGlitchlessAttributes& Attributes)
{
	return FGlitchless::SetGroup(Kind, Id, Attributes);
}

void UGlitchlessBlueprintLibrary::ClearGroup(EGlitchlessGroup Kind)
{
	FGlitchless::ClearGroup(Kind);
}

void UGlitchlessBlueprintLibrary::SetZone(const FString& Zone)
{
	FGlitchless::SetZone(Zone);
}

void UGlitchlessBlueprintLibrary::NetSample(float RttMs, float LossPct, float JitterMs)
{
	FGlitchless::NetSample(RttMs, LossPct, JitterMs);
}

void UGlitchlessBlueprintLibrary::Disconnect(const FString& Reason)
{
	FGlitchless::Disconnect(Reason);
}

void UGlitchlessBlueprintLibrary::Reconnect()
{
	FGlitchless::Reconnect();
}

FGlitchlessAttributes UGlitchlessBlueprintLibrary::AddWord(const FGlitchlessAttributes& Attributes, const FString& Key, const FString& Value)
{
	FGlitchlessAttributes Out = Attributes;
	Out.Add(Key, Value);
	return Out;
}

FGlitchlessAttributes UGlitchlessBlueprintLibrary::AddNumber(const FGlitchlessAttributes& Attributes, const FString& Key, double Value)
{
	FGlitchlessAttributes Out = Attributes;
	Out.Add(Key, Value);
	return Out;
}

FGlitchlessAttributes UGlitchlessBlueprintLibrary::AddFlag(const FGlitchlessAttributes& Attributes, const FString& Key, bool Value)
{
	FGlitchlessAttributes Out = Attributes;
	Out.Add(Key, Value);
	return Out;
}

FGlitchlessAttributes UGlitchlessBlueprintLibrary::AddList(const FGlitchlessAttributes& Attributes, const FString& Key, const TArray<FString>& Value)
{
	FGlitchlessAttributes Out = Attributes;
	Out.Add(Key, Value);
	return Out;
}

void UGlitchlessBlueprintLibrary::LevelComplete(const FString& Level, float Score)
{
	FGlitchless::LevelComplete(Level, Score >= 0 ? TOptional<double>(Score) : TOptional<double>());
}

void UGlitchlessBlueprintLibrary::LevelFail(const FString& Level, const FString& Cause)
{
	FGlitchless::LevelFail(Level, Cause);
}

void UGlitchlessBlueprintLibrary::LevelAbandon(const FString& Level)
{
	FGlitchless::LevelAbandon(Level);
}

void UGlitchlessBlueprintLibrary::Death(FVector Location, const FString& Cause)
{
	FGlitchless::Death(Location, Cause);
}

void UGlitchlessBlueprintLibrary::SetContext(const FString& Key, float Value)
{
	FGlitchless::SetContext(Key, Value);
}

void UGlitchlessBlueprintLibrary::SetPosition(FVector Location)
{
	FGlitchless::SetPosition(Location);
}

void UGlitchlessBlueprintLibrary::Error(const FString& Message, const TMap<FString, FString>& Attributes)
{
	FGlitchless::Error(Message, Attributes);
}

void UGlitchlessBlueprintLibrary::ReportBug(const FString& Note)
{
	FGlitchless::ReportBug(Note);
}

void UGlitchlessBlueprintLibrary::ShowBugReportDialog()
{
	FGlitchless::ShowBugReportDialog();
}

void UGlitchlessBlueprintLibrary::Flush()
{
	FGlitchless::Flush();
}

bool UGlitchlessBlueprintLibrary::IsEnabled()
{
	return FGlitchless::IsEnabled();
}

FString UGlitchlessBlueprintLibrary::GetSessionId()
{
	return FGlitchless::GetSessionId();
}

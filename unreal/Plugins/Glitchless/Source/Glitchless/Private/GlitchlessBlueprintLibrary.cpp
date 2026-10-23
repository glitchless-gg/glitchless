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

void UGlitchlessBlueprintLibrary::LevelStart(const FString& Level)
{
	FGlitchless::LevelStart(Level);
}

void UGlitchlessBlueprintLibrary::LevelComplete(const FString& Level, float Score)
{
	FGlitchless::LevelComplete(Level, Score >= 0 ? TOptional<double>(Score) : TOptional<double>());
}

void UGlitchlessBlueprintLibrary::LevelFail(const FString& Level, const FString& Cause)
{
	FGlitchless::LevelFail(Level, Cause);
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

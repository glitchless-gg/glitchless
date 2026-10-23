// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessTransport.h"

#include "GlitchlessStrings.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "HttpManager.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"

FGlitchlessHttpTransport::FGlitchlessHttpTransport(FCriticalSection* InCoreLock)
	: CoreLock(InCoreLock)
{
}

TSharedRef<IHttpRequest, ESPMode::ThreadSafe> FGlitchlessHttpTransport::Make(const std::string& Url, TArray<uint8>&& Body, const std::string& ContentType, float TimeoutSeconds) const
{
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(GlitchlessText::Tchar(Url));
	Request->SetVerb(TEXT("POST"));
	// text/plain, as every Glitchless SDK sends it; the server spots gzip by its first bytes.
	Request->SetHeader(TEXT("Content-Type"), GlitchlessText::Tchar(ContentType));
	Request->SetContent(MoveTemp(Body));
	Request->SetTimeout(TimeoutSeconds);
	return Request;
}

void FGlitchlessHttpTransport::Send(const std::string& Url, std::vector<uint8_t> Body, const std::string& ContentType, std::function<void(int64_t)> Done)
{
	TArray<uint8> Bytes(Body.data(), static_cast<int32>(Body.size()));
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = Make(Url, MoveTemp(Bytes), ContentType, 10.f);
	FCriticalSection* Lock = CoreLock;
	TSharedRef<bool> Answered = MakeShared<bool>(false);
	Request->OnProcessRequestComplete().BindLambda([Lock, Answered, Done](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected) {
		const int64_t Status = bConnected && Response.IsValid() ? Response->GetResponseCode() : 0;
		FScopeLock Guard(Lock);
		*Answered = true;
		Done(Status);
	});
	Current = Request;
	CurrentAnswered = Answered;
	if (!Request->ProcessRequest())
	{
		Request->OnProcessRequestComplete().Unbind();
		Current.Reset();
		CurrentAnswered.Reset();
		FScopeLock Guard(Lock);
		Done(0);
	}
}

// The game is closing, and no frame will tick the HTTP manager again, so this does until the request has
// its answer. Answers come on the game thread by default, from that tick.
bool FGlitchlessHttpTransport::Wait(int TimeoutMs)
{
	const TSharedPtr<bool> Answered = CurrentAnswered;
	if (!Current.IsValid() || !Answered.IsValid())
	{
		return true;
	}
	const double End = FPlatformTime::Seconds() + TimeoutMs / 1000.0;
	while (!*Answered && FPlatformTime::Seconds() < End)
	{
		FHttpModule::Get().GetHttpManager().Tick(0.f);
		if (!*Answered)
		{
			FPlatformProcess::SleepNoStats(0.002f);
		}
	}
	return *Answered;
}

// The game is closing, so there are no more frames to finish a request on: wait here, up to the deadline.
int64_t FGlitchlessHttpTransport::SendNow(const std::string& Url, const std::vector<uint8_t>& Body, const std::string& ContentType, int TimeoutMs)
{
	TArray<uint8> Bytes(Body.data(), static_cast<int32>(Body.size()));
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = Make(Url, MoveTemp(Bytes), ContentType, FMath::Max(0.1f, TimeoutMs / 1000.f));
	Request->ProcessRequestUntilComplete();
	const FHttpResponsePtr Response = Request->GetResponse();
	return Request->GetStatus() == EHttpRequestStatus::Succeeded && Response.IsValid() ? Response->GetResponseCode() : 0;
}

void FGlitchlessHttpTransport::Abort()
{
	CurrentAnswered.Reset();
	if (TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> Request = MoveTemp(Current))
	{
		Request->OnProcessRequestComplete().Unbind();
		Request->CancelRequest();
	}
}

// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "Core/GlitchlessCore.h"
#include "HAL/CriticalSection.h"
#include "Interfaces/IHttpRequest.h"

/** Sends batches with FHttpModule. Answers come back on the game thread, with the core's lock held. */
class FGlitchlessHttpTransport : public Glitchless::ITransport
{
public:
	explicit FGlitchlessHttpTransport(FCriticalSection* InCoreLock);
	virtual ~FGlitchlessHttpTransport() override;

	virtual void Send(const std::string& Url, std::vector<uint8_t> Body, const std::string& ContentType, std::function<void(int64_t)> Done) override;
	virtual void Get(const std::string& Url, std::function<void(int64_t, const std::string&)> Done) override;
	virtual int64_t SendNow(const std::string& Url, const std::vector<uint8_t>& Body, const std::string& ContentType, int TimeoutMs) override;
	virtual void Abort() override;
	virtual bool Wait(int TimeoutMs) override;

private:
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Make(const std::string& Url, TArray<uint8>&& Body, const std::string& ContentType, float TimeoutSeconds) const;

	FCriticalSection* CoreLock;
	TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> Current;
	TSharedPtr<bool> CurrentAnswered; // set once Current's Done has run
	TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> Health; // the GET, never answered once the core is gone
};

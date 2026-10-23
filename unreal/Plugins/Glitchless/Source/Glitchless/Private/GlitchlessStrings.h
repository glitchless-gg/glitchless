// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"

#include <string>

/** Unreal strings to the core's UTF-8 and back. */
namespace GlitchlessText
{
	inline std::string Utf8(const TCHAR* S)
	{
		const auto Conv = StringCast<UTF8CHAR>(S);
		return std::string(reinterpret_cast<const char*>(Conv.Get()), Conv.Length());
	}

	inline std::string Utf8(const FString& S)
	{
		return Utf8(*S);
	}

	inline FString Tchar(const std::string& S)
	{
		const auto Conv = StringCast<TCHAR>(reinterpret_cast<const UTF8CHAR*>(S.data()), static_cast<int32>(S.size()));
		return FString(Conv.Length(), Conv.Get());
	}
}

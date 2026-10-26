// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "Core/GlitchlessJson.h"

struct FGlitchlessAttributes;

namespace GlitchlessAttributesJson
{
	/** Attributes as the core sends them: one JSON object, booleans as booleans and lists as arrays. */
	Glitchless::FValue Of(const FGlitchlessAttributes& Attributes);
}

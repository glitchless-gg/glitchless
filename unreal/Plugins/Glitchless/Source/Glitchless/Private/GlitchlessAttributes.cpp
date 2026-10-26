// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessAttributes.h"
#include "GlitchlessAttributesJson.h"

#include "GlitchlessStrings.h"

FGlitchlessAttributes& FGlitchlessAttributes::Add(const FString& Key, const FString& Value)
{
	Remove(Key);
	Strings.Add(Key, Value);
	return *this;
}

FGlitchlessAttributes& FGlitchlessAttributes::Add(const FString& Key, const TCHAR* Value)
{
	return Add(Key, FString(Value));
}

FGlitchlessAttributes& FGlitchlessAttributes::Add(const FString& Key, double Value)
{
	Remove(Key);
	Numbers.Add(Key, Value);
	return *this;
}

FGlitchlessAttributes& FGlitchlessAttributes::Add(const FString& Key, int32 Value)
{
	return Add(Key, static_cast<double>(Value));
}

FGlitchlessAttributes& FGlitchlessAttributes::Add(const FString& Key, int64 Value)
{
	return Add(Key, static_cast<double>(Value));
}

FGlitchlessAttributes& FGlitchlessAttributes::Add(const FString& Key, bool Value)
{
	Remove(Key);
	Flags.Add(Key, Value);
	return *this;
}

FGlitchlessAttributes& FGlitchlessAttributes::Add(const FString& Key, const TArray<FString>& Value)
{
	Remove(Key);
	Lists.Add(Key, FGlitchlessStringList(Value));
	return *this;
}

FGlitchlessAttributes& FGlitchlessAttributes::Remove(const FString& Key)
{
	Strings.Remove(Key);
	Numbers.Remove(Key);
	Flags.Remove(Key);
	Lists.Remove(Key);
	return *this;
}

int32 FGlitchlessAttributes::Num() const
{
	return Strings.Num() + Numbers.Num() + Flags.Num() + Lists.Num();
}

namespace GlitchlessAttributesJson
{
	// Words first, then flags (the two that say which count a Count is), then numbers and lists.
	Glitchless::FValue Of(const FGlitchlessAttributes& Attributes)
	{
		Glitchless::FValue Out = Glitchless::FValue::Object();
		for (const TPair<FString, FString>& A : Attributes.Strings)
		{
			Out.Set(GlitchlessText::Utf8(A.Key), GlitchlessText::Utf8(A.Value));
		}
		for (const TPair<FString, bool>& A : Attributes.Flags)
		{
			Out.Set(GlitchlessText::Utf8(A.Key), A.Value);
		}
		for (const TPair<FString, double>& A : Attributes.Numbers)
		{
			Out.Set(GlitchlessText::Utf8(A.Key), A.Value);
		}
		for (const TPair<FString, FGlitchlessStringList>& A : Attributes.Lists)
		{
			Glitchless::FValue List = Glitchless::FValue::Array();
			for (const FString& Item : A.Value.Items)
			{
				List.Push(GlitchlessText::Utf8(Item));
			}
			Out.Set(GlitchlessText::Utf8(A.Key), std::move(List));
		}
		return Out;
	}
}

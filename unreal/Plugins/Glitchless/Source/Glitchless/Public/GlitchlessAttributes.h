// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "GlitchlessAttributes.generated.h"

/** A list of words for one attribute, such as a deck, a build or the boons of a run. A Blueprint map can't hold an array, so a list is this. */
USTRUCT(BlueprintType)
struct GLITCHLESS_API FGlitchlessStringList
{
	GENERATED_BODY()

	FGlitchlessStringList() = default;
	FGlitchlessStringList(const TArray<FString>& InItems)
		: Items(InItems)
	{
	}

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Glitchless")
	TArray<FString> Items;
};

/**
 * What a game event, a count or a level attempt says about itself, in the game's own words: words, numbers, flags
 * (true or false: send an outcome as won = true, so boards can show a win rate) and lists (a deck, a build, items).
 * A key holds one value: adding it again replaces it. Never anything the player typed, and never a list of people.
 *
 *   FGlitchlessAttributes A;
 *   A.Add(TEXT("deck"), TArray<FString>{TEXT("hog_rider"), TEXT("fireball")});
 *   A.Add(TEXT("won"), true);
 *   A.Add(TEXT("duration_s"), 184.0);
 *   FGlitchless::Track(TEXT("battle_end"), A);
 */
USTRUCT(BlueprintType)
struct GLITCHLESS_API FGlitchlessAttributes
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Glitchless")
	TMap<FString, FString> Strings;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Glitchless")
	TMap<FString, double> Numbers;

	/** True or false: won, overtime, picked. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Glitchless")
	TMap<FString, bool> Flags;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Glitchless")
	TMap<FString, FGlitchlessStringList> Lists;

	FGlitchlessAttributes& Add(const FString& Key, const FString& Value);
	FGlitchlessAttributes& Add(const FString& Key, const TCHAR* Value);
	FGlitchlessAttributes& Add(const FString& Key, double Value);
	FGlitchlessAttributes& Add(const FString& Key, int32 Value);
	FGlitchlessAttributes& Add(const FString& Key, int64 Value);
	FGlitchlessAttributes& Add(const FString& Key, bool Value);
	FGlitchlessAttributes& Add(const FString& Key, const TArray<FString>& Value);
	FGlitchlessAttributes& Remove(const FString& Key);
	int32 Num() const;
	bool IsEmpty() const { return Num() == 0; }
};

/** The groups an event can belong to (FGlitchless::SetGroup). */
UENUM(BlueprintType)
enum class EGlitchlessGroup : uint8
{
	/** A match, lobby or battle: an ID the game's server made, shared by everyone in it. */
	Match,
	/** A party, from when it forms until it breaks up (never a guild, clan or friends list): an ID from the game's server. */
	Party,
	/** A run across levels (a roguelite's): the plugin makes its ID. */
	Run,
};

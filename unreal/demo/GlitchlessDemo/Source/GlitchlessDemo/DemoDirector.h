// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "DemoDirector.generated.h"

class AActor;
class UMaterialInterface;
class UStaticMesh;

/** One spark's state. PLANTED PROBLEM 2: a UObject per spark, made and dropped by the thousand. */
UCLASS()
class UDemoSpark : public UObject
{
	GENERATED_BODY()

public:
	UPROPERTY()
	FVector Velocity = FVector::ZeroVector;

	UPROPERTY()
	float Heat = 1;
};

/**
 * Plays the demo: two levels, each a short scripted scene, with three planted problems for Glitchless to find.
 *
 *   gallery  statues; fireworks at 6 s and 12 s. The first fireworks draw materials no frame has drawn yet, and
 *            with PSO precaching off (Config/DefaultEngine.ini) the frame waits while their pipeline states are
 *            created: a pso_compile hitch, once per run.
 *   forge    sparks every frame, each a UObject (UDemoSpark) kept half a second, so every garbage collection has
 *            about 900,000 to purge: a gc spike every 15 s. At 4 s it opens the forge's gate, which the
 *            level never placed: an ensure fires, once per run.
 *
 * It runs whenever the game does. -autoplay (a bot) quits after the forge; -demo-level=forge starts there (to
 * measure the sparks alone with -glitchless-measure); -demo-shots saves 1920 x 1080 screenshots of both levels
 * (Saved/Screenshots). The plugin itself handles -glitchless-measure.
 */
UCLASS()
class UDemoDirector : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

private:
	bool Tick(float DeltaTime);
	void OnMapLoaded(UWorld* World);
	void BuildGallery(UWorld* World);
	void BuildForge(UWorld* World);
	void Fireworks(UWorld* World, int32 Burst);
	void OpenForgeGate(UWorld* World);
	void Sparks(float DeltaTime);
	AActor* Shape(UWorld* World, UStaticMesh* Mesh, const FVector& Where, const FVector& Scale, UMaterialInterface* Material = nullptr);
	void LookAt(UWorld* World, const FVector& From, const FVector& To);
	void Shot(UWorld* World);

	FTSTicker::FDelegateHandle Ticker;
	FString Level;
	double LevelStartedAt = 0;
	int32 Step = 0;
	bool bAutoplay = false;
	bool bStartOnForge = false;
	bool bShots = false;
	int32 ShotsTaken = 0;
	bool bFinished = false;

	UPROPERTY()
	TArray<TObjectPtr<UMaterialInterface>> FireworkMaterials;

	UPROPERTY()
	TObjectPtr<AActor> Camera;

	/** The sparks alive now, and when each batch was made. Dropping a batch leaves its objects to the next GC. */
	UPROPERTY()
	TArray<TObjectPtr<UDemoSpark>> LiveSparks;
	TArray<TPair<double, int32>> SparkBatches;
};

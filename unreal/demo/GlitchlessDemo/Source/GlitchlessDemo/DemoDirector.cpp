// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "DemoDirector.h"

#include "Glitchless.h"

#include "Camera/CameraActor.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerController.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformTime.h"
#include "Kismet/GameplayStatics.h"
#include "Materials/MaterialInterface.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"

DEFINE_LOG_CATEGORY_STATIC(LogGlitchlessDemo, Log, All);

namespace
{
	const TCHAR* GalleryMap = TEXT("/Engine/Maps/Templates/Template_Default");
	const TCHAR* ForgeMap = TEXT("/Engine/Maps/Templates/TimeOfDay_Default");
	const TCHAR* FireworkPaths[] = {TEXT("/Game/Demo/M_Fireworks_A.M_Fireworks_A"), TEXT("/Game/Demo/M_Fireworks_B.M_Fireworks_B"), TEXT("/Game/Demo/M_Fireworks_C.M_Fireworks_C")};
	constexpr double GallerySeconds = 18;
	constexpr double ForgeSeconds = 48;
	// Sparks made each second on the forge, and how long each lives: with a collection every 15 s, each one finds
	// about 900,000 dropped sparks. UE 5.8 collects 150,000 in about 20 ms, inside a frame, and 600,000 in about
	// 55 ms, just over the 50 ms hitch line; 900,000 leaves room on a faster machine.
	constexpr double SparksPerSecond = 60000;
	constexpr double SparkLifeSeconds = 0.5;

	UStaticMesh* BasicShape(const TCHAR* Name)
	{
		return LoadObject<UStaticMesh>(nullptr, *FString::Printf(TEXT("/Engine/BasicShapes/%s.%s"), Name, Name));
	}
}

void UDemoDirector::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	bAutoplay = FParse::Param(FCommandLine::Get(), TEXT("autoplay"));
	FString First;
	bStartOnForge = FParse::Value(FCommandLine::Get(), TEXT("demo-level="), First) && First == TEXT("forge");
	bShots = FParse::Param(FCommandLine::Get(), TEXT("demo-shots"));
	// The game names its levels itself (bMapLevels=False in DefaultGame.ini). Each starts just before its map
	// loads, so the load's long frame belongs to the level it loads.
	Level = TEXT("gallery");
	FGlitchless::LevelStart(Level);
	FCoreUObjectDelegates::PostLoadMapWithWorld.AddUObject(this, &UDemoDirector::OnMapLoaded);
	Ticker = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateUObject(this, &UDemoDirector::Tick));
}

void UDemoDirector::Deinitialize()
{
	FCoreUObjectDelegates::PostLoadMapWithWorld.RemoveAll(this);
	FTSTicker::GetCoreTicker().RemoveTicker(Ticker);
	Super::Deinitialize();
}

void UDemoDirector::OnMapLoaded(UWorld* World)
{
	if (!World || World->WorldType != EWorldType::Game)
	{
		return;
	}
	LevelStartedAt = FPlatformTime::Seconds();
	Step = 0;
	Camera = nullptr;
	if (Level == TEXT("gallery"))
	{
		BuildGallery(World);
	}
	else
	{
		BuildForge(World);
	}
}

bool UDemoDirector::Tick(float DeltaTime)
{
	UWorld* World = GetGameInstance()->GetWorld();
	if (!World || LevelStartedAt <= 0 || bFinished)
	{
		return true;
	}
	const double T = FPlatformTime::Seconds() - LevelStartedAt;
	if (Camera)
	{
		if (APlayerController* PC = World->GetFirstPlayerController(); PC && PC->GetViewTarget() != Camera)
		{
			PC->SetViewTarget(Camera);
		}
	}
	if (Level == TEXT("gallery"))
	{
		if (bStartOnForge && Step == 0)
		{
			Step = 3; // straight to the forge
		}
		if (Step == 0 && T >= 6)
		{
			Step = 1;
			Fireworks(World, 1);
		}
		else if (Step == 1 && T >= 12)
		{
			Step = 2;
			Fireworks(World, 2); // the same materials again: no hitch this time
		}
		else if (bShots && ShotsTaken == 0 && T >= 12.6)
		{
			Shot(World);
		}
		else if ((Step == 2 && T >= GallerySeconds) || (Step == 3 && T >= 0.5))
		{
			Step = 4;
			if (!bStartOnForge)
			{
				FGlitchless::LevelComplete(FString(), 1200);
			}
			Level = TEXT("forge");
			FGlitchless::LevelStart(Level);
			UGameplayStatics::OpenLevel(World, ForgeMap);
		}
		return true;
	}

	Sparks(DeltaTime);
	if (bShots && ShotsTaken == 1 && T >= 6)
	{
		Shot(World);
	}
	if (Step == 0 && T >= 4)
	{
		Step = 1;
		FGlitchless::Track(TEXT("gate"), TEXT("forge"));
		OpenForgeGate(World);
	}
	else if (Step == 1 && T >= 20)
	{
		Step = 2;
		const FVector Lava(600, -200, 0);
		FGlitchless::SetPosition(Lava);
		FGlitchless::Death(Lava, TEXT("lava"));
		FGlitchless::Track(TEXT("respawn"));
	}
	else if (Step == 2 && T >= ForgeSeconds)
	{
		Step = 3;
		FGlitchless::LevelComplete(FString(), 800);
		if (bAutoplay)
		{
			bFinished = true;
			LiveSparks.Reset();
			FGlitchless::Flush();
			FPlatformMisc::RequestExit(false, TEXT("GlitchlessDemo autoplay"));
		}
	}
	return true;
}

// Statues in a ring, a pedestal and the camera. Everything here uses the engine's basic shape material, so the
// fireworks' materials are the first of their kind on screen.
void UDemoDirector::BuildGallery(UWorld* World)
{
	FireworkMaterials.Reset();
	for (const TCHAR* Path : FireworkPaths)
	{
		// Loaded with the map, not when the fireworks go off: loading isn't the problem planted here, drawing is.
		if (UMaterialInterface* M = LoadObject<UMaterialInterface>(nullptr, Path))
		{
			FireworkMaterials.Add(M);
		}
		else
		{
			UE_LOG(LogGlitchlessDemo, Warning, TEXT("%s is missing: run Scripts/make_content.py (unreal/demo/run.mjs does)"), Path);
		}
	}
	UStaticMesh* Cube = BasicShape(TEXT("Cube"));
	UStaticMesh* Cylinder = BasicShape(TEXT("Cylinder"));
	UStaticMesh* Cone = BasicShape(TEXT("Cone"));
	Shape(World, Cylinder, FVector(0, 0, 60), FVector(3, 3, 0.6));
	for (int32 I = 0; I < 8; I++)
	{
		const float A = I * PI / 4;
		const FVector At(FMath::Cos(A) * 900, FMath::Sin(A) * 900, 0);
		Shape(World, Cube, At + FVector(0, 0, 50), FVector(1, 1, 1));
		Shape(World, I % 2 ? Cone : Cylinder, At + FVector(0, 0, 170), FVector(0.6, 0.6, 1.4));
	}
	LookAt(World, FVector(-1700, 0, 650), FVector(0, 0, 250));
}

// The forge: an anvil and a furnace. No actor carries the tag "ForgeGate", which OpenForgeGate expects.
void UDemoDirector::BuildForge(UWorld* World)
{
	FGlitchless::SetContext(TEXT("fireworks"), 0);
	UStaticMesh* Cube = BasicShape(TEXT("Cube"));
	Shape(World, Cube, FVector(0, 0, 50), FVector(2, 1, 1));
	Shape(World, Cube, FVector(400, 300, 150), FVector(2, 2, 3));
	LookAt(World, FVector(-1200, -600, 500), FVector(0, 0, 100));
}

// PLANTED PROBLEM 1: three materials nobody has drawn yet, on 24 spheres at once.
void UDemoDirector::Fireworks(UWorld* World, int32 Burst)
{
	FGlitchless::Track(TEXT("fireworks"), Burst == 1 ? TEXT("first") : TEXT("again"));
	UStaticMesh* Sphere = BasicShape(TEXT("Sphere"));
	for (int32 I = 0; I < 24; I++)
	{
		const float A = I * PI / 12;
		const FVector At(FMath::Cos(A) * 450, FMath::Sin(A) * 450, 500 + 120 * Burst + (I % 3) * 90);
		UMaterialInterface* M = FireworkMaterials.Num() ? FireworkMaterials[I % FireworkMaterials.Num()].Get() : nullptr;
		if (AActor* S = Shape(World, Sphere, At, FVector(0.5), M))
		{
			S->SetLifeSpan(4);
		}
	}
	FGlitchless::SetContext(TEXT("fireworks"), 24);
}

// PLANTED PROBLEM 3: the gate is looked up by tag, and the forge never placed one. The ensure fires once a run.
void UDemoDirector::OpenForgeGate(UWorld* World)
{
	AActor* Gate = nullptr;
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		if (It->ActorHasTag(TEXT("ForgeGate")))
		{
			Gate = *It;
			break;
		}
	}
	if (ensureMsgf(Gate != nullptr, TEXT("The forge has no actor tagged ForgeGate")))
	{
		Gate->SetActorHiddenInGame(true);
	}
}

// PLANTED PROBLEM 2: a UObject per spark, 60,000 a second. Each batch lives half a second and is then dropped for
// garbage collection to find, so every collection purges about 900,000 of them. A struct array (or a Niagara
// system) would make no garbage at all.
void UDemoDirector::Sparks(float DeltaTime)
{
	const double Now = FPlatformTime::Seconds();
	int32 Expired = 0;
	while (SparkBatches.Num() && Now - SparkBatches[0].Key > SparkLifeSeconds)
	{
		Expired += SparkBatches[0].Value;
		SparkBatches.RemoveAt(0);
	}
	if (Expired)
	{
		LiveSparks.RemoveAt(0, FMath::Min(Expired, LiveSparks.Num()), EAllowShrinking::No);
	}
	const int32 Count = FMath::Clamp(FMath::RoundToInt32(SparksPerSecond * DeltaTime), 1, 6000);
	for (int32 I = 0; I < Count; I++)
	{
		UDemoSpark* S = NewObject<UDemoSpark>(GetTransientPackage());
		S->Velocity = FVector(FMath::FRandRange(-1.0, 1.0), FMath::FRandRange(-1.0, 1.0), FMath::FRand()) * 300.0;
		LiveSparks.Add(S);
	}
	SparkBatches.Emplace(Now, Count);
	FGlitchless::SetContext(TEXT("sparks"), LiveSparks.Num());
}

AActor* UDemoDirector::Shape(UWorld* World, UStaticMesh* Mesh, const FVector& Where, const FVector& Scale, UMaterialInterface* Material)
{
	if (!Mesh)
	{
		return nullptr;
	}
	FActorSpawnParameters P;
	P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	AStaticMeshActor* A = World->SpawnActor<AStaticMeshActor>(Where, FRotator::ZeroRotator, P);
	if (!A)
	{
		return nullptr;
	}
	A->SetMobility(EComponentMobility::Movable);
	UStaticMeshComponent* C = A->GetStaticMeshComponent();
	C->SetStaticMesh(Mesh);
	C->SetWorldScale3D(Scale);
	if (Material)
	{
		C->SetMaterial(0, Material);
		C->SetCastShadow(false);
	}
	return A;
}

// A 1920 x 1080 picture of the level, rendered apart from the window, into Saved/Screenshots.
void UDemoDirector::Shot(UWorld* World)
{
	ShotsTaken++;
	// Through the player controller, so the game viewport handles it (the engine's own Exec doesn't).
	if (APlayerController* PC = World->GetFirstPlayerController())
	{
		PC->ConsoleCommand(TEXT("HighResShot 1920x1080"));
	}
}

void UDemoDirector::LookAt(UWorld* World, const FVector& From, const FVector& To)
{
	FActorSpawnParameters P;
	P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	Camera = World->SpawnActor<ACameraActor>(From, (To - From).Rotation(), P);
}

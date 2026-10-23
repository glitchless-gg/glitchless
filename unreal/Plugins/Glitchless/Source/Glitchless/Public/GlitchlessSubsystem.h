// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "GlitchlessSubsystem.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGlitchlessBugReportDialogEvent, bool, bOpen);

/**
 * Starts Glitchless with the game: from Project Settings > Plugins > Glitchless when a service is set
 * there, so a game needs no code. In Play In Editor it also starts and stops the capture, so the
 * editor's own frames and errors are never sent.
 */
UCLASS()
class GLITCHLESS_API UGlitchlessSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual bool ShouldCreateSubsystem(UObject* Outer) const override;
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	/** True when the bug report box opens, false when it closes: pause the game here if it should. */
	UPROPERTY(BlueprintAssignable, Category = "Glitchless")
	FGlitchlessBugReportDialogEvent OnBugReportDialog;

private:
	FDelegateHandle DialogHandle;
	bool bOwnsRuntime = false;
};

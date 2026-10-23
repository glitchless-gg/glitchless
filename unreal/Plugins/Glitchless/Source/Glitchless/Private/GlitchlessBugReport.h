// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"

/**
 * Bug reports: a screenshot of the game viewport, made small and sent as a JPEG data URL with the
 * player's note, and a small box over the game for writing that note.
 */
namespace GlitchlessBugReport
{
	/** Encodes BGRA pixels as a JPEG data URL of at most MaxChars characters, its longer side at most 960 pixels, making it smaller until it fits. */
	FString EncodeJpegDataUrl(const TArray<FColor>& Pixels, int32 Width, int32 Height, int32 MaxChars, int32& OutWidth, int32& OutHeight);
	/** Takes the screenshot (at the end of the next frame: Unreal reads the viewport as it draws), then sends it with Note. */
	void Report(const FString& Note);
	/** Takes the screenshot, then opens the box over the game, holding the game's input back while it is open.
	 * Send (or Ctrl+Enter) reports it; Escape, Cancel or the bug report key again closes it. */
	void ShowDialog();
	void CloseDialog();
	bool IsDialogOpen();
}

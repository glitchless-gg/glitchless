// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "CoreMinimal.h"
#include "ToolsetRegistry/ToolsetDefinition.h"
#include "GlitchlessToolset.generated.h"

class UToolCallAsyncResultString;

/**
 * Glitchless for coding agents in the editor, through Unreal MCP: measure the game while it plays in
 * the editor, and read what Glitchless sees. Start Play In Editor first; Glitchless runs only there.
 *
 * Typical workflow, before and after changing the game:
 *   1. Start Play In Editor and bring the game to the place to measure.
 *   2. Measure(10): frame times, hitches with their causes, the threads' times, memory, new errors.
 *   3. Change the game, play the same way, Measure(10) again and compare.
 * Status() says at any time what Glitchless is sending, the last frame windows and hitches, and errors.
 */
UCLASS(BlueprintType, MinimalAPI)
class UGlitchlessToolset : public UToolsetDefinition
{
	GENERATED_BODY()

public:
	/** What Glitchless sees in the game playing in the editor, as JSON: whether it is sending and where
	 * (service, version, env, intake, session_id), the current level, stats (sent, failed, errors, hitches),
	 * the last frame windows ({ts, level, fps, p95}), the last hitches ({duration_ms, causes}), the game's
	 * gauges (ctx), UObject and actor counts and memory, and this session's errors grouped. Returns an error
	 * when the game isn't playing in the editor. */
	UFUNCTION(meta = (AICallable), Category = "Glitchless")
	static FString Status();

	/** Measures the game playing in the editor for the next Seconds (default 5, at most 120) and completes
	 * with the same JSON as the browser SDK's glitchless_measure: frames, fps, frame_ms {p50, p95, p99,
	 * worst}, pct_frames_over_budget, update_cpu_ms (game thread), render_cpu_ms, rhi_cpu_ms, gpu_ms,
	 * hitch_count and hitches with their causes (pso_compile, shader_compile, gc, map_load, level_stream,
	 * asset_load, script, render, frozen), draw_calls, peak_context, memory and memory_delta, new_errors.
	 * The editor's own frames count too, so compare runs made the same way rather than with shipping numbers.
	 * @param Seconds  How long to measure, in seconds. */
	UFUNCTION(meta = (AICallable), Category = "Glitchless")
	static UToolCallAsyncResultString* Measure(float Seconds = 5);
};

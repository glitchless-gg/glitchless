// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
using UnrealBuildTool;

public class GlitchlessDemo : ModuleRules
{
	public GlitchlessDemo(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "Glitchless" });
	}
}

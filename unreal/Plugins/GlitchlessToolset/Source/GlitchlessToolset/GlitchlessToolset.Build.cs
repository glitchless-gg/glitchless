// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
using UnrealBuildTool;

public class GlitchlessToolset : ModuleRules
{
	public GlitchlessToolset(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new string[] { "Glitchless", "ToolsetRegistry", "UnrealEd" });
	}
}

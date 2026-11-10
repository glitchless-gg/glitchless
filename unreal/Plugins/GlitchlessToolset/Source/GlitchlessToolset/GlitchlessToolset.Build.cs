// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
using UnrealBuildTool;

public class GlitchlessToolset : ModuleRules
{
	public GlitchlessToolset(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new string[] { "Glitchless", "ToolsetRegistry", "UnrealEd" });
		// UE 5.9 moved the async tool results (Measure's) out of ToolsetRegistry into an engine module of their own.
		if (Target.Version.MajorVersion > 5 || (Target.Version.MajorVersion == 5 && Target.Version.MinorVersion >= 9))
		{
			PrivateDependencyModuleNames.Add("AsyncFunctionResult");
		}
	}
}

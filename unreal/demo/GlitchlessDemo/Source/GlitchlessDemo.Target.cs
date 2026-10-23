// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
using UnrealBuildTool;

public class GlitchlessDemoTarget : TargetRules
{
	public GlitchlessDemoTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("GlitchlessDemo");
	}
}

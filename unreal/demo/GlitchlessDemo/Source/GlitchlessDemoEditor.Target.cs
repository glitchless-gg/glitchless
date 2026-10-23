// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
using UnrealBuildTool;

public class GlitchlessDemoEditorTarget : TargetRules
{
	public GlitchlessDemoEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("GlitchlessDemo");
	}
}

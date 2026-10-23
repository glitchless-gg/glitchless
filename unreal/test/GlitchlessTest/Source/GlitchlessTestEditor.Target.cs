using UnrealBuildTool;

public class GlitchlessTestEditorTarget : TargetRules
{
	public GlitchlessTestEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("GlitchlessTest");
	}
}

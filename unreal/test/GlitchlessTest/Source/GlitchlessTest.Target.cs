using UnrealBuildTool;

public class GlitchlessTestTarget : TargetRules
{
	public GlitchlessTestTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("GlitchlessTest");
	}
}

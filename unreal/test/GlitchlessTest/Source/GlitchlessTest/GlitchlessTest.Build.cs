using UnrealBuildTool;

public class GlitchlessTest : ModuleRules
{
	public GlitchlessTest(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "Glitchless", "Slate", "SlateCore", "InputCore" });
	}
}

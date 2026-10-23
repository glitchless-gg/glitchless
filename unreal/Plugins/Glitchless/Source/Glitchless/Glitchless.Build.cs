// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
using System.IO;
using UnrealBuildTool;

public class Glitchless : ModuleRules
{
	public Glitchless(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		// Private/Core is plain C++ that unreal/test also builds without the engine. Keeping it out of
		// unity files means engine headers never land in the middle of it.
		bUseUnity = false;

		// fdlibm's log, so the frame-time buckets match JavaScript's (Source/ThirdParty/fdlibm/README.md).
		PrivateIncludePaths.Add(Path.Combine(ModuleDirectory, "..", "ThirdParty", "fdlibm"));

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"DeveloperSettings",
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"ApplicationCore",
			"EngineSettings",
			"HTTP",
			"ImageWrapper",
			"InputCore",
			"RenderCore",
			"RHI",
			"Slate",
			"SlateCore",
		});
	}
}

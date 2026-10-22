using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

/// <summary>
/// Tooling for this dev project, not part of the package. It copies the package's Fetch! sample into
/// Assets, as the Package Manager's Import button does, makes the sample's scene, and builds a player
/// for unity/test/e2e.mjs. Run from the command line with -executeMethod, or from the Glitchless menu.
/// </summary>
public static class SampleBuilder
{
    const string PackageSample = "Packages/gg.glitchless.sdk/Samples~/Fetch";
    const string Imported = "Assets/Samples/Glitchless/Fetch";
    const string ScenePath = Imported + "/FetchBoot.unity";

    [MenuItem("Glitchless/Import the Fetch! sample")]
    public static void Import()
    {
        var dst = Path.GetFullPath(Imported);
        Directory.CreateDirectory(dst);
        foreach (var f in Directory.GetFiles(Path.GetFullPath(PackageSample)))
            if (!f.EndsWith(".DS_Store")) File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
    }

    // Makes FetchBoot.unity (one GameObject with FetchGame) and copies it back into the package, so the
    // sample ships the scene. Run once the imported scripts have compiled, so in a second -executeMethod.
    [MenuItem("Glitchless/Make the Fetch! scene")]
    public static void MakeScene()
    {
        var type = Type.GetType("GlitchlessSamples.Fetch.FetchGame, Assembly-CSharp") ?? throw new Exception("FetchGame isn't compiled yet: run SampleBuilder.Import first");
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        new GameObject("Fetch", type);
        EditorSceneManager.SaveScene(scene, ScenePath);
        foreach (var f in new[] { ScenePath, ScenePath + ".meta" }) File.Copy(Path.GetFullPath(f), Path.Combine(Path.GetFullPath(PackageSample), Path.GetFileName(f)), true);
    }

    // GLITCHLESS_BUILD_OUT: where the player goes (default Builds/Fetch.app); GLITCHLESS_BUILD_RELEASE=1 for a release build.
    public static void BuildPlayer()
    {
        var output = Environment.GetEnvironmentVariable("GLITCHLESS_BUILD_OUT") ?? "Builds/Fetch.app";
        var release = Environment.GetEnvironmentVariable("GLITCHLESS_BUILD_RELEASE") == "1";
        PlayerSettings.companyName = "Glitchless";
        PlayerSettings.productName = "Fetch";
        PlayerSettings.bundleVersion = "1.0.0";
        PlayerSettings.runInBackground = true;
        PlayerSettings.enableFrameTimingStats = true;
        PlayerSettings.fullScreenMode = FullScreenMode.Windowed;
        PlayerSettings.defaultScreenWidth = 960;
        PlayerSettings.defaultScreenHeight = 540;
        PlayerSettings.resizableWindow = true;
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { ScenePath },
            locationPathName = output,
            target = BuildTarget.StandaloneOSX,
            options = release ? BuildOptions.None : BuildOptions.Development,
        });
        Debug.Log($"[SampleBuilder] {report.summary.result}: {output} ({report.summary.totalErrors} errors)");
        if (Application.isBatchMode) EditorApplication.Exit(report.summary.result == BuildResult.Succeeded ? 0 : 1);
    }
}

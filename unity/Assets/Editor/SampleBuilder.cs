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

    // The WebGL player unity/test/map.mjs plays: an empty scene and Assets/MapProbe, which builds its two levels itself and
    // takes their maps (the GLITCHLESS_MAP_PROBE define), with an unlit material in Resources for its cubes in any pipeline
    // (made here each time, and not committed). Uncompressed, so any static server serves it. GLITCHLESS_BUILD_OUT: where
    // it goes (default Builds/map-probe).
    public static void BuildMapProbe()
    {
        var output = Environment.GetEnvironmentVariable("GLITCHLESS_BUILD_OUT") ?? "Builds/map-probe";
        const string scene = "Assets/MapProbe/MapProbe.unity";
        Directory.CreateDirectory("Assets/MapProbe/Resources");
        AssetDatabase.CreateAsset(new Material(Shader.Find("Unlit/Color")), "Assets/MapProbe/Resources/MapProbeUnlit.mat");
        EditorSceneManager.SaveScene(EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single), scene);
        var product = PlayerSettings.productName;
        PlayerSettings.companyName = "Glitchless";
        PlayerSettings.productName = "MapProbe";
        PlayerSettings.runInBackground = true;
        PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
        BuildReport report;
        try
        {
            report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { scene },
                locationPathName = output,
                target = BuildTarget.WebGL,
                options = BuildOptions.None,
                extraScriptingDefines = new[] { "GLITCHLESS_MAP_PROBE" },
            });
        }
        finally
        {
            PlayerSettings.productName = product;
        }
        Debug.Log($"[SampleBuilder] {report.summary.result}: {output} ({report.summary.totalErrors} errors)");
        if (Application.isBatchMode) EditorApplication.Exit(report.summary.result == BuildResult.Succeeded ? 0 : 1);
    }

    // The player unity/test/overhead.mjs runs: an empty scene and Assets/Overhead, which measures what the SDK costs the
    // main thread. A release build, under a product name of its own, so its saved files never meet Fetch's.
    // GLITCHLESS_BUILD_OUT: where it goes (default Builds/overhead/Overhead.app).
    public static void BuildOverhead()
    {
        var output = Environment.GetEnvironmentVariable("GLITCHLESS_BUILD_OUT") ?? "Builds/overhead/Overhead.app";
        const string scene = "Assets/Overhead/Overhead.unity"; // made here each time, and not committed
        EditorSceneManager.SaveScene(EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single), scene);
        var product = PlayerSettings.productName;
        PlayerSettings.companyName = "Glitchless";
        PlayerSettings.productName = "Overhead";
        PlayerSettings.runInBackground = true;
        BuildReport report;
        try
        {
            report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { scene },
                locationPathName = output,
                target = BuildTarget.StandaloneOSX,
                options = BuildOptions.None,
                extraScriptingDefines = new[] { "GLITCHLESS_OVERHEAD" },
            });
        }
        finally
        {
            PlayerSettings.productName = product;
        }
        Debug.Log($"[SampleBuilder] {report.summary.result}: {output} ({report.summary.totalErrors} errors)");
        if (Application.isBatchMode) EditorApplication.Exit(report.summary.result == BuildResult.Succeeded ? 0 : 1);
    }
}

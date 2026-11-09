// The Unity packages as another Editor would install them, for the tests that run a copy of unity/ in it
// (UNITY=/path/to/Unity node unity/test/e2e.mjs, and map.mjs).
//
// unity/ is saved by Unity 6.3, so its Packages/manifest.json names the packages that ship inside 6.3: test-framework
// 1.6.0, and modules such as vectorgraphics that Unity 6.0 doesn't have. A newer Editor upgrades them by itself; an
// older one can't resolve them. So in the copy, each package the lock file says came from inside the Editor takes this
// Editor's version (its Resources/PackageManager/Editor/manifest.json, the list Package Manager reads), and a built-in
// module the Editor lacks is left out, as a project made in that Editor would have it. Packages from the registry
// (Netcode for GameObjects) keep their version.
import fs from 'node:fs';
import path from 'node:path';

// name → version, from the Editor's own package list. unity is the Editor binary (…/Unity.app/Contents/MacOS/Unity).
export function editorPackages(unity) {
  const file = path.resolve(path.dirname(unity), '../Resources/PackageManager/Editor/manifest.json');
  if (!fs.existsSync(file)) return null;
  const listed = JSON.parse(fs.readFileSync(file, 'utf8')).packages || {};
  return Object.fromEntries(Object.entries(listed).map(([name, p]) => [name, p.version]));
}

// The Editor's version of one package (undefined when it doesn't list it).
export function editorVersionOf(unity, name) {
  return editorPackages(unity)?.[name];
}

// Rewrites project/Packages/manifest.json for the Editor at unity and drops the lock file, so the Editor resolves the
// rest again. Returns the changes, as "name a → b" lines, to print.
export function fitManifest(project, unity) {
  const packages = editorPackages(unity);
  if (!packages) return [];
  const file = path.join(project, 'Packages/manifest.json');
  const lockFile = path.join(project, 'Packages/packages-lock.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const locked = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')).dependencies || {} : {};
  const changes = [];
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (!name.startsWith('com.unity.modules.') && locked[name]?.source !== 'builtin') continue;
    const wanted = packages[name];
    if (wanted === undefined) {
      delete manifest.dependencies[name];
      changes.push(`${name} left out (not in this Editor)`);
    } else if (wanted !== version) {
      manifest.dependencies[name] = wanted;
      changes.push(`${name} ${version} → ${wanted}`);
    }
  }
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  fs.rmSync(lockFile, { force: true });
  return changes;
}

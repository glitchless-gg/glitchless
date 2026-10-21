import { Widget, CodeBlock } from '../components.jsx';
import { publicApiUrl } from '../api.js';

export function Setup() {
  const api = publicApiUrl();
  return (
    <div className="grid">
      <Widget span={7} title="1 · Add the SDK to a three.js game" sub="npm">
        <CodeBlock
          code={`npm install glitchless

import * as THREE from 'three';
import { Glitchless, instrumentThree } from 'glitchless';

const glitchless = Glitchless.init({
  service: 'my-game',
  version: '1.0.0',
  env: 'dev',
  intake: '${api}',
  clientToken: 'gl_pub_dev',
});
instrumentThree(glitchless, { renderer, scene, camera, THREE });`}
        />
        <div className="muted" style={{ margin: '10px 0 6px' }}>
          That's it for frame times, hitches with attribution, errors, WebGL context loss, GPU/device, load times, memory and the in-game overlay (press <code>`</code>). Then teach it your game:
        </div>
        <CodeBlock
          code={`glitchless.levelStart('level-1');
glitchless.death({ ...player.position, cause: 'fell' });
glitchless.levelComplete('level-1', { score });
glitchless.track('powerup', { kind: 'zoomies' });
glitchless.setPosition(player.position);           // every frame → heatmaps & replay
glitchless.setContext({ particles, enemies });     // gauges correlated with hitches
glitchless.captureMap('level-1', { axis: 'xy', bounds: { min: [0, -5], max: [200, 20] } });`}
        />
      </Widget>
      <Widget span={5} title="Or: one script tag" sub="for single-file vibe-coded games">
        <CodeBlock
          code={`<script src="${api}/sdk/glitchless.js"></script>
<script>
  const glitchless = Glitchless.init({ service: 'my-game', version: '1.0.0', intake: '${api}' });
  Glitchless.instrumentThree(glitchless, { renderer, scene, camera, THREE });
</script>`}
        />
        <div className="wt" style={{ margin: '14px 0 6px' }}>
          Or let your agent do it
        </div>
        <CodeBlock code={`/glitchless:instrument\n\n# or, without the plugin:\n"Add Glitchless observability to this three.js game:\n read packages/sdk/README.md and wire level, death\n and pickup events into glitchless.*"`} />
        <div className="wt" style={{ margin: '14px 0 6px' }}>
          Offline / no backend
        </div>
        <div className="muted">
          Omit <code>intake</code> and Glitchless runs as an in-game overlay + WebMCP tool server only. Nothing leaves the browser.
        </div>
      </Widget>
      <Widget span={12} title="Engines" sub="✅ works today; the others are next, on the same telemetry model">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {['three.js ✅', 'React Three Fiber ✅ (via three.js)', 'Godot 4.5+ ✅', 'Babylon.js', 'PlayCanvas', 'Phaser / Pixi (2D)'].map((e) => (
            <span key={e} className="tag" style={{ fontSize: 12, padding: '3px 8px' }}>
              {e}
            </span>
          ))}
        </div>
      </Widget>
    </div>
  );
}

// Writes src/gallery-06-agent.html from a demo run's real output (node unreal/demo/run.mjs writes both files):
// what glitchless_triage tells an agent about the demo, and the -glitchless-measure line the build printed.
//   node docs/release/fab/media/make-agent-page.mjs [dist/unreal-demo]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] || path.join(here, '../../../../dist/unreal-demo'));
const findings = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8'));
const measure = JSON.parse(fs.readFileSync(path.join(dir, 'measure.json'), 'utf8'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The triage list as the MCP tool prints it, then the first finding's advice.
const list = findings.slice(0, 4).map((f, i) => `${i + 1}. <span class="${f.severity === 'high' ? 'w' : 'k'}">[${f.severity.toUpperCase()}]</span> ${esc(cut(f.title, 86))}`).join('\n');
// The finding with the most pipeline-state hitches: the gallery's fireworks.
const pso = [...findings].sort((x, y) => (y.evidence?.hitch_causes?.pso_compile || 0) - (x.evidence?.hitch_causes?.pso_compile || 0))[0];
const advice = esc(cut(pso.suggestion.replace(/^Find the code[^.]*\.[^.]*\.\s*/, ''), 330));
// The fireworks' hitch if the measure caught it, else the first with a pipeline state in it.
const hitches = measure.hitches || [];
const hitch = hitches.find((h) => (h.recent || []).includes('fireworks') && (h.causes || []).includes('pso_compile')) || hitches.find((h) => (h.causes || []).includes('pso_compile')) || hitches[0] || {};
const json = [
  `"frame_ms": {"p50": ${measure.frame_ms?.p50}, "p95": ${measure.frame_ms?.p95}, "worst": ${measure.frame_ms?.worst}},`,
  `"fps": ${measure.fps}, "pct_frames_over_budget": ${measure.pct_frames_over_budget},`,
  `"hitches": [{"ms": ${hitch.ms}, "level": "${hitch.level}",`,
  `  "causes": ${JSON.stringify(hitch.causes || [])}, "recent": ${JSON.stringify(hitch.recent || [])}}, …]`,
].join('\n');

fs.writeFileSync(
  path.join(here, 'src/gallery-06-agent.html'),
  `<!doctype html>
<!-- Fab gallery image, 1920 x 1080: what a coding agent gets. Made by ../make-agent-page.mjs from a demo run's
     findings.json and measure.json; edit that script, not this file. -->
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&family=Outfit:wght@800&display=block" rel="stylesheet">
<link href="_gallery.css" rel="stylesheet">
<style>.cards { grid-template-rows: auto 1fr; } pre { font-size: 12px; }</style>
</head>
<body>
  <h1>Your coding agent <em>reads it too</em></h1>
  <div class="sub">The demo's findings over MCP, and the packaged build measuring itself: the numbers to beat after a fix.</div>
  <div class="brand"><img src="../../../../../assets/brand/glitchless/logo/png/glitchless-icon-128.png" alt="">Glitchless</div>
  <div class="cards">
    <div class="card">
      <h2>glitchless_triage · glitchless-unreal-demo</h2>
<pre>${list}

<span class="c">${esc(cut(pso.title, 80))}:</span>
${advice}</pre>
    </div>
    <div class="card">
      <h2>GlitchlessDemo -glitchless-warmup=1 -glitchless-measure=15</h2>
<pre><span class="c">{"glitchless_measure": {</span>
${esc(json)}
<span class="c">}}</span></pre>
    </div>
  </div>
</body>
</html>
`,
);
console.log('wrote', path.relative(process.cwd(), path.join(here, 'src/gallery-06-agent.html')));

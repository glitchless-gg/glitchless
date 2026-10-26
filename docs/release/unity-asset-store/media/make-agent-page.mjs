// Writes src/screenshot-06-agent.html from the Fetch! runs' real output: what glitchless_triage tells an agent
// (captures/findings.json, from capture-dashboard.mjs) and the line a build printed with --glitchless-measure
// (captures/measure.json).
//   node docs/release/unity-asset-store/media/make-agent-page.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const findings = JSON.parse(fs.readFileSync(path.join(here, 'captures/findings.json'), 'utf8'));
const raw = JSON.parse(fs.readFileSync(path.join(here, 'captures/measure.json'), 'utf8'));
const measure = raw.glitchless_measure ?? raw;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The triage list as the MCP tool prints it, then the advice for the finding with the most garbage-collection hitches
// (the confetti), or the first finding when none has any.
const list = findings.slice(0, 4).map((f, i) => `${i + 1}. <span class="${f.severity === 'high' ? 'w' : 'k'}">[${f.severity.toUpperCase()}]</span> ${esc(cut(f.title, 86))}`).join('\n');
const mostGc = [...findings].sort((x, y) => (y.evidence?.hitch_causes?.gc || 0) - (x.evidence?.hitch_causes?.gc || 0))[0];
const gc = mostGc?.evidence?.hitch_causes?.gc ? mostGc : findings[0];
const advice = esc(cut(String(gc.suggestion || '').replace(/^Find the code[^.]*\.[^.]*\.\s*/, ''), 330));
const hitches = measure.hitches || [];
const hitch = hitches.find((h) => (h.causes || []).includes('gc')) || hitches[0];
const json = [
  `"frame_ms": {"p50": ${measure.frame_ms?.p50}, "p95": ${measure.frame_ms?.p95}, "worst": ${measure.frame_ms?.worst}},`,
  `"fps": ${measure.fps}, "pct_frames_over_budget": ${measure.pct_frames_over_budget},`,
  ...(hitch
    ? [`"hitches": [{"ms": ${hitch.ms}, "level": "${hitch.level}",`, `  "causes": ${JSON.stringify(hitch.causes || [])}, "recent": ${JSON.stringify(hitch.recent || [])}}${hitches.length > 1 ? ', …' : ''}]`]
    : ['"hitches": []']),
].join('\n');

fs.writeFileSync(
  path.join(here, 'src/screenshot-06-agent.html'),
  `<!doctype html>
<!-- Asset Store screenshot, 1920 x 1080: what a coding agent gets. Made by ../make-agent-page.mjs from the Fetch!
     runs' findings.json and measure.json; edit that script, not this file. -->
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
  <div class="sub">The Fetch! sample's findings over MCP, and a build measuring itself: the numbers to beat after a fix.</div>
  <div class="brand"><img src="../../../../../assets/brand/glitchless/logo/png/glitchless-icon-128.png" alt="">Glitchless</div>
  <div class="cards">
    <div class="card">
      <h2>glitchless_triage · fetch-unity</h2>
<pre>${list}

<span class="c">${esc(cut(gc.title, 80))}:</span>
${advice}</pre>
    </div>
    <div class="card">
      <h2>Fetch --autoplay --glitchless-warmup=2 --glitchless-measure=12</h2>
<pre><span class="c">{"glitchless_measure": {</span>
${esc(json)}
<span class="c">}}</span></pre>
    </div>
  </div>
</body>
</html>
`,
);
console.log('wrote src/screenshot-06-agent.html');

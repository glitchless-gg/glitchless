import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Background, Voice, fadeIn } from '../components';
import { C, display, inter, mono } from '../theme';
import { sceneFrames, wordFrame } from '../voice';

// 2 · The agent finds it: two calls from Claude Code's real run (agent-beats.json, Oct 15 2026), large, in plain words.
// The run's own results: triage's top finding was "[CRITICAL] Frame-time spikes on level-2", and after two zoomies
// the live game counted 1,600 confetti meshes (800 a pickup, never removed). The tools were named gamedog_* then.
export const AGENT_FRAMES = sceneFrames('agent', 270);

type Call = { at: number; call: string; source: string; color: string; result: React.ReactNode; resultAt: number };
const CALLS: Call[] = [
  {
    at: wordFrame('agent', 'checked'),
    call: 'glitchless_triage()',
    source: 'Glitchless MCP',
    color: C.violet,
    resultAt: wordFrame('agent', 'checked') + 16,
    result: (
      <>
        <span style={{ fontFamily: mono, fontWeight: 700, color: C.coral, border: `2px solid ${C.coral}`, borderRadius: 10, padding: '2px 14px', marginRight: 20 }}>CRITICAL</span>
        The game stutters on level 2
      </>
    ),
  },
  {
    at: wordFrame('agent', 'played'),
    call: 'zoomies_trigger_zoomies() ×2',
    source: 'WebMCP · live game',
    color: C.mint,
    resultAt: wordFrame('agent', 'eight'),
    result: (
      <>
        <b style={{ color: C.coral, fontFamily: display, fontWeight: 800, marginRight: 14 }}>1,600</b> bits of confetti left behind
      </>
    ),
  },
];

const Row: React.FC<{ c: Call }> = ({ c }) => {
  const frame = useCurrentFrame();
  const o = fadeIn(frame, c.at, 10);
  const r = fadeIn(frame, c.resultAt, 10);
  return (
    <div style={{ opacity: o, transform: `translateY(${(1 - o) * 16}px)` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <span style={{ fontFamily: mono, fontSize: 54, fontWeight: 700, color: C.text }}>{c.call}</span>
        <span style={{ fontFamily: mono, fontSize: 26, fontWeight: 700, color: c.color, border: `2px solid ${c.color}`, borderRadius: 10, padding: '4px 14px', background: `${c.color}1f` }}>{c.source}</span>
      </div>
      <div style={{ opacity: r, display: 'flex', alignItems: 'center', fontFamily: inter, fontWeight: 600, fontSize: 50, color: C.text, marginTop: 24, paddingLeft: 30, borderLeft: `4px solid ${C.line}` }}>{c.result}</div>
    </div>
  );
};

export const Agent: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Background>
      <div style={{ position: 'absolute', left: 120, right: 120, top: 0, bottom: 170, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 76 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, opacity: fadeIn(frame, 0), fontFamily: display, fontWeight: 800, fontSize: 58 }}>
          <span style={{ color: C.claude }}>●</span> Claude Code
        </div>
        {CALLS.map((c) => (
          <Row key={c.call} c={c} />
        ))}
      </div>
      <Voice id="agent" />
    </Background>
  );
};

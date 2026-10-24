import React from 'react';
import { AbsoluteFill, Easing, Img, Sequence, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { C, FPS, display, inter, mono } from './theme';
import frames from '../public/frames.json';
import { LineId, VO_DELAY, WORDS, Word } from './voice';

export const fadeIn = (frame: number, at: number, dur = 12) =>
  interpolate(frame, [at, at + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });

export const Background: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: `radial-gradient(1200px 760px at 80% 12%, #22365f 0%, ${C.navy} 46%, ${C.deep} 100%)`, fontFamily: inter, color: C.text }}>{children}</AbsoluteFill>
);

export const Mark: React.FC<{ size: number; style?: React.CSSProperties }> = ({ size, style }) => (
  <Img src={staticFile('brand/glitchless-mark-dark.svg')} style={{ width: size, height: size * (312 / 440), ...style }} />
);

// The recordings (scripts/frames.mjs): dev is the buggy build on our Mac, before the same build on a slower laptop
// (Chrome's CPU slowed 4x), after the fixed build slowed the same.
export type Clip = keyof typeof frames;
// A stretch of a recording, from its `from` second for `frames` frames. A scene plays its stretches back to back.
export type Stretch = { clip: Clip; from: number; frames: number };

const starts = (run: Stretch[]) => run.map((_, i) => run.slice(0, i).reduce((n, s) => n + s.frames, 0));

export const Footage: React.FC<{ run: Stretch[] }> = ({ run }) => {
  const at = starts(run);
  return (
    <AbsoluteFill>
      {run.map((s, i) => (
        <Sequence key={i} from={at[i]} durationInFrames={s.frames}>
          <Video src={staticFile(`clips/${s.clip}.mp4`)} trimBefore={Math.round(s.from * FPS)} muted style={{ width: 1920, height: 1080 }} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

// Every frame a run shows, on the scene's clock: [second into the scene, ms].
const shown = (run: Stretch[]) => {
  const at = starts(run);
  return run.flatMap((s, i) =>
    (frames[s.clip] as [number, number][]).filter(([t]) => t >= s.from && t < s.from + s.frames / FPS).map(([t, ms]): [number, number] => [at[i] / FPS + t - s.from, ms]),
  );
};

// Frames a second over the last second and a half shown.
const fpsAt = (list: [number, number][], now: number) => {
  const recent = list.filter(([t]) => t <= now && t > now - 1.5);
  const ms = recent.length ? recent.reduce((n, [, m]) => n + m, 0) / recent.length : (list[0]?.[1] ?? 16.7);
  return Math.round(1000 / ms);
};

// Every frame of the run so far, as it plays: as wide as it lasted, as tall as its time, the 60 fps budget dashed.
export const FrameStrip: React.FC<{ run: Stretch[]; x: number; y: number; w: number; h: number }> = ({ run, x, y, w, h }) => {
  const now = useCurrentFrame() / FPS;
  const seconds = run.reduce((n, s) => n + s.frames, 0) / FPS;
  const maxMs = 120;
  const yOf = (ms: number) => h - (Math.min(ms, maxMs) / maxMs) * h;
  const xOf = (s: number) => (s / seconds) * w;
  const bars = shown(run)
    .filter(([t]) => t <= now)
    .map(([t, ms]) => {
      const start = Math.max(0, t - ms / 1000);
      return <rect key={t} x={xOf(start)} y={yOf(ms)} width={Math.max(2, xOf(t) - xOf(start) - 1.5)} height={h - yOf(ms)} fill={ms > 20 ? C.coral : C.mint} />;
    });
  return (
    <svg width={w} height={h + 30} style={{ position: 'absolute', left: x, top: y - 30, overflow: 'visible' }}>
      <g transform="translate(0,30)">
        {bars}
        <line x1={0} x2={w} y1={yOf(16.7)} y2={yOf(16.7)} stroke="rgba(255,255,255,0.85)" strokeWidth={2} strokeDasharray="10 8" />
        <rect x={w - 104} y={yOf(16.7) - 44} width={104} height={36} rx={18} fill="rgba(11,20,38,0.92)" />
        <text x={w - 88} y={yOf(16.7) - 18} fontFamily={display} fontWeight={800} fontSize={24} fill="#fff">
          60 fps
        </text>
      </g>
    </svg>
  );
};

// The band over a recording: its frames a second, big and live, and every frame as it plays. The captions sit below.
export const FootageBand: React.FC<{ run: Stretch[] }> = ({ run }) => {
  const frame = useCurrentFrame();
  const fps = fpsAt(shown(run), frame / FPS);
  return (
    <AbsoluteFill style={{ fontFamily: inter, color: C.text }}>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 480, background: 'linear-gradient(180deg, rgba(11,20,38,0) 0%, rgba(11,20,38,0.8) 32%, rgba(11,20,38,0.96) 100%)' }} />
      <div style={{ position: 'absolute', left: 72, bottom: 300, fontFamily: display, fontWeight: 800, fontSize: 120, lineHeight: 1, color: fps >= 50 ? C.mint : C.coral, opacity: fadeIn(frame, 4) }}>{fps} fps</div>
      <FrameStrip run={run} x={72} y={800} w={1776} h={100} />
      <div style={{ position: 'absolute', right: 72, bottom: 310, display: 'flex', alignItems: 'center', gap: 12, opacity: fadeIn(frame, 4) }}>
        <Mark size={52} />
        <span style={{ fontFamily: display, fontWeight: 800, fontSize: 34 }}>glitchless.gg</span>
      </div>
    </AbsoluteFill>
  );
};

// The picture breaking up from frame `at`: a widening RGB split, the frame jumping, torn bands across it.
export const Glitch: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const frame = useCurrentFrame();
  const g = frame - at;
  const on = g >= 0;
  const amp = on ? 8 + g * 5 : 0;
  const r = (k: string) => random(`${k}-${frame}`) - 0.5;
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <svg width={0} height={0} style={{ position: 'absolute' }}>
        <filter id="rgb-split" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
          <feOffset in="red" dx={amp} dy={0} result="redShifted" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cyan" />
          <feOffset in="cyan" dx={-amp} dy={0} result="cyanShifted" />
          <feBlend in="redShifted" in2="cyanShifted" mode="screen" />
        </filter>
      </svg>
      <AbsoluteFill style={{ filter: on ? 'url(#rgb-split)' : 'none', transform: on ? `translate(${r('x') * amp * 2}px, ${r('y') * amp * 0.5}px) scale(1.03)` : 'none' }}>{children}</AbsoluteFill>
      {on &&
        [0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{ position: 'absolute', left: 0, right: 0, top: random(`top${i}-${frame}`) * 1040, height: 10 + random(`h${i}-${frame}`) * 70, background: i % 2 ? C.coral : C.mint, opacity: 0.4, mixBlendMode: 'screen', transform: `translateX(${r(`band${i}`) * 300}px)` }}
          />
        ))}
    </AbsoluteFill>
  );
};

// The spoken words, a phrase at a time (the phrases written in scripts/voiceover.mjs), the word being said in mint.
const phrases = (words: Word[]) => words.reduce<Word[][]>((out, w) => ((out[w.phrase] ??= []).push(w), out), []);

export const Captions: React.FC<{ id: LineId }> = ({ id }) => {
  const frame = useCurrentFrame();
  const ms = ((frame - VO_DELAY) / FPS) * 1000;
  const list = phrases(WORDS[id]);
  const i = list.findIndex((p, k) => ms < (list[k + 1]?.[0].startMs ?? Infinity));
  const phrase = list[i];
  if (!phrase || ms < phrase[0].startMs - 120 || ms > phrase[phrase.length - 1].endMs + 700) return null;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 52, display: 'flex', justifyContent: 'center' }}>
      <div style={{ maxWidth: 1500, padding: '12px 30px', borderRadius: 22, background: 'rgba(11,20,38,0.88)', fontFamily: display, fontWeight: 800, fontSize: 50, lineHeight: 1.2, textAlign: 'center' }}>
        {phrase.map((w, k) => (
          <span key={k} style={{ color: ms >= w.startMs && ms < w.endMs + 80 ? C.mint : C.text }}>
            {w.text}
            {k < phrase.length - 1 ? ' ' : ''}
          </span>
        ))}
      </div>
    </div>
  );
};

// A scene's line and its captions.
export const Voice: React.FC<{ id: LineId; captions?: boolean }> = ({ id, captions = true }) => (
  <>
    <Sequence from={VO_DELAY} layout="none">
      <Audio src={staticFile(`voiceover/${id}.mp3`)} />
    </Sequence>
    {captions && <Captions id={id} />}
  </>
);

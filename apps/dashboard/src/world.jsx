// A world map of one number per country (a choropleth), for a store_revenue by_country panel (stores.jsx): one hue,
// light to dark on a log scale (a few countries usually have most of it), a neutral grey where a country has none, and
// the country's name and numbers on hover or tap (the list next to it is the same numbers as a table). The outlines are bundled (world-map.js, made by
// scripts/world-map.mjs) and loaded with the first map, so nothing is fetched from anywhere else.
import { useEffect, useState } from 'react';

// Less to more, one hue per measure: installs blue, revenue coral (the revenue panels' colour). Theme tokens
// (styles.css), so a theme can step them the other way on a dark surface.
export const RAMPS = Object.fromEntries(['installs', 'revenue'].map((m) => [m, [1, 2, 3, 4, 5].map((k) => `var(--map-${m}-${k})`)]));

let outlines = null;
function useOutlines() {
  const [map, setMap] = useState(null);
  useEffect(() => {
    let on = true;
    (outlines ??= import('./world-map.js')).then((m) => on && setMap(m));
    return () => {
      on = false;
    };
  }, []);
  return map;
}

// The ramp step of a value: its share of the largest on a log scale, in five steps; -1 for none.
function stepOf(v, max, n) {
  if (!(v > 0) || !(max > 0)) return -1;
  return Math.min(n - 1, Math.floor((Math.log1p(v) / Math.log1p(max)) * n - 1e-9));
}

// The colour a value gets on the map (for a swatch next to it elsewhere).
export function rampColor(v, max, measure) {
  const ramp = RAMPS[measure] ?? RAMPS.installs;
  const s = stepOf(v, max, ramp.length);
  return s < 0 ? 'var(--map-none)' : ramp[s];
}

// rows: [{ country (ISO alpha-2, or null: not drawn), name, … }]; `measure` the field coloured; `tip(row)` the line a
// country shows on hover; `active`, `onActive`: the country hovered (shared with the list next to the map).
export function WorldMap({ rows, measure, format, tip, active, onActive, label }) {
  const map = useOutlines();
  const [at, setAt] = useState(null);
  const ramp = RAMPS[measure] ?? RAMPS.installs;
  const placed = rows.filter((r) => r.country);
  const byCode = new Map(placed.map((r) => [r.country, r]));
  const max = Math.max(0, ...placed.map((r) => r[measure] ?? 0));
  const low = Math.min(...placed.map((r) => r[measure]).filter((v) => v > 0));
  const fill = (code) => rampColor(byCode.get(code)?.[measure], max, measure);
  const hovered = active ? byCode.get(active) : null;
  const enter = (code) => (e) => {
    onActive?.(code);
    const box = e.currentTarget.ownerSVGElement.getBoundingClientRect();
    setAt([e.clientX - box.left, e.clientY - box.top, box.width]);
  };
  const leave = () => onActive?.(null);
  if (!map) return <div className="world-map loading" style={{ aspectRatio: '1000 / 440' }} aria-label="Loading the map" />;
  const shapes = Object.entries(map.outlines);
  const dots = Object.entries(map.dots).filter(([code]) => byCode.get(code)?.[measure] > 0);
  return (
    <div className="world-map">
      <svg viewBox={`0 0 ${map.width} ${map.height}`} role="img" aria-label={label} onMouseLeave={leave}>
        {map.land.map((d, i) => (
          <path key={`l${i}`} d={d} fill="var(--map-none)" />
        ))}
        {shapes.map(([code, d]) => (
          <path key={code} d={d} fill={fill(code)} onMouseMove={byCode.has(code) ? enter(code) : leave} onClick={byCode.has(code) ? enter(code) : leave} />
        ))}
        {dots.map(([code, [x, y]]) => (
          <circle key={code} cx={x} cy={y} r={code === active ? 6 : 4} fill={fill(code)} className="dot" onMouseMove={enter(code)} onClick={enter(code)} />
        ))}
        {/* The hovered country again, on top, so its outline isn't hidden under its neighbours'. */}
        {active && map.outlines[active] && <path d={map.outlines[active]} fill="none" className="ring" pointerEvents="none" />}
      </svg>
      {hovered && at && (
        <div className="map-tip" style={{ left: Math.min(at[0] + 12, at[2] - 200), top: at[1] + 14 }} role="status">
          <b>{hovered.name}</b>
          <div>{tip(hovered, true)}</div>
        </div>
      )}
      {max > 0 && (
        <div className="map-scale" aria-hidden="true">
          <span>{format(low)}</span>
          {ramp.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
          <span>{format(max)}</span>
          <span className="muted">· grey: none</span>
        </div>
      )}
    </div>
  );
}

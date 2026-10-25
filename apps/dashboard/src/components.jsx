import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { fmtNum, colorFor, PALETTE } from './format.js';
import { useShell } from './shell.js';
import { useTheme, color as css } from './theme.js';

// ───────────────────────────── icons ─────────────────────────────

const ICONS = {
  overview: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  board: 'M3 3h18v18H3zM3 9h18M9 9v12',
  events: 'M3 12h4l3-8 4 16 3-8h4',
  perf: 'M12 14l4-4M3.5 17a9 9 0 1117 0M12 17v.01',
  errors: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  players: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  heatmap: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4zM8 2v16M16 6v16',
  sessions: 'M5 3l14 9-14 9V3z',
  versions: 'M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9',
  live: 'M4 6h16M4 12h16M4 18h10',
  agents: 'M12 2a3 3 0 013 3v1h2a3 3 0 013 3v8a3 3 0 01-3 3H7a3 3 0 01-3-3V9a3 3 0 013-3h2V5a3 3 0 013-3zM9 13h.01M15 13h.01M9 17h6',
  setup: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.8-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15',
  ext: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3',
  copy: 'M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
  play: 'M6 4l14 8-14 8z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  x: 'M18 6L6 18M6 6l12 12',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  money: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  bug: 'M8 2l1.9 1.9M14.1 3.9L16 2M9 7.1v-1a3 3 0 116 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.5 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M21 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4',
  image: 'M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5L5 21',
  integrations: 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4.5M12 8h.01',
  collapse: 'M4 4h16v16H4zM9.5 4v16M16 9.5L13.5 12l2.5 2.5',
  system: 'M3 4h18v12H3zM8 20h8M12 16v4',
  light: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  dark: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  expand: 'M4 4h16v16H4zM9.5 4v16M13.5 9.5L16 12l-2.5 2.5',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
};

export function Icon({ name, size = 16, ...rest }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d={ICONS[name] || ICONS.overview} />
    </svg>
  );
}

// ───────────────────────────── layout primitives ─────────────────────────────

// A panel. `sub` is its one short line under the title; `info` (text, or a list of paragraphs) is everything else
// about it, behind the info icon next to the title; `warn` colours that icon when the info says something was left out.
export function Widget({ title, sub, info, warn, actions, children, span = 6, flush, className = '', style }) {
  return (
    <section className={`widget s${span} ${flush ? 'flush' : ''} ${className}`} style={style}>
      {(title || actions) && (
        <div className="wh">
          {title && (
            <div className="wt">
              {title}
              <InfoTip label={title} warn={warn}>
                {info}
              </InfoTip>
            </div>
          )}
          {actions && <div className="wa">{actions}</div>}
          {sub && <div className="ws">{sub}</div>}
        </div>
      )}
      <div className="wb">{children}</div>
    </section>
  );
}

export function QueryValue({ label, value, unit, status = 'neutral', sub, span = 2, info, warn, actions }) {
  return (
    <section className={`widget s${span}`}>
      <div className={`qv ${status}`}>
        <div className="label">
          <span>
            {label}
            <InfoTip label={label} warn={warn}>
              {info}
            </InfoTip>
          </span>
          {actions && <span className="qa">{actions}</span>}
        </div>
        <div className="value">
          {value ?? '–'}
          {unit && value != null && <small>{unit}</small>}
        </div>
        {sub && <div className="sub">{sub}</div>}
      </div>
    </section>
  );
}

// A box floated next to an element, over everything and kept inside the window, so a board's edges and scrolling
// never clip it: below the element (above it when there's no room below), or to its right.
export function Floating({ anchor, place = 'below', id, role = 'tooltip', className = '', children, onPointerEnter, onPointerLeave }) {
  const box = useRef(null);
  const [at, setAt] = useState(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const update = () => {
      const a = anchor.getBoundingClientRect();
      const el = box.current;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const m = 8;
      let left = place === 'right' ? a.right + 10 : a.left - 12;
      let top = place === 'right' ? a.top + a.height / 2 - h / 2 : a.bottom + 6;
      if (place !== 'right' && top + h > vh - m && a.top - 6 - h >= m) top = a.top - 6 - h;
      left = Math.max(m, Math.min(left, vw - w - m));
      top = Math.max(m, Math.min(top, vh - h - m));
      setAt({ left, top });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor, place]);
  return createPortal(
    <div ref={box} id={id} role={role} className={`floating ${className}`.trim()} style={at ?? { left: 0, top: 0, visibility: 'hidden' }} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      {children}
    </div>,
    document.body,
  );
}

// The info icon next to a panel's title: what its numbers mean, caveats, the agent's note. It opens while the mouse
// rests on it (after a moment, so sweeping across a board doesn't flash them), at once on keyboard focus, and on a tap
// or click (which keeps it open until the next tap elsewhere, another click or Escape). The mouse can move onto what
// it opened. Nothing to say, no icon.
export function InfoTip({ label, warn, children }) {
  const paras = (Array.isArray(children) ? children.flat() : [children]).filter((x) => x != null && x !== false && x !== '');
  const btn = useRef(null);
  const leave = useRef(null);
  const rest = useRef(null);
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hover || focus || pinned;
  useEffect(() => {
    if (!open) return;
    const close = () => (setHover(false), setFocus(false), setPinned(false));
    const key = (e) => e.key === 'Escape' && close();
    const down = (e) => !btn.current?.contains(e.target) && !document.getElementById(id)?.contains(e.target) && close();
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', down);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', down);
    };
  }, [open, id]);
  useEffect(() => () => (clearTimeout(leave.current), clearTimeout(rest.current)), []);
  if (!paras.length) return null;
  // Only a mouse hovers: a finger's tap is a click.
  const enter = (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(leave.current);
    if (!hover) rest.current = setTimeout(() => setHover(true), 250);
  };
  const exit = (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(rest.current);
    leave.current = setTimeout(() => setHover(false), 150);
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`info${warn ? ' warn' : ''}${open ? ' open' : ''}`}
        aria-label={`About ${typeof label === 'string' ? label : 'this panel'}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onPointerEnter={enter}
        onPointerLeave={exit}
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && setFocus(true)}
        onBlur={() => setFocus(false)}
        onClick={(e) => {
          e.stopPropagation();
          if (pinned) setHover(false);
          setPinned(!pinned);
        }}
      >
        <Icon name="info" size={13} />
      </button>
      {open && (
        <Floating anchor={btn.current} id={id} className="tip" onPointerEnter={enter} onPointerLeave={exit}>
          {paras.map((x, i) => (
            <p key={i}>{x}</p>
          ))}
        </Floating>
      )}
    </>
  );
}

export function Status({ kind = 'neutral', children }) {
  return <span className={`status ${kind}`}>{children}</span>;
}

export function GroupTitle({ children }) {
  return <div className="group-title">{children}</div>;
}

export function Empty({ title = 'No data yet', children }) {
  const shell = useShell();
  return (
    <div className="empty">
      <img src={shell.emptyImage} alt="" />
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

export function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <button
        className="copy"
        onClick={() => {
          navigator.clipboard?.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {code}
    </div>
  );
}

// ───────────────────────────── charts ─────────────────────────────

function useWidth(ref) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/**
 * Timeseries via uPlot.
 * series: [{ label, values, color, fill, dash, width }]
 * thresholds: [{ value, color, label }]  markers: [{ ts, label, color }]  (deployments, annotations)
 * format: how a value is written (money), instead of a number followed by `unit`
 */
export function TimeSeries({ ts, series, height = 180, unit = '', format, thresholds = [], markers = [], yMin, onPick, bars = false }) {
  const wrap = useRef(null);
  const plot = useRef(null);
  const width = useWidth(wrap);
  const theme = useTheme();
  const hasData = ts?.length && series.some((s) => s.values?.some((v) => v != null));

  useEffect(() => {
    if (!wrap.current || !width || !hasData) return;
    // The canvas gets real colours: tokens read from the chart's own element (light or dark, a board's accent).
    const ink = (c) => css(c, wrap.current);
    const axis = { stroke: ink('var(--chart-axis)'), grid: { stroke: ink('var(--chart-grid)'), width: 1 }, font: '11px Noto Sans, sans-serif' };
    const data = [ts.map((t) => t / 1000), ...series.map((s) => s.values)];
    const fmt = (v) => (v == null ? '' : format ? format(v) : `${fmtNum(v, v < 10 ? 1 : 0)}${unit}`);
    const opts = {
      width,
      height,
      padding: [8, 8, 0, 0],
      cursor: { points: { size: 6 }, drag: { x: false, y: false } },
      legend: { show: false },
      scales: { x: { time: true }, y: { range: (u, min, max) => [yMin ?? Math.min(0, min), Math.max(max * 1.12, ...thresholds.map((t) => t.value * 1.15), 1)] } },
      axes: [
        { ...axis, ticks: { stroke: ink('var(--chart-tick)'), width: 1 } },
        { ...axis, ticks: { show: false }, size: 52, values: (u, vals) => vals.map(fmt) },
      ],
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.label,
          stroke: ink(s.color || PALETTE[i % PALETTE.length]),
          width: s.width ?? 1.6,
          fill: s.fill ? ink(s.fill) : undefined,
          dash: s.dash,
          spanGaps: true,
          points: { show: false },
          paths: bars ? uPlot.paths.bars({ size: [0.7, 40] }) : undefined,
          value: (u, v) => fmt(v),
        })),
      ],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            ctx.save();
            ctx.textAlign = 'left'; // uPlot leaves this set from drawing axis labels
            ctx.textBaseline = 'alphabetic';
            for (const t of thresholds) {
              const y = u.valToPos(t.value, 'y', true);
              ctx.strokeStyle = ink(t.color || '#ff6b57');
              ctx.setLineDash([5, 4]);
              ctx.lineWidth = 1.2 * devicePixelRatio;
              ctx.beginPath();
              ctx.moveTo(u.bbox.left, y);
              ctx.lineTo(u.bbox.left + u.bbox.width, y);
              ctx.stroke();
              if (t.label) {
                ctx.setLineDash([]);
                ctx.fillStyle = ink(t.color || '#ff6b57');
                ctx.font = `${10 * devicePixelRatio}px Noto Sans, sans-serif`;
                ctx.fillText(t.label, u.bbox.left + 6 * devicePixelRatio, y - 4 * devicePixelRatio);
              }
            }
            for (const m of markers) {
              const x = u.valToPos(m.ts / 1000, 'x', true);
              if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
              ctx.strokeStyle = ink(m.color || 'var(--ink)');
              ctx.setLineDash([2, 3]);
              ctx.lineWidth = 1.5 * devicePixelRatio;
              ctx.beginPath();
              ctx.moveTo(x, u.bbox.top);
              ctx.lineTo(x, u.bbox.top + u.bbox.height);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.fillStyle = ink(m.color || 'var(--ink)');
              ctx.font = `600 ${10 * devicePixelRatio}px Noto Sans, sans-serif`;
              const label = m.label || '';
              const tw = ctx.measureText(label).width;
              ctx.fillRect(x, u.bbox.top, tw + 8 * devicePixelRatio, 14 * devicePixelRatio);
              ctx.fillStyle = ink('var(--panel)');
              ctx.fillText(label, x + 4 * devicePixelRatio, u.bbox.top + 10.5 * devicePixelRatio);
            }
            ctx.restore();
          },
        ],
        setCursor: onPick
          ? [
              (u) => {
                if (u.cursor.idx != null) onPick(u.cursor.idx);
              },
            ]
          : [],
      },
    };
    plot.current?.destroy();
    plot.current = new uPlot(opts, data, wrap.current);
    return () => {
      plot.current?.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, width, height, JSON.stringify(ts), JSON.stringify(series.map((s) => s.values)), JSON.stringify(thresholds), JSON.stringify(markers)]);

  return (
    <div>
      <div ref={wrap} className="chart" style={{ minHeight: height }}>
        {!hasData && <div className="empty" style={{ padding: `${height / 2 - 12}px 0` }}>No data in this time range</div>}
      </div>
      {series.length > 1 && hasData && (
        <div className="legend">
          {series.map((s, i) => (
            <span key={s.label}>
              <i style={{ background: s.color || PALETTE[i % PALETTE.length] }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function BarList({ rows, max, format = (v) => fmtNum(v), color = 'var(--ink)', onClick }) {
  const m = max ?? Math.max(1, ...rows.map((r) => (r.segments ? r.segments.reduce((a, s) => a + s.value, 0) : r.value || 0)));
  return (
    <div className="bars">
      {rows.map((r, i) => {
        const total = r.segments ? r.segments.reduce((a, s) => a + s.value, 0) : r.value;
        return (
          <div className="barrow" key={r.label + i} onClick={() => onClick?.(r)} style={{ cursor: onClick ? 'pointer' : 'default' }} title={r.title}>
            <div className="bl">{r.label}</div>
            <div className="bt">
              {r.segments
                ? r.segments.map((s, j) => <div key={j} className="bf" title={`${s.label}: ${format(s.value)}`} style={{ width: `${(s.value / m) * 100}%`, background: s.color || colorFor(s.label, j) }} />)
                : <div className="bf" style={{ width: `${((r.value || 0) / m) * 100}%`, background: r.color || color }} />}
            </div>
            <div className="bv">{r.display ?? format(total)}</div>
          </div>
        );
      })}
    </div>
  );
}

export function Histogram({ edges, counts, budget, height = 170, unitLabel = 'ms' }) {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const max = Math.max(...counts, 1);
  const w = 100 / counts.length;
  return (
    <div>
      <svg viewBox={`0 0 100 ${height / 4}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
        {counts.map((c, i) => {
          const h = (c / max) * (height / 4 - 2);
          const lo = edges[i];
          const color = lo < budget * 1.15 ? 'var(--ink)' : lo < 33.3 ? '#f2a93b' : '#ff6b57';
          return (
            <rect key={i} x={i * w + 0.3} y={height / 4 - h} width={w - 0.6} height={h} fill={color} rx="0.4">
              <title>{`${edges[i]}–${edges[i + 1]}${unitLabel}: ${((c / total) * 100).toFixed(2)}% of frames`}</title>
            </rect>
          );
        })}
      </svg>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${counts.length}, 1fr)`, fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>
        {counts.map((_, i) => (
          <span key={i}>{edges[i] >= 1000 ? `${edges[i] / 1000}s` : Math.round(edges[i])}</span>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${counts.length}, 1fr)`, fontSize: 10, color: 'var(--text-2)', textAlign: 'center', fontWeight: 600 }}>
        {counts.map((c, i) => (
          <span key={i}>{c ? `${((c / total) * 100).toFixed(c / total < 0.01 ? 1 : 0)}%` : ''}</span>
        ))}
      </div>
    </div>
  );
}

export function Sparkline({ values, width = 90, height = 22, color = '#ff6b57' }) {
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 1 - (v / max) * (height - 3)).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" width={width} height={height}>
      <polyline points={`0,${height} ${pts} ${width},${height}`} fill={color} fillOpacity={0.13} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

export function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Findings({ findings, onOpen, compact }) {
  const [open, setOpen] = useState(null);
  if (!findings?.length) return <div className="muted" style={{ padding: '8px 0' }}>Nothing unusual found in this range.</div>;
  return (
    <div className="findings">
      {findings.map((f) => (
        <div key={f.id} className={`finding ${f.severity} ${open === f.id ? 'open' : ''}`} onClick={() => setOpen(open === f.id ? null : f.id)}>
          <div className="ft">
            <Status kind={f.severity}>{f.severity}</Status>
            <span>{f.title}</span>
            <span className="cat">{f.category}</span>
          </div>
          {!compact && <div className="fs">{f.summary}</div>}
          <div className="fx">
            {compact && <div style={{ marginBottom: 6 }}>{f.summary}</div>}
            {f.suggestion && (
              <>
                <b>Suggested fix:</b> {f.suggestion}
              </>
            )}
            {onOpen && f.link && (
              <div style={{ marginTop: 6 }}>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpen(f.link);
                  }}
                >
                  Investigate →
                </a>
                <span className="muted"> · finding id </span>
                <code>{f.id}</code>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

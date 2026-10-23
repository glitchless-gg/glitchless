// Bug Reports: what players and playtesters sent from inside the game (F8 or a button), newest first. Each report
// has the player's note, a screenshot (opens large), where they were, and a link to the session's replay.
import { useEffect, useRef, useState } from 'react';
import { useFilters } from '../filters.js';
import { api, apiSend, useQuery } from '../api.js';
import { Widget, QueryValue, Segmented, CodeBlock, Icon, Empty } from '../components.jsx';
import { fmtNum, fmtMs, fmtTime, timeAgo } from '../format.js';
import { NoGame } from './Overview.jsx';

export function Reports({ route }) {
  const f = useFilters();
  const { data, reload } = useQuery('reports', f.params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  const [level, setLevel] = useState(route.query.get('level') || '');
  const [large, setLarge] = useState(null);
  useEffect(() => setLevel(route.query.get('level') || ''), [route.query.get('level')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const all = data.reports || [];
  const levels = count(all.map((r) => r.level).filter((l) => l != null));
  const rows = level ? all.filter((r) => r.level === level) : all;
  const sessions = new Set(all.map((r) => r.session_id)).size;
  return (
    <div className="grid">
      <QueryValue span={3} label="Bug reports" value={fmtNum(all.length)} status={all.length ? 'warn' : 'ok'} />
      <QueryValue span={3} label="Sessions that sent one" value={fmtNum(sessions)} />
      <QueryValue span={3} label="With a screenshot" value={fmtNum(all.filter((r) => r.has_screenshot).length)} />
      <QueryValue span={3} label="Most reported level" value={levels[0]?.[0] ?? '–'} sub={levels[0] ? `${levels[0][1]} report${levels[0][1] === 1 ? '' : 's'}` : null} />
      <Widget
        span={12}
        title={`${fmtNum(rows.length)} ${rows.length === 1 ? 'report' : 'reports'}`}
        sub="newest first · click a screenshot to see it large, a report for the details"
        flush
        actions={
          levels.length > 1 && (
            <Segmented value={level} onChange={setLevel} options={[{ value: '', label: 'All levels' }, ...levels.slice(0, 6).map(([l, n]) => ({ value: l, label: `${l} (${n})` }))]} />
          )
        }
      >
        {rows.length ? (
          <ReportList reports={rows} onShot={setLarge} />
        ) : (
          <Empty title="No bug reports in this range">{TURN_ON[data.engine] || TURN_ON.web}</Empty>
        )}
      </Widget>
      {route.arg && <ReportDrawer id={route.arg} onClose={() => f.go('reports')} onDeleted={() => (f.go('reports'), reload())} onShot={setLarge} />}
      {large && <Lightbox src={large} onClose={() => setLarge(null)} />}
    </div>
  );
}

// How to turn reports on, in the SDK the game's sessions came from (the reports query says which engine).
const TURN_ON = {
  godot: (
    <>
      Turn them on with <code>"bug_reports": true</code> in the options of <code>Glitchless.init</code>, then press F8 in the game.
    </>
  ),
  unity: (
    <>
      Turn them on with <code>BugReports = new BugReportOptions()</code> in the options of <code>Glitchless.Init</code>, then press F8 in the game.
    </>
  ),
  unreal: (
    <>
      Turn them on with a <code>Bug Report Key</code> (F8) in Project Settings → Plugins → Glitchless, or call <code>Show Bug Report Dialog</code> from the game's menu, then press it in the game.
    </>
  ),
  web: (
    <>
      Turn them on with <code>bugReports: {"{ hotkey: 'F8' }"}</code> in <code>Glitchless.init</code>, then press F8 in the game.
    </>
  ),
};

// Reports as rows: thumbnail, note, where and when, and the session's replay. Used by the view and board panels.
export function ReportList({ reports, onShot, compact = false }) {
  const f = useFilters();
  return (
    <div className="reports">
      {reports.map((r) => (
        <div key={r.id} className={`report ${compact ? 'compact' : ''}`.trim()} onClick={() => f.go(`reports/${r.id}`)}>
          {!compact && <Shot service={f.service} report={r} onOpen={onShot} />}
          <div className="rbody">
            <div className={`rnote ${r.note ? '' : 'muted'}`}>{r.note || '(no note)'}</div>
            <div className="rmeta muted">
              {r.level && <span className="tag">{r.level}</span>}
              <span className="tag">{r.version}</span>
              <span title={fmtTime(r.ts, true)}>{timeAgo(r.ts)}</span>
              {r.position && <span>· at {where(r.position)}</span>}
              {r.device && !compact && <span>· {r.device}</span>}
              {compact && r.has_screenshot && <Icon name="image" size={12} />}
            </div>
          </div>
          <a className="rreplay" href={`#/sessions/${r.session_id}?t=${r.ts}`} onClick={(e) => e.stopPropagation()}>
            Replay →
          </a>
        </div>
      ))}
    </div>
  );
}

// A report's screenshot, fetched once it scrolls into view (a list holds no pictures, only report ids).
function Shot({ service, report, onOpen }) {
  const ref = useRef(null);
  const src = useScreenshot(service, report, ref);
  if (!report.has_screenshot) return <div className="shot none">no screenshot</div>;
  return (
    <div ref={ref} className="shot" onClick={(e) => (e.stopPropagation(), src && onOpen(src))} title="See it large">
      {src ? <img src={src} alt={`What the player saw: ${report.note}`} /> : <div className="loading-bar" />}
    </div>
  );
}

const shots = new Map(); // report id → screenshot data URL (or a promise of one)

function useScreenshot(service, report, ref) {
  const [src, setSrc] = useState(() => (typeof shots.get(report.id) === 'string' ? shots.get(report.id) : null));
  useEffect(() => {
    if (!report.has_screenshot || src || !ref.current) return;
    let live = true;
    const load = () => {
      if (!shots.has(report.id)) shots.set(report.id, api('report', { service, id: report.id }).then((d) => d.report?.screenshot ?? null));
      Promise.resolve(shots.get(report.id)).then(
        (s) => {
          if (typeof s === 'string') shots.set(report.id, s);
          if (live) setSrc(s);
        },
        () => shots.delete(report.id),
      );
    };
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (io.disconnect(), load()), { rootMargin: '200px' });
    io.observe(ref.current);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [service, report.id, report.has_screenshot, src, ref]);
  return src;
}

function ReportDrawer({ id, onClose, onDeleted, onShot }) {
  const f = useFilters();
  const { data } = useQuery('report', { service: f.service, id }, { enabled: !!f.service });
  const [error, setError] = useState(null);
  const r = data?.report;
  // A player who asks for their report (and what they wrote in it) to go away.
  const remove = async () => {
    if (!window.confirm('Delete this report, its note and its screenshot? This cannot be undone.')) return;
    try {
      await apiSend('DELETE', `/v1/report?service=${encodeURIComponent(f.service)}&id=${encodeURIComponent(id)}`);
      shots.delete(id);
      onDeleted();
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const browser = !r?.sdk || /^glitchless-(browser|phaser)\//.test(r.sdk);
  const prompt = `Use the glitchless MCP tools to read bug report ${id} in the "${f.service}" game (glitchless_bug_reports with id "${id}" and screenshot: true), and the session it came from (glitchless_session). Find the cause in this repo and fix it, then ${browser ? 'reproduce it in the running game over WebMCP' : 'run the game and play to the same place'} to confirm it is gone.`;
  return (
    <div className="drawer">
      <div className="dh">
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            {r?.level && <span className="tag">{r.level}</span>}
            {r && <span className="tag">{r.version}</span>}
            {r && <span className="tag">{r.env}</span>}
          </div>
          <h2>{data?.error || (r ? r.note || '(no note)' : 'Loading…')}</h2>
          {error && <div className="err">{error}</div>}
        </div>
        {r && (
          <button className="btn close" onClick={remove} title="Delete this report, its note and its screenshot">
            Delete
          </button>
        )}
        <button className="btn" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {r && (
        <div className="db">
          {r.screenshot ? (
            <img className="shot-large" src={r.screenshot} alt={`What the player saw: ${r.note}`} onClick={() => onShot(r.screenshot)} title="See it full size" />
          ) : (
            <div className="shot none">The player sent no screenshot.</div>
          )}
          <dl className="kv">
            <dt>Sent</dt>
            <dd>
              {fmtTime(r.ts, true)} ({timeAgo(r.ts)})
            </dd>
            <dt>Session</dt>
            <dd>
              <a href={`#/sessions/${r.session_id}?t=${r.ts}`}>Replay {r.session_id} at this moment →</a>
            </dd>
            <dt>Level</dt>
            <dd>{r.level ?? '–'}</dd>
            <dt>Position</dt>
            <dd className="mono">{r.position ? where(r.position) : 'not sent (positions are off)'}</dd>
            <dt>Device</dt>
            <dd>{r.device ?? '–'}</dd>
            <dt>Report id</dt>
            <dd className="mono">{r.id}</dd>
          </dl>
          {r.frames.length > 0 && (
            <div>
              <div className="wt" style={{ marginBottom: 6 }}>
                Frame rate before the report
              </div>
              <table className="dt">
                <tbody>
                  {r.frames.map((w, i) => (
                    <tr key={i}>
                      <td className="muted">{fmtTime(w.ts)}</td>
                      <td>{w.level ?? ''}</td>
                      <td className="num">{fmtNum(w.fps, 1)} fps</td>
                      <td className="num">p95 {fmtMs(w.p95)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div>
            <div className="wt" style={{ marginBottom: 6 }}>
              What happened just before
            </div>
            <div className="timeline">
              {r.recent.map((e, i) => (
                <div key={i} className={`tl ${e.type === 'error' ? 'error' : e.type === 'death' || e.type === 'level_fail' ? 'death' : e.type?.startsWith('level') ? 'level' : ''}`}>
                  <span className="tt">{fmtTime(e.ts)}</span>
                  <span className="ti" />
                  <span>
                    <b>{e.type === 'custom' ? e.name : e.message || e.type}</b> <span className="muted">{[e.level, e.cause].filter(Boolean).join(' · ')}</span>
                  </span>
                </div>
              ))}
              <div className="tl bug">
                <span className="tt">{fmtTime(r.ts)}</span>
                <span className="ti" />
                <span>
                  <b>Bug report sent</b>
                </span>
              </div>
            </div>
          </div>
          <div>
            <div className="wt" style={{ marginBottom: 6 }}>
              Fix it with your coding agent
            </div>
            <CodeBlock code={prompt} />
          </div>
        </div>
      )}
    </div>
  );
}

function Lightbox({ src, onClose }) {
  useEffect(() => {
    // Escape closes the picture first, not the report under it.
    const onKey = (e) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label="Screenshot">
      <img src={src} alt="Screenshot the player sent" />
    </div>
  );
}

function where(p) {
  return [p.x, p.y, p.z].map((v) => (v == null ? '–' : fmtNum(v, 1))).join(', ');
}

// [value, count] pairs, most common first.
function count(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

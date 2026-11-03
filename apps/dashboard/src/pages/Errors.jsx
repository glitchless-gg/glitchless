import { Fragment, useState } from 'react';
import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, Status, CodeBlock, Icon, TimeSeries, Segmented } from '../components.jsx';
import { fmtNum, fmtPct, fmtTime, timeAgo, pctStatus } from '../format.js';
import { NoGame, IssuesTable } from './Overview.jsx';
import { CsvButton, issuesCsv } from '../csv.jsx';
import { useShell } from '../shell.js';

export function Errors({ route }) {
  const f = useFilters();
  const shell = useShell();
  const [view, setView] = useState('open');
  const { data, reload } = useQuery('errors', f.params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  const ov = useQuery('overview', f.params, { enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const issues = data.issues || [];
  // Issues the game's owner resolved (server/src/resolved.js) are kept apart; one that came back is open, first.
  const resolved = issues.filter((i) => i.resolved);
  const open = issues.filter((i) => !i.resolved);
  const shown = view === 'resolved' ? resolved : open;
  const selected = issues.find((i) => i.fingerprint === route.arg);
  const k = ov.data?.kpis || {};
  // Resolving needs a host that keeps resolved errors, and the right to change the game's alert settings.
  const save = shell.resolveErrors ? async (changes) => (await shell.resolveErrors(changes), reload()) : null;
  const views = (resolved.length > 0 || save) && <Segmented value={view} onChange={setView} options={[{ value: 'open', label: `Open (${open.length})` }, { value: 'resolved', label: `Resolved (${resolved.length})` }]} />;
  return (
    <div className="grid">
      <QueryValue span={3} label="Open issues" value={fmtNum(open.length)} status={open.length ? 'warn' : 'ok'} sub={resolved.length ? `and ${fmtNum(resolved.length)} resolved` : undefined} />
      <QueryValue span={3} label="Error-free sessions" value={fmtPct(k.error_free_pct)} status={pctStatus(k.error_free_pct, 99, 90)} />
      <QueryValue span={3} label="Crash-free sessions" value={fmtPct(k.crash_free_pct)} status={pctStatus(k.crash_free_pct, 99.9, 99)} sub="game-aware: context lost, frozen frame, or error → quit" />
      <QueryValue span={3} label="Errors" value={fmtNum(k.errors)} sub={`across ${fmtNum(k.sessions)} sessions`} />
      <Widget
        span={12}
        title={view === 'resolved' ? 'Resolved issues' : 'Issues'}
        sub={view === 'resolved' ? 'hidden from the open list until one fires again in a newer version' : 'grouped by fingerprint (kind + message + top stack frame)'}
        flush
        actions={
          <>
            {views}
            {shown.length > 0 && <CsvButton name="issues" rows={() => issuesCsv(shown)} />}
          </>
        }
      >
        <IssuesTable issues={shown} selected={route.arg} onClick={(i) => f.go(`errors/${i.fingerprint}`)} empty={view === 'resolved' ? 'No resolved issues in this time range.' : undefined} />
      </Widget>
      {selected && <IssueDrawer issue={selected} onClose={() => f.go('errors')} service={f.service} engine={data.engine} ts={ov.data?.series?.ts} save={save} />}
    </div>
  );
}

const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Where an issue stands with the game's owner, and the button that changes it: Resolve (with an optional note, and
// whether any version brings it back) for an open one, Unresolve for a resolved one, Resolve again for one that came
// back. Without `save` (a self-hosted server, a member who can't change alert settings) it only says.
function Resolution({ issue, save }) {
  const [note, setNote] = useState('');
  const [any, setAny] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (change) => {
    setBusy(true);
    setError(null);
    try {
      await save({ [issue.fingerprint]: change });
      setNote('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const was = issue.resolved ?? issue.came_back?.resolved;
  const said = was && (
    <>
      {was.by ? ` by ${was.by}` : ''} on {day(was.at)}
      {was.version ? `, when ${was.version} was the newest version it had been seen in` : ''}
      {was.note ? <>: “{was.note}”.</> : '.'}
    </>
  );
  if (!save && !was) return null;
  return (
    <div className="resolution">
      {issue.came_back && (
        <div>
          <Status kind="alert">came back</Status> It fired again in <b>{issue.came_back.version}</b> on {day(issue.came_back.since)}. It was resolved{said}
        </div>
      )}
      {issue.resolved && (
        <div>
          <Status kind="ok">resolved</Status> Resolved{said} It comes back if it fires again {issue.resolved.any_version ? 'in any version' : 'in a newer version'}.
        </div>
      )}
      {save && issue.resolved && (
        <button className="btn" disabled={busy} onClick={() => run(null)}>
          {busy ? 'Saving…' : 'Unresolve'}
        </button>
      )}
      {save && !issue.resolved && (
        <form
          className="resolve-form"
          onSubmit={(e) => {
            e.preventDefault();
            run({ note: note.trim() || null, any });
          }}
        >
          <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Why (optional): fixed in 1.1.3, test phones only…" aria-label="Why it's resolved" />
          <label className="muted">
            <input type="checkbox" checked={any} onChange={(e) => setAny(e.target.checked)} /> Reopen if it fires in any version, old builds too
          </label>
          <button className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : issue.came_back ? 'Resolve again' : 'Resolve'}
          </button>
        </form>
      )}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

// The stack as the build's source maps give it (sourcemaps.js), with the failing line of code and where it was in
// the minified build under the frame that threw; the minified stack one click away.
function StackTrace({ issue }) {
  const [view, setView] = useState('original');
  const minified = !!issue.minified && view === 'minified';
  const stack = ((minified ? issue.minified.stack : issue.stack) || '').split('\n');
  const top = !minified && issue.frames?.find((f) => f.mapped && f.fn === issue.fn && f.line === issue.line);
  const topLine = top ? stack.findIndex((l) => l.trim() === `at ${top.fn} (${top.file}:${top.line}:${top.col})`) : -1;
  const hl = topLine >= 0 ? (i) => i === topLine : (i, line) => i === 1 || (i === 0 && !line.includes('Error'));
  return (
    <div>
      <div className="wt" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
        Stack trace
        {issue.minified && <Segmented value={view} onChange={setView} options={[{ value: 'original', label: 'Source mapped' }, { value: 'minified', label: 'Minified' }]} />}
      </div>
      <div className="stack">
        {stack.map((line, i) => (
          <Fragment key={i}>
            <div className={hl(i, line) ? 'hl' : ''}>{line}</div>
            {i === topLine && (
              <div className="frame-detail">
                {top.code && <div className="code">{top.code}</div>}
                <div className="muted">minified: {top.minified}</div>
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// How the agent checks its fix: over WebMCP in a browser game; in an engine's, with a measure run, whose JSON lists
// the errors the game heard while it ran (Unreal and GameMaker take the flag with one dash).
const ENGINES = { godot: ['Godot', '--'], unity: ['Unity', '--'], unreal: ['Unreal', '-'], gamemaker: ['GameMaker', '-'] };
function checkFix(engine, levels) {
  const native = ENGINES[engine];
  if (!native) return 'Then reproduce it in the running game over WebMCP (glitchless_errors) to confirm it no longer fires.';
  const where = levels.length ? `through ${levels.slice(0, 3).join(', ')}` : 'to where players hit it';
  return `Then confirm it no longer fires: run the ${native[0]} game with ${native[1]}glitchless-measure=SECONDS (and its autoplay flags, if it has them) and play ${where}; the JSON it prints lists the errors it heard in that time.`;
}

function IssueDrawer({ issue, onClose, service, engine, ts, save }) {
  const f = useFilters();
  const prompt = `Use the glitchless MCP tools to look up error ${issue.fingerprint} in the "${service}" game (glitchless_get_error), find the root cause in this repo and fix it. ${checkFix(engine, issue.levels)}`;
  return (
    <div className="drawer">
      <div className="dh">
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Status kind={issue.fatal ? 'alert' : 'warn'}>{issue.kind}</Status>
            {issue.versions.map((v) => (
              <span className="tag" key={v}>
                {v}
              </span>
            ))}
          </div>
          <h2>{issue.message}</h2>
          <div className="mono muted" style={{ fontSize: 12, marginTop: 4 }} title={issue.minified ? `minified: ${issue.minified.location}` : undefined}>
            {issue.location}
          </div>
        </div>
        <button className="btn close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="db">
        <Resolution issue={issue} save={save} />
        <dl className="kv">
          <dt>Occurrences</dt>
          <dd>{fmtNum(issue.count)}</dd>
          <dt>Sessions affected</dt>
          <dd>
            {fmtNum(issue.sessions)} ({fmtPct(issue.sessions_pct)}) · {fmtNum(issue.players)} players
          </dd>
          <dt>Levels</dt>
          <dd>{issue.levels.join(', ') || '–'}</dd>
          <dt>First seen</dt>
          <dd>
            {fmtTime(issue.first_seen, true)} in <span className="tag">{issue.first_version}</span>
          </dd>
          <dt>Last seen</dt>
          <dd>{timeAgo(issue.last_seen)}</dd>
          <dt>Fingerprint</dt>
          <dd className="mono">{issue.fingerprint}</dd>
        </dl>
        {ts && (
          <div>
            <div className="wt" style={{ marginBottom: 4 }}>
              Occurrences over time
            </div>
            <TimeSeries ts={ts} height={110} bars series={[{ label: 'occurrences', values: issue.series, color: '#ff6b57' }]} />
          </div>
        )}
        <StackTrace issue={issue} />
        <div>
          <div className="wt" style={{ marginBottom: 6 }}>
            Breadcrumbs (sample session)
          </div>
          <div className="timeline">
            {(issue.breadcrumbs || []).map((b, i) => (
              <div key={i} className={`tl ${b.type === 'death' ? 'death' : b.type.startsWith('level') ? 'level' : ''}`}>
                <span className="tt">{fmtTime(b.ts)}</span>
                <span className="ti" />
                <span>
                  <b>{b.name || b.type}</b> <span className="muted">{b.level}</span>
                </span>
              </div>
            ))}
            <div className="tl error">
              <span className="tt">{fmtTime(issue.sample_ts)}</span>
              <span className="ti" />
              <span>
                <b className="alert-t">{issue.message}</b>
              </span>
            </div>
          </div>
          <a href={`#/sessions/${issue.sample_session}`} onClick={() => f.go(`sessions/${issue.sample_session}`)}>
            Open sample session replay →
          </a>
        </div>
        <div>
          <div className="wt" style={{ marginBottom: 6 }}>
            Fix it with your coding agent
          </div>
          <CodeBlock code={prompt} />
        </div>
      </div>
    </div>
  );
}

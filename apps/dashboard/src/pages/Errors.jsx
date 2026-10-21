import { useFilters } from '../filters.js';
import { useQuery } from '../api.js';
import { Widget, QueryValue, Status, CodeBlock, Icon, TimeSeries } from '../components.jsx';
import { fmtNum, fmtPct, fmtTime, timeAgo, pctStatus } from '../format.js';
import { NoGame, IssuesTable } from './Overview.jsx';

export function Errors({ route }) {
  const f = useFilters();
  const { data } = useQuery('errors', f.params, { refreshMs: f.live ? 10000 : 0, enabled: !!f.service });
  const ov = useQuery('overview', f.params, { enabled: !!f.service });
  if (!f.service) return <NoGame />;
  if (!data) return <div className="loading-bar" />;
  const issues = data.issues || [];
  const selected = issues.find((i) => i.fingerprint === route.arg);
  const k = ov.data?.kpis || {};
  return (
    <div className="grid">
      <QueryValue span={3} label="Open issues" value={fmtNum(issues.length)} status={issues.length ? 'warn' : 'ok'} />
      <QueryValue span={3} label="Error-free sessions" value={fmtPct(k.error_free_pct)} status={pctStatus(k.error_free_pct, 99, 90)} />
      <QueryValue span={3} label="Crash-free sessions" value={fmtPct(k.crash_free_pct)} status={pctStatus(k.crash_free_pct, 99.9, 99)} sub="game-aware: context lost, frozen frame, or error → quit" />
      <QueryValue span={3} label="Errors" value={fmtNum(k.errors)} sub={`across ${fmtNum(k.sessions)} sessions`} />
      <Widget span={12} title="Issues" sub="grouped by fingerprint (kind + message + top stack frame)" flush>
        <IssuesTable issues={issues} selected={route.arg} onClick={(i) => f.go(`errors/${i.fingerprint}`)} />
      </Widget>
      {selected && <IssueDrawer issue={selected} onClose={() => f.go('errors')} service={f.service} ts={ov.data?.series?.ts} />}
    </div>
  );
}

function IssueDrawer({ issue, onClose, service, ts }) {
  const f = useFilters();
  const prompt = `Use the glitchless MCP tools to look up error ${issue.fingerprint} in the "${service}" game (glitchless_get_error), find the root cause in this repo and fix it. Then reproduce it in the running game over WebMCP (glitchless_errors) to confirm it no longer fires.`;
  const stack = (issue.stack || '').split('\n');
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
          <div className="mono muted" style={{ fontSize: 12, marginTop: 4 }}>
            {issue.location}
          </div>
        </div>
        <button className="btn close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="db">
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
        <div>
          <div className="wt" style={{ marginBottom: 6 }}>
            Stack trace
          </div>
          <div className="stack">
            {stack.map((line, i) => (
              <div key={i} className={i === 1 || (i === 0 && !line.includes('Error')) ? 'hl' : ''}>
                {line}
              </div>
            ))}
          </div>
        </div>
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

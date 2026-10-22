// Shared by the pages: what a page shows before a game reports, and the table of error issues. (The overview
// itself is a board now: the first page of a game's dashboard.)
import { useShell } from '../shell.js';
import { Empty, Status, Sparkline } from '../components.jsx';
import { fmtNum, fmtPct, timeAgo } from '../format.js';

export function NoGame() {
  const { setupLink } = useShell();
  return (
    <Empty title="No games reporting yet">
      Add the SDK to your game and play it. <a href={setupLink.href}>{setupLink.label}</a>
    </Empty>
  );
}

export function IssuesTable({ issues, onClick, selected }) {
  if (!issues?.length) return <div className="empty">No errors in this time range.</div>;
  return (
    <div className="tablewrap">
      <table className="dt">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Levels</th>
            <th className="num">Count</th>
            <th className="num">Sessions</th>
            <th>Trend</th>
            <th>Versions</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i) => (
            <tr key={i.fingerprint} className={`click ${selected === i.fingerprint ? 'sel' : ''}`} onClick={() => onClick?.(i)}>
              <td style={{ maxWidth: 460 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Status kind={i.fatal ? 'alert' : 'warn'}>{i.kind}</Status>
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.message}</b>
                </div>
                <div className="muted mono" style={{ fontSize: 11.5, marginTop: 2 }}>
                  {i.location}
                </div>
              </td>
              <td>{i.levels.map((l) => <span className="tag" key={l}>{l}</span>)}</td>
              <td className="num">{fmtNum(i.count)}</td>
              <td className="num">
                {fmtNum(i.sessions)} <span className="muted">({fmtPct(i.sessions_pct, 0)})</span>
              </td>
              <td>
                <Sparkline values={i.series} />
              </td>
              <td>{i.versions.map((v) => <span className="tag" key={v}>{v}</span>)}</td>
              <td className="muted">{timeAgo(i.last_seen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

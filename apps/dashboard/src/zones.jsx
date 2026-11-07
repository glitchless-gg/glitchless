// Zones on a board (SPEC §3b Zones, server/src/zones.js): the time played in each zone (a breakdown by $zone without an
// event), a stat about one zone, and frame time by zone or level (a frame_time panel with `by`). Board.jsx draws these
// with the helpers here, and csv.jsx exports them.
import { BarList, Status } from './components.jsx';
import { fmtNum, fmtPct, fmtDuration, fmtMs, frameStatus, colorFor } from './format.js';

const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
const zoneWord = (by) => (by === '$level' ? 'level' : 'zone');
// Who went to a zone: players when the game sends player IDs, else sessions.
const who = (r) => (r.players != null ? plural(r.players, 'player') : plural(r.sessions, 'session'));

export const isZoneTime = (p) => p.type === 'breakdown' && p.counts === 'time';
export const isFrameRows = (p) => p.type === 'frame_time' && Array.isArray(p.rows);

// Each zone's share of play time as its bar, and how long a session that went there stayed (the median).
export function ZoneTimeBody({ p }) {
  return (
    <BarList
      max={Math.max(1, ...p.rows.map((r) => r.share_pct || 0))}
      rows={p.rows.map((r, i) => ({
        label: r.value,
        value: r.share_pct,
        color: colorFor(r.value, i),
        display: `${fmtPct(r.share_pct, r.share_pct < 10 ? 1 : 0)}${r.median_s != null ? ` · ${fmtDuration(r.median_s)}` : ''}`,
        // Time outside every zone (none) has its time only.
        title: r.sessions == null ? `${r.value}: ${fmtPct(r.share_pct)} of play time (${fmtDuration(r.seconds)}), outside every zone.` : `${r.value}: ${fmtPct(r.share_pct)} of play time (${fmtDuration(r.seconds)}). ${who(r)} went there (${fmtPct(r.sessions_pct, 0)} of sessions); half of them stayed under ${fmtDuration(r.median_s)}.`,
      }))}
    />
  );
}

// A row per zone or level: its frame time and hitches, the most played first. The share of play says how much it counts.
export function FrameRowsBody({ p }) {
  return (
    <div className="tablewrap">
      <table className="dt frame-rows">
        <thead>
          <tr>
            <th>{zoneWord(p.by) === 'level' ? 'Level' : 'Zone'}</th>
            <th className="num">Play</th>
            <th className="num">p50</th>
            <th className="num">p95</th>
            <th className="num">Hitches / min</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <tr key={r.value}>
              <td>{r.value}</td>
              <td className="num">{fmtPct(r.share_pct, 0)}</td>
              <td className="num">{fmtMs(r.p50)}</td>
              <td className="num">
                <Status kind={frameStatus(r.pct_over_budget, r.p95)}>{fmtMs(r.p95)}</Status>
              </td>
              <td className="num">{fmtNum(r.hitches_per_min, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The panel's one line under its title.
export function zoneLine(p) {
  const more = p.more > 0 ? ` · ${p.more} more` : '';
  if (isZoneTime(p)) return `${fmtDuration(p.total)} played in ${plural(p.sessions, 'session')}${more}`;
  if (isFrameRows(p)) return `${p.kpis.avg_fps != null ? `${fmtNum(p.kpis.avg_fps)} fps on average` : `p95 ${fmtMs(p.kpis.p95)}`}${more}`;
  return null;
}

// What the numbers are, for the info icon.
export function zoneInfo(p) {
  if (isZoneTime(p)) {
    return [
      'Time in a zone is the time the game drew frames there; time in the background or another window is left out.',
      `Each bar is the zone's share of all play time; next to it, the median time in it of the sessions that went there (half stayed less, half more).${p.rows.some((r) => r.value === '(none)') ? ' (none) is play outside every zone.' : ''}`,
      ...(p.more > 0 ? [`${plural(p.more, 'more zone')} ${p.more === 1 ? "isn't" : "aren't"} shown.`] : []),
    ];
  }
  if (isFrameRows(p)) {
    const word = zoneWord(p.by);
    return [`Each row is the frames drawn in that ${word}: half took under p50 and 95% under p95; p95 is coloured when 5% or more of its frames were over their screen's budget. Hitches per minute are per minute played in the ${word}; Play is its share of all play time.${p.rows.some((r) => r.value === '(none)') ? ` (none) is play outside every ${word}.` : ''}`];
  }
  return [];
}

// Under a zone stat: what it is out of.
export function zoneStatSub(p) {
  if (p.metric === 'zone_time_pct') return `${fmtDuration(p.seconds)} of ${fmtDuration(p.total_s)} played`;
  if (p.metric === 'zone_median_s') return `of ${plural(p.sessions, 'session')} that went there (${fmtPct(p.sessions_pct, 0)})`;
  return null;
}

// The CSV of a zone panel, or null for any other.
export function zoneCsv(p) {
  if (isZoneTime(p)) {
    const players = p.rows.some((r) => r.players != null);
    return [['zone', 'Seconds played', 'Share of play time (%)', 'Sessions', 'Share of sessions (%)', ...(players ? ['Players'] : []), 'Median time per session (s)'], ...p.rows.map((r) => [r.value, r.seconds, r.share_pct, r.sessions, r.sessions_pct, ...(players ? [r.players] : []), r.median_s])];
  }
  if (isFrameRows(p)) return [[zoneWord(p.by), 'Seconds played', 'Share of play time (%)', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'Frames over budget (%)', 'Hitches', 'Hitches per minute', 'Sessions'], ...p.rows.map((r) => [r.value, r.seconds, r.share_pct, r.p50, r.p95, r.p99, r.pct_over_budget, r.hitches, r.hitches_per_min, r.sessions])];
  return null;
}

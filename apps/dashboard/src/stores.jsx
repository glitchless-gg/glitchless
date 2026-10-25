// The store panels of a board (server/src/reviews.js), for a game connected to a store (Steam, Google Play, the App
// Store): its reviews over time with each release marked and a row per build (what players said, what Glitchless
// measured on it), the store's own vitals next to Glitchless's, players online next to the sessions measured, and units,
// returns and wishlists by day. And a revenue source's (RevenueCat's, server/src/revenue.js): its revenue, installs,
// active users, MRR, subscriptions and trials as numbers (Board.jsx draws them as stats, with revenueStat), revenue per
// day next to the game's own purchase events, installs and active users per day next to the new players and players
// Glitchless measured, and revenue by version next to what Glitchless measured. storeCsv is what their CSV
// button downloads.
import { TimeSeries, Status } from './components.jsx';
import { fmtNum, fmtPct, fmtTime, fmtMoney } from './format.js';

export const STORE_TYPES = new Set(['store_reviews', 'store_vitals', 'store_players', 'store_sales', 'store_revenue']);
// The store_revenue measures that are one number.
export const REVENUE_STATS = new Set(['revenue', 'per_player', 'installs', 'active_users', 'mrr', 'actives', 'trials']);
// What of Glitchless's own measures each store vital compares with (server/src/reviews.js VITALS), and their names.
const VS = { slow_rendering_20fps: 'slow20_pct', slow_rendering_30fps: 'slow30_pct', crash_rate: 'crashed_pct', hang_rate: 'hitches_per_min', launch_time: 'ttff_p50', animation_hitch_rate: 'hitches_per_min' };
const MEASURED = { slow20_pct: ['Sessions under 20 fps', '%'], slow30_pct: ['Sessions under 30 fps', '%'], crashed_pct: ['Sessions crashed', '%'], hitches_per_min: ['Hitches a minute', ''], ttff_p50: ['First frame p50', 'ms'] };
const DAY = 86_400_000;
const SOURCE = {
  build: (s) => `Builds set live on ${s}’s default branch`,
  sessions: () => 'Builds the game’s sessions name (its SDK sends the Steam build)',
  store_version: (s) => `Versions ${s}’s reviews name`,
  patch_notes: (s) => `Releases from the game’s patch notes on ${s}`,
  version: () => 'Releases from the versions Glitchless saw first',
};

export function StorePanelBody({ p }) {
  if (p.type === 'store_reviews') return <Reviews p={p} />;
  if (p.type === 'store_vitals') return <Vitals p={p} />;
  if (p.type === 'store_players') return <Players p={p} />;
  if (p.type === 'store_sales') return <Sales p={p} />;
  if (p.type === 'store_revenue' && p.measure === 'by_day') return <RevenueDays p={p} />;
  if (p.type === 'store_revenue' && p.measure === 'by_version') return <RevenueVersions p={p} />;
  if (p.type === 'store_revenue' && p.measure === 'players_by_day') return <CustomerDays p={p} />;
  return null;
}

const money = (p, v, short = false) => (v == null ? '–' : p.currency ? fmtMoney(v, p.currency, short) : fmtNum(v, 2));

// A store_revenue number: its value and the line under it (what it is out of, or how it moved).
export function revenueStat(p) {
  const value = p.currency ? fmtMoney(p.value, p.currency) : fmtNum(p.value);
  if (p.measure === 'revenue') {
    const own = p.glitchless ? ` · the game's purchase events: ${money(p, p.glitchless.sum)} (${fmtPct(p.glitchless.coverage_pct, 0)})` : '';
    return { value, sub: `${p.transactions != null ? `${fmtNum(p.transactions)} transactions on ` : 'On '}${p.store_name}, ${fmtNum(p.days)} UTC ${p.days === 1 ? 'day' : 'days'}${p.incomplete ? ' (today so far)' : ''}${own}` };
  }
  if (p.measure === 'per_player') return { value, sub: `${money(p, p.total)} over ${fmtNum(p.players)} ${p.players_are_sessions ? 'sessions' : 'players'} measured` };
  if (p.measure === 'installs' || p.measure === 'active_users') {
    if (p.from_overview) return { value, sub: `On ${p.store_name}, the last 28 days` };
    if (p.measure === 'installs') return { value, sub: `${p.store_name}'s new customers (first app opens), ${fmtNum(p.days)} UTC ${p.days === 1 ? 'day' : 'days'} · ${p.glitchless ? `Glitchless: ${fmtNum(p.glitchless.new_players)} new players (${fmtPct(p.glitchless.pct, 0)})` : p.anonymous ? 'Glitchless counts new players with player IDs (install mode)' : 'no new players measured'}` };
    return { value, sub: `${p.store_name}'s active customers, average of ${fmtNum(p.days)} ${p.days === 1 ? 'day' : 'days'}${p.glitchless ? ` · Glitchless: ${fmtNum(p.glitchless.players_per_day)} players a day` : ''}` };
  }
  const change = p.change == null ? null : `${p.change >= 0 ? '+' : '−'}${p.currency ? fmtMoney(Math.abs(p.change), p.currency) : fmtNum(Math.abs(p.change))} since ${p.since}`;
  return { value, sub: p.from_overview ? `On ${p.store_name} now` : (change ?? `On ${p.store_name}, ${p.day}`) };
}

// How to read a revenue panel's numbers (server/src/revenue.js notes).
function Notes({ notes }) {
  if (!notes?.length) return null;
  return (
    <div className="muted" style={{ marginTop: 8, fontSize: 11.5, display: 'grid', gap: 4 }}>
      {notes.map((n, i) => (
        <div key={i}>{n}</div>
      ))}
    </div>
  );
}

function RevenueDays({ p }) {
  const [revenue, own] = p.series;
  return (
    <>
      <TimeSeries ts={p.ts} height={150} bars={!own} format={(v) => money(p, v, true)} series={[{ ...revenue, color: '#f2545b' }, ...(own ? [{ ...own, color: '#14213d', dash: [4, 3] }] : [])]} />
      <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
        {money(p, p.total)} by UTC day, as {p.store_name} counts it (production purchases only){p.incomplete_day ? `; ${p.incomplete_day} is still filling in` : ''}.
        {p.glitchless && ` The game's own purchase events add up to ${money(p, p.glitchless.sum)}, ${fmtPct(p.glitchless.coverage_pct, 0)} of it.`}
      </div>
      <Notes notes={p.notes?.filter((n) => !/add up to/.test(n))} />
    </>
  );
}

const CUSTOMER_COLORS = { installs: '#f2545b', new_players: '#14213d', active_users: '#f2a93b', players: '#3d8cf5' };

// Installs (the source's new customers) and active users per day, next to the new players and players Glitchless
// measured those days.
function CustomerDays({ p }) {
  return (
    <>
      <TimeSeries ts={p.ts} height={150} series={p.series.map((s) => ({ ...s, color: CUSTOMER_COLORS[s.key], ...(s.measured ? { dash: [4, 3] } : {}) }))} />
      <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
        {fmtNum(p.installs)} installs by UTC day as {p.store_name} counts them{p.new_players != null ? `; Glitchless saw ${fmtNum(p.new_players)} new players` : ''}{p.incomplete_day ? `; ${p.incomplete_day} is still filling in` : ''}.
      </div>
      <Notes notes={p.notes} />
    </>
  );
}

// Revenue by the app version purchases were made on (left), what Glitchless measured of the same version (right).
function RevenueVersions({ p }) {
  return (
    <>
      <div className="tablewrap">
        <table className="dt wrap-th">
          <thead>
            <tr>
              <th>Version</th>
              <th className="num">Revenue</th>
              <th className="num">Share</th>
              <th className="num">Transactions</th>
              <th className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                Players
              </th>
              <th className="num">Sessions</th>
              <th className="num" title={`${p.store_name}'s revenue on this version over the players Glitchless measured on it`}>
                Per player
              </th>
              {p.comparable && (
                <th className="num" title="What the game's own purchase events on this version add up to (sandbox purchases left out)">
                  Purchase events
                </th>
              )}
              <th className="num">Crash-free</th>
              <th className="num">Frame p95</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.version}>
                <td>
                  <span className="tag">{r.version}</span>
                </td>
                <td className="num">{money(p, r.revenue)}</td>
                <td className="num">{fmtPct(r.share_pct, 0)}</td>
                <td className="num">{fmtNum(r.transactions)}</td>
                <td className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                  {fmtNum(r.players)}
                </td>
                <td className="num">{fmtNum(r.sessions)}</td>
                <td className="num">{money(p, r.per_player)}</td>
                {p.comparable && <td className="num">{money(p, r.purchases)}</td>}
                <td className="num">{fmtPct(r.crash_free_pct)}</td>
                <td className="num">{r.frame_p95 == null ? '–' : `${fmtNum(r.frame_p95, 1)} ms`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
        Left: what {p.store_name} counted on each version (production purchases only). Right: what Glitchless measured of the same version.
      </div>
      <Notes notes={p.notes} />
    </>
  );
}

function Reviews({ p }) {
  const [up, down, perf] = p.series;
  return (
    <>
      <TimeSeries
        ts={p.ts}
        height={150}
        markers={p.markers}
        series={[
          { ...up, color: '#1fae84' },
          { ...down, color: '#ff6b57' },
          { ...perf, color: '#f2a93b', dash: [4, 3] },
        ]}
      />
      <div className="muted" style={{ margin: '6px 0 10px' }}>
        {fmtNum(p.total)} reviews by {p.bucket_ms === DAY ? 'day' : 'hour'}, {fmtPct(p.positive_pct, 0)} positive; {fmtNum(p.perf_negative)} negative about stutter, lag, fps, freezes or crashes.
        {p.summary && (
          <>
            {' '}
            On {p.store_name} overall: <b>{p.summary.desc}</b> ({fmtNum(p.summary.positive)} positive, {fmtNum(p.summary.negative)} negative).
          </>
        )}
      </div>
      {p.builds.length > 0 && (
        <div className="tablewrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Build</th>
                <th>Live from</th>
                <th className="num">Reviews</th>
                <th className="num">Positive</th>
                <th className="num" title="Negative reviews that mention stutter, lag, fps, freezes or crashes, of all reviews written while this build was live">
                  About performance
                </th>
                {p.segment && (
                  <th className="num" title={`Reviewers who played mostly on ${p.segment}`}>
                    {p.segment}
                  </th>
                )}
                <th className="num">Frame p95</th>
                <th className="num">Crash-free</th>
              </tr>
            </thead>
            <tbody>
              {p.builds.map((b) => (
                <tr key={b.key}>
                  <td>
                    <span className="tag">{b.label}</span>
                  </td>
                  <td className="muted">{b.from ? fmtTime(b.from, true) : '–'}</td>
                  <td className="num">{fmtNum(b.reviews)}</td>
                  <td className="num">{fmtPct(b.positive_pct, 0)}</td>
                  <td className="num">
                    <Status kind={b.perf_pct >= 25 ? 'alert' : b.perf_pct >= 10 ? 'warn' : 'neutral'}>
                      {fmtNum(b.perf_negative)} · {fmtPct(b.perf_pct, 0)}
                    </Status>
                  </td>
                  {p.segment && <td className="num">{fmtPct(b.deck_pct, 0)}</td>}
                  <td className="num">{b.frame_p95 == null ? '–' : `${fmtNum(b.frame_p95, 1)} ms`}</td>
                  <td className="num">{fmtPct(b.crash_free_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.source && (
        <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
          {SOURCE[p.source]?.(p.store_name)}. Frame p95 and crash-free are what Glitchless measured on that build’s version.
        </div>
      )}
    </>
  );
}

// A store's own vitals by version (left), what Glitchless measured of the same version (right), and where they disagree.
function Vitals({ p }) {
  const ours = [...new Set(p.columns.map((c) => VS[c.metric]).filter(Boolean))];
  const unit = (v, u) => (v == null ? '–' : `${fmtNum(v, v < 10 ? 2 : v < 100 ? 1 : 0)}${u === '%' ? '%' : u ? ` ${u}` : ''}`);
  const d = p.devices;
  const worst = (list) => list?.slice(0, 4).map((x) => `${x.name} ${fmtPct(x.rate)}`).join(' · ');
  return (
    <>
      <div className="tablewrap">
        <table className="dt wrap-th">
          <thead>
            <tr>
              <th>Version</th>
              {p.columns.map((c) => (
                <th key={c.key} className="num" title={`${p.store_name}'s ${c.label}`}>
                  {c.label}
                </th>
              ))}
              <th className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                Sessions
              </th>
              <th className="num">Frame p95</th>
              {ours.map((k) => (
                <th key={k} className="num">
                  {MEASURED[k][0]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.version}>
                <td>
                  <span className="tag">{r.version}</span>
                  {r.build != null && r.build !== r.version && <span className="muted mono"> {r.build}</span>}
                </td>
                {p.columns.map((c) => (
                  <td key={c.key} className="num">
                    {r.notes.some((n) => n.metric === c.metric) ? <Status kind="warn">{unit(r.store[c.key], c.unit)}</Status> : unit(r.store[c.key], c.unit)}
                  </td>
                ))}
                <td className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                  {fmtNum(r.glitchless?.sessions)}
                </td>
                <td className="num">{r.glitchless?.frame_p95 == null ? '–' : `${fmtNum(r.glitchless.frame_p95, 1)} ms`}</td>
                {ours.map((k) => (
                  <td key={k} className="num">
                    {unit(r.glitchless?.[k], MEASURED[k][1])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
        Left: what {p.store_name} measured{p.store === 'google_play' ? ' (users in a day, a day or two late)' : ''}. Right: what Glitchless measured of the same version (sessions).
      </div>
      {p.notes.length > 0 && (
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {p.notes.map((n, i) => (
            <div key={i} className="warn-t" style={{ fontSize: 12.5 }}>
              {n.says}
            </div>
          ))}
        </div>
      )}
      {d && (
        <div className="muted" style={{ marginTop: 10, fontSize: 12.5, display: 'grid', gap: 4 }}>
          {d.slow_rendering_by_gpu?.length > 0 && <div>Slowest GPUs ({d.day}): {worst(d.slow_rendering_by_gpu)}</div>}
          {d.slow_rendering_by_device?.length > 0 && <div>Slowest devices: {worst(d.slow_rendering_by_device)}</div>}
          {d.crash_rate_by_device?.length > 0 && <div>Most crashes: {worst(d.crash_rate_by_device)}</div>}
        </div>
      )}
      {p.hangs?.signatures?.length > 0 && (
        <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
          Heaviest hangs in build {p.hangs.build}
          {p.hangs.version ? ` (${p.hangs.version})` : ''}:{' '}
          {p.hangs.signatures.map((x, i) => (
            <span key={i}>
              {i ? ' · ' : ''}
              <span className="mono">{x.signature}</span> {fmtPct(x.weight, 0)}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function Players({ p }) {
  const [counted, measured] = p.series;
  return (
    <>
      <div className="row" style={{ gap: 18, marginBottom: 6 }}>
        <Figure label={`On ${p.store_name} now`} value={fmtNum(p.latest.store)} />
        {p.latest.glitchless != null && <Figure label="Measured now" value={fmtNum(p.latest.glitchless)} />}
        <Figure label="Coverage" value={p.coverage_pct == null ? '–' : fmtPct(p.coverage_pct, 0)} title={`Sessions Glitchless measured at the minutes ${p.store_name} was asked, over its players online then`} />
        <Figure label={`Peak on ${p.store_name}`} value={fmtNum(p.peak.store)} sub={fmtTime(p.peak.ts, true)} />
      </div>
      <TimeSeries ts={p.ts} height={140} series={[{ ...counted, color: '#14213d' }, ...(measured ? [{ ...measured, color: '#3d8cf5' }] : [])]} />
      <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
        {p.why_no_coverage || `${p.store_name} is asked for players online once an hour. The gap is players on a build that sends no telemetry: an older build, or one without the SDK.`}
      </div>
    </>
  );
}

function Sales({ p }) {
  const t = p.totals;
  return (
    <>
      <div className="row" style={{ gap: 18, marginBottom: 6 }}>
        {t.units != null && <Figure label="Units sold" value={fmtNum(t.units)} />}
        {t.returns != null && <Figure label="Returns" value={fmtNum(t.returns)} sub={t.return_pct != null ? `${fmtPct(t.return_pct)} of units` : null} />}
        {t.wishlist_adds != null && <Figure label="Wishlist adds" value={fmtNum(t.wishlist_adds)} sub={`${fmtNum(t.wishlist_deletes)} deleted, ${fmtNum(t.wishlist_purchases)} bought`} />}
      </div>
      <div className="row" style={{ gap: 12, alignItems: 'stretch' }}>
        {p.sales_series && (
          <div style={{ flex: 1, minWidth: 220 }}>
            <TimeSeries ts={p.ts} height={130} series={[{ ...p.sales_series[0], color: '#14213d' }, { ...p.sales_series[1], color: '#ff6b57' }]} />
          </div>
        )}
        {p.wishlist_series && (
          <div style={{ flex: 1, minWidth: 220 }}>
            <TimeSeries ts={p.ts} height={130} series={[{ ...p.wishlist_series[0], color: '#1fae84' }, { ...p.wishlist_series[1], color: '#f2a93b' }]} />
          </div>
        )}
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
        By day, as {p.store_name} reports them{p.store === 'steam' ? ' (units and returns by Pacific day, wishlists by GMT day), from the Financial API key' : ''}.
      </div>
    </>
  );
}

function Figure({ label, value, sub, title }) {
  return (
    <div title={title}>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11.5 }}>{sub}</div>}
    </div>
  );
}

const iso = (ts) => (ts == null ? null : new Date(ts).toISOString());
const MONEY_STATS = new Set(['revenue', 'per_player', 'mrr']);

// Rows for a store panel's CSV: reviews by time with the build live then; players by sample; sales by day.
export function storeCsv(p) {
  if (p.type === 'store_reviews') {
    const builds = [...p.builds].filter((b) => b.from != null).sort((a, b) => a.from - b.from);
    const at = (t) => builds.filter((b) => b.from <= t + p.bucket_ms - 1).at(-1)?.label ?? null;
    return [['Time', ...p.series.map((s) => s.label), 'Build'], ...p.ts.map((t, i) => [iso(t), ...p.series.map((s) => s.values[i]), at(t)])];
  }
  if (p.type === 'store_vitals') {
    const ours = [...new Set(p.columns.map((c) => VS[c.metric]).filter(Boolean))];
    return [['Version', 'Build', ...p.columns.map((c) => `${p.store_name}: ${c.label}${c.unit ? ` (${c.unit})` : ''}`), 'Glitchless: sessions', 'Glitchless: frame p95 (ms)', ...ours.map((k) => `Glitchless: ${MEASURED[k][0]}${MEASURED[k][1] ? ` (${MEASURED[k][1]})` : ''}`), 'Where they disagree'], ...p.rows.map((r) => [r.version, r.build, ...p.columns.map((c) => r.store[c.key]), r.glitchless?.sessions, r.glitchless?.frame_p95, ...ours.map((k) => r.glitchless?.[k]), r.notes.map((n) => n.says).join(' | ')])];
  }
  if (p.type === 'store_players') return [['Time', ...p.series.map((s) => s.label)], ...p.ts.map((t, i) => [iso(t), ...p.series.map((s) => s.values[i])])];
  if (p.type === 'store_sales') {
    const series = [...(p.sales_series ?? []), ...(p.wishlist_series ?? [])];
    return [['Day', ...series.map((s) => s.label)], ...p.ts.map((t, i) => [iso(t).slice(0, 10), ...series.map((s) => s.values[i])])];
  }
  if (p.type === 'store_revenue') {
    const cur = p.currency ? ` (${p.currency})` : '';
    if (p.measure === 'by_day') {
      const own = p.series[1];
      return [['Day', `Revenue${cur}`, 'Transactions', `MRR${cur}`, 'Active subscriptions', 'Active trials', ...(own ? [`The game's purchase events${cur}`] : [])], ...p.days.map((d, i) => [d, p.series[0].values[i], p.transactions[i], p.mrr[i], p.actives[i], p.trials[i], ...(own ? [own.values[i]] : [])])];
    }
    if (p.measure === 'players_by_day') return [['Day', ...p.series.map((s) => s.label)], ...p.days.map((d, i) => [d, ...p.series.map((s) => s.values[i])])];
    if (p.measure === 'by_version') return [['Version', `Revenue${cur}`, 'Share (%)', 'Transactions', 'Glitchless: players', 'Glitchless: sessions', `Revenue per player${cur}`, ...(p.comparable ? [`The game's purchase events${cur}`] : []), 'Glitchless: crash-free sessions (%)', 'Glitchless: frame p95 (ms)'], ...p.rows.map((r) => [r.version, r.revenue, r.share_pct, r.transactions, r.players, r.sessions, r.per_player, ...(p.comparable ? [r.purchases] : []), r.crash_free_pct, r.frame_p95])];
    return [['Stat', `Value${MONEY_STATS.has(p.measure) ? cur : ''}`, 'Day'], [p.title, p.value, p.day ?? p.to_day ?? null]];
  }
  return null;
}

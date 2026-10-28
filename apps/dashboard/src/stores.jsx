// The store panels of a board (server/src/reviews.js), for a game connected to a store (Steam, Google Play, the App
// Store): its reviews over time with each release marked and a row per build (what players said, what Glitchless
// measured on it), the store's own vitals next to Glitchless's, players online next to the sessions measured, and units,
// returns and wishlists by day. And a revenue source's (RevenueCat's or Stripe's, server/src/revenue.js): its revenue,
// installs, active users, MRR, subscriptions and trials (Stripe: refunds and new paying customers) as numbers (Board.jsx
// draws them as stats, with revenueStat), revenue per day next to the game's own purchase events (Stripe: and its
// refunds), installs and active users per day next to the new players and players Glitchless measured, revenue by
// version next to what Glitchless measured, installs and revenue by country on a world map (world.jsx) with a ranked
// list, revenue by store next to the sessions on each store's platform, and revenue by product (Stripe). And a store's
// score: its reviews' average stars next to the store's own rating. storeLine is a panel's one short line, storeInfo
// what its info icon says (how the store counts, what Glitchless measured beside it, the server's notes); storeCsv is
// what their CSV button downloads.
import { useState } from 'react';
import { TimeSeries, Status } from './components.jsx';
import { fmtNum, fmtPct, fmtTime, fmtMoney } from './format.js';
import { WorldMap, rampColor } from './world.jsx';

export const STORE_TYPES = new Set(['store_reviews', 'store_vitals', 'store_players', 'store_sales', 'store_revenue', 'store_score']);
// The store_revenue measures that are one number.
export const REVENUE_STATS = new Set(['revenue', 'per_player', 'installs', 'active_users', 'mrr', 'actives', 'trials', 'refunds', 'customers']);
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
  if (p.type === 'store_revenue' && p.measure === 'by_product') return <RevenueProducts p={p} />;
  if (p.type === 'store_revenue' && p.measure === 'by_country') return <Countries p={p} />;
  if (p.type === 'store_revenue' && p.measure === 'by_store') return <RevenueStores p={p} />;
  if (p.type === 'store_score') return <Score p={p} />;
  return null;
}

const money = (p, v, short = false) => (v == null ? '–' : p.currency ? fmtMoney(v, p.currency, short) : fmtNum(v, 2));

const days = (p) => `${fmtNum(p.days)} UTC ${p.days === 1 ? 'day' : 'days'}${p.incomplete ? ' (today so far)' : ''}`;

// A store_revenue number: its value, the short line under it (what it counts, or how it moved) and what its info icon
// says (where it comes from, over which days, what Glitchless measured beside it).
export function revenueStat(p) {
  const value = p.currency ? fmtMoney(p.value, p.currency) : fmtNum(p.value);
  const notes = [p.note, ...(p.notes ?? [])];
  const anonymous = p.anonymous && !notes.some((n) => /player IDs/.test(n ?? '')) && 'Glitchless counts new players only when the game sends player IDs (install mode).';
  if (p.measure === 'revenue') {
    // Stripe's: payments rather than transactions, and what's left after refunds, disputes and its fees.
    const what = p.net != null ? ['payment', 'payments'] : ['transaction', 'transactions'];
    return {
      value,
      sub: p.transactions != null ? `${fmtNum(p.transactions)} ${what[p.transactions === 1 ? 0 : 1]} on ${p.store_name}` : `On ${p.store_name}`,
      info: [`${p.store_name}'s revenue over ${days(p)}.`, p.net != null && `${money(p, p.net)} left after refunds and fees.`, p.glitchless && `The game's own purchase events add up to ${money(p, p.glitchless.sum)}, ${fmtPct(p.glitchless.coverage_pct, 0)} of it.`, ...notes],
    };
  }
  if (p.measure === 'refunds') return { value, sub: `${fmtNum(p.refund_count)} ${p.refund_count === 1 ? 'refund' : 'refunds'}${p.share_pct != null ? `, ${fmtPct(p.share_pct)} of revenue` : ''}`, info: [`Refunds on ${p.store_name}.`, p.disputes && `And ${money(p, p.disputes)} in disputes.`, ...notes] };
  if (p.measure === 'customers') return { value, sub: p.glitchless ? `${fmtNum(p.glitchless.new_players)} new players measured` : `First-time buyers on ${p.store_name}`, info: [`First-time buyers on ${p.store_name} over ${days(p)}.`, p.glitchless && `Glitchless measured ${fmtNum(p.glitchless.new_players)} new players.`, anonymous, ...notes] };
  if (p.measure === 'per_player') return { value, sub: `${money(p, p.total)} over ${fmtNum(p.players)} ${p.players_are_sessions ? 'sessions' : 'players'}`, info: [`${p.store_name}'s revenue over the ${p.players_are_sessions ? 'sessions' : 'players'} Glitchless measured.`, p.players_are_sessions && 'The game sends no player IDs, so this is per session.', ...notes] };
  if (p.measure === 'installs' || p.measure === 'active_users') {
    if (p.from_overview) return { value, sub: `On ${p.store_name}, the last 28 days`, info: [`From ${p.store_name}'s overview.`, ...notes] };
    if (p.measure === 'installs')
      return {
        value,
        sub: p.glitchless ? `${fmtNum(p.glitchless.new_players)} new players measured (${fmtPct(p.glitchless.pct, 0)})` : `New customers on ${p.store_name}`,
        info: [`${p.store_name}'s new customers (first app opens) over ${days(p)}.`, p.glitchless ? `Glitchless measured ${fmtNum(p.glitchless.new_players)} new players, ${fmtPct(p.glitchless.pct, 0)} of them.` : anonymous || 'Glitchless measured no new players.', ...notes],
      };
    return { value, sub: p.glitchless ? `${fmtNum(p.glitchless.players_per_day)} players a day measured` : `Active customers on ${p.store_name}`, info: [`${p.store_name}'s active customers, the average of ${fmtNum(p.days)} ${p.days === 1 ? 'day' : 'days'}.`, p.glitchless && `Glitchless measured ${fmtNum(p.glitchless.players_per_day)} players a day.`, ...notes] };
  }
  const change = p.change == null ? null : `${p.change >= 0 ? '+' : '−'}${p.currency ? fmtMoney(Math.abs(p.change), p.currency) : fmtNum(Math.abs(p.change))} since ${p.since}`;
  if (p.from_overview) return { value, sub: `On ${p.store_name} now`, info: notes };
  return { value, sub: change ?? `On ${p.store_name}, ${p.day}`, info: [change && `On ${p.store_name}, ${p.day}.`, ...notes] };
}

// A store panel's one short line under its title: how much is on it. The store score and the map say theirs in the
// panel itself.
export function storeLine(p) {
  if (p.type === 'store_reviews') return `${fmtNum(p.total)} reviews, ${fmtPct(p.positive_pct, 0)} positive · ${fmtNum(p.perf_negative)} about performance`;
  if (p.type === 'store_revenue') {
    if (p.measure === 'by_day') return `${money(p, p.total)} on ${p.store_name}`;
    if (p.measure === 'players_by_day') return `${fmtNum(p.installs)} installs on ${p.store_name}${p.new_players != null ? ` · ${fmtNum(p.new_players)} new players measured` : ''}`;
    if (p.measure === 'by_version' && p.payers > 0) return `${fmtNum(p.payers)} ${p.payers === 1 ? 'player' : 'players'} paid${p.payers_pct != null ? ` (${fmtPct(p.payers_pct)} of those measured)` : ''}`;
  }
  return null;
}

// What a store panel's info icon says: how the store counts, what Glitchless measured beside it, the server's notes.
export function storeInfo(p) {
  if (p.empty) return [];
  const notes = p.notes ?? [];
  if (p.type === 'store_reviews')
    return [
      `Reviews by ${p.bucket_ms === DAY ? 'day' : 'hour'}. ${fmtNum(p.perf_negative)} negative ${p.perf_negative === 1 ? 'review mentions' : 'reviews mention'} stutter, lag, fps, freezes, crashes or optimization.`,
      p.summary && `On ${p.store_name} overall: ${p.summary.desc} (${fmtNum(p.summary.positive)} positive, ${fmtNum(p.summary.negative)} negative).`,
      p.source && `${SOURCE[p.source]?.(p.store_name)}. Frame p95 and crash-free are what Glitchless measured on that build's version.`,
    ];
  if (p.type === 'store_vitals') return [`Left: what ${p.store_name} measured${p.store === 'google_play' ? ' (users in a day, a day or two late)' : ''}. Right: what Glitchless measured of the same version (sessions).`];
  if (p.type === 'store_players') return [p.why_no_coverage || `${p.store_name} is asked for players online once an hour. The gap is players on a build that sends no telemetry: an older build, or one without the SDK.`];
  if (p.type === 'store_sales') return [`By day, as ${p.store_name} reports them${p.store === 'steam' ? ' (units and returns by Pacific day, wishlists by GMT day), from the Financial API key' : ''}.`];
  if (p.type === 'store_score') return scoreInfo(p);
  if (p.type !== 'store_revenue') return notes;
  if (p.measure === 'by_day')
    return [
      `By UTC day, as ${p.store_name} counts it${p.net_total != null ? `: ${money(p, p.refunds_total)} of it refunded or disputed, and ${money(p, p.net_total)} left after Stripe's fees` : ' (production purchases only)'}.${p.incomplete_day ? ` ${p.incomplete_day} is still filling in.` : ''}`,
      p.glitchless && `The game's own purchase events add up to ${money(p, p.glitchless.sum)}, ${fmtPct(p.glitchless.coverage_pct, 0)} of it.`,
      ...notes.filter((n) => !/add up to/.test(n)),
    ];
  if (p.measure === 'players_by_day') return [`Installs are ${p.store_name}'s new customers, by UTC day.${p.incomplete_day ? ` ${p.incomplete_day} is still filling in.` : ''}`, ...notes];
  if (p.measure === 'by_version')
    return [
      p.unjoined ? `Left: the payments on ${p.store_name} tied to a session Glitchless measured, by that session's version.` : `Left: what ${p.store_name} counted on each version (production purchases only).`,
      'Right: what Glitchless measured of the same version.',
      p.platforms?.length > 0 && `By platform: ${p.platforms.map((x) => `${x.platform} ${money(p, x.revenue)}`).join(', ')}.`,
      ...notes,
    ];
  if (p.measure === 'by_country') return [`${money(p, p.totals.revenue)} from ${fmtNum(p.totals.purchases)} ${p.store === 'stripe' ? 'payments' : 'purchases'}.`, ...notes];
  return notes;
}

// Revenue's colour is the source's own (RevenueCat's coral, Stripe's purple).
const DAY_COLORS = { revenue: '#f2545b', refunds: '#f2a93b', purchases: 'var(--ink)' };

function RevenueDays({ p }) {
  const own = p.series.find((s) => s.key === 'purchases' || s.label === "The game's purchase events");
  const color = (s, i) => (s === own ? DAY_COLORS.purchases : i === 0 ? (p.store === 'stripe' ? '#635bff' : DAY_COLORS.revenue) : (DAY_COLORS[s.key] ?? '#8a94a6'));
  return (
    <>
      <TimeSeries ts={p.ts} height={150} bars={p.series.length === 1} format={(v) => money(p, v, true)} series={p.series.map((s, i) => ({ ...s, color: color(s, i), ...(s === own ? { dash: [4, 3] } : {}) }))} />
    </>
  );
}

// Revenue and refunds by product, most revenue first (Stripe).
function RevenueProducts({ p }) {
  return (
    <>
      <div className="tablewrap">
        <table className="dt wrap-th">
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">Revenue</th>
              <th className="num">Share</th>
              <th className="num">Payments</th>
              <th className="num">Refunded</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.product}>
                <td title={r.product === '(none)' ? undefined : r.product}>{r.name}</td>
                <td className="num">{money(p, r.revenue)}</td>
                <td className="num">{fmtPct(r.share_pct, 0)}</td>
                <td className="num">{fmtNum(r.transactions)}</td>
                <td className="num" title={r.refund_count ? `${fmtNum(r.refund_count)} ${r.refund_count === 1 ? 'refund' : 'refunds'}` : undefined}>
                  {r.refunds ? `${money(p, r.refunds)} (${fmtPct(r.refunded_pct, 0)})` : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const CUSTOMER_COLORS = { installs: '#f2545b', new_players: 'var(--ink)', active_users: '#f2a93b', players: '#3d8cf5' };

// Installs (the source's new customers) and active users per day, next to the new players and players Glitchless
// measured those days.
function CustomerDays({ p }) {
  return (
    <>
      <TimeSeries ts={p.ts} height={150} series={p.series.map((s) => ({ ...s, color: CUSTOMER_COLORS[s.key], ...(s.measured ? { dash: [4, 3] } : {}) }))} />
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
    </>
  );
}

// Installs and revenue by country: the map (one of the two at a time) and the countries ranked by it, with both
// numbers and the purchases. Hovering a country on either shows it on both.
// A source without installs (Stripe) has its revenue and payments only.
function Countries({ p }) {
  const installs = p.has?.installs !== false;
  const bought = p.store === 'stripe' ? ['payment', 'payments'] : ['purchase', 'purchases'];
  const views = [installs && 'installs', p.has?.revenue !== false && 'revenue'].filter(Boolean);
  const [view, setView] = useState(views.includes(p.show) ? p.show : views[0]);
  const [active, setActive] = useState(null);
  const [all, setAll] = useState(false);
  const t = p.totals;
  const rows = [...p.rows].sort((a, b) => (a.key === '(other)') - (b.key === '(other)') || b[view] - a[view] || b[view === 'installs' ? 'revenue' : 'installs'] - a[view === 'installs' ? 'revenue' : 'installs']);
  const shown = all ? rows : rows.slice(0, 12);
  const top = Math.max(0, ...p.rows.filter((r) => r.country).map((r) => r[view]));
  const value = (r, v = view) => (v === 'revenue' ? money(p, r.revenue) : fmtNum(r.installs));
  const tip = (r) => `${installs ? `${fmtNum(r.installs)} ${r.installs === 1 ? 'install' : 'installs'} · ` : ''}${money(p, r.revenue)} from ${fmtNum(r.purchases)} ${bought[r.purchases === 1 ? 0 : 1]}`;
  return (
    <div className="countries">
      <div className="countries-head">
        {views.length > 1 && (
          <div className="segmented" role="group" aria-label="What the map shows">
            {views.map((v) => (
              <button key={v} className={v === view ? 'on' : undefined} aria-pressed={v === view} onClick={() => setView(v)}>
                {v === 'installs' ? 'Installs' : 'Revenue'}
              </button>
            ))}
          </div>
        )}
        <span className="muted">
          {installs ? `${fmtNum(t.installs)} installs · ` : ''}
          {money(p, t.revenue)} · {fmtNum(p.countries)} {p.countries === 1 ? 'country' : 'countries'}
        </span>
      </div>
      <div className="countries-body">
        <WorldMap rows={p.rows} measure={view} active={active} onActive={setActive} tip={tip} label={`${view === 'installs' ? 'Installs' : 'Revenue'} by country on ${p.store_name}`} format={(v) => (view === 'revenue' ? money(p, v, true) : fmtNum(v))} />
        <div className="countries-list tablewrap">
          <table className="dt wrap-th">
            <thead>
              <tr>
                <th>Country</th>
                {installs && <th className="num">Installs</th>}
                <th className="num">Revenue</th>
                <th className="num">{bought[1][0].toUpperCase() + bought[1].slice(1)}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={r.key} className={r.country && r.country === active ? 'sel' : undefined} onMouseEnter={() => setActive(r.country)} onMouseLeave={() => setActive(null)}>
                  <td>
                    <span className="country">
                      <i className="swatch" style={{ background: r.country ? rampColor(r[view], top, view) : 'var(--map-none)' }} />
                      {r.name}
                    </span>
                  </td>
                  {installs && <td className={`num${view === 'installs' ? ' b' : ''}`}>{value(r, 'installs')}</td>}
                  <td className={`num${view === 'revenue' ? ' b' : ''}`}>{value(r, 'revenue')}</td>
                  <td className="num">{fmtNum(r.purchases)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 12 && (
            <button className="linkish" onClick={() => setAll(!all)}>
              {all ? 'Show the top 12' : `Show all ${rows.length}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Revenue by store (left), and what Glitchless measured on that store's platform (right): its sessions, players and
// revenue per player.
function RevenueStores({ p }) {
  const max = Math.max(...p.rows.map((r) => r.revenue), 0) || 1;
  const per = p.players_are_sessions ? 'session' : 'player';
  return (
    <>
      <div className="tablewrap">
        <table className="dt wrap-th">
          <thead>
            <tr>
              <th>Store</th>
              <th style={{ width: '34%' }}>Revenue</th>
              <th className="num">Purchases</th>
              <th style={{ borderLeft: '1px solid var(--border)' }}>Platform</th>
              <th className="num">Sessions</th>
              {!p.players_are_sessions && <th className="num">Players</th>}
              <th className="num" title={`${p.store_name}'s revenue in that store over the ${per}s Glitchless measured on its platform`}>
                Per {per}
              </th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.store}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <b>{r.name}</b>
                </td>
                <td>
                  <div className="barrow" style={{ gridTemplateColumns: '1fr minmax(72px, max-content)' }}>
                    <div className="bt">
                      <div className="bf" style={{ width: `${(r.revenue / max) * 100}%`, background: '#f2545b' }} />
                    </div>
                    <div className="bv">
                      {money(p, r.revenue)} <span className="muted">· {fmtPct(r.share_pct, 0)}</span>
                    </div>
                  </div>
                </td>
                <td className="num">{fmtNum(r.purchases)}</td>
                <td style={{ borderLeft: '1px solid var(--border)' }}>{r.platform ?? <span className="muted">–</span>}</td>
                <td className="num">{fmtNum(r.sessions)}</td>
                {!p.players_are_sessions && <td className="num">{fmtNum(r.players)}</td>}
                <td className="num">{money(p, r.per_player)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const stars = (v) => (v == null ? '–' : `${fmtNum(v, 1)} ★`);

// A store's score: the store's own overall number where it has one (Apple's rating, Steam's summary), then the average
// of the written reviews synced in the window; how each is counted is in scoreInfo, behind the info icon.
function Score({ p }) {
  const o = p.overall;
  const s = p.synced;
  const steam = p.store === 'steam';
  return (
    <div className="score">
      {o && p.store === 'app_store' && <Figure label="Apple's rating" value={stars(o.average)} sub={`${fmtNum(o.count)} ${o.count === 1 ? 'rating' : 'ratings'}${o.current ? ` · ${o.current.version ?? 'this version'}: ${stars(o.current.average)}` : ''}`} />}
      {o && steam && <Figure label="On Steam" value={o.desc ?? fmtPct(o.positive_pct, 0)} sub={`${fmtPct(o.positive_pct, 0)} of ${fmtNum(o.count)} positive`} />}
      {s && <Figure label={o ? 'This window' : null} value={steam ? fmtPct(s.positive_pct, 0) : stars(s.average)} sub={steam ? `positive, of ${fmtNum(s.reviews)}` : `${fmtNum(s.reviews)} ${s.reviews === 1 ? 'review' : 'reviews'}${o ? '' : ' in this window'}`} />}
      {!s && <Figure label="This window" value="–" sub="no reviews synced" />}
    </div>
  );
}

function scoreInfo(p) {
  const o = p.overall;
  const s = p.synced;
  return [
    o && p.store === 'app_store' && `Apple's rating: ${stars(o.average)} from ${fmtNum(o.count)} ${o.count === 1 ? 'rating' : 'ratings'}.${o.current ? ` ${o.current.version ?? 'This version'}: ${stars(o.current.average)} from ${fmtNum(o.current.count)}.` : ''}`,
    o && p.store === 'steam' && `Steam's summary of every review: ${fmtPct(o.positive_pct, 0)} positive of ${fmtNum(o.count)}.`,
    s && `${p.store === 'steam' ? 'The positive share' : 'The average'} of the ${fmtNum(s.reviews)} written ${s.reviews === 1 ? 'review' : 'reviews'} synced in this window${s.since ? ` (since ${fmtTime(s.since, true)})` : ''}.`,
    s?.stars && `Stars: ${s.stars.map((n, i) => `${i + 1}★ ${n}`).join(', ')}.`,
    ...(p.notes ?? []),
  ];
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
      {p.builds.length > 0 && (
        <div className="tablewrap" style={{ marginTop: 8 }}>
          <table className="dt">
            <thead>
              <tr>
                <th>Build</th>
                <th>Live from</th>
                <th className="num">Reviews</th>
                <th className="num">Positive</th>
                <th className="num" title="Negative reviews that mention stutter, lag, fps, freezes, crashes or optimization, of all reviews written while this build was live">
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
      <TimeSeries ts={p.ts} height={140} series={[{ ...counted, color: 'var(--ink)' }, ...(measured ? [{ ...measured, color: '#3d8cf5' }] : [])]} />
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
            <TimeSeries ts={p.ts} height={130} series={[{ ...p.sales_series[0], color: 'var(--ink)' }, { ...p.sales_series[1], color: '#ff6b57' }]} />
          </div>
        )}
        {p.wishlist_series && (
          <div style={{ flex: 1, minWidth: 220 }}>
            <TimeSeries ts={p.ts} height={130} series={[{ ...p.wishlist_series[0], color: '#1fae84' }, { ...p.wishlist_series[1], color: '#f2a93b' }]} />
          </div>
        )}
      </div>
    </>
  );
}

function Figure({ label, value, sub, title }) {
  return (
    <div className="figure" title={title}>
      {label && <div className="figure-label">{label}</div>}
      <div className="figure-value">{value}</div>
      {sub && <div className="figure-sub">{sub}</div>}
    </div>
  );
}

const iso = (ts) => (ts == null ? null : new Date(ts).toISOString());
const MONEY_STATS = new Set(['revenue', 'per_player', 'mrr', 'refunds']);

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
  if (p.type === 'store_score') {
    const o = p.overall;
    return [
      ['What', 'Value', 'Count'],
      ...(o && p.store === 'app_store' ? [["Apple's rating (stars)", o.average, o.count]] : []),
      ...(o && p.store === 'steam' ? [['Steam positive (%)', o.positive_pct, o.count]] : []),
      ...(p.synced ? [[p.store === 'steam' ? 'Reviews in this window, positive (%)' : 'Reviews in this window (stars)', p.synced.average ?? p.synced.positive_pct, p.synced.reviews]] : []),
    ];
  }
  if (p.type === 'store_sales') {
    const series = [...(p.sales_series ?? []), ...(p.wishlist_series ?? [])];
    return [['Day', ...series.map((s) => s.label)], ...p.ts.map((t, i) => [iso(t).slice(0, 10), ...series.map((s) => s.values[i])])];
  }
  if (p.type === 'store_revenue') {
    const cur = p.currency ? ` (${p.currency})` : '';
    if (p.measure === 'by_day') {
      const own = p.series.find((s) => s.key === 'purchases' || s.label === "The game's purchase events");
      if (p.net) return [['Day', `Revenue${cur}`, 'Payments', `Refunds${cur}`, `Disputes${cur}`, `Stripe's fees${cur}`, `Net${cur}`, 'New paying customers', ...(own ? [`The game's purchase events${cur}`] : [])], ...p.days.map((d, i) => [d, p.series[0].values[i], p.transactions[i], p.refunds[i], p.disputes[i], p.fees[i], p.net[i], p.new_customers[i], ...(own ? [own.values[i]] : [])])];
      return [['Day', `Revenue${cur}`, 'Transactions', `MRR${cur}`, 'Active subscriptions', 'Active trials', ...(own ? [`The game's purchase events${cur}`] : [])], ...p.days.map((d, i) => [d, p.series[0].values[i], p.transactions[i], p.mrr[i], p.actives[i], p.trials[i], ...(own ? [own.values[i]] : [])])];
    }
    if (p.measure === 'by_product') return [['Product', 'Product ID', `Revenue${cur}`, 'Share (%)', 'Payments', `Refunds${cur}`, 'Refunds'], ...p.rows.map((r) => [r.name, r.product, r.revenue, r.share_pct, r.transactions, r.refunds, r.refund_count])];
    if (p.measure === 'players_by_day') return [['Day', ...p.series.map((s) => s.label)], ...p.days.map((d, i) => [d, ...p.series.map((s) => s.values[i])])];
    if (p.measure === 'by_country') {
      if (p.has?.installs === false) return [['Country code', 'Country', `Revenue${cur}`, 'Payments'], ...p.rows.map((r) => [r.country, r.name, r.revenue, r.purchases])];
      return [['Country code', 'Country', 'Installs', `Revenue${cur}`, 'Purchases'], ...p.rows.map((r) => [r.country, r.name, r.installs, r.revenue, r.purchases])];
    }
    if (p.measure === 'by_store') return [['Store', `Revenue${cur}`, 'Share (%)', 'Purchases', 'Glitchless: platform', 'Glitchless: sessions', 'Glitchless: players', `Revenue per ${p.players_are_sessions ? 'session' : 'player'}${cur}`], ...p.rows.map((r) => [r.name, r.revenue, r.share_pct, r.purchases, r.platform, r.sessions, r.players, r.per_player])];
    if (p.measure === 'by_version') return [['Version', `Revenue${cur}`, 'Share (%)', 'Transactions', 'Glitchless: players', 'Glitchless: sessions', `Revenue per player${cur}`, ...(p.comparable ? [`The game's purchase events${cur}`] : []), 'Glitchless: crash-free sessions (%)', 'Glitchless: frame p95 (ms)'], ...p.rows.map((r) => [r.version, r.revenue, r.share_pct, r.transactions, r.players, r.sessions, r.per_player, ...(p.comparable ? [r.purchases] : []), r.crash_free_pct, r.frame_p95])];
    return [['Stat', `Value${MONEY_STATS.has(p.measure) ? cur : ''}`, 'Day'], [p.title, p.value, p.day ?? p.to_day ?? null]];
  }
  return null;
}

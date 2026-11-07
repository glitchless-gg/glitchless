// Robux, Roblox's currency, as a board's money. A Roblox game sells developer products and passes for Robux, so its
// purchase events say `currency: 'ROBUX'` (SPEC §2), and a dashboard can keep its money in Robux (`currency: "ROBUX"`).
// Robux are kept apart from real currencies as any two currencies are (sums.js): never added to dollars, never
// converted. They become money only through Roblox's Developer Exchange (DevEx), so a money panel can opt in to an
// estimate in US dollars at DevEx's standard rate (`devex: true`), always labelled an estimate: it is the price players
// paid in Robux at that rate, and what the experience earns, and can cash out, is less (Roblox keeps a share of each sale,
// and pays out only past a minimum, on request). The rate is revenue.js's DEVEX, which the Roblox integration's revenue
// panels use too, so both read the same.

import { DEVEX } from './revenue.js';
import { round } from './analytics.js';

export const ROBUX = 'ROBUX';

// Where DEVEX's rates come from, and when they were read: Roblox's Developer Exchange page.
export const DEVEX_SOURCE = { url: 'https://create.roblox.com/docs/production/monetization/developer-exchange', checked: '2026-11-07', since: '2025-09-05' };

// A board's currency as given (any case) → as stored: a three-letter ISO 4217 code or ROBUX, else null.
export function boardCurrency(v) {
  const c = String(v ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) || c === ROBUX ? c : null;
}

// What `robux` would be worth in US dollars at DevEx's standard rate, as a money panel answers it (`devex`): the
// Roblox integration's revenue panels' shape (revenue.js devexOf: robux, usd, rate, adult_rate, minimum), with
// `estimate` always true and where the rate comes from. `usd` is rounded to cents.
export function devexEstimate(robux) {
  return { estimate: true, robux: robux ?? null, usd: devexUsd(robux), rate: DEVEX.usd, adult_rate: DEVEX.adult_usd, minimum: DEVEX.minimum, since: DEVEX_SOURCE.since, source: DEVEX_SOURCE.url };
}

// The same estimate for many numbers at once (a breakdown's rows): each in dollars, rounded to cents.
export function devexUsd(robux) {
  return robux == null ? null : round(robux * DEVEX.usd, 2);
}

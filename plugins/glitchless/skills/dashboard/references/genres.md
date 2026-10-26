# Panels for each kind of game

What the [dashboard skill](../SKILL.md) adds for a game with these features. Use the game's own names for
events, attributes and pages.

**Balance, outcomes and economies.** A rate breakdown answers "which hero wins too often" with how sure it is: each
row's whisker is the range its rate likely sits in, and a row whose range misses the line (all heroes, or `expect`)
is drawn in colour. Set `min` so rows of a handful of matches stay out (100 or more for a balance question), and say
in the `note` what the line should be ("Should sit near 50%"). A game with published odds (a gacha banner's 0.6%) can
put them in `expect` on a rate of its pulls: the board and a finding then say when what players got misses it, and the
developer decides what that means. Per-hour numbers (`per: "$hours"`) compare versions fairly when sessions get
longer or shorter, so put an economy's earn and spend rates in stats and add a `versions` panel; a sum per hour that
moves 50% between versions, or a distribution whose median moves 30%, becomes a finding. To check one combination
the board doesn't show, ask `glitchless_events` with `name`, `rate` and `by` (and a filter in `name`), or `of` for a
distribution.

**Money.** A sum of events that carry a `currency` is money: the dashboard shows it with the currency's symbol and
two decimals. A game has one currency, the dashboard's `currency` (`glitchless_set_dashboard` with
`currency: "USD"`, sent again with every save) or else the one most purchases are sent in; purchases in another
currency are listed on the panel as left out, never added in. If one shows up, fix the game (convert before
sending, or send the store's price in one currency) rather than the board. Revenue is hidden on a shared board
unless the link is made to show it. A game connected to RevenueCat (Glitchless Cloud: Settings → Integrations) gets a Revenue page of
`store_revenue` panels by itself: that is the real revenue (RevenueCat counts production purchases only), with installs
and active users next to the players Glitchless measures, so keep it, and read it with `glitchless_revenue`; the game's
own `purchase` sums are for revenue by item, level or player. A game that sells through its own Stripe account gets a
Stripe one (refunds, fees, new paying customers, revenue by product). For its revenue by version, the game's server puts
the player's Glitchless session ID (`Glitchless.instance.sessionId` in a web game) in the Checkout Session's
`client_reference_id`, or `glitchless_session` metadata on it or the PaymentIntent.

**Who is playing.** A game that sets properties splits anything by them (`by: "$rank"`): win rate by hero at each
rank is a page with `"where": { "$rank": ["diamond", "master"] }` and the same breakdown on it; retention by
`$spender`, frame time by `$preset` (the Performance view's by-property table), versions by `$class`. A property with
more than 200 values a day is an ID and reads as "(too many values)": fix the game. These read the sessions, so
ranges of 31 days or less.

**Multiplayer.** A game with online play gets a Network page: `stat` ping_p95 and disconnect_pct, a `net` panel by
`$region` (or `$link` on mobile: Wi-Fi against mobile data) and one with `show: "disconnects"`, and `findings`; a
whole lobby lagging at once (the server) and one player lagging (their connection) are findings of their own. With
match groups, keep the `matches` view. With dedicated servers in server mode, a Servers page (`servers_now`,
`server_tick_p95`, `server_crash_free_pct`, a `servers` panel `by: "players"`) or the built-in `servers` view; the
servers' sessions are kept under `<game>.server`, never counted as players. An open world splits by `$zone`.

**Platforms, browsers, devices.** A web game: `breakdown` by `$browser`. A game on PC, Mac and Steam Deck: by
`$platform`. Any game whose frame times vary: by `$device_tier`, next to frame time. For a game on iOS and Android, put the split on its main page: `breakdown` by `$platform` (players or
sessions on each), the same with `event: "purchase"` (purchases tracked on each), and with RevenueCat connected,
`store_revenue` `by_store` (the money in each store) and `by_country` (where installs and money come from). Add a
`store_score` per store the game is connected to.

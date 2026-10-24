# The shared leaderboard

The game talks to a leaderboard through one small interface (`src/leaderboard/index.js`). Without
`VITE_LAGDERBOARD_API` it keeps runs in the player's own browser. With it, every run goes to the leaderboard API in
[`server/`](server), and the sheet shows everyone's runs.

## The API

| Route | Does |
| --- | --- |
| `POST /runs` | a run → `{ id, rank, total, approximate, deviceBest, deviceRuns }`, rank within its device class |
| `GET /devices?class=phone&limit=25` | the best run per device, highest first |
| `GET /runs?class=phone&limit=25` | single runs, highest first (the last 30 days) |
| `GET /health` | `{ ok: true }` |

A run is `{ score, deviceClass, deviceName, seconds, gpu?, browser?, os?, hz?, version?, sessionId?, id? }`. The
game posts it as `text/plain` JSON, a CORS-safelisted type, so a board on another origin costs no preflight. The
lists answer with `Cache-Control: public, max-age=30`, so a CDN in front takes most reads.

**Rank.** Exact within the top 50 of a class. Below that it comes from a histogram of scores in bins about 2.3%
wide, so the end card says "about #1,204 of 54,000". One read of the histogram serves every submit for 15 seconds.

**Checks.** A score is a whole number from 1 to 8,000,000, a run lasts 3 to 600 seconds, the class is phone, tablet
or desktop. Device names keep letters, digits and the punctuation real ones use, up to 60 characters. One address
may post 30 runs in 10 minutes. `LAGDERBOARD_HIDE` takes device names to leave off the lists.

Scores are measured in the player's browser, so a determined person can post a made-up one. For a fun board that's
acceptable. If it isn't, every run carries its Glitchless `sessionId`, and that session's frame windows show whether
it really slowed down at the end.

## Running it

```bash
npm run server -w lagderboard          # http://localhost:7798, the board in data/lagderboard-board.json
npm test -w lagderboard                # the store contract, the service and the HTTP API
VITE_LAGDERBOARD_API=http://localhost:7798 npm run dev -w lagderboard
```

`server/serve.js` is plain Node with no dependencies and a JSON file store: enough for a self-hosted board. To put
the API inside another Node server, use `nodeHandler()` from `server/node.js` with `createHandler(service,
{ prefix: '/lagderboard', origins: [...] })`.

## Another store

The service needs seven calls (listed at the top of `server/leaderboard.js`): keep a run, raise a device's best and
count its runs, count a score bin, read the histogram, the top devices, the top runs, and count hits for rate
limits. Each maps to a single sorted-key read or write, so any key-value database with ordered keys fits.
`server/test/store-contract.js` is the contract: call `storeContract(name, makeStore)` with your store and it runs
the same checks as the memory and file stores.

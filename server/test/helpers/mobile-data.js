// A game on Google Play and the App Store, for tests, the cloud's local end-to-end run and screenshots: version 1.4.1
// (code 141) went out 20 days ago, 1.4.2 (code 142) four days ago, and 1.4.2 renders slower, hangs more and crashes
// more, as both stores and the reviews say. In the stores' own shapes (Google Play's reviews.list and Reporting API
// rows, App Store Connect's customerReviews and XcodeMetrics, Apple's RSS feed), so the adapters parse what the stores
// send. It goes with steam-data.js's scenarioSessions (1.4.1 then 1.4.2, the same release time).
import { mulberry32 } from './steam-data.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const PACKAGE = 'gg.glitchless.caverun';
export const APPLE_ID = '6800000001';

const TEXTS = {
  good: ['Great little cave runner, smooth on my phone.', 'Fun and fair. The new caves look amazing.', 'Love the art and the music.'],
  bad: ['Too many ads.', 'Levels feel too similar.'],
  perf: ['Since the update the caves stutter and the fps drops a lot.', 'Crashes every time I enter caves-2 now.', 'Game freezes for a second on every room after 1.4.2.', 'Really laggy since the last update.'],
};
const PHONES = [
  { device: 'a52q', manufacturer: 'Samsung', productName: 'Galaxy A52', cpuMake: 'Qualcomm', cpuModel: 'SM7125', glEsVersion: 196610, ramMb: 6144 },
  { device: 'redfin', manufacturer: 'Google', productName: 'Pixel 5', cpuMake: 'Qualcomm', cpuModel: 'SM7250', glEsVersion: 196610, ramMb: 8192 },
  { device: 'mt6765', manufacturer: 'Xiaomi', productName: 'Redmi 9A', cpuMake: 'MediaTek', cpuModel: 'MT6765', glEsVersion: 196609, ramMb: 2048 },
];

export function mobileScenario({ now = Date.now(), seed = 21, release = now - 4 * DAY } = {}) {
  const rnd = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const versions = [
    { name: '1.4.1', code: 141, from: now - 20 * DAY, appleId: 'asv-141' },
    { name: '1.4.2', code: 142, from: release, appleId: 'asv-142' },
  ];
  const at = (ts) => (ts >= release ? versions[1] : versions[0]);
  const reviews = [];
  for (let i = 0; i < 160; i++) {
    const ts = now - Math.floor(rnd() * 28 * DAY) - 60_000;
    const v = at(ts);
    const late = v.name === '1.4.2';
    const rating = rnd() < (late ? 0.5 : 0.85) ? pick([4, 5, 5]) : pick([1, 2, 3]);
    const kind = rating >= 4 ? 'good' : rnd() < (late ? 0.8 : 0.2) ? 'perf' : 'bad';
    reviews.push({ i, ts, version: v, rating, text: pick(TEXTS[kind]), phone: pick(PHONES), territory: pick(['USA', 'USA', 'GBR', 'DEU']) });
  }
  reviews.sort((a, b) => b.ts - a.ts);
  return { now, release, versions, reviews, ...vitals(now, release, rnd) };
}

// Play's daily vitals by version code over 30 days, and Apple's metrics by version.
function vitals(now, release, rnd) {
  const play = [];
  for (let d = 30; d >= 2; d--) {
    const t = now - d * DAY;
    const day = new Date(t).toISOString().slice(0, 10);
    for (const v of [{ code: 141, live: true }, { code: 142, live: t >= release }]) {
      if (!v.live) continue;
      const late = v.code === 142;
      const users = late ? 300 + Math.floor(rnd() * 80) : t >= release ? 60 : 380 + Math.floor(rnd() * 60);
      play.push({ day, code: v.code, users, slow20: late ? 0.14 : 0.04, slow30: late ? 0.24 : 0.09, crash: late ? 0.024 : 0.006, anr: late ? 0.005 : 0.002 });
    }
  }
  const apple = [
    { version: '1.4.1', hang: 1.2, launch50: 1650, launch90: 2600, hitch: 2.1 },
    { version: '1.4.2', hang: 4.1, launch50: 1820, launch90: 3100, hitch: 6.8 },
  ];
  const signatures = [
    { signature: 'ShaderCache::Compile (in CaveRun) +1204', weight: 0.62 },
    { signature: 'AudioMixer::Load (in CaveRun) +88', weight: 0.21 },
  ];
  return { play, apple, signatures };
}

// ── the stores' own shapes ──

export function playReview(r) {
  return {
    reviewId: `gp:${r.i}`,
    authorName: `Player ${r.i}`,
    comments: [{ userComment: { text: `\t${r.text}`, lastModified: { seconds: String(Math.floor(r.ts / 1000)), nanos: 0 }, starRating: r.rating, reviewerLanguage: 'en_US', device: r.phone.device, androidOsVersion: 33, appVersionCode: r.version.code, appVersionName: r.version.name, thumbsUpCount: 0, thumbsDownCount: 0, deviceMetadata: { productName: r.phone.productName, manufacturer: r.phone.manufacturer, deviceClass: 'phone', screenWidthPx: 1080, screenHeightPx: 2400, nativePlatform: 'arm64-v8a', screenDensityDpi: 420, glEsVersion: r.phone.glEsVersion, cpuModel: r.phone.cpuModel, cpuMake: r.phone.cpuMake, ramMb: r.phone.ramMb } } }],
  };
}

export function connectReview(r) {
  return { type: 'customerReviews', id: `as-${r.i}`, attributes: { rating: r.rating, title: r.rating >= 4 ? 'Great' : 'Not great', body: r.text, reviewerNickname: `player${r.i}`, createdDate: new Date(r.ts).toISOString(), territory: r.territory } };
}

export function rssEntry(r, appId = APPLE_ID) {
  return {
    author: { uri: { label: `https://itunes.apple.com/us/reviews/id${100 + r.i}` }, name: { label: `player${r.i}` }, label: '' },
    updated: { label: new Date(r.ts).toISOString().replace('Z', '-00:00') },
    'im:rating': { label: String(r.rating) },
    'im:version': { label: r.version.name },
    id: { label: String(14600000000 + r.i) },
    title: { label: r.rating >= 4 ? 'Great' : 'Not great' },
    content: { label: r.text, attributes: { type: 'text' } },
    link: { attributes: { rel: 'related', href: `https://itunes.apple.com/us/review?id=${appId}&type=Purple%20Software` } },
    'im:voteSum': { label: '0' },
    'im:contentType': { attributes: { term: 'Application', label: 'Application' } },
    'im:voteCount': { label: '0' },
  };
}

// The Reporting API's MetricsRow for a day and version code of a metric set.
export function metricsRow(row, set, dims) {
  const values = { slowRenderingRate: { slowRenderingRate20Fps: row.slow20, slowRenderingRate30Fps: row.slow30 }, crashRate: { crashRate: row.crash }, anrRate: { anrRate: row.anr } }[set];
  const [y, m, d] = row.day.split('-').map(Number);
  return {
    aggregationPeriod: 'DAILY',
    startTime: { year: y, month: m, day: d, timeZone: { id: 'America/Los_Angeles' } },
    dimensions: dims,
    metrics: [...Object.entries(values).map(([metric, v]) => ({ metric, decimalValue: { value: String(v) } })), { metric: 'distinctUsers', decimalValue: { value: String(row.users) } }],
  };
}

// App Store Connect's perfPowerMetrics answer (XcodeMetrics), its fields as Apple documents them.
export function xcodeMetrics(sc) {
  const points = (key) => sc.apple.map((a) => ({ version: a.version, value: a[key], errorMargin: 0.1, goal: '' }));
  const dataset = (key, percentile = 'percentile.fifty') => ({ filterCriteria: { percentile, device: 'all_iPhones', deviceMarketingName: 'All iPhones' }, points: points(key) });
  return {
    version: '1.0',
    insights: { trendingUp: [], regressions: [] },
    productData: [
      {
        platform: 'iOS',
        metricCategories: [
          { identifier: 'HANG', metrics: [{ identifier: 'hangRate', unit: { identifier: 'sec/hr', displayName: 'seconds per hour' }, goalKeys: [], datasets: [dataset('hang')] }] },
          { identifier: 'LAUNCH', metrics: [{ identifier: 'launchTime', unit: { identifier: 'ms', displayName: 'Milliseconds' }, goalKeys: [], datasets: [dataset('launch50'), dataset('launch90', 'percentile.ninety')] }, { identifier: 'resumeTime', unit: { identifier: 'ms', displayName: 'Milliseconds' }, datasets: [dataset('launch50')] }] },
          { identifier: 'ANIMATION', metrics: [{ identifier: 'scrollHitchTimeRatio', unit: { identifier: 'ms/s', displayName: 'ms per s' }, goalKeys: [], datasets: [dataset('hitch')] }] },
          { identifier: 'MEMORY', metrics: [{ identifier: 'peakMemory', unit: { identifier: 'MB', displayName: 'MB' }, datasets: [dataset('hang')] }] },
        ],
      },
    ],
  };
}

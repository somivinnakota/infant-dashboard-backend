/**
 * Meta Graph API — Instagram and Facebook Page Insights (replaces CSV uploads)
 *
 * .env:
 *   FACEBOOK_PAGE_ID, FACEBOOK_ACCESS_TOKEN   (token auto-refreshed by server.js)
 *   META_GRAPH_VERSION                         optional, default v24.0
 *
 * How data is collected:
 *   - Daily values go back to 1 January of last year so year-on-year comparisons are fair.
 *   - Every value is saved to meta-history.json. After the first backfill, each refresh only
 *     re-fetches the last few days, and history keeps growing beyond Meta's retention window.
 *   - Instagram "total_value" metrics (views, interactions, profile visits, link taps) only ever
 *     return ONE total for the requested range, so they are fetched one day at a time
 *     (50 days per Graph batch request).
 *   - Results are cached in memory for 30 minutes.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v24.0'}`;
const HTTP_TIMEOUT = 30000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const REFETCH_DAYS = 4;          // recent days are re-fetched every time (Meta finalises data up to 48h late)
const DAY_MS = 86400000;
const STORE_FILE = path.join(__dirname, 'meta-history.json');

// Instagram metrics fetched per day with metric_type=total_value. Metrics Meta rejects are skipped.
const IG_TOTAL_METRICS = {
  views: 'ig-views',
  total_interactions: 'ig-interactions',
  profile_views: 'ig-visits',
  profile_links_taps: 'ig-clicks',
};

// Series where a run of 0s at the start means "Meta has no data that far back".
const NO_LEADING_ZEROS = new Set(['ig-views', 'ig-interactions', 'ig-reach', 'fb-views', 'fb-viewers', 'fb-interactions']);

// Facebook Page metrics (period=day), keyed to match Meta Business Suite exports:
// its "Views" export is page_media_view and its "Viewers" export is page_total_media_view_unique.
// fb-clicks (link clicks) has no reliable API metric, so it comes from uploaded exports only.
const FB_METRICS = {
  'fb-views': 'page_media_view',                // Meta "Views"
  'fb-viewers': 'page_total_media_view_unique', // Meta "Viewers" (unique people)
  'fb-visits': 'page_views_total',              // page visits
  'fb-interactions': 'page_post_engagements',   // reactions, comments, shares, clicks
  'fb-follows': 'page_daily_follows',           // new follows
};
// Bump when a key's meaning changes; older saved values for those keys are dropped and re-fetched.
const STORE_VERSION = 2;
const CHANGED_IN_V2 = ['fb-views', 'fb-clicks'];

// ── Small helpers ─────────────────────────────────────────────────────────────

const cache = new Map();
function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return Promise.resolve(hit.value);
  return loader().then(value => { cache.set(key, { value, time: Date.now() }); return value; });
}
function invalidate() { cache.clear(); }

const token = () => process.env.FACEBOOK_ACCESS_TOKEN;
const pageId = () => process.env.FACEBOOK_PAGE_ID;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const toTs = iso => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
const addDays = (iso, n) => isoDay(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS);
const today = () => isoDay(Date.now());
const historyStart = () => `${new Date().getUTCFullYear() - 1}-01-01`;
const apiError = err => err?.response?.data?.error?.message || err?.message || String(err);

function readStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const store = { version: s.version || 1, series: s.series || {}, backfilled: s.backfilled || {}, igDays: s.igDays || {} };
    if (store.version < STORE_VERSION) {
      for (const key of CHANGED_IN_V2) { delete store.series[key]; delete store.backfilled[key]; }
      store.version = STORE_VERSION;
    }
    return store;
  } catch {
    return { version: STORE_VERSION, series: {}, backfilled: {}, igDays: {} };
  }
}
// Merges into what's on disk, so the background backfill and normal refreshes never overwrite each other.
function writeStore(store) {
  const disk = readStore();
  for (const [key, byDate] of Object.entries(store.series)) Object.assign((disk.series[key] ||= {}), byDate);
  Object.assign(disk.backfilled, store.backfilled);
  Object.assign(disk.igDays, store.igDays);
  disk.version = STORE_VERSION;
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(disk)); }
  catch (err) { console.warn('Could not save meta-history.json:', err.message); }
}
function saveValues(store, key, points) {
  const s = (store.series[key] ||= {});
  for (const { date, value } of points) s[date] = value;
}

async function graphGet(url, params, accessToken = token()) {
  const { data } = await axios.get(url, { params: { ...params, access_token: accessToken }, timeout: HTTP_TIMEOUT });
  return data;
}

// Up to 50 GET requests in one HTTP call. Returns [{ ok, status, body }] in order.
async function graphBatch(relativeUrls) {
  const batch = JSON.stringify(relativeUrls.map(u => ({ method: 'GET', relative_url: u })));
  const body = new URLSearchParams({ access_token: token(), batch, include_headers: 'false' });
  const { data } = await axios.post(`${GRAPH}/`, body, { timeout: 90000 });
  return data.map(r => {
    let parsed = null;
    try { parsed = JSON.parse(r?.body || 'null'); } catch { /* ignore */ }
    return { ok: r?.code === 200, status: r?.code, body: parsed };
  });
}

// Fetch a period=day time series in chunks. A failing chunk is skipped, not fatal.
// Meta stamps each value with the END of its day, so the value belongs to the day before end_time.
async function fetchDaily(url, params, since, until, chunkDays, accessToken) {
  const points = [];
  for (let start = since; start <= until; start = addDays(start, chunkDays)) {
    const end = [addDays(start, chunkDays), addDays(until, 1)].sort()[0];
    try {
      const data = await graphGet(url, { ...params, period: 'day', since: toTs(start), until: toTs(end) }, accessToken);
      for (const item of data?.data || []) {
        for (const v of item.values || []) {
          if (v.end_time) points.push({ date: isoDay(Date.parse(v.end_time) - DAY_MS), value: Number(v.value) || 0 });
        }
      }
    } catch (err) {
      console.warn(`Meta ${params.metric} ${start}→${end}: ${apiError(err)}`);
    }
  }
  return points;
}

// Only fetch what's missing: full history the first time, then just the recent days.
function fetchFrom(store, key) {
  return store.backfilled[key] ? addDays(today(), -REFETCH_DAYS) : historyStart();
}

// ── Accounts ──────────────────────────────────────────────────────────────────

async function getPageToken() {
  return cached('fb-page-token', async () => {
    const data = await graphGet(`${GRAPH}/${pageId()}`, { fields: 'access_token' });
    if (!data?.access_token) throw new Error('Could not get a Page access token — check the token has pages_read_engagement');
    return data.access_token;
  });
}

async function getInstagramAccountId() {
  return cached('ig-account-id', async () => {
    const data = await graphGet(`${GRAPH}/${pageId()}`, { fields: 'instagram_business_account' });
    const igId = data?.instagram_business_account?.id;
    if (!igId) throw new Error('No Instagram Business Account linked to this Facebook Page.');
    return igId;
  });
}

// ── Instagram ─────────────────────────────────────────────────────────────────

// Check once which total_value metrics this account/API version accepts.
async function usableIgMetrics(igId) {
  return cached('ig-usable-metrics', async () => {
    const day = addDays(today(), -3);
    const ok = [];
    await Promise.all(Object.keys(IG_TOTAL_METRICS).map(async metric => {
      try {
        await graphGet(`${GRAPH}/${igId}/insights`, { metric, metric_type: 'total_value', period: 'day', since: toTs(day), until: toTs(addDays(day, 1)) });
        ok.push(metric);
      } catch (err) {
        console.warn(`Instagram metric ${metric} not available: ${apiError(err)}`);
      }
    }));
    return ok;
  });
}

// One request per day for the per-day totals; days already saved are skipped.
let igBackfillRunning = false;
async function fetchIgDailyTotals(store, igId, metrics, maxDays = Infinity) {
  if (!metrics.length) return;
  const days = [];
  const recent = addDays(today(), -REFETCH_DAYS);
  for (let d = historyStart(); d <= today(); d = addDays(d, 1)) {
    if (!store.igDays[d] || d >= recent) days.push(d);
  }
  days.reverse(); // newest first, so the dashboard fills from the present backwards
  const todo = days.slice(0, maxDays);

  for (let i = 0; i < todo.length; i += 50) {
    const group = todo.slice(i, i + 50);
    const urls = group.map(d =>
      `${igId}/insights?metric=${metrics.join(',')}&metric_type=total_value&period=day&since=${toTs(d)}&until=${toTs(addDays(d, 1))}`);
    let results;
    try { results = await graphBatch(urls); }
    catch (err) { console.warn('Instagram batch failed:', apiError(err)); break; }

    results.forEach((r, j) => {
      const date = group[j];
      if (r.ok) {
        for (const item of r.body?.data || []) {
          const key = IG_TOTAL_METRICS[item.name];
          if (key) saveValues(store, key, [{ date, value: Number(item.total_value?.value) || 0 }]);
        }
        store.igDays[date] = true;
      } else if (r.status === 400) {
        store.igDays[date] = true; // outside Meta's retention window: don't ask again
      }
    });
    writeStore(store);
  }
}

async function getInstagramSeries(store) {
  const igId = await getInstagramAccountId();

  // Reach: a true daily time series (max 30 days per request).
  const reach = await fetchDaily(`${GRAPH}/${igId}/insights`, { metric: 'reach' }, fetchFrom(store, 'ig-reach'), today(), 30);
  if (reach.length) { saveValues(store, 'ig-reach', reach); store.backfilled['ig-reach'] = true; }

  // New followers: Meta only exposes the last 30 days, so history builds up from here on.
  const follows = await fetchDaily(`${GRAPH}/${igId}/insights`, { metric: 'follower_count' }, addDays(today(), -29), addDays(today(), -1), 30);
  if (follows.length) {
    // Some API versions return a running total instead of daily adds; convert if so.
    const sorted = follows.sort((a, b) => a.date.localeCompare(b.date));
    const median = sorted.map(p => p.value).sort((a, b) => a - b)[Math.floor(sorted.length / 2)];
    const daily = median > 50
      ? sorted.slice(1).map((p, i) => ({ date: p.date, value: Math.max(0, p.value - sorted[i].value) }))
      : sorted;
    saveValues(store, 'ig-follows', daily);
  }

  // Views, interactions, profile visits, link taps: one total per day.
  const metrics = await usableIgMetrics(igId);
  if (igBackfillRunning) return;
  if (Object.keys(store.igDays).length < 60) {
    // First run: the last 60 days now so the page isn't empty, the rest in the background.
    await fetchIgDailyTotals(store, igId, metrics, 60);
    igBackfillRunning = true;
    fetchIgDailyTotals(readStore(), igId, metrics)
      .then(() => { console.log('Instagram history backfill complete'); invalidate(); })
      .catch(err => console.warn('Instagram backfill stopped:', apiError(err)))
      .finally(() => { igBackfillRunning = false; });
  } else {
    await fetchIgDailyTotals(store, igId, metrics);
  }
}

// ── Facebook ──────────────────────────────────────────────────────────────────

async function getFacebookSeries(store) {
  const pgToken = await getPageToken();
  await Promise.all(Object.entries(FB_METRICS).map(async ([key, metric]) => {
    const points = await fetchDaily(`${GRAPH}/${pageId()}/insights`, { metric }, fetchFrom(store, key), today(), 90, pgToken);
    if (points.length) { saveValues(store, key, points); store.backfilled[key] = true; }
  }));
}

// ── Combined ──────────────────────────────────────────────────────────────────

async function getAllMetaSeries() {
  return cached('meta-all', async () => {
    const store = readStore();
    const results = await Promise.allSettled([getInstagramSeries(store), getFacebookSeries(store)]);
    results.forEach(r => r.status === 'rejected' && console.warn('Meta API:', apiError(r.reason)));
    writeStore(store);
    const merged = readStore();

    const series = {};
    for (const [key, byDate] of Object.entries(merged.series)) {
      let rows = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
      // Meta answers 0 (not "no data") for days older than it keeps views/interactions for.
      // An active account never has weeks of exactly 0 views, so drop those leading zeros:
      // the days then count as missing, uploaded exports can fill them, and comparisons stay honest.
      if (NO_LEADING_ZEROS.has(key)) {
        const first = rows.findIndex(r => r.value > 0);
        rows = first === -1 ? [] : rows.slice(first);
      }
      series[key] = rows;
    }
    if (!Object.keys(series).length) {
      throw new Error(results.filter(r => r.status === 'rejected').map(r => apiError(r.reason)).join('; ') || 'No Meta data');
    }
    return { series, since: historyStart(), until: today(), source: 'meta-api' };
  });
}

async function getMetaStatus() {
  const result = { instagram: false, facebook: false, igAccountId: null, error: null };
  if (!token() || !pageId()) {
    result.error = 'FACEBOOK_PAGE_ID or FACEBOOK_ACCESS_TOKEN not set in .env';
    return result;
  }
  try {
    await graphGet(`${GRAPH}/${pageId()}`, { fields: 'id,name' }, await getPageToken());
    result.facebook = true;
  } catch (err) {
    result.error = `Facebook: ${apiError(err)}`;
    return result;
  }
  try {
    result.igAccountId = await getInstagramAccountId();
    result.instagram = true;
  } catch (err) {
    result.error = `Instagram: ${err.message}`;
  }
  return result;
}

module.exports = { getAllMetaSeries, getMetaStatus, getInstagramAccountId, invalidateCache: invalidate };
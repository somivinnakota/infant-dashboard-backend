/**
 * Meta Graph API — Instagram and Facebook Page Insights
 *
 * Fetches historical engagement metrics directly from the Graph API so the
 * dashboard no longer needs CSV uploads for ig-* and fb-* series.
 *
 * Instagram access requires the Facebook Page to have a linked Instagram
 * Business or Creator account.  The same Page access token is used for both.
 *
 * Environment variables read from process.env:
 *   FACEBOOK_PAGE_ID          — numeric Page ID
 *   FACEBOOK_ACCESS_TOKEN     — long-lived Page access token (auto-refreshed by server.js)
 *
 * The module caches every result in memory so repeated page loads don't hammer
 * the API.  Cache entries expire after CACHE_TTL_MS (default 30 minutes).
 */

const axios = require('axios');

const GRAPH = 'https://graph.facebook.com/v21.0';
const HTTP_TIMEOUT = 20000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const cache = new Map();

function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return Promise.resolve(hit.value);
  return loader().then(value => {
    cache.set(key, { value, time: Date.now() });
    return value;
  });
}

function invalidate() {
  cache.clear();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function token() {
  return process.env.FACEBOOK_ACCESS_TOKEN;
}

function pageId() {
  return process.env.FACEBOOK_PAGE_ID;
}

// Graph API paginates large date ranges; collect all pages.
async function graphGet(url, params) {
  const { data } = await axios.get(url, { params: { ...params, access_token: token() }, timeout: HTTP_TIMEOUT });
  return data;
}

/**
 * Facebook Page Insights requires a Page Access Token (not a User token).
 * Exchange the user token for a page token via /{page-id}?fields=access_token.
 * Cached so we only fetch it once per server session.
 */
async function getPageToken() {
  return cached('fb-page-token', async () => {
    const data = await graphGet(`${GRAPH}/${pageId()}`, { fields: 'access_token' });
    if (!data?.access_token) {
      throw new Error('Could not retrieve Page Access Token — check token permissions include pages_read_engagement');
    }
    return data.access_token;
  });
}

async function graphGetPage(url, params) {
  const pgToken = await getPageToken();
  const { data } = await axios.get(url, { params: { ...params, access_token: pgToken }, timeout: HTTP_TIMEOUT });
  return data;
}

// Convert Graph API value array [{ end_time, value }] → [{ date, value }]
function toSeries(values = []) {
  return values
    .map(v => ({ date: v.end_time ? v.end_time.slice(0, 10) : null, value: Number(v.value) || 0 }))
    .filter(v => v.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Build an ISO date string N days before today (UTC).
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// ── Instagram Business Account ID ─────────────────────────────────────────────

/**
 * Returns the Instagram Business Account ID linked to the Facebook Page.
 * Throws if no Instagram account is connected.
 */
async function getInstagramAccountId() {
  return cached('ig-account-id', async () => {
    const data = await graphGet(`${GRAPH}/${pageId()}`, {
      fields: 'instagram_business_account',
    });
    const igId = data?.instagram_business_account?.id;
    if (!igId) {
      throw new Error(
        'No Instagram Business Account linked to this Facebook Page. ' +
        'Open Facebook · Settings · Linked Accounts and connect your Instagram.'
      );
    }
    return igId;
  });
}

// ── Instagram Insights ────────────────────────────────────────────────────────

/**
 * Instagram metrics split into two groups with different API requirements:
 *
 * GROUP A — period=day, max 30-day window per request (chunked):
 *   reach, follower_count
 *
 * GROUP B — metric_type=total_value, period=days_28 (rolling 28-day total per day):
 *   views, profile_views, total_interactions, website_clicks
 *
 * Both groups use the user token (Instagram insights works with the user token).
 */

async function fetchIgDailyMetric(igId, metric, since, until) {
  // Max 30-day window; chunk accordingly
  const sinceTs = Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000);
  const untilTs = Math.floor(new Date(`${until}T23:59:59Z`).getTime() / 1000);
  const CHUNK = 30 * 86400;
  const points = [];

  let chunkStart = sinceTs;
  while (chunkStart < untilTs) {
    const chunkEnd = Math.min(chunkStart + CHUNK, untilTs);
    const data = await graphGet(`${GRAPH}/${igId}/insights`, {
      metric,
      period: 'day',
      since: chunkStart,
      until: chunkEnd,
    });
    const values = data?.data?.[0]?.values || [];
    points.push(...toSeries(values));
    chunkStart = chunkEnd + 1;
  }

  const seen = new Set();
  return points.filter(p => seen.has(p.date) ? false : seen.add(p.date));
}

async function fetchIgTotalValueMetric(igId, metric, since, until) {
  // metric_type=total_value with period=day (NOT days_28 — Meta rejects that).
  // Max 30-day window per request.
  const sinceTs = Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000);
  const untilTs = Math.floor(new Date(`${until}T23:59:59Z`).getTime() / 1000);
  const CHUNK = 30 * 86400;
  const points = [];

  let chunkStart = sinceTs;
  while (chunkStart < untilTs) {
    const chunkEnd = Math.min(chunkStart + CHUNK, untilTs);
    const data = await graphGet(`${GRAPH}/${igId}/insights`, {
      metric,
      period: 'day',
      metric_type: 'total_value',
      since: chunkStart,
      until: chunkEnd,
    });
    // total_value response shape: data[] each with total_value.value and end_time
    const items = data?.data || [];
    for (const item of items) {
      const date = item.end_time ? item.end_time.slice(0, 10) : null;
      const value = item.total_value?.value ?? item.total_value?.breakdowns?.[0]?.results?.[0]?.value;
      if (date && value != null) points.push({ date, value: Number(value) || 0 });
    }
    chunkStart = chunkEnd + 1;
  }

  const seen = new Set();
  return points
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter(p => seen.has(p.date) ? false : seen.add(p.date));
}

/**
 * Returns all Instagram series for the dashboard as a map.
 *
 * Metrics mapping (updated 2025/2026):
 *   ig-reach        → reach            (daily; max 30-day chunks)
 *   ig-views        → views            (total_value; replaces deprecated impressions)
 *   ig-interactions → total_interactions (total_value)
 *   ig-visits       → profile_views    (total_value)
 *   ig-follows      → follower_count   (daily; diff'd to daily adds)
 *   ig-clicks       → website_clicks   (total_value)
 */
async function getInstagramSeries(since, until) {
  const igId = await getInstagramAccountId();

  // [key, metric, fetchType]  fetchType: 'day' | 'total_value' | 'follower'
  const METRIC_MAP = [
    ['ig-reach',        'reach',               'day'],
    ['ig-views',        'views',               'total_value'],
    ['ig-interactions', 'total_interactions',  'total_value'],
    ['ig-visits',       'profile_views',       'total_value'],
    ['ig-follows',      'follower_count',      'follower'],
    ['ig-clicks',       'website_clicks',      'total_value'],
  ];

  // follower_count: Meta only supports last 30 days, ending yesterday
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const followerSince = daysAgo(30);

  const results = {};
  await Promise.allSettled(
    METRIC_MAP.map(async ([key, metric, fetchType]) => {
      try {
        let series;
        if (fetchType === 'follower') {
          series = await fetchIgDailyMetric(igId, metric, followerSince, yesterday);
        } else if (fetchType === 'total_value') {
          series = await fetchIgTotalValueMetric(igId, metric, since, until);
        } else {
          series = await fetchIgDailyMetric(igId, metric, since, until);
        }

        // follower_count is a running total; convert to daily new followers
        if (key === 'ig-follows' && series.length > 1) {
          series = series.map((p, i) => ({
            date: p.date,
            value: i === 0 ? 0 : Math.max(0, p.value - series[i - 1].value),
          })).slice(1);
        }

        results[key] = series;
      } catch (err) {
        const detail = err.response?.data?.error?.message || err.response?.data || err.message;
        console.warn(`Instagram metric ${metric} unavailable:`, detail);
        results[key] = [];
      }
    })
  );

  return results;
}

// ── Facebook Page Insights ────────────────────────────────────────────────────

/**
 * Fetch a single daily Facebook Page metric for a date range.
 * Page Insights supports up to 93 days per request; we chunk similarly.
 *
 * @param {string} metric   Page Insights metric name
 * @param {string} since    ISO date
 * @param {string} until    ISO date
 */
async function fetchFbMetric(metric, since, until) {
  // Facebook Page Insights requires a Page Access Token (not a User token).
  // graphGetPage() exchanges the user token for the page token automatically.
  const sinceTs = Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000);
  const untilTs = Math.floor(new Date(`${until}T23:59:59Z`).getTime() / 1000);
  const CHUNK = 90 * 86400;
  const points = [];

  let chunkStart = sinceTs;
  while (chunkStart < untilTs) {
    const chunkEnd = Math.min(chunkStart + CHUNK, untilTs);
    const data = await graphGetPage(`${GRAPH}/${pageId()}/insights/${metric}`, {
      period: 'day',
      since: chunkStart,
      until: chunkEnd,
    });
    const values = data?.data || [];
    for (const item of values) {
      points.push(...toSeries(item.values || []));
    }
    chunkStart = chunkEnd + 1;
  }

  const seen = new Set();
  return points.filter(p => seen.has(p.date) ? false : seen.add(p.date));
}

/**
 * Returns all Facebook series for the dashboard:
 *   { 'fb-views': [...], 'fb-visits': [...], 'fb-interactions': [...], 'fb-clicks': [...], 'fb-follows': [...] }
 *
 * Metrics mapping (updated 2026):
 *   fb-views        → page_total_media_view_unique  (replaces deprecated page_impressions_unique)
 *   fb-visits       → page_views_total              (still valid)
 *   fb-interactions → page_post_engagements         (still valid)
 *   fb-clicks       → page_total_actions            (CTA/contact clicks; page_website_clicks was never valid)
 *   fb-follows      → page_daily_follows            (page_fan_adds removed; page_daily_follows is current)
 *
 * All calls use a Page Access Token (auto-fetched via getPageToken()).
 */
async function getFacebookSeries(since, until) {
  const METRIC_MAP = [
    ['fb-views',        'page_total_media_view_unique'],
    ['fb-visits',       'page_views_total'],
    ['fb-interactions', 'page_post_engagements'],
    ['fb-clicks',       'page_impressions'],
    ['fb-follows',      'page_daily_follows'],
  ];

  const results = {};
  await Promise.allSettled(
    METRIC_MAP.map(async ([key, metric]) => {
      try {
        results[key] = await fetchFbMetric(metric, since, until);
      } catch (err) {
        const detail = err.response?.data?.error?.message || err.response?.data || err.message;
        console.warn(`Facebook metric ${metric} unavailable:`, detail);
        results[key] = [];
      }
    })
  );

  return results;
}

// ── Combined endpoint ─────────────────────────────────────────────────────────

/**
 * Returns all Instagram + Facebook series for the dashboard, covering
 * the past ~13 months so year-on-year comparisons work.
 *
 * Result shape:
 * {
 *   series: {
 *     'ig-reach': [{date, value}, ...],
 *     ...all other ig-* and fb-* keys...
 *   },
 *   since: '2025-10-01',
 *   until: '2026-11-03',
 *   source: 'meta-api',
 * }
 */
async function getAllMetaSeries() {
  const today = new Date().toISOString().slice(0, 10);
  // Go back 13 months so we have this full year and last full year
  const since = daysAgo(395);

  return cached(`meta-all-${today}`, async () => {
    const [igSeries, fbSeries] = await Promise.all([
      getInstagramSeries(since, today),
      getFacebookSeries(since, today),
    ]);

    return {
      series: { ...igSeries, ...fbSeries },
      since,
      until: today,
      source: 'meta-api',
    };
  });
}

/**
 * Quick connectivity check — returns { instagram: bool, facebook: bool, igAccountId: string|null }
 * Used by /api/meta-status
 */
async function getMetaStatus() {
  const result = { instagram: false, facebook: false, igAccountId: null, error: null };
  if (!token() || !pageId()) {
    result.error = 'FACEBOOK_PAGE_ID or FACEBOOK_ACCESS_TOKEN not set in .env';
    return result;
  }

  try {
    // Test Facebook — use graphGetPage so we also validate page token exchange
    await graphGetPage(`${GRAPH}/${pageId()}`, { fields: 'id,name' });
    result.facebook = true;
  } catch (err) {
    result.error = `Facebook: ${err.response?.data?.error?.message || err.message}`;
    return result;
  }

  try {
    result.igAccountId = await getInstagramAccountId();
    result.instagram = true;
  } catch (err) {
    result.error = `Instagram not linked: ${err.message}`;
  }

  return result;
}

module.exports = { getAllMetaSeries, getMetaStatus, getInstagramAccountId, invalidateCache: invalidate };
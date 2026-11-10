// LinkedIn (Community Management API). Connected in server.js.
//   GET /api/linkedin    followers, daily figures, demographics and recent posts
// .env: LINKEDIN_ORG_ID, LINKEDIN_ACCESS_TOKEN, optional LINKEDIN_API_VERSION,
// LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET / LINKEDIN_REFRESH_TOKEN (auto-renew)
// Scopes: rw_organization_admin, r_organization_social

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createCache } = require('./cache');
const { dataPath } = require('./data-dir');
const { HOUR, DAY, isoDay } = require('./time');

const API = 'https://api.linkedin.com/rest';
const VERSION = process.env.LINKEDIN_API_VERSION || '202610';
const cache = createCache(HOUR);

// LinkedIn only gives the last 12 months, so every day it returns is saved here.
// That keeps older quarters available for reports after they drop out of LinkedIn's window.
const HISTORY_FILE = dataPath('linkedin-history.json', path.join(__dirname, 'linkedin-history.json'));

// The daily figures reports use, and which LinkedIn answer each one comes from.
// A series is only saved when its answer arrived, so a failed call never records false zeros.
const REPORT_SERIES = {
  'li-impressions': { from: 'shareDaily', value: day => day.impressions },
  'li-interactions': { from: 'shareDaily', value: day => day.likes + day.comments + day.shares },
  'li-follows': { from: 'followerDaily', value: day => day.followerGain },
  'li-page-views': { from: 'pageDaily', value: day => day.pageViews },
};

// LinkedIn sends codes for these; the names come from its documentation.
const SENIORITY = { 1: 'Unpaid', 2: 'Training', 3: 'Entry', 4: 'Senior', 5: 'Manager', 6: 'Director', 7: 'VP', 8: 'CXO', 9: 'Partner', 10: 'Owner' };
const FUNCTION = {
  1: 'Accounting', 2: 'Administrative', 3: 'Arts and Design', 4: 'Business Development', 5: 'Community & Social Services',
  6: 'Consulting', 7: 'Education', 8: 'Engineering', 9: 'Entrepreneurship', 10: 'Finance', 11: 'Healthcare Services',
  12: 'Human Resources', 13: 'Information Technology', 14: 'Legal', 15: 'Marketing', 16: 'Media & Communication',
  17: 'Military & Protective Services', 18: 'Operations', 19: 'Product Management', 20: 'Program & Project Management',
  21: 'Purchasing', 22: 'Quality Assurance', 23: 'Real Estate', 24: 'Research', 25: 'Sales', 26: 'Support',
};
const STAFF = {
  SIZE_1: '1', SIZE_2_TO_10: '2–10', SIZE_11_TO_50: '11–50', SIZE_51_TO_200: '51–200', SIZE_201_TO_500: '201–500',
  SIZE_501_TO_1000: '501–1k', SIZE_1001_TO_5000: '1k–5k', SIZE_5001_TO_10000: '5k–10k', SIZE_10001_OR_MORE: '10k+',
};

const enc = encodeURIComponent;
const idOf = urn => String(urn).split(':').pop(); // 'urn:li:geo:104738515' -> '104738515'
const interval = (start, end) => `(timeRange:(start:${start},end:${end}),timeGranularityType:DAY)`;

/* ── Talking to LinkedIn ─────────────────────────────────────── */

async function get(path) {
  const { data } = await axios.get(`${API}${path}`, {
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
      'LinkedIn-Version': VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });
  return data;
}

// Swaps the refresh token for a new access token. Returns false if the refresh settings aren't in .env.
async function refreshToken() {
  const { LINKEDIN_CLIENT_ID: id, LINKEDIN_CLIENT_SECRET: secret, LINKEDIN_REFRESH_TOKEN: refresh } = process.env;
  if (!id || !secret || !refresh) return false;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret });
  const { data } = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', body, { timeout: 15000 });
  process.env.LINKEDIN_ACCESS_TOKEN = data.access_token;
  console.log(`LinkedIn token refreshed (valid ${Math.round(data.expires_in / 86400)} days). Update LINKEDIN_ACCESS_TOKEN in .env to keep it after restarts.`);
  return true;
}

// Names for geo / industry IDs. Best effort: returns nothing if the lookup isn't permitted,
// and the caller then shows the raw ID.
async function lookupNames(path, ids, pick) {
  if (!ids.length) return {};
  try {
    const data = await get(`${path}?ids=List(${ids.join(',')})`);
    return Object.fromEntries(Object.entries(data.results || {}).map(([id, value]) => [id, pick(value)]));
  } catch {
    return {};
  }
}

/* ── Turning LinkedIn's answers into what the dashboard shows ── */

// One row per day, combining post figures, follower gains and page views.
function dailyRows(r) {
  const days = {};
  const row = ms => (days[isoDay(ms)] ||= { date: isoDay(ms), impressions: 0, uniqueImpressions: 0, clicks: 0, likes: 0, comments: 0, shares: 0, followerGain: 0, pageViews: 0 });

  for (const e of r.shareDaily?.elements || []) {
    const s = e.totalShareStatistics || {};
    const d = row(e.timeRange.start);
    d.impressions += s.impressionCount || 0;
    d.uniqueImpressions += s.uniqueImpressionsCount || s.uniqueImpressionsCounts || 0;
    d.clicks += s.clickCount || 0;
    d.likes += s.likeCount || 0;
    d.comments += s.commentCount || 0;
    d.shares += s.shareCount || 0;
  }
  for (const e of r.followerDaily?.elements || []) {
    const gains = e.followerGains || {};
    row(e.timeRange.start).followerGain += (gains.organicFollowerGain || 0) + (gains.paidFollowerGain || 0);
  }
  for (const e of r.pageDaily?.elements || []) {
    row(e.timeRange.start).pageViews += e.totalPageStatistics?.views?.allPageViews?.pageViews || 0;
  }
  return Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
}

function totalsFor(daily) {
  const sum = key => daily.reduce((total, day) => total + day[key], 0);
  const totals = {
    impressions: sum('impressions'), clicks: sum('clicks'), likes: sum('likes'), comments: sum('comments'),
    shares: sum('shares'), followerGain: sum('followerGain'), pageViews: sum('pageViews'),
  };
  totals.engagementRate = totals.impressions
    ? (totals.clicks + totals.likes + totals.comments + totals.shares) / totals.impressions
    : null;
  return totals;
}

// The ten largest groups in one follower breakdown, e.g. followerCountsBySeniority.
function topTen(items = [], key, label) {
  return items
    .map(i => ({ name: label(i[key]), value: i.followerCounts?.organicFollowerCount || 0 }))
    .filter(i => i.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

async function demographicsFor(followers) {
  const geoIds = (followers.followerCountsByGeoCountry || []).map(i => idOf(i.geo)).slice(0, 15);
  const industryIds = (followers.followerCountsByIndustry || []).map(i => idOf(i.industry)).slice(0, 15);
  const [geoNames, industryNames] = await Promise.all([
    lookupNames('/geo', geoIds, v => v.defaultLocalizedName?.value),
    lookupNames('/industryTaxonomyVersions/DEFAULT/industries', industryIds, v => v.name?.localized?.en_US || v.name?.value),
  ]);
  return {
    seniority: topTen(followers.followerCountsBySeniority, 'seniority', u => SENIORITY[idOf(u)] || `Seniority ${idOf(u)}`),
    function: topTen(followers.followerCountsByFunction, 'function', u => FUNCTION[idOf(u)] || `Function ${idOf(u)}`),
    industry: topTen(followers.followerCountsByIndustry, 'industry', u => industryNames[idOf(u)] || `Industry ${idOf(u)}`),
    country: topTen(followers.followerCountsByGeoCountry, 'geo', u => geoNames[idOf(u)] || `Region ${idOf(u)}`),
    companySize: topTen(followers.followerCountsByStaffCountRange, 'staffCountRange', s => STAFF[s] || s),
  };
}

function postType(content) {
  if (content?.media) return 'Media';
  if (content?.article) return 'Link';
  if (content?.multiImage) return 'Images';
  if (content?.poll) return 'Poll';
  if (content?.document) return 'Document';
  return 'Text';
}

// Recent published posts with each post's own figures. Problems are added to `errors`, not thrown.
async function recentPosts(postsAnswer, org, errors) {
  const published = (postsAnswer?.elements || []).filter(p => p.lifecycleState === 'PUBLISHED');
  if (!published.length) return [];

  // LinkedIn has two kinds of post ID and wants them in separate requests.
  const idsOfKind = kind => published.filter(p => p.id.startsWith(`urn:li:${kind}:`)).map(p => enc(p.id));
  const shares = idsOfKind('share');
  const ugcPosts = idsOfKind('ugcPost');
  const statsUrl = `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${org}`;
  const calls = [];
  if (shares.length) calls.push(get(`${statsUrl}&shares=List(${shares.join(',')})`));
  if (ugcPosts.length) calls.push(get(`${statsUrl}&ugcPosts=List(${ugcPosts.join(',')})`));

  const stats = {};
  for (const result of await Promise.allSettled(calls)) {
    if (result.status === 'rejected') {
      errors.push({ source: 'postStats', message: result.reason.response?.data?.message || result.reason.message });
      continue;
    }
    for (const e of result.value.elements || []) stats[e.share || e.ugcPost] = e.totalShareStatistics || {};
  }

  return published.map(p => {
    const s = stats[p.id] || {};
    const impressions = s.impressionCount || 0;
    const engaged = (s.clickCount || 0) + (s.likeCount || 0) + (s.commentCount || 0) + (s.shareCount || 0);
    return {
      id: p.id,
      date: isoDay(p.publishedAt || p.createdAt),
      text: (p.commentary || '').replace(/\s+/g, ' ').slice(0, 220),
      type: postType(p.content),
      url: `https://www.linkedin.com/feed/update/${p.id}`,
      impressions, clicks: s.clickCount || 0, likes: s.likeCount || 0, comments: s.commentCount || 0, shares: s.shareCount || 0,
      engagementRate: impressions ? engaged / impressions : 0,
    };
  });
}

/* ── Saved history, for reports ──────────────────────────────── */

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return { series: {} }; }
}

function saveHistory(daily, answered) {
  const history = readHistory();
  for (const [key, { from, value }] of Object.entries(REPORT_SERIES)) {
    if (!answered.includes(from)) continue;
    const byDate = (history.series[key] ||= {});
    for (const day of daily) byDate[day.date] = value(day);
  }
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); }
  catch (error) { console.warn('Could not save linkedin-history.json:', error.message); }
}

// LinkedIn's daily figures for reports, as { 'li-impressions': [{ date, value }], ... }.
// Refreshes from LinkedIn when it is set up (at most once an hour), then returns everything saved,
// so reports still have the history when LinkedIn can't be reached. Returns null if there is none.
async function getLinkedInSeries() {
  const { LINKEDIN_ORG_ID: orgId, LINKEDIN_ACCESS_TOKEN: token } = process.env;
  if (orgId && token && token !== 'pending') {
    try { await cache.get('linkedin', fetchAllWithFreshToken); }
    catch (error) { console.warn('LinkedIn unavailable, using saved history:', error.message); }
  }
  const series = Object.fromEntries(Object.entries(readHistory().series)
    .map(([key, byDate]) => [key, Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }))])
    .filter(([, rows]) => rows.length));
  return Object.keys(series).length ? series : null;
}

/* ── Everything for the LinkedIn tab ─────────────────────────── */

async function fetchAll() {
  const org = enc(`urn:li:organization:${process.env.LINKEDIN_ORG_ID}`);
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()); // today 00:00 UTC
  const start = end - 362 * DAY; // API keeps a rolling 12 months
  const days = interval(start, end);

  // Ask for everything at once. One failing doesn't stop the others; only all failing is an error.
  const calls = {
    network: get(`/networkSizes/${org}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`),
    followerLifetime: get(`/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${org}`),
    followerDaily: get(`/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${org}&timeIntervals=${days}`),
    shareLifetime: get(`/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${org}`),
    shareDaily: get(`/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${org}&timeIntervals=${days}`),
    pageDaily: get(`/organizationPageStatistics?q=organization&organization=${org}&timeIntervals=${days}`),
    posts: get(`/posts?q=author&author=${org}&count=50&sortBy=CREATED`),
  };
  const names = Object.keys(calls);
  const settled = await Promise.allSettled(Object.values(calls));
  const r = {};
  const errors = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') r[names[i]] = result.value;
    else errors.push({ source: names[i], status: result.reason.response?.status, message: result.reason.response?.data?.message || result.reason.message });
  });
  if (errors.length === names.length) {
    throw Object.assign(new Error(errors[0].message), { status: errors[0].status });
  }

  const daily = dailyRows(r);
  saveHistory(daily, Object.keys(r));
  const lifetime = r.shareLifetime?.elements?.[0]?.totalShareStatistics || {};

  return {
    connected: true,
    fetchedAt: new Date().toISOString(),
    apiVersion: VERSION,
    followers: r.network?.firstDegreeSize ?? null,
    lifetime: {
      impressions: lifetime.impressionCount ?? null, uniqueImpressions: lifetime.uniqueImpressionsCount ?? null,
      clicks: lifetime.clickCount ?? null, likes: lifetime.likeCount ?? null, comments: lifetime.commentCount ?? null,
      shares: lifetime.shareCount ?? null, engagementRate: lifetime.engagement ?? null,
    },
    totals12m: totalsFor(daily),
    daily,
    demographics: await demographicsFor(r.followerLifetime?.elements?.[0] || {}),
    posts: await recentPosts(r.posts, org, errors),
    errors,
  };
}

// If LinkedIn says the token has expired, renew it and try once more.
async function fetchAllWithFreshToken() {
  try {
    return await fetchAll();
  } catch (error) {
    if (error.status === 401 && await refreshToken()) return fetchAll();
    throw error;
  }
}

function hintFor(error) {
  if (error.status === 401) return 'Access token expired or invalid — generate a new one in the LinkedIn developer portal.';
  if (error.status === 403) return 'Token is missing a scope (rw_organization_admin / r_organization_social) or the user is not a page admin.';
  if (error.status === 426) return `LinkedIn-Version ${VERSION} is no longer supported — set LINKEDIN_API_VERSION to a newer YYYYMM.`;
  return error.message;
}

module.exports = function linkedinRoutes(app) {
  app.get('/api/linkedin', async (req, res) => {
    const { LINKEDIN_ORG_ID: orgId, LINKEDIN_ACCESS_TOKEN: token } = process.env;
    if (!orgId || !token || token === 'pending') {
      return res.json({ connected: false, message: 'Set LINKEDIN_ORG_ID and LINKEDIN_ACCESS_TOKEN in the server .env file.' });
    }
    try {
      res.json(await cache.get('linkedin', fetchAllWithFreshToken, { refresh: Boolean(req.query.refresh) }));
    } catch (error) {
      console.error('LinkedIn error:', error.status, error.message);
      res.status(502).json({ connected: false, error: hintFor(error) });
    }
  });
};

module.exports.getLinkedInSeries = getLinkedInSeries;

// Exported for tests.
module.exports.dailyRows = dailyRows;
module.exports.totalsFor = totalsFor;
module.exports.topTen = topTen;
module.exports.postType = postType;
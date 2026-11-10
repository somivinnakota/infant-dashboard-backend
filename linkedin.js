// LinkedIn (Community Management API). Connected in server.js.
//   GET /api/linkedin    followers, daily figures, demographics and recent posts
// .env: LINKEDIN_ORG_ID, LINKEDIN_ACCESS_TOKEN, optional LINKEDIN_API_VERSION,
// LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET / LINKEDIN_REFRESH_TOKEN (auto-renew)
// Scopes: rw_organization_admin, r_organization_social

const axios = require('axios');

module.exports = function linkedinRoutes(app) {
  const API = 'https://api.linkedin.com/rest';
  const VERSION = process.env.LINKEDIN_API_VERSION || '202610';
  const DAY = 86400000;
  const CACHE_MS = 60 * 60 * 1000;

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

  let cache = null;

  const enc = encodeURIComponent;
  const idOf = urn => String(urn).split(':').pop();
  const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
  const interval = (start, end) => `(timeRange:(start:${start},end:${end}),timeGranularityType:DAY)`;

  const get = (path) => {
    return axios.get(`${API}${path}`, {
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
        'LinkedIn-Version': VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    }).then(r => r.data);
  }

  const refreshToken = async () => {
    const { LINKEDIN_CLIENT_ID: id, LINKEDIN_CLIENT_SECRET: secret, LINKEDIN_REFRESH_TOKEN: refresh } = process.env;
    if (!id || !secret || !refresh) return false;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret });
    const { data } = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', body, { timeout: 15000 });
    process.env.LINKEDIN_ACCESS_TOKEN = data.access_token;
    console.log(`LinkedIn token refreshed (valid ${Math.round(data.expires_in / 86400)} days). Update LINKEDIN_ACCESS_TOKEN in .env to keep it after restarts.`);
    return true;
  }

  // Sorted top-N list from a follower facet, e.g. followerCountsBySeniority.
  const facet = (items = [], key, label) => {
    return items
      .map(i => ({ name: label(i[key]), value: i.followerCounts?.organicFollowerCount || 0 }))
      .filter(i => i.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }

  // Names for geo / industry URNs. Best effort: falls back to the raw ID if lookup isn't permitted.
  const lookupNames = async (path, ids, pick) => {
    if (!ids.length) return {};
    try {
      const data = await get(`${path}?ids=List(${ids.join(',')})`);
      const out = {};
      for (const [id, v] of Object.entries(data.results || {})) out[id] = pick(v);
      return out;
    } catch { return {}; }
  }

  const fetchAll = async () => {
    const org = `urn:li:organization:${process.env.LINKEDIN_ORG_ID}`;
    const o = enc(org);
    const now = new Date();
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()); // today 00:00 UTC
    const start = end - 362 * DAY; // API keeps a rolling 12 months

    const calls = {
      network: get(`/networkSizes/${o}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`),
      followerLifetime: get(`/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${o}`),
      followerDaily: get(`/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${o}&timeIntervals=${interval(start, end)}`),
      shareLifetime: get(`/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${o}`),
      shareDaily: get(`/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${o}&timeIntervals=${interval(start, end)}`),
      pageDaily: get(`/organizationPageStatistics?q=organization&organization=${o}&timeIntervals=${interval(start, end)}`),
      posts: get(`/posts?q=author&author=${o}&count=50&sortBy=CREATED`),
    };
    const keys = Object.keys(calls);
    const settled = await Promise.allSettled(Object.values(calls));
    const r = {}; const errors = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') r[keys[i]] = s.value;
      else errors.push({ source: keys[i], status: s.reason.response?.status, message: s.reason.response?.data?.message || s.reason.message });
    });
    if (errors.length === keys.length) {
      const err = new Error(errors[0].message); err.status = errors[0].status; throw err;
    }

    // ── Daily series (shares + followers + page views merged by date) ──
    const days = {};
    const row = ms => (days[isoDay(ms)] ||= { date: isoDay(ms), impressions: 0, uniqueImpressions: 0, clicks: 0, likes: 0, comments: 0, shares: 0, followerGain: 0, pageViews: 0 });
    for (const e of r.shareDaily?.elements || []) {
      const s = e.totalShareStatistics || {}; const d = row(e.timeRange.start);
      d.impressions += s.impressionCount || 0; d.uniqueImpressions += s.uniqueImpressionsCount || s.uniqueImpressionsCounts || 0;
      d.clicks += s.clickCount || 0; d.likes += s.likeCount || 0; d.comments += s.commentCount || 0; d.shares += s.shareCount || 0;
    }
    for (const e of r.followerDaily?.elements || []) {
      const g = e.followerGains || {}; row(e.timeRange.start).followerGain += (g.organicFollowerGain || 0) + (g.paidFollowerGain || 0);
    }
    for (const e of r.pageDaily?.elements || []) {
      row(e.timeRange.start).pageViews += e.totalPageStatistics?.views?.allPageViews?.pageViews || 0;
    }
    const daily = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));

    // ── Lifetime totals ──
    const lt = r.shareLifetime?.elements?.[0]?.totalShareStatistics || {};
    const sum = k => daily.reduce((t, d) => t + d[k], 0);
    const totals12m = {
      impressions: sum('impressions'), clicks: sum('clicks'), likes: sum('likes'), comments: sum('comments'),
      shares: sum('shares'), followerGain: sum('followerGain'), pageViews: sum('pageViews'),
    };
    totals12m.engagementRate = totals12m.impressions
      ? (totals12m.clicks + totals12m.likes + totals12m.comments + totals12m.shares) / totals12m.impressions : null;

    // ── Follower demographics ──
    const f = r.followerLifetime?.elements?.[0] || {};
    const geoIds = (f.followerCountsByGeoCountry || []).map(i => idOf(i.geo)).slice(0, 15);
    const indIds = (f.followerCountsByIndustry || []).map(i => idOf(i.industry)).slice(0, 15);
    const [geoNames, indNames] = await Promise.all([
      lookupNames('/geo', geoIds, v => v.defaultLocalizedName?.value),
      lookupNames('/industryTaxonomyVersions/DEFAULT/industries', indIds, v => v.name?.localized?.en_US || v.name?.value),
    ]);
    const demographics = {
      seniority: facet(f.followerCountsBySeniority, 'seniority', u => SENIORITY[idOf(u)] || `Seniority ${idOf(u)}`),
      function: facet(f.followerCountsByFunction, 'function', u => FUNCTION[idOf(u)] || `Function ${idOf(u)}`),
      industry: facet(f.followerCountsByIndustry, 'industry', u => indNames[idOf(u)] || `Industry ${idOf(u)}`),
      country: facet(f.followerCountsByGeoCountry, 'geo', u => geoNames[idOf(u)] || `Region ${idOf(u)}`),
      companySize: facet(f.followerCountsByStaffCountRange, 'staffCountRange', s => STAFF[s] || s),
    };

    // ── Recent posts with per-post stats ──
    const postList = (r.posts?.elements || []).filter(p => p.lifecycleState === 'PUBLISHED');
    let posts = [];
    if (postList.length) {
      const shares = postList.filter(p => p.id.startsWith('urn:li:share:')).map(p => enc(p.id));
      const ugc = postList.filter(p => p.id.startsWith('urn:li:ugcPost:')).map(p => enc(p.id));
      const statCalls = [];
      if (shares.length) statCalls.push(get(`/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${o}&shares=List(${shares.join(',')})`));
      if (ugc.length) statCalls.push(get(`/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${o}&ugcPosts=List(${ugc.join(',')})`));
      const stats = {};
      for (const s of await Promise.allSettled(statCalls)) {
        if (s.status === 'rejected') { errors.push({ source: 'postStats', message: s.reason.response?.data?.message || s.reason.message }); continue; }
        for (const e of s.value.elements || []) stats[e.share || e.ugcPost] = e.totalShareStatistics || {};
      }
      posts = postList.map(p => {
        const s = stats[p.id] || {};
        const impressions = s.impressionCount || 0;
        const engaged = (s.clickCount || 0) + (s.likeCount || 0) + (s.commentCount || 0) + (s.shareCount || 0);
        return {
          id: p.id,
          date: isoDay(p.publishedAt || p.createdAt),
          text: (p.commentary || '').replace(/\s+/g, ' ').slice(0, 220),
          type: p.content?.media ? 'Media' : p.content?.article ? 'Link' : p.content?.multiImage ? 'Images' : p.content?.poll ? 'Poll' : p.content?.document ? 'Document' : 'Text',
          url: `https://www.linkedin.com/feed/update/${p.id}`,
          impressions, clicks: s.clickCount || 0, likes: s.likeCount || 0, comments: s.commentCount || 0, shares: s.shareCount || 0,
          engagementRate: impressions ? engaged / impressions : 0,
        };
      });
    }

    return {
      connected: true,
      fetchedAt: new Date().toISOString(),
      apiVersion: VERSION,
      followers: r.network?.firstDegreeSize ?? null,
      lifetime: {
        impressions: lt.impressionCount ?? null, uniqueImpressions: lt.uniqueImpressionsCount ?? null,
        clicks: lt.clickCount ?? null, likes: lt.likeCount ?? null, comments: lt.commentCount ?? null,
        shares: lt.shareCount ?? null, engagementRate: lt.engagement ?? null,
      },
      totals12m,
      daily,
      demographics,
      posts,
      errors,
    };
  }

  // Route
  {
    app.get('/api/linkedin', async (req, res) => {
      const { LINKEDIN_ORG_ID: orgId, LINKEDIN_ACCESS_TOKEN: token } = process.env;
      if (!orgId || !token || token === 'pending') {
        return res.json({ connected: false, message: 'Set LINKEDIN_ORG_ID and LINKEDIN_ACCESS_TOKEN in the server .env file.' });
      }
      if (cache && !req.query.refresh && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);

      try {
        let data;
        try { data = await fetchAll(); }
        catch (e) {
          if (e.status === 401 && await refreshToken()) data = await fetchAll();
          else throw e;
        }
        cache = { at: Date.now(), data };
        res.json(data);
      } catch (e) {
        console.error('LinkedIn error:', e.status, e.message);
        const hint = e.status === 401 ? 'Access token expired or invalid — generate a new one in the LinkedIn developer portal.'
          : e.status === 403 ? 'Token is missing a scope (rw_organization_admin / r_organization_social) or the user is not a page admin.'
          : e.status === 426 ? `LinkedIn-Version ${VERSION} is no longer supported — set LINKEDIN_API_VERSION to a newer YYYYMM.`
          : e.message;
        res.status(502).json({ connected: false, error: hint });
      }
    });
  }
};
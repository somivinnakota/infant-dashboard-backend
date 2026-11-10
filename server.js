require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const axios = require('axios');
const Groq = require('groq-sdk');
const socialImport = require('./social-import');
const metaInsights = require('./meta-insights');
const glossary = require('./glossary');
const publications = require('./publications');
const { formatNumber } = require('./format');
const { dataPath } = require('./data-dir');


/* =========================================================
   Settings
   ========================================================= */

const PORT = process.env.PORT || 5000;
// Only this computer can reach the server. Set HOST=0.0.0.0 in .env to share it on a network.
const HOST = process.env.HOST || '127.0.0.1';
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',').map(s => s.trim());
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-oss-20b';

const IMPACT_FILE = path.join(__dirname, 'impact-data.json');
const ENV_FILE = path.join(__dirname, '.env');

const ORG_NAME = 'INFANT Research Centre, University College Cork';
const HTTP_TIMEOUT = 15000;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// The standard social media series the dashboard charts. Data comes from uploaded Meta exports.
const SOCIAL_SERIES = {
  'ig-reach': 'Instagram reach (daily reach added up)',
  'ig-views': 'Instagram views',
  'ig-interactions': 'Instagram interactions',
  'ig-visits': 'Instagram profile visits',
  'ig-follows': 'Instagram new followers',
  'ig-clicks': 'Instagram link clicks',
  'fb-views': 'Facebook page views',
  'fb-visits': 'Facebook page visits',
  'fb-interactions': 'Facebook interactions',
  'fb-clicks': 'Facebook link clicks',
  'fb-follows': 'Facebook new followers',
};

/* =========================================================
   App setup
   ========================================================= */

const app = express();
app.use(cors({ origin: FRONTEND_ORIGINS }));
app.use(compression());
app.use(express.json({ limit: '25mb' })); // room for several uploaded export files
require('./mailchimp')(app);

// Created only when a key is set, so the rest of the dashboard still works without one.
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

/* =========================================================
   Small helpers
   ========================================================= */

// Keeps results in memory for a while so pages don't hit the same API again and again.
// Failed calls are not cached, so they are retried next time.
const cache = new Map();
async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.value;
  const value = await loader();
  cache.set(key, { value, time: Date.now() });
  return value;
}

// Runs an optional data call; logs and returns null instead of breaking the whole request.
async function optional(label, loader) {
  try {
    return await loader();
  } catch (error) {
    console.warn(`${label} unavailable:`, error.message);
    return null;
  }
}

function readImpactData() {
  return JSON.parse(fs.readFileSync(IMPACT_FILE, 'utf8'));
}

/* =========================================================
   AI
   ========================================================= */

const AI_RULES = `Rules that always apply:
- Use only the figures given in the data. Never invent, estimate or round up numbers.
- If a figure is marked "not available", say it is not available instead of guessing.
- Plain text only: no markdown, no asterisks, no # symbols. Put each section heading in CAPITALS on its own line, and start bullet points with "- ".
- Write in the third person.`;

async function askAI(prompt) {
  if (!groq) throw new Error('GROQ_API_KEY is not set in .env, so AI features are unavailable.');
  // A reasoning model can spend all its tokens "thinking" and return no text, so keep the
  // thinking short, leave plenty of room for the answer, and try once more if it's still empty.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await groq.chat.completions.create({
      model: AI_MODEL,
      temperature: 0.3,
      max_completion_tokens: 4000,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: `You write reports for ${ORG_NAME}.\n\n${AI_RULES}` },
        { role: 'user', content: prompt },
      ],
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    if (text) return text;
    console.warn(`AI returned no text (attempt ${attempt}, finish reason: ${completion.choices?.[0]?.finish_reason || 'unknown'}).`);
  }
  throw new Error('The AI returned an empty response twice. Try again in a minute.');
}

/* =========================================================
   Data sources
   ========================================================= */

// ── Facebook ─────────────────────────────────────────────────
async function getFacebookStats() {
  return cached('facebook', 15 * MINUTE, async () => {
    const { data } = await axios.get(`https://graph.facebook.com/${process.env.FACEBOOK_PAGE_ID}`, {
      params: {
        fields: 'name,fan_count,followers_count,talking_about_count',
        access_token: process.env.FACEBOOK_ACCESS_TOKEN,
      },
      timeout: HTTP_TIMEOUT,
    });
    const engagementRate = data.followers_count > 0
      ? `${((data.talking_about_count / data.followers_count) * 100).toFixed(2)}%`
      : 'not available';
    return { ...data, engagement_rate: engagementRate };
  });
}

// ── Eventbrite ───────────────────────────────────────────────
// Eventbrite returns events in pages of 50, so keep asking until there are no more.
async function getEventbriteEvents() {
  return cached('eventbrite', 15 * MINUTE, async () => {
    const raw = [];
    let continuation;
    let total = 0;
    for (let page = 0; page < 20; page++) {
      const { data } = await axios.get(
        `https://www.eventbriteapi.com/v3/organizations/${process.env.EVENTBRITE_ORG_ID}/events/`,
        {
          params: { status: 'all', order_by: 'start_desc', expand: 'venue', ...(continuation ? { continuation } : {}) },
          headers: { Authorization: `Bearer ${process.env.EVENTBRITE_TOKEN}` },
          timeout: HTTP_TIMEOUT,
        }
      );
      raw.push(...(data.events || []));
      total = data.pagination?.object_count ?? raw.length;
      if (!data.pagination?.has_more_items || !data.pagination?.continuation) break;
      continuation = data.pagination.continuation;
    }

    const events = raw.map(e => ({
      id: e.id,
      name: e.name?.text || 'Untitled',
      description: e.description?.text?.slice(0, 200) || '',
      start: e.start?.local || '',
      end: e.end?.local || '',
      status: e.status,
      url: e.url,
      venue: e.venue?.name || '',
      capacity: e.capacity || null,
      is_free: e.is_free,
    }));
    return { events, total };
  });
}

// ── Social media data from uploaded exports ──────────────────
// Every upload is merged into one saved file (social-data.json), so file names never matter.
// The platform comes from where the file was dropped; social-import.js works out
// everything else from the file's contents.

const SOCIAL_STORE = dataPath('social-data.json', path.join(__dirname, 'social-data.json'));
const { PLATFORMS, PLATFORM_NAMES, decodeText, parseCsv, importFile } = socialImport;
const PLATFORM_CODES = Object.fromEntries(Object.entries(PLATFORMS).map(([id, p]) => [id, p.code]));
const MAX_UPLOAD_FILES = 40;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const seriesLabel = (name, meta) => socialImport.seriesLabel(name, meta);

function emptyStore() {
  // freshness records, for each saved day, the last day of the export it came from,
  // so an older export can never overwrite figures from a newer one.
  return { series: {}, meta: {}, freshness: {}, breakdowns: {}, items: {}, uploads: [] };
}

function readStore() {
  if (!fs.existsSync(SOCIAL_STORE)) return emptyStore();
  try {
    const data = JSON.parse(fs.readFileSync(SOCIAL_STORE, 'utf8'));
    return { ...emptyStore(), ...data };
  } catch (error) {
    // Keep the damaged file instead of overwriting it, so nothing is lost.
    const backup = SOCIAL_STORE.replace(/\.json$/, `.damaged-${Date.now()}.json`);
    fs.renameSync(SOCIAL_STORE, backup);
    console.error(`social-data.json could not be read and was moved to ${path.basename(backup)}:`, error.message);
    return emptyStore();
  }
}

// Writes to a temporary file first, so a crash mid-save can't corrupt the data.
function writeStore(store) {
  const temp = `${SOCIAL_STORE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store));
  fs.renameSync(temp, SOCIAL_STORE);
}

// All saved social data, with each series as a date-ordered list.
async function loadSocialData() {
  const store = readStore();

  let liveData = null;
  try {
    liveData = await metaInsights.getAllMetaSeries();
  } catch (err) {
    console.warn('Meta Graph API unavailable, using uploaded CSV data:', err.message);
  }

  const names = new Set([...Object.keys(SOCIAL_SERIES), ...Object.keys(store.series)]);
  if (liveData) Object.keys(liveData.series).forEach(k => names.add(k));

  const series = {};
  const meta = {};
  let latestDate = '';

  for (const name of names) {
    const storedRows = Object.fromEntries(
      Object.entries(store.series[name] || {}).map(([d, v]) => [d, v])
    );
    if (liveData?.series[name]) {
      for (const { date, value } of liveData.series[name]) {
        // An uploaded Meta export is Meta's own figure for that day, so it wins; the API fills the other days.
        if (date in storedRows) continue;
        storedRows[date] = value;
      }
    }
    let rows = Object.entries(storedRows)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value }));
    // Meta's Instagram views/interactions exports are 0 before Meta recorded them (until Aug 2025);
    // treat that leading run of 0s as missing so year-on-year comparisons aren't inflated.
    if (name === 'ig-views' || name === 'ig-interactions') {
      const first = rows.findIndex(r => r.value > 0);
      rows = first === -1 ? [] : rows.slice(first);
    }
    series[name] = rows;
    meta[name] = { aggregation: 'sum', format: 'number', primary: true, ...store.meta[name], label: seriesLabel(name, store.meta) };
    const last = rows[rows.length - 1];
    if (last && last.date > latestDate) latestDate = last.date;
  }

  const items = Object.fromEntries(Object.entries(store.items).map(([key, list]) => [
    key, { label: list.label, measures: list.measures, rows: Object.values(list.rows) },
  ]));

  return {
    series, meta, breakdowns: store.breakdowns, items,
    latestDate: latestDate || null,
    dataSource: liveData ? 'meta-api' : 'csv-upload',
  };
}

// Options for the verified publication list (publications.js): INFANT's researchers from impact-data.json.
function publicationOptions() {
  try { return { researcherIds: readImpactData().researcherIds || [] }; } catch { return { researcherIds: [] }; }
}

// Verified INFANT publications since 2013 (Scopus and PubMed, checked for an INFANT affiliation).
async function getPublicationCount() {
  const data = await publications.getPublications(publicationOptions());
  if (!data) throw new Error('The verified publication list is not available yet.');
  return data.totalVerified;
}

/* =========================================================
   Routes: data
   ========================================================= */

app.get('/api/facebook', async (req, res) => {
  try {
    res.json(await getFacebookStats());
  } catch (error) {
    console.error('Facebook error:', error.message);
    res.status(502).json({ error: 'Could not load Facebook data.' });
  }
});

// Live Instagram figures for the Social media page: followers and posts, plus interactions over the last 7 days.
app.get('/api/instagram', async (req, res) => {
  try {
    const igId = await metaInsights.getInstagramAccountId();
    const graph = `https://graph.facebook.com/v21.0/${igId}`;
    const token = process.env.FACEBOOK_ACCESS_TOKEN;
    const { data } = await axios.get(graph, {
      params: { fields: 'username,followers_count,media_count', access_token: token }, timeout: 20000,
    });
    // Likes, comments, saves and shares in the last 7 days (optional: left out if Meta doesn't return it).
    let interactions = null;
    try {
      const until = Math.floor(Date.now() / 1000);
      const { data: ins } = await axios.get(`${graph}/insights`, {
        params: { metric: 'total_interactions', metric_type: 'total_value', period: 'day', since: until - 7 * 86400, until, access_token: token },
        timeout: 20000,
      });
      interactions = ins?.data?.[0]?.total_value?.value ?? null;
    } catch { /* not available for this account */ }
    res.json({ ...data, interactions_7d: interactions });
  } catch (error) {
    console.error('Instagram error:', error.response?.data?.error?.message || error.message);
    res.status(502).json({ error: 'Could not load Instagram data.' });
  }
});

app.get('/api/eventbrite', async (req, res) => {
  try {
    res.json(await getEventbriteEvents());
  } catch (error) {
    console.error('Eventbrite error:', error.message);
    res.status(502).json({ error: 'Could not load Eventbrite events.' });
  }
});

app.get('/api/publications/count', async (req, res) => {
  try {
    // Also per year: verified papers (each counted once) and the Scopus citations of those papers.
    const data = await publications.getPublications(publicationOptions());
    const byYear = {};
    for (const p of (data?.papers || []).filter(x => x.status === 'verified' && x.year)) {
      const y = (byYear[p.year] = byYear[p.year] || { publications: 0, citations: 0, withCitationCount: 0 });
      y.publications += 1;
      if (typeof p.citations === 'number') { y.citations += p.citations; y.withCitationCount += 1; }
    }
    res.json({ total: await getPublicationCount(), byYear, source: 'Scopus and PubMed, verified INFANT affiliation' });
  } catch (error) {
    console.error('Publication count error:', error.message);
    res.status(502).json({ error: 'The verified publication list is not available yet.' });
  }
});

// The verified INFANT publication list, cross-checked against the INFANT website (see publications.js).
// The first build after a restart takes a minute or two; until then this answers 202 and the page waits.
app.get('/api/publications/verified', async (req, res) => {
  try {
    const pending = publications.refresh(publicationOptions(), { force: Boolean(req.query.refresh) });
    const current = publications.latest() || await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 20000))]);
    if (!current) return res.status(202).json({ building: true });
    res.json({ ...current, building: publications.isBuilding() });
  } catch (error) {
    console.error('Verified publications error:', error.message);
    res.status(500).json({ error: 'The publication list could not be built. Check the server log for details.' });
  }
});

// All social media CSV data in one response, one list per series across every year.
app.get('/api/social-data', async (req, res) => {
  try {
    res.json(await loadSocialData());
  } catch (error) {
    console.error('Social data error:', error.message);
    res.status(500).json({ error: 'Could not read the saved social media data.' });
  }
});

// Upload analytics exports.
// Body: { platform: 'instagram' | 'facebook' | 'linkedin', files: [{ name, data (base64 CSV) } or { name, sheets: [{ name, rows }] }] }
// Excel files are read into rows in the browser; CSV files are sent as they are.
app.post('/api/social-upload', (req, res) => {
  const platform = PLATFORM_CODES[req.body?.platform];
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!platform) return res.status(400).json({ error: 'Choose a platform for these files.' });
  if (files.length === 0) return res.status(400).json({ error: 'No files were sent.' });
  if (files.length > MAX_UPLOAD_FILES) return res.status(400).json({ error: `Upload up to ${MAX_UPLOAD_FILES} files at a time.` });

  try {
    const store = readStore();
    const results = files.map(file => {
      const fileName = String(file?.name || 'file').slice(0, 200);
      try {
        let sheets;
        if (Array.isArray(file?.sheets)) {
          sheets = file.sheets.map(sh => ({ name: String(sh?.name || fileName), rows: Array.isArray(sh?.rows) ? sh.rows : [] }));
        } else {
          const buffer = Buffer.from(String(file?.data || ''), 'base64');
          if (buffer.length === 0) return { fileName, ok: false, message: 'This file is empty.' };
          if (buffer.length > MAX_FILE_BYTES) return { fileName, ok: false, message: 'This file is too large (over 10 MB).' };
          sheets = [{ name: fileName, rows: parseCsv(decodeText(buffer)) }];
        }
        return importFile(store, { fileName, sheets, platform });
      } catch (error) {
        console.warn(`Upload of ${fileName} failed:`, error.message);
        return { fileName, ok: false, message: 'This file could not be read.' };
      }
    });
    if (results.some(r => r.ok)) writeStore(store);
    res.json({ results });
  } catch (error) {
    console.error('Social upload error:', error);
    res.status(500).json({ error: 'The files could not be saved. Check the server log for details.' });
  }
});

// What social data is stored, grouped by platform, plus recent uploads.
app.get('/api/social-status', (req, res) => {
  try {
    const store = readStore();
    const platforms = Object.values(PLATFORMS).map(p => {
      const keys = Object.keys(store.series).filter(k => k.startsWith(`${p.code}-`));
      const series = keys.map(name => {
        const dates = Object.keys(store.series[name]).sort();
        const meta = store.meta[name] || {};
        return { name, label: seriesLabel(name, store.meta), from: dates[0] || null, to: dates[dates.length - 1] || null, days: dates.length, primary: meta.primary !== false };
      }).sort((a, b) => a.label.localeCompare(b.label));
      const breakdowns = Object.keys(store.breakdowns).filter(k => k.startsWith(`${p.code}-`)).length;
      const posts = Object.entries(store.items).filter(([k]) => k.startsWith(`${p.code}-`))
        .reduce((n, [, list]) => n + Object.keys(list.rows).length, 0);
      return { id: Object.keys(PLATFORMS).find(id => PLATFORMS[id].code === p.code), code: p.code, name: p.name, series, breakdowns, posts };
    });
    res.json({ platforms, uploads: store.uploads.slice(0, 20) });
  } catch (error) {
    console.error('Social status error:', error.message);
    res.status(500).json({ error: 'Could not read the saved social media data.' });
  }
});

// Removes everything uploaded for one platform, e.g. to start again.
app.delete('/api/social-platform/:platform', (req, res) => {
  try {
    const code = PLATFORM_CODES[req.params.platform];
    if (!code) return res.status(404).json({ error: 'Unknown platform.' });
    const store = readStore();
    for (const group of ['series', 'meta', 'freshness', 'breakdowns', 'items']) {
      for (const key of Object.keys(store[group])) if (key.startsWith(`${code}-`)) delete store[group][key];
    }
    store.uploads.unshift({ summary: `Removed all ${PLATFORM_NAMES[code]} data`, at: new Date().toISOString() });
    writeStore(store);
    res.json({ ok: true });
  } catch (error) {
    console.error('Social platform delete error:', error.message);
    res.status(500).json({ error: 'The data could not be removed.' });
  }
});

// Removes one series, e.g. after uploading files under the wrong platform.
app.delete('/api/social-series/:name', (req, res) => {
  try {
    const store = readStore();
    const { name } = req.params;
    if (!store.series[name]) return res.status(404).json({ error: 'That data was not found.' });
    const label = seriesLabel(name, store.meta);
    delete store.series[name];
    delete store.meta[name];
    delete store.freshness[name];
    store.uploads.unshift({ summary: `Removed ${label}`, at: new Date().toISOString() });
    writeStore(store);
    res.json({ ok: true });
  } catch (error) {
    console.error('Social delete error:', error.message);
    res.status(500).json({ error: 'The data could not be removed.' });
  }
});

// The engagement metrics glossary, for the "what does this mean" tooltips on metric cards.
app.get('/api/glossary', (req, res) => {
  const data = glossary.loadGlossary();
  if (!data) return res.status(500).json({ error: 'The glossary could not be read.' });
  res.json({
    title: data.title,
    version: data.schema_version,
    metrics: data.metrics.map(({ id, term, category, definition, why_it_matters }) => ({ id, term, category, definition, why_it_matters })),
  });
});

app.get('/api/impact-data', (req, res) => {
  try {
    res.json(readImpactData());
  } catch (error) {
    console.error('Impact data error:', error.message);
    res.status(500).json({ error: 'Could not read impact-data.json. Check the file is valid JSON.' });
  }
});

/* =========================================================
   Routes: AI reports
   ========================================================= */

app.post('/api/impact-narrative', async (req, res) => {
  try {
    const impact = readImpactData();
    const [pubCount, eventbrite] = await Promise.all([
      optional('Publications', getPublicationCount),
      optional('Eventbrite', getEventbriteEvents),
    ]);
    const totalCapacity = eventbrite
      ? eventbrite.events.reduce((total, e) => total + (e.capacity || 0), 0)
      : null;
    const s = impact.impactScores;
    const sm = impact.impactSummaries;

    const prompt = `Write a research impact narrative for INFANT, a maternal and child health research centre at University College Cork, Ireland.

DATA:
- ${impact.headlines.infantsImpacted} infants impacted globally
- ${impact.headlines.fundingSecured} research funding secured
- ${impact.headlines.partnerships}+ partnerships across ${impact.headlines.partnershipCountries} countries
- ${pubCount === null ? 'Publication count: not available' : `${formatNumber(pubCount)} verified INFANT publications since ${publications.FIRST_YEAR} (Scopus and PubMed)`}
- ${totalCapacity === null ? 'Eventbrite event capacity: not available' : `${formatNumber(totalCapacity)} total capacity across Eventbrite events`}

IMPACT SCORES (out of 5, scored using the ${impact.assessedBy}):
- Commercialisation: ${s.commercialisation}/5
- Scholarly Outputs: ${s.scholarlyOutputs}/5
- Policy & Influence: ${s.policyAndInfluence}/5
- Lives Changed: ${s.livesChanged}/5
- Sustainability & Development: ${s.sustainabilityAndDevelopment}/5

IMPACT SUMMARIES:
Commercialisation: ${sm.commercialisation}
Scholarly Outputs: ${sm.scholarlyOutputs}
Policy & Influence: ${sm.policyAndInfluence}
Lives Changed: ${sm.livesChanged}
Sustainability & Development: ${sm.sustainabilityAndDevelopment}

SDG ALIGNMENT: ${(impact.sdgs || []).map(g => `SDG ${g.number} (${g.title})`).join(', ')}

Write a compelling 3-4 sentence narrative that:
- leads with the most impressive human impact number
- references the research scale (publications, funding, countries)
- mentions the highest-scoring impact category
- ends with a forward-looking statement about INFANT's mission

Do not describe the scores as an external assessment. No headings. Maximum 100 words.`;

    res.json({ narrative: await askAI(prompt) });
  } catch (error) {
    console.error('Impact narrative error:', error);
    res.status(500).json({ error: 'The impact narrative could not be generated.' });
  }
});

app.get('/api/meta-status', async (req, res) => {
  try {
    res.json(await metaInsights.getMetaStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/meta-insights/refresh', (req, res) => {
  metaInsights.invalidateCache();
  res.json({ message: 'Meta API cache cleared.' });
});
/* =========================================================
   Facebook token auto-refresh
   ========================================================= */

async function refreshFacebookToken() {
  try {
    const currentToken = process.env.FACEBOOK_ACCESS_TOKEN;
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!currentToken || !appId || !appSecret) {
      console.log('Facebook token refresh: missing credentials in .env');
      return;
    }

    const { data } = await axios.get('https://graph.facebook.com/debug_token', {
      params: { input_token: currentToken, access_token: `${appId}|${appSecret}` },
      timeout: HTTP_TIMEOUT,
    });
    const tokenData = data?.data;
    if (!tokenData) { console.log('Facebook token refresh: could not read token data'); return; }
    if (tokenData.is_valid === false) {
      console.warn('Facebook token check returned invalid — may be a wrong App Secret in .env. The token itself may still work.');
      return;
    }

    // expires_at of 0 means the token never expires, so there's nothing to refresh.
    if (!tokenData.expires_at) {
      console.log('Facebook token does not expire; no refresh needed.');
      return;
    }

    const daysLeft = Math.floor((tokenData.expires_at * 1000 - Date.now()) / (24 * HOUR));
    console.log(`Facebook token expires in ${daysLeft} days`);
    if (daysLeft > 10) return;

    const refresh = await axios.get('https://graph.facebook.com/oauth/access_token', {
      params: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: currentToken },
      timeout: HTTP_TIMEOUT,
    });
    const newToken = refresh.data?.access_token;
    if (!newToken) { console.log('Facebook token refresh: no new token returned'); return; }

    process.env.FACEBOOK_ACCESS_TOKEN = newToken;
    cache.delete('facebook');

    // Save the new token so it survives a restart.
    const env = fs.readFileSync(ENV_FILE, 'utf8');
    fs.writeFileSync(ENV_FILE, env.replace(/FACEBOOK_ACCESS_TOKEN=.*/, `FACEBOOK_ACCESS_TOKEN=${newToken}`));
    console.log('Facebook token refreshed and saved to .env');
  } catch (error) {
    console.error('Facebook token refresh error:', error.message);
  }
}

app.get('/api/refresh-token', async (req, res) => {
  await refreshFacebookToken();
  res.json({ message: 'Token refresh attempted. Check the server log for the result.' });
});

/* =========================================================
   Start-up checks and start
   ========================================================= */

function startupChecks() {
  const requiredEnv = ['GROQ_API_KEY', 'FACEBOOK_PAGE_ID', 'FACEBOOK_ACCESS_TOKEN', 'EVENTBRITE_ORG_ID', 'EVENTBRITE_TOKEN'];
  const missingEnv = requiredEnv.filter(name => !process.env[name]);
  if (missingEnv.length) console.warn(`Missing in .env: ${missingEnv.join(', ')}`);

  const stored = readStore().series;
  const missing = Object.keys(SOCIAL_SERIES).filter(name => !stored[name]);
  if (missing.length) {
    console.warn(`No social data uploaded yet for: ${missing.map(n => seriesLabel(n)).join(', ')}`);
  }

  try {
    readImpactData();
  } catch (error) {
    console.warn('impact-data.json could not be read:', error.message);
  }
}

startupChecks();
publications.refresh(publicationOptions()); // build the verified publication list in the background
refreshFacebookToken();
setInterval(refreshFacebookToken, 24 * HOUR);

// ── Routes kept in their own files ──
require('./linkedin')(app);
require('./quarterly-report')(app, { loadSocialData, getFacebookStats, optional, askAI });
require('./pdf')(app);

// ── Executive reports (AI analysis layer) ──
app.use('/api/executive', require('./executive/routes')({ loadSocialData, getEventbriteEvents, readImpactData, getFacebookStats, getMailchimpCampaigns: require('./mailchimp').getCampaigns, loadPublications: () => publications.getPublicationItems(publicationOptions()) }));

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
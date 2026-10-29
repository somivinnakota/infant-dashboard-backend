require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const axios = require('axios');
const Groq = require('groq-sdk');
const PDFDocument = require('pdfkit');
const socialImport = require('./social-import');
const glossary = require('./glossary');
const publications = require('./publications');


/* =========================================================
   Settings
   ========================================================= */

const PORT = process.env.PORT || 5000;
// Only this computer can reach the server. Set HOST=0.0.0.0 in .env to share it on a network.
const HOST = process.env.HOST || '127.0.0.1';
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',').map(s => s.trim());
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-oss-20b';

const CSV_DIR = path.join(__dirname, 'csv-data');
const IMPACT_FILE = path.join(__dirname, 'impact-data.json');
const ENV_FILE = path.join(__dirname, '.env');

const ORG_NAME = 'INFANT Research Centre, University College Cork';
const PUBMED_TERM = '"INFANT research centre"[Affiliation]';
const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_SUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
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

const QUARTERS = {
  Q1: { start: 1, end: 3 },
  Q2: { start: 4, end: 6 },
  Q3: { start: 7, end: 9 },
  Q4: { start: 10, end: 12 },
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

const formatNumber = n => Number(n).toLocaleString('en-IE');
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const sumValues = rows => rows.reduce((total, row) => total + row.value, 0);
const peakValue = rows => rows.reduce((max, row) => Math.max(max, row.value), 0);

function percentChange(current, previous) {
  if (!previous) return 'not available (no data for the comparison period)';
  const change = ((current - previous) / previous) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

function formatDayMonth(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('en-IE', { day: 'numeric', month: 'long' });
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
  const completion = await groq.chat.completions.create({
    model: AI_MODEL,
    temperature: 0.3,
    messages: [
      { role: 'system', content: `You write reports for ${ORG_NAME}.\n\n${AI_RULES}` },
      { role: 'user', content: prompt },
    ],
  });
  const text = completion.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('The AI returned an empty response.');
  return text;
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

// ── PubMed ───────────────────────────────────────────────────
async function getPubMedCount() {
  return cached('pubmed-count', 6 * HOUR, async () => {
    const { data } = await axios.get(PUBMED_SEARCH, {
      params: { db: 'pubmed', term: PUBMED_TERM, retmax: 0, retmode: 'json' },
      timeout: HTTP_TIMEOUT,
    });
    const count = parseInt(data.esearchresult?.count, 10);
    if (Number.isNaN(count)) throw new Error('PubMed did not return a count');
    return count;
  });
}

async function getPubMedPublications(size, page) {
  return cached(`pubmed-list-${size}-${page}`, 24 * HOUR, async () => {
    const search = await axios.get(PUBMED_SEARCH, {
      params: { db: 'pubmed', term: PUBMED_TERM, retmax: size, retstart: (page - 1) * size, retmode: 'json', sort: 'date' },
      timeout: HTTP_TIMEOUT,
    });
    const total = parseInt(search.data.esearchresult?.count, 10) || 0;
    const ids = search.data.esearchresult?.idlist || [];
    if (ids.length === 0) return { publications: [], total, page };

    const summary = await axios.get(PUBMED_SUMMARY, {
      params: { db: 'pubmed', id: ids.join(','), retmode: 'json' },
      timeout: HTTP_TIMEOUT,
    });
    const result = summary.data.result || {};
    const publications = ids.map(id => {
      const paper = result[id];
      if (!paper) return null;
      return {
        title: paper.title || 'Untitled',
        authors: (paper.authors || []).slice(0, 5).map(a => a.name).join(', '),
        journal: paper.fulljournalname || paper.source || '',
        year: paper.pubdate?.split(' ')[0] || '—',
        pmid: id,
        doi: paper.articleids?.find(a => a.idtype === 'doi')?.value
          || paper.elocationid?.match(/10\.\d{4,9}\/[^\s;]+/)?.[0] || '',
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}`,
        isOpenAccess: Boolean(paper.pmc),
      };
    }).filter(Boolean);

    return { publications, total, page };
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

const SOCIAL_STORE = path.join(__dirname, 'social-data.json');
const { PLATFORMS, PLATFORM_NAMES, decodeText, parseCsv, importFile, analyseSheet } = socialImport;
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

// One-off: brings in the CSV files from the old csv-data folder the first time the server runs.
// Their platform is known from the old file names, so each goes straight to its series.
const LEGACY_FILE_NAMES = {
  'reach.csv': 'ig-reach',
  'views (2).csv': 'ig-views',
  'interactions (2).csv': 'ig-interactions',
  'visits (2).csv': 'ig-visits',
  'follows (2).csv': 'ig-follows',
  'link clicks (2).csv': 'ig-clicks',
  'views (3).csv': 'fb-views',
  'viewers (2).csv': 'fb-viewers',
  'visits (3).csv': 'fb-visits',
  'interactions (3).csv': 'fb-interactions',
  'link clicks (3).csv': 'fb-clicks',
  'follows (3).csv': 'fb-follows',
};

function legacySeriesFor(fileName) {
  const lower = fileName.toLowerCase();
  if (LEGACY_FILE_NAMES[lower]) return LEGACY_FILE_NAMES[lower];
  const match = lower.match(/^(ig|fb)-([a-z]+)-\d+\.csv$/); // e.g. ig-reach-2025.csv, ig-visits-2.csv
  return match ? `${match[1]}-${match[2]}` : null;
}

function importLegacyCsvFiles() {
  if (fs.existsSync(SOCIAL_STORE) || !fs.existsSync(CSV_DIR)) return;
  const store = emptyStore();
  let imported = 0;
  for (const file of fs.readdirSync(CSV_DIR)) {
    const key = legacySeriesFor(file);
    if (!key) continue;
    try {
      const table = analyseSheet(parseCsv(decodeText(fs.readFileSync(path.join(CSV_DIR, file)))), file);
      const series = table.kind === 'daily' ? table.series[0] : null;
      if (!series) { console.warn(`Could not import ${file}: no daily figures found`); continue; }
      const values = store.series[key] || (store.series[key] = {});
      const freshness = store.freshness[key] || (store.freshness[key] = {});
      const fileEnd = series.points[series.points.length - 1]?.date || '';
      series.points.forEach(p => {
        if ((freshness[p.date] || '') > fileEnd) return; // keep figures from a more recent file
        values[p.date] = p.value;
        freshness[p.date] = fileEnd;
      });
      store.meta[key] = { label: socialImport.STANDARD_LABELS[key.slice(3)] || series.name, aggregation: 'sum', format: 'number', primary: true };
      store.uploads.push({ fileName: file, platform: key.slice(0, 2), summary: `${seriesLabel(key, store.meta)} (imported from csv-data)`, at: new Date().toISOString() });
      imported += 1;
    } catch (error) {
      console.warn(`Could not import ${file}:`, error.message);
    }
  }
  if (imported) {
    writeStore(store);
    console.log(`Imported ${imported} existing files from csv-data into social-data.json. Check them under Social media → Upload analytics files.`);
  }
}

// All saved social data, with each series as a date-ordered list.
function loadSocialData() {
  const store = readStore();
  const names = new Set([...Object.keys(SOCIAL_SERIES), ...Object.keys(store.series)]);
  const series = {};
  const meta = {};
  let latestDate = '';
  for (const name of names) {
    const rows = Object.entries(store.series[name] || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value }));
    series[name] = rows;
    meta[name] = { aggregation: 'sum', format: 'number', primary: true, ...store.meta[name], label: seriesLabel(name, store.meta) };
    const last = rows[rows.length - 1];
    if (last && last.date > latestDate) latestDate = last.date;
  }
  const items = Object.fromEntries(Object.entries(store.items).map(([key, list]) => [
    key, { label: list.label, measures: list.measures, rows: Object.values(list.rows) },
  ]));
  return { series, meta, breakdowns: store.breakdowns, items, latestDate: latestDate || null };
}

// Combines values the right way for each metric: added up, averaged (rates) or latest (running totals).
function combine(rows, aggregation) {
  if (rows.length === 0) return null;
  if (aggregation === 'mean') return rows.reduce((t, r) => t + r.value, 0) / rows.length;
  if (aggregation === 'last') return rows[rows.length - 1].value;
  return sumValues(rows);
}

const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// For each headline metric: this year to date against the same days last year, or, when
// there's no data for last year (e.g. a new export), the last 90 days against the 90 before.
function socialComparisons(social) {
  const results = [];
  for (const [name, rows] of Object.entries(social.series)) {
    const meta = social.meta[name];
    if (!rows.length || meta.primary === false) continue;
    const last = rows[rows.length - 1].date;
    const year = Number(last.slice(0, 4));
    const current = rows.filter(r => r.date.startsWith(`${year}-`));
    const sameDaysLastYear = rows.filter(r => r.date.startsWith(`${year - 1}-`) && r.date.slice(5) <= last.slice(5));

    if (sameDaysLastYear.length >= current.length * 0.8) {
      results.push({ name, meta, period: `1 Jan to ${formatDayMonth(last)} ${year}`, comparedWith: `same dates ${year - 1}`,
        current: combine(current, meta.aggregation), previous: combine(sameDaysLastYear, meta.aggregation) });
      continue;
    }
    const recentStart = addDays(last, -89);
    const recent = rows.filter(r => r.date >= recentStart);
    const before = rows.filter(r => r.date < recentStart && r.date >= addDays(recentStart, -90));
    results.push({ name, meta, period: `last 90 days to ${formatDayMonth(last)} ${year}`, comparedWith: 'previous 90 days',
      current: combine(recent, meta.aggregation), previous: before.length >= 72 ? combine(before, meta.aggregation) : null });
  }
  return results;
}

const formatMetric = (value, meta) => {
  if (value === null || value === undefined) return 'not available';
  return meta.format === 'percent' ? `${(value * 100).toFixed(2)}%` : formatNumber(Math.round(value * 100) / 100);
};

/* =========================================================
   Data blocks for AI prompts
   ========================================================= */

function facebookBlock(fb) {
  if (!fb) return 'LIVE FACEBOOK DATA: not available (the connection failed).';
  return `LIVE FACEBOOK DATA:
- Followers: ${formatNumber(fb.followers_count)}
- Page likes (fans): ${formatNumber(fb.fan_count)}
- People talking about the page (last 7 days): ${formatNumber(fb.talking_about_count)}
- Talking about as a share of followers: ${fb.engagement_rate}`;
}

function socialBlock(social) {
  const comparisons = socialComparisons(social);
  if (comparisons.length === 0) return 'SOCIAL MEDIA DATA: not available (no analytics exports uploaded).';

  const lines = ['SOCIAL MEDIA (from uploaded analytics exports; rates are averages, other figures are totals for the period):'];
  for (const c of comparisons) {
    const change = c.previous ? percentChange(c.current, c.previous) : 'not available (no data for the comparison period)';
    lines.push(`- ${c.meta.label}, ${c.period}: ${formatMetric(c.current, c.meta)} | ${c.comparedWith}: ${formatMetric(c.previous, c.meta)} | change: ${change}`);
  }

  // Audience breakdowns and top posts, where uploaded.
  for (const b of Object.entries(social.breakdowns)) {
    const [key, data] = b;
    const top = data.rows.slice(0, 3).map(r => `${r.name} (${formatNumber(r.value)})`).join(', ');
    lines.push(`- ${PLATFORM_NAMES[key.split('-')[0]] || ''} ${data.label}, top 3: ${top}`);
  }
  for (const [key, list] of Object.entries(social.items)) {
    const measure = list.measures.find(m => /impression|reach|view/i.test(m.header)) || list.measures[0];
    if (!measure) continue;
    const top = [...list.rows].filter(r => r.values[measure.header] !== undefined)
      .sort((a, b) => b.values[measure.header] - a.values[measure.header]).slice(0, 5);
    if (!top.length) continue;
    lines.push(`- ${PLATFORM_NAMES[key.split('-')[0]] || ''} top 5 posts by ${measure.header.toLowerCase()}:`);
    top.forEach(r => lines.push(`  · "${r.title.slice(0, 90)}"${r.date ? ` (${r.date})` : ''}: ${formatNumber(r.values[measure.header])}`));
  }
  return lines.join('\n');
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

function publicationsBlock(count) {
  return count === null
    ? 'PUBLICATIONS: not available (the verified publication list could not be loaded).'
    : `PUBLICATIONS (Scopus and PubMed, verified INFANT affiliation, since ${publications.FIRST_YEAR}): ${formatNumber(count)} publications.`;
}

function uploadBlock(text, name) {
  const value = typeof text === 'string' && text.trim() ? clip(text.trim(), 8000) : '';
  return value || `${name}: No data uploaded yet.`;
}

/* =========================================================
   Report prompts
   ========================================================= */

function buildReportPrompt(type, data, year) {
  const prompts = {
    quarterly: `Write a quarterly executive report for senior leadership.

Use ALL of the data below: social media, KPIs, press coverage, events, conferences and publications. Do not focus only on social media. If KPI, press, events or conference data is provided, analyse it and reference exact figures from it.

${data}

Use these exact sections:

EXECUTIVE SUMMARY
2-3 sentences. The single headline story. Reference the most significant number across ALL data sources.

KEY PERFORMANCE INDICATORS
If KPI tracker data was provided, list and analyse the specific KPIs, targets and actuals. If not, state this clearly and note what KPIs should be tracked.

SOCIAL MEDIA PERFORMANCE
3 bullet points. Facebook and Instagram with the year-on-year figures given.

PRESS AND MEDIA COVERAGE
If press data was provided, analyse it: how many articles, which outlets, what topics. If not, state this gap clearly.

EVENTS AND CONFERENCES
If events or conference data was provided, summarise key events, attendance and presentations. If not, state this gap.

RESEARCH OUTPUT
Reference the PubMed publication figure and what it means for research visibility.

RISKS
2 bullet points with specific numbers. What is underperforming?

RECOMMENDED ACTIONS FOR NEXT QUARTER
4 specific bullet points that address gaps across ALL data sources.

Every section must reference data. If a data source is missing, say so. Maximum 500 words. No generic advice.`,

    comms: `Write a communications report for the comms team.

Use ALL data sources below. Social media is one part of communications; also analyse press coverage, events and anything else provided.

${data}

Use these exact sections:

COMMUNICATIONS OVERVIEW
2-3 sentences on communications across ALL channels.

SOCIAL MEDIA PERFORMANCE
Facebook: figures and year-on-year changes.
Instagram: figures and year-on-year changes.
LinkedIn: if LinkedIn figures are given above, report them and note they come from uploaded exports while API approval is pending; if not, flag LinkedIn as a data gap.

PRESS AND MEDIA COVERAGE
If press data was provided, analyse it in detail: articles, outlets, topics, patterns. If not, flag the gap and recommend uploading it.

EVENTS AND CONFERENCES
If events or conference data was provided, analyse it. If not, flag the gap.

CONTENT PERFORMANCE ANALYSIS
3 bullet points on what the interaction data suggests is and isn't working.

CHANNEL GAPS
Name each channel not yet fully tracked: LinkedIn (API approval pending, uploaded exports used meanwhile), Instagram live API (not connected, exports used instead), newsletter/Mailchimp (not connected), website analytics GA4 (not connected).

RECOMMENDATIONS FOR COMMS TEAM
4 bullet points, each starting with a verb.

Write for a comms professional, not a board. Flag every data gap. Maximum 450 words.`,

    research: `Write a research impact report.

Focus on publications, conferences and how research is communicated through social media and the press. Use ALL data provided.

${data}

Use these exact sections:

RESEARCH OUTPUT SUMMARY
Analyse the PubMed publication figure and what it represents for a research centre of this size.

CONFERENCE ACTIVITY
If conference data was provided, analyse it: how many conferences, which ones, who presented, what topics. If not, state the gap and why conference tracking matters.

RESEARCH DISSEMINATION THROUGH SOCIAL MEDIA
How effectively is research being communicated on social media? Use the Instagram and Facebook figures given.

MEDIA COVERAGE OF RESEARCH
If press data was provided, identify which research topics generated coverage and which outlets covered INFANT. If not, note the gap.

RESEARCH COMMUNICATION GAPS
2 bullet points on missed opportunities, based on the data.

RECOMMENDATIONS FOR RESEARCH IMPACT
4 bullet points on communicating maternal and child health research to the public, media and stakeholders.

Reference specific numbers in every section. Flag data gaps clearly. Maximum 450 words.`,

    annual: `Write the communications section of the annual report in formal, polished prose suitable for publication.

${data}

Use these sections:

COMMUNICATIONS AND ENGAGEMENT: ${year}
3-4 sentences highlighting the strongest growth figures across ALL channels.

DIGITAL REACH AND SOCIAL MEDIA
3-4 sentences covering Instagram and Facebook, using the figures given.

PRESS AND MEDIA
2-3 sentences. Use press figures if provided; otherwise say media coverage tracking is under way.

EVENTS AND CONFERENCES
2-3 sentences. Use events or conference figures if provided; otherwise say event tracking is under way.

RESEARCH DISSEMINATION
2-3 sentences referencing the PubMed publication figure.

LOOKING AHEAD: ${year + 1}
2-3 sentences on priorities, including the data gaps and planned improvements to measurement and reporting.

KEY STATISTICS: ${year}
Exactly 8 statistics taken from the data, each on its own line as:
- [Number]: [what it represents]

Formal annual report tone. No bullet points except in Key Statistics. Be accurate. Maximum 500 words.`,
  };
  return prompts[type] || prompts.quarterly;
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

app.get('/api/publications', async (req, res) => {
  try {
    const size = Math.min(Math.max(parseInt(req.query.size, 10) || 200, 1), 500);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    res.json(await getPubMedPublications(size, page));
  } catch (error) {
    console.error('Publications error:', error.message);
    res.status(502).json({ error: 'Could not load publications from PubMed.' });
  }
});

// All social media CSV data in one response, one list per series across every year.
app.get('/api/social-data', (req, res) => {
  try {
    res.json(loadSocialData());
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

app.get('/api/linkedin', async (req, res) => {
  const orgId = process.env.LINKEDIN_ORG_ID;
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token || !orgId || token === 'pending') {
    return res.json({ pending: true, message: 'LinkedIn access token not yet configured' });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'LinkedIn-Version': '202406',
    'X-Restli-Protocol-Version': '2.0.0',
  };
  const org = `urn:li:organization:${orgId}`;
  try {
    const [followers, pageStats, followerStats] = await Promise.all([
      axios.get(`https://api.linkedin.com/rest/networkSizes/${org}?edgeType=CompanyFollowedByMember`, { headers, timeout: HTTP_TIMEOUT }),
      axios.get(`https://api.linkedin.com/rest/organizationPageStatistics?q=organization&organization=${org}`, { headers, timeout: HTTP_TIMEOUT }),
      axios.get(`https://api.linkedin.com/rest/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${org}`, { headers, timeout: HTTP_TIMEOUT }),
    ]);
    res.json({
      followers: followers.data.firstDegreeSize || 0,
      pageStats: pageStats.data,
      followerStats: followerStats.data,
    });
  } catch (error) {
    console.error('LinkedIn error:', error.message);
    res.status(502).json({ error: 'Could not load LinkedIn data.' });
  }
});

/* =========================================================
   Routes: AI reports
   ========================================================= */

app.post('/api/report', async (req, res) => {
  try {
    const { type = 'quarterly', additionalData = {} } = req.body || {};

    const [fb, pubCount] = await Promise.all([
      optional('Facebook', getFacebookStats),
      optional('Publications', getPublicationCount),
    ]);
    const social = loadSocialData();
    const year = social.latestDate ? Number(social.latestDate.slice(0, 4)) : new Date().getFullYear();

    const data = [
      facebookBlock(fb),
      socialBlock(social),
      publicationsBlock(pubCount),
      'ADDITIONAL DATA FROM DASHBOARD UPLOADS:',
      uploadBlock(additionalData.kpi, 'KPI tracker'),
      uploadBlock(additionalData.press, 'Press and media'),
      uploadBlock(additionalData.events, 'Calendar of events'),
      uploadBlock(additionalData.conferences, 'Conference list'),
    ].join('\n\n');

    const report = await askAI(buildReportPrompt(type, data, year));
    res.json({ report, type });
  } catch (error) {
    console.error('Report error:', error);
    res.status(500).json({ error: 'The report could not be generated. Check the server log for details.' });
  }
});

app.get('/api/quarterly-report', async (req, res) => {
  try {
    const quarter = QUARTERS[req.query.quarter] ? req.query.quarter : 'Q3';
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const prevYear = year - 1;
    const q = QUARTERS[quarter];
    const social = loadSocialData();

    // If the quarter is still in progress, compare both years only up to the latest uploaded day.
    const latest = social.latestDate;
    const latestMonth = latest ? Number(latest.slice(5, 7)) : 0;
    const quarterInProgress = latest && latest.startsWith(`${year}-`) && latestMonth >= q.start && latestMonth <= q.end;

    const inQuarter = (rows, y) => rows.filter(r => {
      const month = Number(r.date.slice(5, 7));
      return r.date.startsWith(`${y}-`) && month >= q.start && month <= q.end;
    });
    // Each metric is cut off at its own latest day, so last year is compared like-for-like.
    const compare = name => {
      const current = inQuarter(social.series[name] || [], year);
      const cutoff = current.length ? current[current.length - 1].date.slice(5) : '12-31';
      const previous = inQuarter(social.series[name] || [], prevYear).filter(r => r.date.slice(5) <= cutoff);
      return { current, previous };
    };
    const totals = name => {
      const { current, previous } = compare(name);
      return { current: sumValues(current), previous: sumValues(previous) };
    };

    const ig = {
      reach: totals('ig-reach'),
      views: totals('ig-views'),
      interactions: totals('ig-interactions'),
      visits: totals('ig-visits'),
      follows: totals('ig-follows'),
      peakReach: {
        current: peakValue(compare('ig-reach').current),
        previous: peakValue(compare('ig-reach').previous),
      },
    };
    const fbCsv = {
      views: totals('fb-views'),
      visits: totals('fb-visits'),
      interactions: totals('fb-interactions'),
    };

    const hasData = [...Object.values(ig), ...Object.values(fbCsv)].some(m => m.current > 0);
    if (!hasData) {
      return res.status(404).json({ error: `No Instagram or Facebook data found for ${quarter} ${year}. Upload the Meta exports on the Social media page.` });
    }

    // Other platforms from uploads (e.g. LinkedIn), compared with the previous quarter,
    // since they often have no data for the same quarter last year.
    const prevQ = quarter === 'Q1' ? { quarter: 'Q4', year: year - 1 } : { quarter: `Q${Number(quarter[1]) - 1}`, year };
    const inAnyQuarter = (rows, y, qq) => rows.filter(r => {
      const month = Number(r.date.slice(5, 7));
      return r.date.startsWith(`${y}-`) && month >= qq.start && month <= qq.end;
    });
    const otherLines = [];
    const otherFigures = [];
    for (const [name, rows] of Object.entries(social.series)) {
      const code = name.split('-')[0];
      const meta = social.meta[name];
      if (code === 'ig' || code === 'fb' || meta.primary === false || !rows.length) continue;
      const now = inAnyQuarter(rows, year, q);
      if (!now.length) continue;
      const before = inAnyQuarter(rows, prevQ.year, QUARTERS[prevQ.quarter]);
      const c = combine(now, meta.aggregation);
      const p = combine(before, meta.aggregation);
      otherLines.push(`- ${meta.label}: ${formatMetric(c, meta)} | ${prevQ.quarter} ${prevQ.year}: ${formatMetric(p, meta)} | change: ${p ? percentChange(c, p) : 'not available'}`);
      otherFigures.push({ key: name, platform: PLATFORM_NAMES[code] || code, label: meta.label, display: formatMetric(c, meta), previousDisplay: p === null ? null : formatMetric(p, meta), change: p ? percentChange(c, p) : null });
    }

    const fb = await optional('Facebook', getFacebookStats);
    const live = {
      followers: fb?.followers_count ?? '—',
      talkingAbout: fb?.talking_about_count ?? '—',
      engagementRate: fb?.engagement_rate ?? '—',
    };

    const line = (label, m) =>
      `- ${label}: ${formatNumber(m.current)} | ${quarter} ${prevYear}: ${formatNumber(m.previous)} | change: ${percentChange(m.current, m.previous)}`;
    const periodNote = quarterInProgress
      ? `Note: ${quarter} ${year} is still in progress. Each metric is compared with the same days last year, up to its latest uploaded day (newest data: ${formatDayMonth(latest)}).`
      : '';
    const nextQuarter = quarter === 'Q4' ? `Q1 ${year + 1}` : `Q${Number(quarter[1]) + 1} ${year}`;

    // Email (Mailchimp): this quarter against the same quarter last year. If the quarter is still
    // in progress, last year is cut off at the same day, so the comparison is like-for-like.
    const mailchimpData = await optional('Mailchimp', () => require('./mailchimp').getCampaigns());
    const campaigns = (mailchimpData?.campaigns || []).map(c => ({ ...c, date: String(c.sentAt || '').slice(0, 10) }));
    const today = new Date().toISOString().slice(0, 10);
    const todayMonth = Number(today.slice(5, 7));
    const emailCutoff = today.startsWith(`${year}-`) && todayMonth >= q.start && todayMonth <= q.end ? today.slice(5) : '12-31';
    const emailFor = y => {
      const list = inQuarter(campaigns, y).filter(c => c.date.slice(5) <= emailCutoff);
      const total = key => list.reduce((t, c) => t + (c[key] || 0), 0);
      const delivered = total('delivered');
      return {
        campaigns: list.length,
        delivered,
        openRate: delivered ? total('uniqueOpens') / delivered : null,
        engagementRate: delivered ? total('uniqueClicks') / delivered : null,
      };
    };
    const email = mailchimpData ? { connected: true, current: emailFor(year), previous: emailFor(prevYear) } : { connected: false };
    const rateText = v => (v === null ? 'not available' : `${(v * 100).toFixed(1)}%`);
    const pointsChange = (c, p) => (c === null || p === null ? 'not available' : `${c - p >= 0 ? '+' : ''}${((c - p) * 100).toFixed(1)} percentage points`);
    let emailBlock;
    if (!email.connected) {
      emailBlock = 'EMAIL (MAILCHIMP): not available (Mailchimp is not connected).';
    } else if (!email.current.campaigns) {
      emailBlock = `EMAIL (MAILCHIMP): no email campaigns were sent in ${quarter} ${year} (${quarter} ${prevYear}: ${email.previous.campaigns}).`;
    } else {
      const ec = email.current;
      const ep = email.previous;
      emailBlock = `EMAIL (MAILCHIMP), compared with ${quarter} ${prevYear}:
${line('Campaigns sent', { current: ec.campaigns, previous: ep.campaigns })}
${line('Emails delivered', { current: ec.delivered, previous: ep.delivered })}
- Engagement rate (subscribers who clicked ÷ emails delivered): ${rateText(ec.engagementRate)} | ${quarter} ${prevYear}: ${rateText(ep.engagementRate)} | change: ${pointsChange(ec.engagementRate, ep.engagementRate)}
- Open rate (can be inflated by Apple Mail privacy features, so treat with caution): ${rateText(ec.openRate)} | ${quarter} ${prevYear}: ${rateText(ep.openRate)} | change: ${pointsChange(ec.openRate, ep.openRate)}`;
    }

    // Glossary entries for the metrics in this report: given to the AI, and listed in the PDF appendix.
    const glossaryIds = [...new Set([
      ...['ig-reach', 'ig-views', 'ig-interactions', 'ig-visits', 'ig-follows', 'fb-views', 'fb-visits', 'fb-interactions'].map(glossary.glossaryIdFor),
      'engagement_rate', // the live Facebook "talking about as a share of followers" figure
      ...otherFigures.map(o => glossary.glossaryIdFor(o.key)),
      ...(email.connected && email.current.campaigns ? ['click_through_rate', 'open_rate'] : []),
      'year_on_year_change',
      ...(otherFigures.length ? ['quarter_on_quarter_change'] : []),
    ].filter(Boolean))];
    // Short version (definitions only): the free AI model runs out of room with the full notes and rules.
    const glossaryBlock = glossary.promptBlock(glossaryIds, { compact: true });

    const prompt = `Write a board-level quarterly engagement report that is analytical, evidence-based and direct.

PERIOD: ${quarter} ${year}, compared with ${quarter} ${prevYear}.
${periodNote}

INSTAGRAM:
${line('Reach (daily reach added up)', ig.reach)}
${line('Views', ig.views)}
${line('Interactions', ig.interactions)}
${line('Profile visits', ig.visits)}
${line('New followers', ig.follows)}
${line('Peak daily reach', ig.peakReach)}

FACEBOOK:
- Followers (live today): ${live.followers}
- Talking about the page (live, last 7 days): ${live.talkingAbout}
- Talking about as a share of followers: ${live.engagementRate}
${line('Page views', fbCsv.views)}
${line('Page visits', fbCsv.visits)}
${line('Interactions', fbCsv.interactions)}
${otherLines.length ? `\nOTHER PLATFORMS FROM UPLOADED EXPORTS (compared with ${prevQ.quarter} ${prevQ.year}):\n${otherLines.join('\n')}\n` : ''}
${emailBlock}
${glossaryBlock ? `\n${glossaryBlock}\n` : ''}
Use these exact sections:
QUARTERLY SUMMARY (2-3 sentences, headline story)
WHAT CHANGED AND WHY (3-4 sentences, analytical; only suggest reasons as possibilities, not facts)
SUCCESSES: ${quarter} ${year} (exactly 3 bullet points with numbers)
AREAS FOR ATTENTION (exactly 2 bullet points with numbers)
RECOMMENDATIONS FOR ${nextQuarter} (exactly 4 actionable bullet points)
RISKS IF NO ACTION TAKEN (exactly 2 bullet points)
OPPORTUNITIES (exactly 2 bullet points)
THINGS NEEDING ATTENTION THIS WEEK (exactly 3 action items starting with a verb)
ONE-LINE EXECUTIVE SUMMARY (one sentence with a number)

Reference numbers in every section. Never use "it is important to". Maximum 450 words.`;

    const report = await askAI(prompt);

    res.json({
      quarter, year, prevYear,
      periodNote,
      data: {
        instagram: {
          current: {
            reach: ig.reach.current, views: ig.views.current, interactions: ig.interactions.current,
            visits: ig.visits.current, follows: ig.follows.current, peakReach: ig.peakReach.current,
          },
          previous: {
            reach: ig.reach.previous, views: ig.views.previous, interactions: ig.interactions.previous,
            visits: ig.visits.previous, follows: ig.follows.previous, peakReach: ig.peakReach.previous,
          },
        },
        facebook: {
          live,
          current: { views: fbCsv.views.current, visits: fbCsv.visits.current, interactions: fbCsv.interactions.current },
          previous: { views: fbCsv.views.previous, visits: fbCsv.visits.previous, interactions: fbCsv.interactions.previous },
        },
        others: otherFigures,
        othersComparedWith: `${prevQ.quarter} ${prevQ.year}`,
        mailchimp: email,
      },
      report,
      glossaryIds,
    });
  } catch (error) {
    console.error('Quarterly report error:', error);
    res.status(500).json({ error: 'The quarterly report could not be generated. Check the server log for details.' });
  }
});

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

/* =========================================================
   Route: PDF of the report shown on screen
   ========================================================= */

// Standard PDF fonts can't draw emoji or most symbols, so swap or remove them.
function pdfSafe(text) {
  return text
    .replace(/→/g, '->').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/−/g, '-')
    .replace(/▲/g, 'up ').replace(/▼/g, 'down ')
    .replace(/[^\t\n\r\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC]/g, '');
}

function stripMarkdown(text) {
  return text
    .replace(/^\s*[*+]\s+/gm, '- ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*|__|`/g, '');
}

const isHeading = line => line.length <= 90 && /[A-Z]/.test(line) && line === line.toUpperCase();

app.post('/api/pdf', (req, res) => {
  const title = pdfSafe(clip(String(req.body?.title || 'Report'), 120));
  const subtitle = pdfSafe(clip(String(req.body?.subtitle || ''), 200));
  const report = pdfSafe(stripMarkdown(clip(String(req.body?.report || ''), 30000)));
  if (!report.trim()) return res.status(400).json({ error: 'No report text was sent.' });

  const fileName = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'Report'}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(res);
  const width = doc.page.width - 100;
  const generated = new Date().toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });

  doc.rect(0, 0, doc.page.width, 80).fill('#53266a'); // INFANT purple
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('INFANT Research Centre', 50, 22);
  doc.font('Helvetica').fontSize(10).fillColor('#e4d6ec').text(title, 50, 46, { width });
  doc.fontSize(9).text(`Generated ${generated}${subtitle ? ` · ${subtitle}` : ''}`, 50, 62, { width });
  doc.y = 105;

  for (const raw of report.split('\n')) {
    const line = raw.trim();
    if (!line) { doc.moveDown(0.4); continue; }
    if (isHeading(line)) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#53266a').text(line, 50, doc.y, { width });
      doc.moveDown(0.2);
    } else if (/^[-•]\s+/.test(line)) {
      doc.font('Helvetica').fontSize(9.5).fillColor('#374151')
        .text(`•  ${line.replace(/^[-•]\s+/, '')}`, 62, doc.y, { width: width - 12, lineGap: 2 });
    } else {
      doc.font('Helvetica').fontSize(9.5).fillColor('#374151').text(line, 50, doc.y, { width, lineGap: 2 });
    }
  }

  // Appendix: definitions of the metrics used in this report, taken from the central glossary.
  const ids = Array.isArray(req.body?.glossaryIds) ? req.body.glossaryIds.map(String).slice(0, 60) : [];
  const appendix = glossary.entriesFor(ids);
  if (appendix.length) {
    const source = glossary.loadGlossary();
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#53266a').text('APPENDIX: GLOSSARY OF METRICS USED IN THIS REPORT', 50, 50, { width });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(8.5).fillColor('#6b7280')
      .text(pdfSafe(`Definitions from the ${source?.title || 'INFANT Engagement Metrics Glossary'}${source?.schema_version ? `, version ${source.schema_version}` : ''}.`), 50, doc.y, { width });
    doc.moveDown(0.6);
    for (const m of appendix) {
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#374151').text(pdfSafe(m.term), 50, doc.y, { width, continued: true })
        .font('Helvetica').fillColor('#9ca3af').text(pdfSafe(`  ·  ${m.category}`));
      doc.font('Helvetica').fontSize(9.5).fillColor('#374151').text(pdfSafe(m.definition), 50, doc.y, { width, lineGap: 2 });
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#4b5563').text(pdfSafe(`Why it matters: ${m.why_it_matters}`), 50, doc.y, { width, lineGap: 2 });
      doc.moveDown(0.6);
    }
  }

  doc.moveDown(1.5);
  doc.font('Helvetica').fontSize(8).fillColor('#9ca3af')
    .text('INFANT Research Centre · University College Cork · infantcentre.ie', 50, doc.y, { width, align: 'center' });
  doc.end();
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
      console.error('Facebook token is no longer valid. Generate a new one and update FACEBOOK_ACCESS_TOKEN in .env.');
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

  importLegacyCsvFiles();
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

// ── Executive reports (AI analysis layer) ──
app.use('/api/executive', require('./executive/routes')({ loadSocialData, getEventbriteEvents, readImpactData, getFacebookStats, getMailchimpCampaigns: require('./mailchimp').getCampaigns, loadPublications: () => publications.getPublicationItems(publicationOptions()) }));

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
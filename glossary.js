// The INFANT Engagement Metrics Glossary, kept in one place: glossary/engagement_glossary.json.
// The AI reports, the PDF glossary appendix and the dashboard's metric tooltips all read it from here,
// so INFANT can update a definition by editing that file, without touching any prompt or page.
// The file is re-read whenever it changes, so edits apply without restarting the server.

const fs = require('fs');
const path = require('path');

const GLOSSARY_FILE = path.join(__dirname, 'glossary', 'engagement_glossary.json');

let cache = { mtimeMs: 0, data: null };

function loadGlossary() {
  try {
    const { mtimeMs } = fs.statSync(GLOSSARY_FILE);
    if (!cache.data || mtimeMs !== cache.mtimeMs) {
      const data = JSON.parse(fs.readFileSync(GLOSSARY_FILE, 'utf8'));
      if (!Array.isArray(data.metrics)) throw new Error('the file has no "metrics" list');
      cache = { mtimeMs, data };
    }
    return cache.data;
  } catch (error) {
    console.warn('Glossary could not be read:', error.message);
    return cache.data; // keep using the last good version, if there is one
  }
}

// Which glossary entry describes each dashboard metric. Matched on the metric's id or name;
// the first rule that matches wins, so the more specific rules come first.
// Metrics with no matching entry (e.g. LinkedIn unique visitors) simply have no definition.
const RULES = [
  [/unique[- ]visitors/i, null],
  [/^email\.engagement_rate$/, 'click_through_rate'],
  [/^email\.open_rate$/, 'open_rate'],
  [/^email\.click_to_open$/, 'click_to_open_rate'],
  [/^email\.unsubscribe_rate$/, 'unsubscribe_rate'],
  [/^email\./, null],
  [/^media\.rows$/, 'media_mentions'],
  [/engagement[- ]rate/i, 'engagement_rate'],
  [/unique[- ]impressions|reach|viewers/i, 'reach'],
  [/impressions/i, 'impressions'],
  [/page[- ]views|visits/i, 'profile_visits'],
  [/views/i, 'views'],
  [/interactions|reactions|comments|reposts/i, 'interactions'],
  [/follow/i, 'follower_growth'],
  [/clicks/i, 'link_clicks'],
];

// Only social media metrics are matched by name; other sections use their exact ids above.
function glossaryIdFor(metricId) {
  const id = String(metricId || '');
  const social = id.replace(/^social\./, '');
  const isSocial = /^(ig|fb|li)-/.test(social);
  for (const [pattern, entry] of RULES) {
    if (pattern.test(id) || (isSocial && pattern.test(social))) {
      if (!isSocial && !/^(email|media)\./.test(id)) return null;
      return entry;
    }
  }
  return null;
}

// The comparison entries that apply to a report's comparison periods.
function comparisonIds(comparisonKeys, reportType) {
  const ids = [];
  if (reportType === 'quarterly' && comparisonKeys.includes('previous_period')) ids.push('quarter_on_quarter_change');
  if (comparisonKeys.includes('same_period_last_year')) ids.push('year_on_year_change');
  return ids;
}

// Full entries for a list of glossary ids, in glossary order, without duplicates.
function entriesFor(ids) {
  const glossary = loadGlossary();
  if (!glossary) return [];
  const wanted = new Set(ids.filter(Boolean));
  return glossary.metrics.filter(m => wanted.has(m.id));
}

// The glossary text the AI receives. Compact (free plan): definitions only, to stay within size limits.
function promptBlock(ids, { compact = false } = {}) {
  const glossary = loadGlossary();
  const entries = entriesFor(ids);
  if (!glossary || !entries.length) return '';
  const lines = entries.map(m => {
    if (compact) return `- ${m.term}: ${m.definition}`;
    const notes = [m.calculation_notes, ...Object.entries(m.platform_notes || {}).map(([p, n]) => `${p}: ${n}`)].filter(Boolean);
    return `- ${m.term}: ${m.definition} Why it matters: ${m.why_it_matters}${notes.length ? ` Notes: ${notes.join(' ')}` : ''}`;
  });
  const rules = compact ? [] : (glossary.usage?.reporting_rules || []).map(r => `- ${r}`);
  return [
    'METRIC GLOSSARY (INFANT\'s approved definitions; interpret every metric according to its definition below and never write replacement definitions):',
    ...lines,
    ...(rules.length ? ['Glossary rules:', ...rules] : []),
  ].join('\n');
}

module.exports = { loadGlossary, glossaryIdFor, comparisonIds, entriesFor, promptBlock, GLOSSARY_FILE };
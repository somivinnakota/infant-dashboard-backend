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
  [/^posts\.li\.reach$/, 'impressions'], // LinkedIn impressions from posts published in the period
  [/^posts\.[a-z]+\.avg_engagement_rate$/, 'engagement_rate'],
  [/^posts\./, null],
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
      if (!isSocial && !/^(email|media|posts)\./.test(id)) return null;
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

// Where a dashboard figure differs from its glossary definition, so the AI describes it correctly
// and flags the difference (the glossary's rule: "If a platform's exported metric differs from this
// glossary, flag the discrepancy for review"). Matched on the metric id (social ids without "social.").
// Each: [metric id pattern, name, note for the AI, note for readers (the methodology section)].
const METRIC_NOTES = [
  [/^(ig|fb)-reach$/, 'Instagram reach',
    'This figure adds up each day\'s reach, so one account can be counted on several days. Call it "reach (daily figures added up)", never unique reach.',
    'Instagram reach adds up each day\'s reach, so one account can be counted on several days; it is not the number of unique accounts reached.'],
  [/^fb-clicks$/, 'Facebook link clicks',
    'From the live Meta connection this is Facebook "page actions" (clicks on the Page\'s buttons), while older days come from exported link clicks. Flag that the two are not the same measure.',
    'Facebook clicks from the live Meta connection are "page actions" (clicks on the Page\'s buttons); older days come from exported link clicks, which are a different measure.'],
  [/^(ig|fb|li)-(new-)?follow/, 'New followers',
    'These are followers gained, not net follower growth (people who unfollowed are not subtracted). Call them new followers.',
    'Follower figures are new followers gained, not net growth: people who unfollowed are not subtracted.'],
];

const matchingNotes = (metricIds = []) => {
  const ids = metricIds.map(id => String(id).replace(/^social\./, ''));
  return METRIC_NOTES.filter(([pattern]) => ids.some(id => pattern.test(id)));
};

// Notes for the AI on the dashboard metrics in a report (ids as in the data package, e.g. "social.ig-reach").
function metricNotes(metricIds = []) {
  return matchingNotes(metricIds).map(([, label, note]) => `- ${label}: ${note}`);
}

// The reporting rules that matter most when the AI is writing, in a short form for the free plan.
const KEY_RULES = [
  'Never treat impressions or views as unique people, or visibility as proof of impact.',
  'Only compare rates that use the same denominator and period; say which denominator a rate uses.',
  'Follow each metric\'s note below when describing it.',
];

const clipText = (text, max) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text);

// The glossary text the AI receives.
//   Full (paid plan): every field of each entry, plus all of the glossary's reporting rules.
//   Compact (free plan): definition and calculation note of each entry, the key rules, and notes on
//   figures that differ from their definitions. lean: definitions only (used if a request would be too large).
function promptBlock(ids, { compact = false, lean = false, metricIds = [] } = {}) {
  const glossary = loadGlossary();
  const entries = entriesFor(ids);
  if (!glossary || !entries.length) return '';
  const lines = entries.map(m => {
    if (compact && lean) return `- ${m.term}: ${m.definition}`;
    if (compact) return `- ${m.term}: ${m.definition}${m.calculation_notes ? ` Note: ${clipText(m.calculation_notes, 220)}` : ''}`;
    const notes = [m.calculation_notes, ...Object.entries(m.platform_notes || {}).map(([p, n]) => `${p}: ${n}`)].filter(Boolean);
    return `- ${m.term}: ${m.definition} Why it matters: ${m.why_it_matters}${notes.length ? ` Notes: ${notes.join(' ')}` : ''}`;
  });
  const rules = compact
    ? (lean ? [] : KEY_RULES.map(r => `- ${r}`))
    : (glossary.usage?.reporting_rules || []).map(r => `- ${r}`);
  const figureNotes = lean ? [] : metricNotes(metricIds);
  return [
    'METRIC GLOSSARY (INFANT\'s approved definitions; interpret every metric according to its definition below and never write replacement definitions):',
    ...lines,
    ...(rules.length ? ['Glossary rules:', ...rules] : []),
    ...(figureNotes.length ? ['How these dashboard figures differ from the glossary (mention this where you use them):', ...figureNotes] : []),
  ].join('\n');
}

// The methodology note the glossary asks for at the end of every report: periods, sources,
// missing data and calculation limitations. Built from the data package, so it is always accurate.
const AVAILABILITY_TEXT = {
  not_connected: 'not connected',
  no_data_for_period: 'no data for this period',
  no_dates: 'uploaded without dates, so it cannot be split by period',
  no_dataset: 'not collected yet',
  headline_figure_only: 'headline figure only',
  not_uploaded: 'not uploaded',
  not_available: 'not available',
};
const SOURCE_NAMES = {
  instagram: 'Instagram (Meta)', facebook: 'Facebook (Meta)', linkedin: 'LinkedIn',
  mailchimp: 'Mailchimp', post_level_content: 'post-level content', publications: 'publications (Scopus and PubMed, verified INFANT affiliation)',
  events: 'Eventbrite', media: 'press and media sheet', kpis: 'KPI tracker', events_calendar: 'calendar of events',
  conferences: 'conference list', website: 'website analytics', awards: 'awards', campaigns: 'campaigns',
  content_themes: 'content themes', partnerships: 'partnerships',
};
const nameOf = key => SOURCE_NAMES[key] || key.replace(/_/g, ' ');

function methodologyNote(pkg) {
  if (!pkg?.report) return null;
  const { period, comparisons } = pkg.report;
  const availability = Object.entries(pkg.availability || {});
  const used = availability.filter(([, v]) => v === 'available').map(([k]) => nameOf(k));
  const missing = availability.filter(([, v]) => v !== 'available').map(([k, v]) => `${nameOf(k)} (${AVAILABILITY_TEXT[v] || String(v).replace(/_/g, ' ')})`);
  const partial = (pkg.facts || []).filter(f => f.current?.days_in_period && f.current.days_with_data < f.current.days_in_period)
    .map(f => `${f.label} (${f.current.days_with_data} of ${f.current.days_in_period} days)`);
  const glossary = loadGlossary();
  const limitations = [
    'All figures were calculated by the dashboard from the sources above. The AI interpreted them but did not calculate any number, and every figure it quotes was checked against the data; any problems found are shown with the report.',
    'Where a period was not fully covered by data, comparisons use the same number of days in each period.',
    ...matchingNotes((pkg.facts || []).map(f => f.id)).map(([, , , reader]) => reader),
    'Changes between periods show association, not cause.',
  ];
  return {
    periods: `${period.label} (${period.start} to ${period.end}), compared with ${comparisons.map(c => `${c.label} (${c.start} to ${c.end})`).join(' and ')}.`,
    sources: used,
    missing,
    partial_coverage: partial,
    limitations,
    glossary: glossary ? `Metric definitions: ${glossary.title}${glossary.schema_version ? `, version ${glossary.schema_version}` : ''}${glossary.status ? ` (${String(glossary.status).replace(/_/g, ' ')})` : ''}.` : null,
  };
}

// Plain-text version of the methodology note, for copying and the PDF.
function methodologyText(note) {
  if (!note) return '';
  const lines = ['METHODOLOGY', `Reporting period: ${note.periods}`];
  if (note.sources.length) lines.push(`Sources: ${note.sources.join(', ')}.`);
  if (note.missing.length) lines.push(`Not included: ${note.missing.join('; ')}.`);
  if (note.partial_coverage.length) lines.push(`Partial data in the period: ${note.partial_coverage.join('; ')}.`);
  lines.push('Limitations:', ...note.limitations.map(l => `- ${l}`));
  if (note.glossary) lines.push(note.glossary);
  return lines.join('\n');
}

module.exports = { loadGlossary, glossaryIdFor, comparisonIds, entriesFor, promptBlock, metricNotes, methodologyNote, methodologyText, GLOSSARY_FILE };
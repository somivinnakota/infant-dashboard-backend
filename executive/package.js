// Builds the "AI Data Package": every figure the AI may talk about, calculated here in code.
// The AI never does arithmetic. Each figure is a "fact" with a stable id that the AI must cite,
// and that the validator checks against.

const crypto = require('crypto');
const axios = require('axios');
const { resolvePeriod, daysIn, toIso, DAY } = require('./periods');

const PACKAGE_VERSION = '1.0';
const MAX_TITLE = 150;
const PLATFORM_NAMES = { ig: 'Instagram', fb: 'Facebook', li: 'LinkedIn' };
const UPLOAD_SOURCES = {
  media: 'Press and media',
  kpis: 'KPI tracker',
  events_calendar: 'Calendar of events',
  conferences: 'Conference list',
};

/* ── Small helpers ───────────────────────────────────────────── */

const shortHash = text => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 8);
const clip = (text, max = MAX_TITLE) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'value';
const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const inPeriod = (date, p) => date >= p.start && date <= p.end;

function combine(values, how) {
  if (!values.length) return null;
  if (how === 'mean') return values.reduce((a, b) => a + b, 0) / values.length;
  if (how === 'last') return values[values.length - 1];
  return values.reduce((a, b) => a + b, 0);
}

function formatValue(value, unit) {
  if (value === null || value === undefined) return 'not available';
  if (unit === 'percent') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'average') return value.toLocaleString('en-IE', { maximumFractionDigits: 1 });
  return Math.round(value).toLocaleString('en-IE');
}

// Change from a comparison value to the current value, with display text the AI quotes as given.
function compare(current, previous, unit) {
  if (current === null || previous === null || previous === undefined) return null;
  const change = current - previous;
  const pct = previous !== 0 ? round((change / Math.abs(previous)) * 100, 1) : null;
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  const result = {
    value: round(previous, 4),
    display: formatValue(previous, unit),
    change: round(change, 4),
    change_display: unit === 'percent'
      ? `${sign}${Math.abs(change * 100).toFixed(1)} percentage points`
      : `${sign}${formatValue(Math.abs(change), unit)}`,
    change_pct: pct,
    change_pct_display: pct === null ? 'not calculable (comparison value was zero)' : `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}%`,
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'no change',
  };
  if (unit !== 'percent' && previous !== 0 && Math.abs(previous) < 20) {
    result.note = 'Small comparison base: treat the percentage change with caution.';
  }
  return result;
}

/* ── Daily series (social media) ─────────────────────────────── */

// One fact for a daily series: current period, each comparison, and data coverage.
// If the current period isn't finished, each comparison uses the same number of days,
// so a part-covered quarter is never compared with a whole one.
function seriesFact({ id, section, platform, label, unit, how, rows, period }) {
  const current = rows.filter(r => inPeriod(r.date, period));
  if (!current.length) return null;
  const lastOffset = Math.round((Date.parse(current[current.length - 1].date) - Date.parse(period.start)) / DAY);
  const partial = current[current.length - 1].date < period.end;
  const notes = [];
  if (current.length < period.days) notes.push(`Data covers ${current.length} of ${period.days} days in ${period.label}.`);

  const vs = {};
  for (const c of period.comparisons) {
    const windowEnd = partial ? toIso(Date.parse(c.start) + lastOffset * DAY) : c.end;
    const window = { start: c.start, end: windowEnd < c.end ? windowEnd : c.end };
    const compRows = rows.filter(r => inPeriod(r.date, window));
    const expected = daysIn(window);
    if (compRows.length < expected * 0.8) {
      vs[c.key] = null;
      notes.push(`No reliable comparison with ${c.label}: data covers ${compRows.length} of ${expected} days.`);
      continue;
    }
    const result = compare(combine(current.map(r => r.value), how), combine(compRows.map(r => r.value), how), unit);
    if (partial) result.note = [result.note, `Like-for-like: first ${expected} days of each period.`].filter(Boolean).join(' ');
    vs[c.key] = result;
  }

  const value = combine(current.map(r => r.value), how);
  return {
    id, section, platform, label, unit, combined_by: how,
    current: { value: round(value, 4), display: formatValue(value, unit), days_with_data: current.length, days_in_period: period.days },
    vs,
    notes,
  };
}

function monthlyValues(rows, how, from, to) {
  const months = new Map();
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    const key = r.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(r.value);
  }
  return [...months.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([month, values]) => ({ month, value: round(combine(values, how), 4), days_with_data: values.length }));
}

function socialSection(social, period) {
  const facts = [];
  const monthly = {};
  const earliestCompare = period.comparisons.reduce((min, c) => (c.start < min ? c.start : min), period.start);
  for (const [name, rows] of Object.entries(social.series || {})) {
    const meta = social.meta?.[name] || {};
    if (!rows.length || meta.primary === false) continue;
    const code = name.split('-')[0];
    const unit = meta.format === 'percent' ? 'percent' : meta.aggregation === 'mean' ? 'average' : 'count';
    const fact = seriesFact({
      id: `social.${name}`,
      section: 'social',
      platform: PLATFORM_NAMES[code] || code,
      label: meta.label || name,
      unit,
      how: meta.aggregation || 'sum',
      rows,
      period,
    });
    if (!fact) continue;
    if (meta.aggregation === 'sum' && /reach|unique/i.test(meta.label || '')) {
      fact.notes.push('Daily figures added up, so the same person can be counted on several days.');
    }
    facts.push(fact);
    monthly[fact.id] = monthlyValues(rows, meta.aggregation || 'sum', earliestCompare, period.end);
  }
  return { facts, monthly };
}

/* ── Post lists (e.g. LinkedIn "All posts") ──────────────────── */

function postsSection(social, period) {
  const facts = [];
  const lists = {};
  for (const [key, list] of Object.entries(social.items || {})) {
    const code = key.split('-')[0];
    const platform = PLATFORM_NAMES[code] || code;
    const rows = (list.rows || []).filter(r => r.date);
    const reach = list.measures.find(m => /impression|reach|view/i.test(m.header));
    const rate = list.measures.find(m => /engagement rate/i.test(m.header));
    const shown = list.measures.slice(0, 6).map(m => m.header);

    const countFact = (label, idPart, pick) => {
      const now = pick(rows.filter(r => inPeriod(r.date, period)));
      if (now === null) return;
      const vs = {};
      for (const c of period.comparisons) vs[c.key] = compare(now, pick(rows.filter(r => inPeriod(r.date, c))), idPart === 'avg_engagement_rate' ? 'percent' : 'count');
      const unit = idPart === 'avg_engagement_rate' ? 'percent' : 'count';
      facts.push({ id: `posts.${code}.${idPart}`, section: 'content', platform, label: `${platform} ${label}`, unit, combined_by: idPart === 'avg_engagement_rate' ? 'mean' : 'sum', current: { value: round(now, 4), display: formatValue(now, unit) }, vs, notes: [] });
    };
    countFact('posts published', 'count', items => items.length);
    if (reach) countFact(`${reach.header.toLowerCase()} from posts published in the period`, 'reach', items => (items.length ? items.reduce((t, r) => t + (r.values[reach.header] || 0), 0) : null));
    if (rate) countFact('average engagement rate per post', 'avg_engagement_rate', items => {
      const values = items.map(r => r.values[rate.header]).filter(v => typeof v === 'number');
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    });

    const current = rows.filter(r => inPeriod(r.date, period) && (!reach || typeof r.values[reach.header] === 'number'));
    const sorted = reach ? [...current].sort((a, b) => b.values[reach.header] - a.values[reach.header]) : current;
    const describePost = r => ({
      id: `post.${code}.${shortHash(r.id)}`,
      date: r.date,
      title: clip(r.title),
      metrics: Object.fromEntries(shown.filter(h => typeof r.values[h] === 'number').map(h => [h, round(r.values[h], 4)])),
    });
    lists[`${code}_posts`] = {
      platform,
      ranked_by: reach ? reach.header : null,
      top: sorted.slice(0, 5).map(describePost),
      bottom: sorted.length > 8 ? sorted.slice(-3).map(describePost) : [],
    };
  }
  return { facts, lists };
}

/* ── Audience breakdowns (snapshots, not period-specific) ────── */

function audienceSection(social) {
  return Object.entries(social.breakdowns || {}).map(([key, b]) => ({
    id: `aud.${key}`,
    platform: PLATFORM_NAMES[key.split('-')[0]] || key,
    label: b.label,
    note: 'Snapshot from the latest upload, not specific to the report period.',
    top: (b.rows || []).slice(0, 5).map(r => ({ name: clip(r.name, 60), value: r.value })),
  }));
}

/* ── Publications (PubMed) ───────────────────────────────────── */

const PUBMED = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const PUBMED_TERM = '"INFANT research centre"[Affiliation]';
let pubCache = { at: 0, items: null };

async function fetchPublications() {
  if (pubCache.items && Date.now() - pubCache.at < 6 * 3600 * 1000) return pubCache.items;
  const search = await axios.get(`${PUBMED}/esearch.fcgi`, {
    params: { db: 'pubmed', term: PUBMED_TERM, retmax: 600, retmode: 'json', sort: 'pub_date' },
    timeout: 20000,
  });
  const ids = search.data.esearchresult?.idlist || [];
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { data } = await axios.get(`${PUBMED}/esummary.fcgi`, { params: { db: 'pubmed', id: batch.join(','), retmode: 'json' }, timeout: 20000 });
    for (const id of batch) {
      const p = data.result?.[id];
      const date = (p?.sortpubdate || '').slice(0, 10).replace(/\//g, '-');
      if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      items.push({ id: `pub.${id}`, date, title: clip(p.title), journal: clip(p.fulljournalname || p.source || '', 80), open_access: Boolean(p.pmc) });
    }
  }
  pubCache = { at: Date.now(), items };
  return items;
}

function publicationsSection(items, period) {
  if (!items) return { status: 'not_available', facts: [], context: {} };
  const earliest = items.reduce((min, p) => (p.date < min ? p.date : min), '9999');
  const count = p => items.filter(i => inPeriod(i.date, p)).length;
  const now = count(period);
  const vs = {};
  const notes = ['Counted from PubMed by the "INFANT Research Centre" affiliation; other databases count differently.'];
  for (const c of period.comparisons) {
    if (c.start < earliest) { vs[c.key] = null; notes.push(`No comparison with ${c.label}: the publication list loaded does not go back that far.`); continue; }
    vs[c.key] = compare(now, count(c), 'count');
  }
  const current = items.filter(i => inPeriod(i.date, period)).sort((a, b) => b.date.localeCompare(a.date));
  const facts = [{ id: 'pub.count', section: 'publications', label: 'Publications (PubMed)', unit: 'count', combined_by: 'count', current: { value: now, display: formatValue(now, 'count') }, vs, notes }];
  if (current.length) {
    const share = current.filter(i => i.open_access).length / current.length;
    facts.push({ id: 'pub.open_access_share', section: 'publications', label: 'Share of publications open access in PubMed Central', unit: 'percent', combined_by: 'share', current: { value: round(share, 4), display: formatValue(share, 'percent') }, vs: {}, notes: [] });
  }
  const journals = {};
  current.forEach(i => { if (i.journal) journals[i.journal] = (journals[i.journal] || 0) + 1; });
  return {
    status: 'available',
    facts,
    context: {
      top_journals: Object.entries(journals).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([journal, n]) => ({ journal, publications: n })),
      in_period: current.slice(0, 25),
    },
  };
}

/* ── Events (Eventbrite) ─────────────────────────────────────── */

function eventsSection(eventbrite, period) {
  if (!eventbrite) return { status: 'not_available', facts: [], context: {} };
  const events = eventbrite.events.map(e => ({ ...e, date: (e.start || '').slice(0, 10) })).filter(e => e.date);
  const pick = p => events.filter(e => inPeriod(e.date, p));
  const fact = (id, label, measure) => {
    const now = measure(pick(period));
    const vs = {};
    for (const c of period.comparisons) vs[c.key] = compare(now, measure(pick(c)), 'count');
    return { id, section: 'events', label, unit: 'count', combined_by: 'count', current: { value: now, display: formatValue(now, 'count') }, vs, notes: [] };
  };
  return {
    status: 'available',
    facts: [
      fact('ev.count', 'Eventbrite events held or scheduled', list => list.length),
      fact('ev.capacity', 'Total Eventbrite capacity (places offered, not attendance)', list => list.reduce((t, e) => t + (e.capacity || 0), 0)),
      fact('ev.free', 'Free Eventbrite events', list => list.filter(e => e.is_free).length),
    ],
    context: {
      note: 'Eventbrite provides capacity but not registrations or attendance.',
      in_period: pick(period).slice(0, 20).map(e => ({ id: `ev.${e.id}`, date: e.date, name: clip(e.name, 100), status: e.status, capacity: e.capacity || null })),
    },
  };
}

/* ── Email (Mailchimp) ───────────────────────────────────────── */

// Campaigns sent in each period. Rates are worked out from the period's totals (all campaigns
// combined), so a large send counts for more than a small one.
function emailSection(mailchimp, period) {
  if (!mailchimp) return { status: 'not_connected', facts: [], context: {} };
  const campaigns = (mailchimp.campaigns || [])
    .map(c => ({ ...c, date: String(c.sentAt || '').slice(0, 10) }))
    .filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.date));
  const current = campaigns.filter(c => inPeriod(c.date, period));
  if (!current.length) return { status: 'no_data_for_period', facts: [], context: {} };

  const earliest = campaigns.reduce((min, c) => (c.date < min ? c.date : min), '9999-12-31');
  const pick = p => campaigns.filter(c => inPeriod(c.date, p));
  const total = (list, key) => list.reduce((t, c) => t + (c[key] || 0), 0);
  const rate = (list, key, base) => { const b = total(list, base); return b > 0 ? total(list, key) / b : null; };
  const measures = [
    ['email.campaigns', 'Email campaigns sent (Mailchimp)', 'count', list => list.length],
    ['email.delivered', 'Emails delivered (Mailchimp)', 'count', list => total(list, 'delivered')],
    ['email.engagement_rate', 'Email engagement rate (subscribers who clicked ÷ emails delivered)', 'percent', list => rate(list, 'uniqueClicks', 'delivered')],
    ['email.open_rate', 'Email open rate (unique opens ÷ emails delivered)', 'percent', list => rate(list, 'uniqueOpens', 'delivered')],
    ['email.click_to_open', 'Email click-to-open rate (subscribers who clicked ÷ unique opens)', 'percent', list => rate(list, 'uniqueClicks', 'uniqueOpens')],
    ['email.unsubscribe_rate', 'Email unsubscribe rate (unsubscribes ÷ emails delivered)', 'percent', list => rate(list, 'unsubscribed', 'delivered')],
  ];

  const facts = [];
  for (const [id, label, unit, measure] of measures) {
    const now = measure(current);
    if (now === null) continue;
    const vs = {};
    const notes = [];
    for (const c of period.comparisons) {
      if (c.end < earliest) {
        vs[c.key] = null;
        notes.push(`No comparison with ${c.label}: no Mailchimp campaigns are recorded before ${earliest}.`);
        continue;
      }
      vs[c.key] = compare(now, measure(pick(c)), unit);
    }
    if (id === 'email.open_rate') notes.push('Open rates can be inflated by Apple Mail Privacy Protection, so the engagement rate is the more reliable measure.');
    facts.push({
      id, section: 'email', platform: 'Mailchimp', label, unit,
      combined_by: unit === 'percent' ? 'ratio of period totals' : 'sum',
      current: { value: round(now, 4), display: formatValue(now, unit) },
      vs, notes,
    });
  }

  const perCampaign = (c, key) => (c.delivered > 0 ? c[key] / c.delivered : null);
  const ranked = [...current].sort((a, b) => (perCampaign(b, 'uniqueClicks') ?? -1) - (perCampaign(a, 'uniqueClicks') ?? -1));
  return {
    status: 'available',
    facts,
    context: {
      note: 'Campaigns sent from Mailchimp, ranked by engagement rate.',
      in_period: ranked.slice(0, 10).map(c => ({
        id: `email.${c.id}`,
        date: c.date,
        title: clip(c.title, 100),
        delivered: c.delivered,
        open_rate: formatValue(perCampaign(c, 'uniqueOpens'), 'percent'),
        engagement_rate: formatValue(perCampaign(c, 'uniqueClicks'), 'percent'),
        unsubscribes: c.unsubscribed,
      })),
    },
  };
}

/* ── Uploaded spreadsheets (press, KPIs, calendar, conferences) ─ */

const MONTH_WORDS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function toDate(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return isoFrom(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return isoFrom(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})$/i);
  if (m && MONTH_WORDS.includes(m[2].slice(0, 3).toLowerCase())) return isoFrom(+m[3], MONTH_WORDS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
  return null;
}
function isoFrom(y, mo, d) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
}
const toNumber = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[€$£%,\s]/g, '')) : NaN);

function uploadSection(key, title, upload, period) {
  if (!upload || !Array.isArray(upload.sheets) || !upload.sheets.length) return { status: 'not_uploaded', facts: [], context: {} };
  const sheet = upload.sheets.find(s => (s.rows || []).length) || upload.sheets[0];
  const headers = sheet.headers || [];
  const rows = (sheet.rows || []).slice(0, 5000);
  const filled = h => rows.map(r => r[h]).filter(v => v !== null && v !== undefined && String(v).trim() !== '');

  const dateCol = headers.find(h => /date|day|published|when/i.test(h) && filled(h).filter(toDate).length >= filled(h).length * 0.7 && filled(h).length)
    || headers.find(h => filled(h).length && filled(h).filter(toDate).length >= filled(h).length * 0.9);
  if (!dateCol) {
    return {
      status: 'no_dates',
      facts: [{ id: `${key}.rows`, section: key, label: `${title}: rows in the uploaded file`, unit: 'count', combined_by: 'count', current: { value: rows.length, display: formatValue(rows.length, 'count') }, vs: {}, notes: ['The file has no date column, so it cannot be split by period.'] }],
      context: { file: upload.fileName, columns: headers },
    };
  }
  const dated = rows.map(r => ({ r, date: toDate(r[dateCol]) })).filter(x => x.date);
  const pick = p => dated.filter(x => inPeriod(x.date, p));
  const numberCols = headers.filter(h => h !== dateCol && filled(h).length && filled(h).filter(v => !Number.isNaN(toNumber(v))).length >= filled(h).length * 0.8);
  const textCols = headers.filter(h => h !== dateCol && !numberCols.includes(h) && filled(h).length);

  const makeFact = (id, label, measure) => {
    const now = measure(pick(period));
    const vs = {};
    for (const c of period.comparisons) vs[c.key] = compare(now, measure(pick(c)), 'count');
    return { id, section: key, label, unit: 'count', combined_by: 'sum', current: { value: now, display: formatValue(now, 'count') }, vs, notes: [] };
  };
  const facts = [makeFact(`${key}.rows`, `${title}: entries`, list => list.length)];
  numberCols.slice(0, 6).forEach(h => facts.push(makeFact(`${key}.${slug(h)}.total`, `${title}: total ${h}`, list => list.reduce((t, x) => t + (Number.isNaN(toNumber(x.r[h])) ? 0 : toNumber(x.r[h])), 0))));

  const current = pick(period);
  const categories = textCols
    .map(h => ({ h, values: current.map(x => String(x.r[h] ?? '').trim()).filter(Boolean) }))
    .filter(c => c.values.length && new Set(c.values).size <= Math.max(3, c.values.length * 0.6) && c.values.every(v => v.length <= 40))
    .slice(0, 3)
    .map(c => {
      const counts = {};
      c.values.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
      return { column: c.h, top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, entries: n })) };
    });

  return {
    status: 'available',
    facts,
    context: {
      file: upload.fileName,
      date_column: dateCol,
      categories,
      in_period: current.slice(0, 15).map((x, i) => ({
        id: `${key}.row.${i + 1}`,
        date: x.date,
        ...Object.fromEntries(textCols.slice(0, 3).map(h => [h, clip(x.r[h], 120)])),
        ...Object.fromEntries(numberCols.slice(0, 2).map(h => [h, toNumber(x.r[h])])),
      })),
    },
  };
}

/* ── The package ─────────────────────────────────────────────── */

async function buildPackage({ type, periodKey, social, eventbrite, impact, facebook, mailchimp = null, uploads = {}, loadPublications = fetchPublications }) {
  const period = resolvePeriod(type, periodKey);
  const { facts: socialFacts, monthly } = socialSection(social, period);
  const { facts: postFacts, lists: posts } = postsSection(social, period);

  let publications = null;
  try { publications = await loadPublications(); } catch (error) { console.warn('Executive report: PubMed unavailable:', error.message); }
  const pubs = publicationsSection(publications, period);
  const events = eventsSection(eventbrite, period);
  const email = emailSection(mailchimp, period);
  const uploadParts = Object.fromEntries(Object.entries(UPLOAD_SOURCES).map(([key, title]) => [key, uploadSection(key, title, uploads[key], period)]));

  const context = [];
  if (impact?.headlines) {
    const h = impact.headlines;
    const add = (id, label, value) => value !== undefined && context.push({ id, label, display: String(value) });
    add('ctx.infants_impacted', 'Infants impacted globally', h.infantsImpacted);
    add('ctx.funding', 'Research funding secured', h.fundingSecured);
    add('ctx.team', 'Team members', h.teamMembers);
    add('ctx.spinouts', 'Spin-out companies', h.spinouts);
    add('ctx.countries', 'Partner countries', h.partnershipCountries);
    add('ctx.partnerships', 'Active partnerships', h.partnerships);
  }
  if (facebook?.followers_count !== undefined) context.push({ id: 'ctx.fb_followers_today', label: 'Facebook followers today (live, not period-specific)', display: Number(facebook.followers_count).toLocaleString('en-IE') });

  const platformAvailable = code => socialFacts.some(f => f.id.startsWith(`social.${code}-`));
  const facts = [
    ...socialFacts,
    ...postFacts,
    ...pubs.facts,
    ...events.facts,
    ...email.facts,
    ...Object.values(uploadParts).flatMap(u => u.facts),
  ];

  const pkg = {
    package_version: PACKAGE_VERSION,
    generated_at: new Date().toISOString(),
    report: {
      type: period.type,
      period: { key: period.key, label: period.label, start: period.start, end: period.end, days: period.days },
      comparisons: period.comparisons.map(({ key, label, start, end, days }) => ({ key, label, start, end, days })),
    },
    availability: {
      website: 'not_connected',
      instagram: platformAvailable('ig') ? 'available' : 'no_data_for_period',
      facebook: platformAvailable('fb') ? 'available' : 'no_data_for_period',
      linkedin: platformAvailable('li') ? 'available' : 'no_data_for_period',
      mailchimp: email.status,
      post_level_content: postFacts.length ? 'available' : 'no_data_for_period',
      publications: pubs.status,
      events: events.status,
      media: uploadParts.media.status,
      kpis: uploadParts.kpis.status,
      events_calendar: uploadParts.events_calendar.status,
      conferences: uploadParts.conferences.status,
      awards: 'no_dataset',
      campaigns: 'no_dataset',
      content_themes: 'no_dataset',
      partnerships: 'headline_figure_only',
    },
    facts,
    monthly,
    content: posts,
    audience: audienceSection(social),
    publications: pubs.context,
    events: events.context,
    email: email.context,
    uploads: Object.fromEntries(Object.entries(uploadParts).map(([k, v]) => [k, v.context])),
    context,
  };
  pkg.data_snapshot = `sha256:${crypto.createHash('sha256').update(JSON.stringify({ facts, monthly, posts })).digest('hex').slice(0, 16)}`;
  return pkg;
}

// Every id the AI is allowed to cite.
function evidenceIds(pkg) {
  const ids = new Set(pkg.facts.map(f => f.id));
  pkg.context.forEach(c => ids.add(c.id));
  pkg.audience.forEach(a => ids.add(a.id));
  Object.values(pkg.content).forEach(l => [...l.top, ...l.bottom].forEach(p => ids.add(p.id)));
  (pkg.publications.in_period || []).forEach(p => ids.add(p.id));
  (pkg.events.in_period || []).forEach(e => ids.add(e.id));
  (pkg.email?.in_period || []).forEach(c => ids.add(c.id));
  Object.values(pkg.uploads).forEach(u => (u.in_period || []).forEach(r => ids.add(r.id)));
  return ids;
}

module.exports = { buildPackage, evidenceIds, compare, combine, formatValue, seriesFact, uploadSection, fetchPublications, UPLOAD_SOURCES };
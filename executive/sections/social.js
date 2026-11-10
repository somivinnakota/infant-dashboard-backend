// Social media: one fact per daily series, the top and bottom posts, and audience breakdowns.

const { daysIn } = require('../periods');
const { DAY, isoDay } = require('../../time');
const { PLATFORM_NAMES, shortHash, clip, round, inPeriod, combine, formatValue, compare, compareEach } = require('../facts');

/* ── Daily series ────────────────────────────────────────────── */

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
    const windowEnd = partial ? isoDay(Date.parse(c.start) + lastOffset * DAY) : c.end;
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

    // Adds one fact about the posts published in the period. measure(posts) returns the figure, or null for none.
    const addFact = (idPart, label, unit, how, measure) => {
      const postsIn = p => rows.filter(r => inPeriod(r.date, p));
      const now = measure(postsIn(period));
      if (now === null) return;
      facts.push({
        id: `posts.${code}.${idPart}`, section: 'content', platform, label: `${platform} ${label}`, unit, combined_by: how,
        current: { value: round(now, 4), display: formatValue(now, unit) },
        vs: compareEach(period, c => compare(now, measure(postsIn(c)), unit)),
        notes: [],
      });
    };
    addFact('count', 'posts published', 'count', 'sum', posts => posts.length);
    if (reach) {
      addFact('reach', `${reach.header.toLowerCase()} from posts published in the period`, 'count', 'sum',
        posts => (posts.length ? posts.reduce((total, r) => total + (r.values[reach.header] || 0), 0) : null));
    }
    if (rate) {
      addFact('avg_engagement_rate', 'average engagement rate per post', 'percent', 'mean', posts => {
        const values = posts.map(r => r.values[rate.header]).filter(v => typeof v === 'number');
        return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      });
    }

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

module.exports = { seriesFact, socialSection, postsSection, audienceSection };
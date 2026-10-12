// Recognises social media analytics exports by their structure, not by file names
// or exact column names. Works for Meta CSVs, LinkedIn spreadsheets and similar files.
//
// Every sheet in an upload is sorted into one of three kinds of table:
//   daily       a date column plus number columns, one row per day   → time series
//   breakdown   a category column plus one number column             → audience snapshot
//   items       titles/links plus numbers (e.g. one row per post)     → item list
// Dates (ISO, day/month or month/day), rates and running totals are worked out from the data.

const PLATFORMS = {
  instagram: { code: 'ig', name: 'Instagram', domain: 'instagram.com' },
  facebook: { code: 'fb', name: 'Facebook', domain: 'facebook.com' },
  linkedin: { code: 'li', name: 'LinkedIn', domain: 'linkedin.com' },
};
const PLATFORM_NAMES = Object.fromEntries(Object.values(PLATFORMS).map(p => [p.code, p.name]));

// Metric names that map to the dashboard's standard keys, so Meta charts keep working.
// Any other metric is still imported, under a key made from its own name.
const METRIC_ALIASES = {
  'reach': 'reach',
  'accounts reached': 'reach',
  'views': 'views',
  'interactions': 'interactions',
  'content interactions': 'interactions',
  'visits': 'visits',
  'profile visits': 'visits',
  'page visits': 'visits',
  'follows': 'follows',
  'new follows': 'follows',
  'new followers': 'follows',
  'link clicks': 'clicks',
  'viewers': 'viewers',
};
const STANDARD_LABELS = {
  reach: 'reach (daily reach added up)',
  views: 'views',
  interactions: 'interactions',
  visits: 'visits',
  follows: 'new followers',
  clicks: 'link clicks',
  viewers: 'viewers',
};

const GENERIC_VALUE_HEADER = /^(primary|value|values|count|amount|total|metric|number)$/i;
const DATE_HEADER = /\b(date|day)\b/i;
const RATE_HEADER = /\b(rate|ctr|ratio|average|avg|percent|percentage)\b|%/i;
const TITLE_HEADER = /\b(title|name|post|text|caption|description|message)\b/i;
const URL_PATTERN = /^https?:\/\//i;
const MAX_HEADER_SEARCH = 25;
const MAX_ITEMS_PER_LIST = 1000;
const MAX_BREAKDOWN_ROWS = 100;

/* ── Cells ───────────────────────────────────────────────────── */

const isBlank = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const s = value.trim();
  if (s === '') return NaN;
  const percent = s.endsWith('%');
  const n = Number(s.replace(/[%,€$£\s]/g, ''));
  return percent ? n / 100 : n;
}
const isNumeric = v => !Number.isNaN(toNumber(v));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NAMED_DATE = /^(?:[a-z]+,?\s+)?(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?|([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?)\s+(\d{4})$/i;

// Splits a date into parts without deciding day/month order yet.
function dateParts(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) return { kind: 'iso', y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?:\s.*)?$/);
  if (m) return { kind: 'ab', a: +m[1], b: +m[2], y: m[3].length === 2 ? 2000 + +m[3] : +m[3] };
  m = s.match(NAMED_DATE);
  if (m) {
    const month = MONTHS.indexOf((m[2] || m[3]).slice(0, 3).toLowerCase()) + 1;
    if (month > 0) return { kind: 'iso', y: +m[5], m: month, d: +(m[1] || m[4]) };
  }
  return null;
}

function isoDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

function partsToIso(parts, order) {
  if (!parts) return null;
  if (parts.kind === 'iso') return isoDate(parts.y, parts.m, parts.d);
  return order === 'mdy' ? isoDate(parts.y, parts.a, parts.b) : isoDate(parts.y, parts.b, parts.a);
}

const dayNumber = iso => Date.parse(`${iso}T00:00:00Z`) / 86400000;

// Works out whether ambiguous dates like 05/10/2025 are day-first or month-first:
// first from any value above 12, then from which reading gives a steady sequence of days.
function inferDateOrder(values) {
  const parts = values.map(dateParts).filter(p => p && p.kind === 'ab');
  if (parts.length === 0) return { order: 'dmy', ambiguous: false };
  if (parts.some(p => p.a > 12)) return { order: 'dmy', ambiguous: false };
  if (parts.some(p => p.b > 12)) return { order: 'mdy', ambiguous: false };
  const score = order => {
    const days = parts.map(p => partsToIso(p, order)).filter(Boolean).map(dayNumber);
    let steady = 0;
    for (let i = 1; i < days.length; i++) if (Math.abs(days[i] - days[i - 1]) === 1) steady += 1;
    return steady;
  };
  const dmy = score('dmy');
  const mdy = score('mdy');
  if (dmy === mdy) return { order: 'dmy', ambiguous: true };
  return { order: mdy > dmy ? 'mdy' : 'dmy', ambiguous: false };
}

/* ── Table recognition ───────────────────────────────────────── */

const isTextLabel = v => typeof v === 'string' && !isNumeric(v) && !dateParts(v);

// The header row is the first row with two or more text labels, followed by a row with data.
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length - 1, MAX_HEADER_SEARCH); i++) {
    const filled = rows[i].filter(v => !isBlank(v));
    if (filled.length < 2 || !filled.every(isTextLabel)) continue;
    const next = rows.slice(i + 1).find(r => r.some(v => !isBlank(v)));
    if (next && next.some(v => isNumeric(v) || dateParts(v))) return i;
  }
  return -1;
}

// A one-cell line above the header, like Meta's "Views". Ignores "sep=," and long descriptions.
function findTitle(rows, headerIndex) {
  for (let i = headerIndex - 1; i >= 0; i--) {
    const filled = rows[i].filter(v => !isBlank(v));
    if (filled.length === 1 && typeof filled[0] === 'string') {
      const text = filled[0].trim();
      if (!/^sep=/i.test(text) && text.length <= 60) return text;
    }
  }
  return null;
}

function describeColumn(rows, index) {
  const values = rows.map(r => r[index]).filter(v => !isBlank(v));
  const count = values.length;
  if (count === 0) return { count: 0 };
  const strings = values.filter(v => typeof v === 'string');
  return {
    count,
    values,
    dateRatio: values.filter(v => dateParts(v)).length / count,
    numericRatio: values.filter(isNumeric).length / count,
    urlRatio: strings.filter(v => URL_PATTERN.test(v.trim())).length / count,
    uniqueRatio: new Set(values.map(v => String(v).trim())).size / count,
    avgLength: strings.reduce((n, v) => n + v.length, 0) / Math.max(strings.length, 1),
  };
}

// How a metric should be combined over time: added up, averaged (rates) or latest value (running totals).
function aggregationFor(header, numbers) {
  const values = numbers.filter(n => !Number.isNaN(n));
  if (RATE_HEADER.test(header)) {
    // Rates stored as fractions (0.06 = 6%); the odd day can exceed 1 when engagement beats impressions.
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return { aggregation: 'mean', format: median <= 1 ? 'percent' : 'number' };
  }
  if (values.length && values.every(v => v >= 0 && v <= 1) && values.some(v => v > 0 && v < 1)) {
    return { aggregation: 'mean', format: 'percent' };
  }
  if (values.length >= 14 && values[0] > 0) {
    let rising = 0;
    for (let i = 1; i < values.length; i++) if (values[i] >= values[i - 1]) rising += 1;
    if (rising / (values.length - 1) >= 0.95 && values[values.length - 1] > values[0]) return { aggregation: 'last', format: 'number' };
  }
  return { aggregation: 'sum', format: 'number' };
}

// Detail columns are kept but not headlined when a total for them exists, e.g.
// "Clicks (organic)" next to "Clicks (total)", or "Sponsored followers" next to "Total followers".
function isDetailColumn(header, headers) {
  const lower = header.toLowerCase();
  const m = header.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m && m[2].trim().toLowerCase() !== 'total') {
    const total = `${m[1].trim()} (total)`.toLowerCase();
    if (headers.some(h => h.toLowerCase() === total)) return true;
  }
  if (lower.startsWith('total ')) return false;
  return headers.some(h => {
    const t = h.match(/^total\s+(.+)$/i);
    return t && h !== header && lower.endsWith(` ${t[1].toLowerCase()}`);
  });
}

// "Total followers" in a sheet called "New followers" means new followers per day, not a running total.
function metricName(header, title, sheetName) {
  if (GENERIC_VALUE_HEADER.test(header) && title) return title;
  const t = header.match(/^total\s+(.+)$/i);
  if (t && sheetName && sheetName.toLowerCase() !== t[1].toLowerCase() && sheetName.toLowerCase().endsWith(t[1].toLowerCase())) {
    return `${sheetName} (total)`;
  }
  return header;
}

function analyseSheet(rawRows, sheetName) {
  const rows = rawRows.map(r => (Array.isArray(r) ? r : []).map(v => (typeof v === 'string' ? v.trim() : v)));
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) return { kind: 'unknown', sheetName };

  const width = Math.max(...rows.map(r => r.length));
  const headers = Array.from({ length: width }, (_, i) => {
    const h = rows[headerIndex][i];
    return isBlank(h) ? `Column ${i + 1}` : String(h).trim();
  });
  const data = rows.slice(headerIndex + 1).filter(r => r.some(v => !isBlank(v)));
  const title = findTitle(rows, headerIndex);
  const columns = headers.map((h, i) => ({ header: h, index: i, ...describeColumn(data, i) })).filter(c => c.count > 0);

  const dateColumn = columns.find(c => DATE_HEADER.test(c.header) && c.dateRatio >= 0.8)
    || columns.find(c => c.dateRatio >= 0.9);
  const numberColumns = columns.filter(c => c !== dateColumn && c.numericRatio >= 0.8);
  const textColumns = columns.filter(c => c !== dateColumn && !numberColumns.includes(c) && c.dateRatio < 0.8);

  // Daily time series: one row per date, numbers only.
  if (dateColumn && numberColumns.length && textColumns.length === 0) {
    const { order, ambiguous } = inferDateOrder(dateColumn.values);
    const dated = data
      .map(r => ({ date: partsToIso(dateParts(r[dateColumn.index]), order), row: r }))
      .filter(x => x.date);
    const uniqueDates = new Set(dated.map(x => x.date)).size;
    if (dated.length && uniqueDates >= dated.length * 0.95) {
      dated.sort((a, b) => a.date.localeCompare(b.date));
      const series = numberColumns.map(c => {
        const name = metricName(c.header, title, sheetName);
        const points = dated
          .map(x => ({ date: x.date, value: toNumber(x.row[c.index]) }))
          .filter(p => !Number.isNaN(p.value));
        return {
          name,
          points,
          ...aggregationFor(c.header, points.map(p => p.value)),
          primary: !isDetailColumn(c.header, headers),
        };
      });
      return { kind: 'daily', sheetName, series, dateOrder: order, ambiguousDates: ambiguous };
    }
  }

  // Breakdown: a category column plus one number column.
  if (columns.length === 2 && textColumns.length === 1 && numberColumns.length === 1 && textColumns[0].index < numberColumns[0].index) {
    const [category] = textColumns;
    const [count] = numberColumns;
    const items = data
      .map(r => ({ name: String(r[category.index] ?? '').trim(), value: toNumber(r[count.index]) }))
      .filter(x => x.name && !Number.isNaN(x.value))
      .sort((a, b) => b.value - a.value)
      .slice(0, MAX_BREAKDOWN_ROWS);
    return { kind: 'breakdown', sheetName, label: `${count.header} by ${category.header}`, category: category.header, measure: count.header, rows: items };
  }

  // Item list, e.g. one row per post.
  if (numberColumns.length && textColumns.length) {
    const urlColumn = textColumns.find(c => c.urlRatio >= 0.8);
    const titleColumn = textColumns.find(c => c !== urlColumn && TITLE_HEADER.test(c.header) && c.uniqueRatio >= 0.5)
      || [...textColumns].filter(c => c !== urlColumn).sort((a, b) => b.avgLength - a.avgLength)[0];
    const itemDateColumn = columns.find(c => DATE_HEADER.test(c.header) && c.dateRatio >= 0.8);
    const { order } = itemDateColumn ? inferDateOrder(itemDateColumn.values) : { order: 'dmy' };
    const measures = numberColumns.map(c => ({ header: c.header, ...aggregationFor(c.header, c.values.map(toNumber)) }));
    const items = data.map(r => {
      const titleText = titleColumn ? String(r[titleColumn.index] ?? '').trim() : '';
      const url = urlColumn ? String(r[urlColumn.index] ?? '').trim() : '';
      const date = itemDateColumn ? partsToIso(dateParts(r[itemDateColumn.index]), order) : null;
      const values = {};
      numberColumns.forEach(c => {
        const n = toNumber(r[c.index]);
        if (!Number.isNaN(n)) values[c.header] = n;
      });
      return { id: url || `${date || ''}|${titleText.slice(0, 80)}`, title: titleText.slice(0, 300), url, date, values };
    }).filter(item => item.title || item.url);
    return { kind: 'items', sheetName, label: sheetName, measures, rows: items };
  }

  return { kind: 'unknown', sheetName };
}

/* ── CSV text → rows ─────────────────────────────────────────── */

function decodeText(buffer) {
  const isUtf16 = (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer.length > 1 && buffer[1] === 0x00);
  return buffer.toString(isUtf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
}

// A small CSV reader that handles quotes, "sep=" lines and comma, semicolon or tab separators.
function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  let separator = ',';
  const sepLine = lines.find(l => /^"?sep=.?"?$/i.test(l.trim()));
  if (sepLine) separator = sepLine.replace(/"/g, '').trim().slice(4) || ',';
  else {
    const sample = lines.slice(0, 20).join('\n');
    const counts = { ',': (sample.match(/,/g) || []).length, ';': (sample.match(/;/g) || []).length, '\t': (sample.match(/\t/g) || []).length };
    separator = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(v => (v.trim() === '' ? null : v.trim())));
}

/* ── Keys and labels ─────────────────────────────────────────── */

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'metric';

function seriesKey(code, metricName) {
  const normal = metricName.toLowerCase().replace(/\b(instagram|facebook|linkedin)\b/g, '').replace(/\s+/g, ' ').trim();
  const standard = METRIC_ALIASES[normal];
  // "Total page views (total)" reads better as "Total page views".
  const label = standard ? STANDARD_LABELS[standard] : metricName.replace(/^(total\s.+?)\s*\(total\)$/i, '$1');
  return { key: `${code}-${standard || slug(normal)}`, label };
}

function seriesLabel(key, meta) {
  const code = key.split('-')[0];
  const metric = key.slice(code.length + 1);
  const label = meta?.[key]?.label || STANDARD_LABELS[metric] || metric.replace(/-/g, ' ');
  return `${PLATFORM_NAMES[code] || code} ${label}`;
}

/* ── Importing into the saved store ──────────────────────────── */

// Counts links to each platform's website, to catch files dropped under the wrong platform.
function dominantPlatformInLinks(sheets) {
  const counts = {};
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const v of row) {
        if (typeof v !== 'string' || !URL_PATTERN.test(v)) continue;
        for (const p of Object.values(PLATFORMS)) if (v.includes(p.domain)) counts[p.code] = (counts[p.code] || 0) + 1;
      }
    }
  }
  const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return top && top[1] >= 3 ? top[0] : null;
}

const formatDay = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function importFile(store, { fileName, sheets, platform }) {
  const code = platform;
  const name = PLATFORM_NAMES[code];

  const linked = dominantPlatformInLinks(sheets);
  if (linked && linked !== code) {
    return { fileName, ok: false, message: `This file contains ${PLATFORM_NAMES[linked]} links, but it was added under ${name}.` };
  }

  const analysed = sheets.map(s => analyseSheet(s.rows || [], s.name || fileName));
  const recognised = analysed.filter(a => a.kind !== 'unknown');
  if (recognised.length === 0) {
    return { fileName, ok: false, message: 'No daily figures, breakdowns or post lists were found in this file. Is it an analytics export?' };
  }

  // A file whose daily figures exactly match another platform's was almost certainly dropped in the wrong box.
  for (const table of recognised.filter(a => a.kind === 'daily')) {
    for (const s of table.series) {
      const { key } = seriesKey(code, s.name);
      const metric = key.slice(code.length + 1);
      for (const other of Object.values(PLATFORMS)) {
        if (other.code === code) continue;
        const existing = store.series[`${other.code}-${metric}`];
        if (!existing) continue;
        const overlap = s.points.filter(p => p.date in existing);
        if (overlap.length >= 7 && overlap.every(p => existing[p.date] === p.value)) {
          return { fileName, ok: false, message: `This matches the ${other.name} data already uploaded. Check it was dropped under the right platform.` };
        }
      }
    }
  }

  // Saving rule for daily figures:
  //   - days the store doesn't have yet are added;
  //   - days it already has are replaced only if this file is at least as recent as the one that
  //     saved them (Meta revises recent days, so the newest export is the most accurate);
  //   - an older export never overwrites a newer one, and days missing from a file are left alone.
  // "Recent" means the file's last day, which is when the export was taken.
  store.freshness = store.freshness || {};
  const summary = { metrics: 0, newDays: 0, revised: 0, keptNewer: 0, breakdowns: 0, items: 0, latest: null, notes: [] };
  for (const table of recognised) {
    if (table.kind === 'daily') {
      if (table.ambiguousDates) summary.notes.push(`Dates in "${table.sheetName}" could be read either way; read as day/month.`);
      for (const s of table.series) {
        if (!s.points.length) continue;
        const { key, label } = seriesKey(code, s.name);
        const values = store.series[key] || {};
        const freshness = store.freshness[key] || {};
        const fileEnd = s.points[s.points.length - 1].date;
        for (const { date, value } of s.points) {
          if (!(date in values)) {
            summary.newDays += 1;
          } else if ((freshness[date] || '') > fileEnd) {
            summary.keptNewer += 1; // a more recent export already saved this day
            continue;
          } else if (values[date] !== value) {
            summary.revised += 1;
          }
          values[date] = value;
          freshness[date] = fileEnd;
        }
        store.series[key] = values;
        store.freshness[key] = freshness;
        store.meta[key] = { label, aggregation: s.aggregation, format: s.format, primary: s.primary };
        summary.metrics += 1;
        const latest = Object.keys(values).sort().pop();
        if (!summary.latest || latest > summary.latest) summary.latest = latest;
      }
    } else if (table.kind === 'breakdown') {
      const key = `${code}-${slug(table.label)}`;
      store.breakdowns[key] = { label: table.label, category: table.category, measure: table.measure, rows: table.rows, fileName, at: new Date().toISOString() };
      summary.breakdowns += 1;
    } else if (table.kind === 'items') {
      const key = `${code}-${slug(table.label)}`;
      const list = store.items[key] || { label: table.label, measures: [], rows: {} };
      list.label = table.label;
      list.measures = table.measures;
      for (const item of table.rows) list.rows[item.id] = item;
      const kept = Object.values(list.rows).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, MAX_ITEMS_PER_LIST);
      list.rows = Object.fromEntries(kept.map(item => [item.id, item]));
      store.items[key] = list;
      summary.items += table.rows.length;
    }
  }

  const parts = [];
  if (summary.metrics) {
    const what = summary.metrics === 1
      ? (store.meta[seriesKey(code, recognised.find(t => t.kind === 'daily').series[0].name).key]?.label || 'figures')
      : `${summary.metrics} daily metrics`;
    let changes;
    if (summary.newDays || summary.revised) {
      changes = [
        summary.newDays ? `${summary.newDays} new day${summary.newDays === 1 ? '' : 's'} added` : '',
        summary.revised ? `${summary.revised} day${summary.revised === 1 ? '' : 's'} corrected by the newer export` : '',
      ].filter(Boolean).join(', ');
    } else if (summary.keptNewer) {
      changes = 'no change: this export is older than the data already saved, so the newer figures were kept';
    } else {
      changes = 'no change: these figures were already saved';
    }
    parts.push(`${what}, now up to ${formatDay(summary.latest)} · ${changes}`);
    if (summary.keptNewer && (summary.newDays || summary.revised)) {
      summary.notes.push(`${summary.keptNewer} day${summary.keptNewer === 1 ? '' : 's'} kept from a more recent export.`);
    }
  }
  if (summary.breakdowns) parts.push(`${summary.breakdowns} audience breakdown${summary.breakdowns === 1 ? '' : 's'}`);
  if (summary.items) parts.push(`${summary.items} posts`);
  const skipped = analysed.filter(a => a.kind === 'unknown').map(a => a.sheetName);

  const entry = { fileName, platform: code, summary: `${name} ${parts.join(' · ')}`, latest: summary.latest };
  store.uploads = [{ ...entry, at: new Date().toISOString() }, ...store.uploads].slice(0, 100);
  return {
    ok: true,
    ...entry,
    notes: [...summary.notes, ...(skipped.length ? [`Skipped (not recognised): ${skipped.join(', ')}`] : [])],
  };
}

module.exports = {
  PLATFORMS,
  PLATFORM_NAMES,
  STANDARD_LABELS,
  analyseSheet,
  parseCsv,
  decodeText,
  importFile,
  seriesLabel,
};
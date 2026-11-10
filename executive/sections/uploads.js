// Uploaded spreadsheets (press, calendar of events, conference list): counts the rows dated in
// the period and adds up the number columns. Works out which column holds the dates by itself.

const { clip, slug, inPeriod, formatValue, compare } = require('../facts');

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
  // Only periods the file covers can be counted: a zero outside its dates means "no data", not "none".
  const first = dated.reduce((min, x) => (x.date < min ? x.date : min), '9999-12-31');
  const last = dated.reduce((max, x) => (x.date > max ? x.date : max), '0000-01-01');
  const covered = p => p.end >= first && p.start <= last;
  if (!covered(period)) return { status: 'no_data_for_period', facts: [], context: { file: upload.fileName, covers: `${first} to ${last}` } };
  const numberCols = headers.filter(h => h !== dateCol && filled(h).length && filled(h).filter(v => !Number.isNaN(toNumber(v))).length >= filled(h).length * 0.8);
  const textCols = headers.filter(h => h !== dateCol && !numberCols.includes(h) && filled(h).length);

  const makeFact = (id, label, measure) => {
    const now = measure(pick(period));
    const vs = {};
    const notes = [];
    for (const c of period.comparisons) {
      if (covered(c)) vs[c.key] = compare(now, measure(pick(c)), 'count');
      else { vs[c.key] = null; notes.push(`No comparison with ${c.label}: the file has no entries before ${first}.`); }
    }
    return { id, section: key, label, unit: 'count', combined_by: 'sum', current: { value: now, display: formatValue(now, 'count') }, vs, notes };
  };
  const facts = [makeFact(`${key}.rows`, `${title}: entries`, list => list.length)];
  if (upload.note) facts[0].notes.push(String(upload.note).slice(0, 200));
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

module.exports = { uploadSection };
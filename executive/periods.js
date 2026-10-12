// Reporting periods: quarters, half-years and years, and the periods each is compared with.
// Everything here is plain date arithmetic, so it can be tested without any AI.

const DAY = 86400000;
const TYPES = ['quarterly', 'six-month', 'annual'];

const toIso = ms => new Date(ms).toISOString().slice(0, 10);
const daysIn = p => Math.round((Date.parse(p.end) - Date.parse(p.start)) / DAY) + 1;

function monthsRange(year, firstMonth, months) {
  return {
    start: toIso(Date.UTC(year, firstMonth, 1)),
    end: toIso(Date.UTC(year, firstMonth + months, 0)),
  };
}

function describe(type, year, n) {
  if (type === 'quarterly') return { key: `${year}-Q${n}`, label: `Q${n} ${year}`, ...monthsRange(year, (n - 1) * 3, 3) };
  if (type === 'six-month') return { key: `${year}-H${n}`, label: `${n === 1 ? 'January–June' : 'July–December'} ${year}`, ...monthsRange(year, (n - 1) * 6, 6) };
  return { key: `${year}`, label: `${year}`, ...monthsRange(year, 0, 12) };
}

function parseKey(type, key) {
  const pattern = type === 'quarterly' ? /^(\d{4})-Q([1-4])$/ : type === 'six-month' ? /^(\d{4})-H([12])$/ : /^(\d{4})$/;
  const m = String(key).match(pattern);
  if (!m) throw new Error(`"${key}" is not a valid ${type} period.`);
  return { year: Number(m[1]), n: Number(m[2] || 1) };
}

function previousOf(type, year, n) {
  const perYear = type === 'quarterly' ? 4 : type === 'six-month' ? 2 : 1;
  return n > 1 ? { year, n: n - 1 } : { year: year - 1, n: perYear };
}

// e.g. resolvePeriod('quarterly', '2026-Q3') → Q3 2026, compared with Q2 2026 and Q3 2025.
function resolvePeriod(type, key) {
  if (!TYPES.includes(type)) throw new Error(`Unknown report type "${type}".`);
  const { year, n } = parseKey(type, key);
  const period = describe(type, year, n);
  const prev = previousOf(type, year, n);
  // "key" names the kind of comparison; "period_key" is the compared period itself (e.g. 2026-Q2).
  const asComparison = (kind, p) => ({ ...p, period_key: p.key, key: kind });
  const comparisons = [asComparison('previous_period', describe(type, prev.year, prev.n))];
  if (type !== 'annual') comparisons.push(asComparison('same_period_last_year', describe(type, year - 1, n)));
  return {
    type,
    ...period,
    days: daysIn(period),
    comparisons: comparisons.map(c => ({ ...c, days: daysIn(c) })),
  };
}

// The periods the data covers, newest first, for the period picker.
function listPeriods(earliest, latest) {
  if (!earliest || !latest) return {};
  const result = {};
  const caps = { quarterly: 12, 'six-month': 6, annual: 4 };
  for (const type of TYPES) {
    const list = [];
    const latestYear = Number(latest.slice(0, 4));
    const latestMonth = Number(latest.slice(5, 7));
    let year = latestYear;
    let n = type === 'quarterly' ? Math.ceil(latestMonth / 3) : type === 'six-month' ? (latestMonth <= 6 ? 1 : 2) : 1;
    while (list.length < caps[type]) {
      const p = describe(type, year, n);
      if (p.end < earliest) break;
      list.push({ ...p, in_progress: latest < p.end });
      ({ year, n } = previousOf(type, year, n));
    }
    result[type] = list;
  }
  return result;
}

module.exports = { TYPES, resolvePeriod, listPeriods, daysIn, toIso, DAY };
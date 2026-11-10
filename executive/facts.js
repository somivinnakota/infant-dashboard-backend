// Helpers shared by every section of the AI data package (see package.js).
// A "fact" is one figure the AI may quote: its value for the report period, plus how it
// compares with each comparison period.

const crypto = require('crypto');
const { PLATFORM_NAMES } = require('../social-import');

const MAX_TITLE = 150;

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

// Runs compareOne for each comparison period and returns the results keyed by comparison,
// e.g. { previous_period: {...}, same_period_last_year: {...} }.
function compareEach(period, compareOne) {
  return Object.fromEntries(period.comparisons.map(c => [c.key, compareOne(c)]));
}

module.exports = { PLATFORM_NAMES, shortHash, clip, slug, round, inPeriod, combine, formatValue, compare, compareEach };
// Run from the backend folder with:  node --test executive/tests/executive.test.js
// These tests need no AI and no internet. They check that the figures are calculated
// correctly and that the validator catches invented numbers, unknown evidence and causal claims.

const test = require('node:test');
const assert = require('node:assert');
const { resolvePeriod, listPeriods } = require('../periods');
const { buildPackage, compare, uploadSection } = require('../package');
const { validateReport, validateAnswer } = require('../validate');
const { REPORT_SCHEMA, ANSWER_SCHEMA } = require('../schema');

/* ── Fictional INFANT dashboard data ─────────────────────────── */

function daily(start, end, valueFor) {
  const rows = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    rows.push({ date, value: valueFor(date) });
  }
  return rows;
}

const social = {
  series: {
    // LinkedIn impressions: 100 a day in Q2 2026, 120 a day in Q3 2026
    'li-impressions-total': daily('2026-04-01', '2026-09-30', d => (d < '2026-07-01' ? 100 : 120)),
    // Engagement rate: 5% in Q2, 4% in Q3 (a decline)
    'li-engagement-rate-total': daily('2026-04-01', '2026-09-30', d => (d < '2026-07-01' ? 0.05 : 0.04)),
    // Instagram reach: identical every day, so no change
    'ig-reach': daily('2025-07-01', '2026-09-30', () => 50),
    // Facebook link clicks: zero every day
    'fb-clicks': daily('2025-07-01', '2026-09-30', () => 0),
  },
  meta: {
    'li-impressions-total': { label: 'LinkedIn Impressions (total)', aggregation: 'sum', format: 'number', primary: true },
    'li-engagement-rate-total': { label: 'LinkedIn Engagement rate (total)', aggregation: 'mean', format: 'percent', primary: true },
    'ig-reach': { label: 'Instagram reach (daily reach added up)', aggregation: 'sum', format: 'number', primary: true },
    'fb-clicks': { label: 'Facebook link clicks', aggregation: 'sum', format: 'number', primary: true },
  },
  breakdowns: {},
  items: {},
  latestDate: '2026-09-30',
};

const build = (extra = {}) => buildPackage({ type: 'quarterly', periodKey: '2026-Q3', social, eventbrite: null, impact: null, facebook: null, loadPublications: async () => [], ...extra });
const fact = (pkg, id) => pkg.facts.find(f => f.id === id);

/* ── Periods ─────────────────────────────────────────────────── */

test('quarters resolve with previous quarter and same quarter last year', () => {
  const p = resolvePeriod('quarterly', '2026-Q3');
  assert.deepStrictEqual([p.start, p.end, p.days], ['2026-07-01', '2026-09-30', 92]);
  assert.deepStrictEqual(p.comparisons.map(c => c.label), ['Q2 2026', 'Q3 2025']);
});

test('Q1 compares with Q4 of the year before', () => {
  assert.strictEqual(resolvePeriod('quarterly', '2026-Q1').comparisons[0].label, 'Q4 2025');
});

test('six-month and annual periods', () => {
  assert.deepStrictEqual([resolvePeriod('six-month', '2026-H1').end, resolvePeriod('six-month', '2026-H2').comparisons[0].key], ['2026-06-30', 'previous_period']);
  assert.strictEqual(resolvePeriod('annual', '2025').comparisons.length, 1);
});

test('invalid periods are rejected', () => {
  assert.throws(() => resolvePeriod('quarterly', '2026-Q5'));
});

test('period list marks the current quarter as in progress', () => {
  const list = listPeriods('2025-01-01', '2026-10-05');
  assert.strictEqual(list.quarterly[0].key, '2026-Q4');
  assert.strictEqual(list.quarterly[0].in_progress, true);
});

/* ── Calculations ────────────────────────────────────────────── */

test('percentage change is calculated by the dashboard, not the AI', () => {
  const c = compare(120, 100, 'count');
  assert.deepStrictEqual([c.change, c.change_pct, c.direction, c.change_pct_display], [20, 20, 'up', '+20%']);
});

test('a zero comparison value gives no percentage instead of infinity', () => {
  const c = compare(5, 0, 'count');
  assert.strictEqual(c.change_pct, null);
  assert.match(c.change_pct_display, /not calculable/);
});

test('small bases are flagged', () => {
  assert.match(compare(9, 2, 'count').note, /Small comparison base/);
});

test('quarter totals, a decline in a rate, no change and zero values', async () => {
  const pkg = await build();
  const imp = fact(pkg, 'social.li-impressions-total');
  assert.strictEqual(imp.current.value, 120 * 92);
  // Q2 has 91 days (9,100) and Q3 has 92 (11,040), so the change is +21.3%, not +20%.
  assert.strictEqual(imp.vs.previous_period.change_pct, 21.3);
  assert.strictEqual(imp.vs.same_period_last_year, null, 'no LinkedIn data for Q3 2025');

  const rate = fact(pkg, 'social.li-engagement-rate-total');
  assert.strictEqual(rate.current.display, '4.0%', 'rates are averaged, not added up');
  assert.strictEqual(rate.vs.previous_period.direction, 'down');
  assert.match(rate.vs.previous_period.change_display, /1\.0 percentage points/);

  // Same daily figure every day: Q3 2025 has the same 92 days, so no change year on year.
  assert.strictEqual(fact(pkg, 'social.ig-reach').vs.same_period_last_year.direction, 'no change');
  assert.strictEqual(fact(pkg, 'social.fb-clicks').current.value, 0);
});

test('a part-covered period is compared like-for-like', async () => {
  const partial = { ...social, series: { ...social.series, 'ig-reach': daily('2025-07-01', '2026-07-10', () => 50) } };
  const pkg = await buildPackage({ type: 'quarterly', periodKey: '2026-Q3', social: partial, loadPublications: async () => [] });
  const reach = fact(pkg, 'social.ig-reach');
  assert.strictEqual(reach.current.days_with_data, 10);
  assert.strictEqual(reach.vs.previous_period.value, 500, 'first 10 days of Q2 only');
  assert.ok(reach.notes.some(n => /10 of 92 days/.test(n)));
});

test('missing areas are declared, not left out', async () => {
  const pkg = await build();
  assert.strictEqual(pkg.availability.website, 'not_connected');
  assert.strictEqual(pkg.availability.media, 'not_uploaded');
  assert.strictEqual(pkg.availability.awards, 'no_dataset');
});

test('uploaded press sheets are split by period', () => {
  const sheet = { headers: ['Date', 'Outlet', 'Reach'], rows: [
    { Date: '12 August 2026', Outlet: 'RTE', Reach: '90,000' },
    { Date: '2026-09-01', Outlet: 'Irish Times', Reach: 45000 },
    { Date: '03/05/2026', Outlet: 'RTE', Reach: 1000 },
  ] };
  const part = uploadSection('media', 'Press and media', { fileName: 'press.xlsx', sheets: [sheet] }, resolvePeriod('quarterly', '2026-Q3'));
  assert.strictEqual(part.facts[0].current.value, 2);
  assert.strictEqual(part.facts.find(f => f.id === 'media.reach.total').current.value, 135000);
});

/* ── Validator (hallucination checks) ────────────────────────── */

function goodReport() {
  const section = status => ({ status, summary: status === 'analysed' ? 'Summary.' : 'No data is available for this area.', findings: [] });
  return {
    executive_summary: { text: 'LinkedIn impressions rose 21.3% to 11,040 in Q3 2026 compared with Q2 2026. The available data does not identify the cause.', evidence: ['social.li-impressions-total'] },
    key_findings: [{ statement: 'Average engagement rate fell by 1.0 percentage points to 4.0%.', type: 'fact', evidence_level: 'high', evidence: ['social.li-engagement-rate-total'] }],
    kpi_analysis: [{ fact_id: 'social.li-impressions-total', interpretation: 'Visibility grew.', significance: 'notable' }],
    sections: {
      website: section('not_available'), social: section('analysed'), content: section('not_available'), media: section('not_available'),
      publications: section('not_available'), events: section('not_available'), conferences: section('not_available'), kpis: section('not_available'),
    },
    trends: [],
    cross_dataset: [],
    risks: [{ statement: 'Engagement rate is declining while impressions grow.', type: 'observation', evidence_level: 'medium', evidence: ['social.li-engagement-rate-total', 'social.li-impressions-total'] }],
    opportunities: [],
    recommendations: [{ recommendation: 'Review which posts kept engagement high.', evidence: ['social.li-engagement-rate-total'], reasoning: 'Rate fell.', expected_benefit: 'Better engagement.', priority: 'medium' }],
    data_gaps: ['Website analytics is not connected.'],
    best_performing: [],
    annual_summary: '',
  };
}

test('a grounded report passes', async () => {
  const result = validateReport(goodReport(), await build(), REPORT_SCHEMA);
  assert.deepStrictEqual(result.issues, []);
});

test('an invented statistic is caught', async () => {
  const r = goodReport();
  r.executive_summary.text = 'LinkedIn followers grew 37% this quarter.';
  const result = validateReport(r, await build(), REPORT_SCHEMA);
  assert.ok(result.issues.some(i => /37/.test(i.problem)));
});

test('an invented cause is caught (no campaign data supplied)', async () => {
  const r = goodReport();
  r.key_findings[0].statement = 'Impressions rose 21.3%, driven by the World Cerebral Palsy Day campaign.';
  const result = validateReport(r, await build(), REPORT_SCHEMA);
  assert.ok(result.issues.some(i => /cause/.test(i.problem)));
});

test('citing evidence that does not exist is caught', async () => {
  const r = goodReport();
  r.key_findings[0].evidence = ['social.li-followers-campaign'];
  const result = validateReport(r, await build(), REPORT_SCHEMA);
  assert.ok(result.issues.some(i => /not in the data package/.test(i.problem)));
});

test('website findings are rejected when website data is not connected', async () => {
  const r = goodReport();
  r.sections.website = { status: 'analysed', summary: 'Website traffic grew.', findings: [] };
  const result = validateReport(r, await build(), REPORT_SCHEMA);
  assert.ok(result.issues.some(i => i.path === '$.sections.website'));
});

test('a recommendation without evidence is rejected', async () => {
  const r = goodReport();
  r.recommendations[0].evidence = [];
  const result = validateReport(r, await build(), REPORT_SCHEMA);
  assert.ok(result.issues.some(i => /cites no evidence/.test(i.problem)));
});

test('a missing section is caught by the schema check', async () => {
  const r = goodReport();
  delete r.risks;
  assert.strictEqual(validateReport(r, await build(), REPORT_SCHEMA).ok, false);
});

test('an unsupported question must not be answered with a guess', async () => {
  const pkg = await build();
  const guess = { answer: 'About 4,500 people visited the website.', insufficient_data: false, statement_type: 'fact', evidence_level: 'high', evidence: [] };
  assert.strictEqual(validateAnswer(guess, pkg, ANSWER_SCHEMA).ok, false);
  const honest = { answer: "I don't have enough information in the dashboard data to answer that.", insufficient_data: true, statement_type: 'fact', evidence_level: 'high', evidence: [] };
  assert.strictEqual(validateAnswer(honest, pkg, ANSWER_SCHEMA).ok, true);
});
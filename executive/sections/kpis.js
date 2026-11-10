// KPI tracker (sent already read by the KPI tracker page).
//
// The KPI tracker has no date column: each row is a KPI, with one column per quarter ("1Q26")
// and a target and result per year. The KPI page reads that layout and sends
// { kpis: [{ id, name, quarters: [{ year, quarter, value }], target: { year: n }, result: { year: n } }] }.
// Each KPI's figure for a period is the sum of its quarterly results in that period, except for
// a whole year, where the tracker's own yearly result is used when there is one.

const { clip, round, inPeriod, formatValue, compare, compareEach } = require('../facts');

const MAX_KPI_FACTS = 12;

function kpiSection(upload, period) {
  const kpis = (upload?.kpis || []).filter(k => k && k.id && Array.isArray(k.quarters));
  if (!kpis.length) return null;
  const quarterStart = q => `${q.year}-${String(q.quarter * 3 - 2).padStart(2, '0')}-01`;
  const wholeYear = p => p.start.endsWith('-01-01') && p.end.endsWith('-12-31') && p.start.slice(0, 4) === p.end.slice(0, 4);
  const valueFor = (k, p) => {
    if (wholeYear(p) && typeof k.result?.[p.start.slice(0, 4)] === 'number') return k.result[p.start.slice(0, 4)];
    const values = k.quarters.filter(q => typeof q.value === 'number' && inPeriod(quarterStart(q), p)).map(q => q.value);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const anyData = p => kpis.filter(k => valueFor(k, p) !== null).length;

  if (!anyData(period)) return { status: 'no_data_for_period', facts: [], context: { file: upload.fileName } };
  const vs = {};
  const notes = [`${kpis.length} KPIs in the tracker.`];
  for (const c of period.comparisons) {
    if (anyData(c)) vs[c.key] = compare(anyData(period), anyData(c), 'count');
    else { vs[c.key] = null; notes.push(`No comparison with ${c.label}: the tracker has no results for it.`); }
  }
  const facts = [{
    id: 'kpis.reported', section: 'kpis', label: 'KPIs with a result recorded', unit: 'count', combined_by: 'count',
    current: { value: anyData(period), display: formatValue(anyData(period), 'count') }, vs, notes,
  }];

  // For a whole year: how many KPIs met their target. Only KPIs with the tracker's own yearly result
  // count, so a year still in progress isn't judged on its quarters so far.
  const year = period.start.slice(0, 4);
  if (wholeYear(period)) {
    const scored = kpis.filter(k => typeof k.target?.[year] === 'number' && k.target[year] > 0 && typeof k.result?.[year] === 'number');
    if (scored.length) {
      const met = scored.filter(k => valueFor(k, period) >= k.target[year]).length;
      facts.push({
        id: 'kpis.targets_met', section: 'kpis', label: `KPIs that met their ${year} target, out of ${scored.length} with a target`, unit: 'count', combined_by: 'count',
        current: { value: met, display: formatValue(met, 'count') }, vs: {}, notes: [],
      });
    }
  }

  // One fact per KPI with a figure this period, biggest changes first, so the AI can name specific KPIs.
  const perKpi = kpis
    .map(k => {
      const now = valueFor(k, period);
      if (now === null) return null;
      const target = wholeYear(period) ? k.target?.[year] : undefined;
      return {
        id: `kpis.k${k.id}`, section: 'kpis', label: clip(`KPI ${k.id} ${k.name}`, 90), unit: 'count', combined_by: wholeYear(period) ? 'yearly result' : 'sum of quarterly results',
        current: { value: round(now, 4), display: formatValue(now, 'count') },
        vs: compareEach(period, c => compare(now, valueFor(k, c), 'count')),
        notes: [
          ...(typeof target === 'number' ? [`${year} target: ${formatValue(target, 'count')}.`] : []),
          ...(wholeYear(period) && typeof k.result?.[year] !== 'number' ? ['No yearly result recorded yet: this is the quarterly results so far.'] : []),
        ],
      };
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.vs.previous_period?.change ?? 0) - Math.abs(a.vs.previous_period?.change ?? 0))
    .slice(0, MAX_KPI_FACTS);

  return {
    status: 'available',
    facts: [...facts, ...perKpi],
    context: { file: upload.fileName, note: 'KPI figures come from the KPI tracker; quarterly results are added up for longer periods.' },
  };
}

module.exports = { kpiSection };
// Publications: how many verified INFANT papers were published in the period.
// The list itself comes from publications.js (Scopus and PubMed, checked for an INFANT affiliation).

const { round, inPeriod, formatValue, compare } = require('../facts');

function publicationsSection(items, period) {
  if (!items) return { status: 'not_available', facts: [], context: {} };
  const earliest = items.reduce((min, p) => (p.date < min ? p.date : min), '9999');
  const count = p => items.filter(i => inPeriod(i.date, p)).length;
  const now = count(period);
  const vs = {};
  const notes = ['Verified INFANT publications: found in Scopus or PubMed with an INFANT affiliation, each paper counted once.'];
  for (const c of period.comparisons) {
    if (c.start < earliest) { vs[c.key] = null; notes.push(`No comparison with ${c.label}: the publication list loaded does not go back that far.`); continue; }
    vs[c.key] = compare(now, count(c), 'count');
  }
  const current = items.filter(i => inPeriod(i.date, period)).sort((a, b) => b.date.localeCompare(a.date));
  const facts = [{ id: 'pub.count', section: 'publications', label: 'Publications (verified, Scopus and PubMed)', unit: 'count', combined_by: 'count', current: { value: now, display: formatValue(now, 'count') }, vs, notes }];
  if (current.length) {
    const share = current.filter(i => i.open_access).length / current.length;
    facts.push({ id: 'pub.open_access_share', section: 'publications', label: 'Share of publications open access', unit: 'percent', combined_by: 'share', current: { value: round(share, 4), display: formatValue(share, 'percent') }, vs: {}, notes: [] });
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

module.exports = { publicationsSection };
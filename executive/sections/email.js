// Email: Mailchimp campaigns sent in the period.

const { clip, round, inPeriod, formatValue, compare } = require('../facts');

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

module.exports = { emailSection };
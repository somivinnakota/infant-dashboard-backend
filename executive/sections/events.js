// Events: Eventbrite events held or scheduled in the period.

const { clip, inPeriod, formatValue, compare, compareEach } = require('../facts');

function eventsSection(eventbrite, period) {
  if (!eventbrite) return { status: 'not_available', facts: [], context: {} };
  const events = eventbrite.events.map(e => ({ ...e, date: (e.start || '').slice(0, 10) })).filter(e => e.date);
  const pick = p => events.filter(e => inPeriod(e.date, p));
  const fact = (id, label, measure) => {
    const now = measure(pick(period));
    return {
      id, section: 'events', label, unit: 'count', combined_by: 'count',
      current: { value: now, display: formatValue(now, 'count') },
      vs: compareEach(period, c => compare(now, measure(pick(c)), 'count')),
      notes: [],
    };
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

module.exports = { eventsSection };
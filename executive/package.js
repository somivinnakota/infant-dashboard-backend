// Builds the "AI Data Package": every figure the AI may talk about, calculated here in code.
// The AI never does arithmetic. Each figure is a "fact" with a stable id that the AI must cite,
// and that the validator checks against.
//
// Each data source has its own file in sections/. This file puts them together.

const crypto = require('crypto');
const { resolvePeriod } = require('./periods');
const { compare } = require('./facts');
const { socialSection, postsSection, audienceSection } = require('./sections/social');
const { publicationsSection } = require('./sections/publications');
const { eventsSection } = require('./sections/events');
const { emailSection } = require('./sections/email');
const { uploadSection } = require('./sections/uploads');
const { kpiSection } = require('./sections/kpis');

const PACKAGE_VERSION = '1.0';
const UPLOAD_SOURCES = {
  media: 'Press and media',
  kpis: 'KPI tracker',
  events_calendar: 'Calendar of events',
  conferences: 'Conference list',
};

async function buildPackage({ type, periodKey, social, eventbrite, impact, facebook, mailchimp = null, uploads = {}, loadPublications = async () => null }) {
  const period = resolvePeriod(type, periodKey);
  const { facts: socialFacts, monthly } = socialSection(social, period);
  const { facts: postFacts, lists: posts } = postsSection(social, period);

  let publications = null;
  try { publications = await loadPublications(); } catch (error) { console.warn('Executive report: publications unavailable:', error.message); }
  const pubs = publicationsSection(publications, period);
  const events = eventsSection(eventbrite, period);
  const email = emailSection(mailchimp, period);
  const uploadParts = Object.fromEntries(Object.entries(UPLOAD_SOURCES).map(([key, title]) => [key,
    (key === 'kpis' && kpiSection(uploads.kpis, period)) || uploadSection(key, title, uploads[key], period)]));

  const context = [];
  if (impact?.headlines) {
    const h = impact.headlines;
    const add = (id, label, value) => value !== undefined && context.push({ id, label, display: String(value) });
    add('ctx.infants_impacted', 'Infants impacted globally', h.infantsImpacted);
    add('ctx.funding', 'Research funding secured', h.fundingSecured);
    add('ctx.team', 'Team members', h.teamMembers);
    add('ctx.spinouts', 'Spin-out companies', h.spinouts);
    add('ctx.countries', 'Partner countries', h.partnershipCountries);
    add('ctx.partnerships', 'Active partnerships', h.partnerships);
  }
  if (facebook?.followers_count !== undefined) context.push({ id: 'ctx.fb_followers_today', label: 'Facebook followers today (live, not period-specific)', display: Number(facebook.followers_count).toLocaleString('en-IE') });

  const platformAvailable = code => socialFacts.some(f => f.id.startsWith(`social.${code}-`));
  const facts = [
    ...socialFacts,
    ...postFacts,
    ...pubs.facts,
    ...events.facts,
    ...email.facts,
    ...Object.values(uploadParts).flatMap(u => u.facts),
  ];

  const pkg = {
    package_version: PACKAGE_VERSION,
    generated_at: new Date().toISOString(),
    report: {
      type: period.type,
      period: { key: period.key, label: period.label, start: period.start, end: period.end, days: period.days },
      comparisons: period.comparisons.map(({ key, label, start, end, days }) => ({ key, label, start, end, days })),
    },
    availability: {
      website: 'not_connected',
      instagram: platformAvailable('ig') ? 'available' : 'no_data_for_period',
      facebook: platformAvailable('fb') ? 'available' : 'no_data_for_period',
      linkedin: platformAvailable('li') ? 'available' : 'no_data_for_period',
      mailchimp: email.status,
      post_level_content: postFacts.length ? 'available' : 'no_data_for_period',
      publications: pubs.status,
      events: events.status,
      media: uploadParts.media.status,
      kpis: uploadParts.kpis.status,
      events_calendar: uploadParts.events_calendar.status,
      conferences: uploadParts.conferences.status,
      awards: 'no_dataset',
      campaigns: 'no_dataset',
      content_themes: 'no_dataset',
      partnerships: 'headline_figure_only',
    },
    facts,
    monthly,
    content: posts,
    audience: audienceSection(social),
    publications: pubs.context,
    events: events.context,
    email: email.context,
    uploads: Object.fromEntries(Object.entries(uploadParts).map(([k, v]) => [k, v.context])),
    context,
  };
  pkg.data_snapshot = `sha256:${crypto.createHash('sha256').update(JSON.stringify({ facts, monthly, posts })).digest('hex').slice(0, 16)}`;
  return pkg;
}

// Every id the AI is allowed to cite.
function evidenceIds(pkg) {
  const ids = new Set(pkg.facts.map(f => f.id));
  pkg.context.forEach(c => ids.add(c.id));
  pkg.audience.forEach(a => ids.add(a.id));
  Object.values(pkg.content).forEach(l => [...l.top, ...l.bottom].forEach(p => ids.add(p.id)));
  (pkg.publications.in_period || []).forEach(p => ids.add(p.id));
  (pkg.events.in_period || []).forEach(e => ids.add(e.id));
  (pkg.email?.in_period || []).forEach(c => ids.add(c.id));
  Object.values(pkg.uploads).forEach(u => (u.in_period || []).forEach(r => ids.add(r.id)));
  return ids;
}

module.exports = { buildPackage, evidenceIds, compare, uploadSection, UPLOAD_SOURCES };
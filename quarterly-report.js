// The quarterly engagement report: this quarter against the same quarter last year,
// written up by the AI from figures calculated here. Connected in server.js.
//   GET /api/quarterly-report?quarter=Q3&year=2026

const glossary = require('./glossary');
const mailchimp = require('./mailchimp');
const { PLATFORM_NAMES } = require('./social-import');
const { formatNumber } = require('./format');

const QUARTERS = {
  Q1: { start: 1, end: 3 },
  Q2: { start: 4, end: 6 },
  Q3: { start: 7, end: 9 },
  Q4: { start: 10, end: 12 },
};

const sumValues = rows => rows.reduce((total, row) => total + row.value, 0);
const peakValue = rows => rows.reduce((max, row) => Math.max(max, row.value), 0);

function percentChange(current, previous) {
  if (!previous) return 'not available (no data for the comparison period)';
  const change = ((current - previous) / previous) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

function formatDayMonth(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('en-IE', { day: 'numeric', month: 'long' });
}

// Combines values the right way for each metric: added up, averaged (rates) or latest (running totals).
function combine(rows, aggregation) {
  if (rows.length === 0) return null;
  if (aggregation === 'mean') return rows.reduce((t, r) => t + r.value, 0) / rows.length;
  if (aggregation === 'last') return rows[rows.length - 1].value;
  return sumValues(rows);
}

const formatMetric = (value, meta) => {
  if (value === null || value === undefined) return 'not available';
  return meta.format === 'percent' ? `${(value * 100).toFixed(2)}%` : formatNumber(Math.round(value * 100) / 100);
};

// loadSocialData, getFacebookStats, optional and askAI come from server.js.
module.exports = function quarterlyReportRoutes(app, { loadSocialData, getFacebookStats, optional, askAI }) {
  app.get('/api/quarterly-report', async (req, res) => {
    try {
      const quarter = QUARTERS[req.query.quarter] ? req.query.quarter : 'Q3';
      const year = parseInt(req.query.year, 10) || new Date().getFullYear();
      const prevYear = year - 1;
      const q = QUARTERS[quarter];
      const social = await loadSocialData();

      // If the quarter is still in progress, compare both years only up to the latest uploaded day.
      const latest = social.latestDate;
      const latestMonth = latest ? Number(latest.slice(5, 7)) : 0;
      const quarterInProgress = latest && latest.startsWith(`${year}-`) && latestMonth >= q.start && latestMonth <= q.end;

      const inQuarter = (rows, y) => rows.filter(r => {
        const month = Number(r.date.slice(5, 7));
        return r.date.startsWith(`${y}-`) && month >= q.start && month <= q.end;
      });
      // Each metric is cut off at its own latest day, so last year is compared like-for-like.
      const compare = name => {
        const current = inQuarter(social.series[name] || [], year);
        const cutoff = current.length ? current[current.length - 1].date.slice(5) : '12-31';
        const previous = inQuarter(social.series[name] || [], prevYear).filter(r => r.date.slice(5) <= cutoff);
        return { current, previous };
      };
      const totals = name => {
        const { current, previous } = compare(name);
        return { current: sumValues(current), previous: sumValues(previous) };
      };

      const ig = {
        reach: totals('ig-reach'),
        views: totals('ig-views'),
        interactions: totals('ig-interactions'),
        visits: totals('ig-visits'),
        follows: totals('ig-follows'),
        peakReach: {
          current: peakValue(compare('ig-reach').current),
          previous: peakValue(compare('ig-reach').previous),
        },
      };
      const fbCsv = {
        views: totals('fb-views'),
        visits: totals('fb-visits'),
        interactions: totals('fb-interactions'),
      };

      const hasData = [...Object.values(ig), ...Object.values(fbCsv)].some(m => m.current > 0);
      if (!hasData) {
        return res.status(404).json({ error: `No Instagram or Facebook data found for ${quarter} ${year}. Upload the Meta exports on the Social media page.` });
      }

      // Other platforms from uploads (e.g. LinkedIn), compared with the previous quarter,
      // since they often have no data for the same quarter last year.
      const prevQ = quarter === 'Q1' ? { quarter: 'Q4', year: year - 1 } : { quarter: `Q${Number(quarter[1]) - 1}`, year };
      const inAnyQuarter = (rows, y, qq) => rows.filter(r => {
        const month = Number(r.date.slice(5, 7));
        return r.date.startsWith(`${y}-`) && month >= qq.start && month <= qq.end;
      });
      const otherLines = [];
      const otherFigures = [];
      for (const [name, rows] of Object.entries(social.series)) {
        const code = name.split('-')[0];
        const meta = social.meta[name];
        if (code === 'ig' || code === 'fb' || meta.primary === false || !rows.length) continue;
        const now = inAnyQuarter(rows, year, q);
        if (!now.length) continue;
        const before = inAnyQuarter(rows, prevQ.year, QUARTERS[prevQ.quarter]);
        const c = combine(now, meta.aggregation);
        const p = combine(before, meta.aggregation);
        otherLines.push(`- ${meta.label}: ${formatMetric(c, meta)} | ${prevQ.quarter} ${prevQ.year}: ${formatMetric(p, meta)} | change: ${p ? percentChange(c, p) : 'not available'}`);
        otherFigures.push({ key: name, platform: PLATFORM_NAMES[code] || code, label: meta.label, display: formatMetric(c, meta), previousDisplay: p === null ? null : formatMetric(p, meta), change: p ? percentChange(c, p) : null });
      }

      const fb = await optional('Facebook', getFacebookStats);
      const live = {
        followers: fb?.followers_count ?? '—',
        talkingAbout: fb?.talking_about_count ?? '—',
        engagementRate: fb?.engagement_rate ?? '—',
      };

      const line = (label, m) =>
        `- ${label}: ${formatNumber(m.current)} | ${quarter} ${prevYear}: ${formatNumber(m.previous)} | change: ${percentChange(m.current, m.previous)}`;
      const periodNote = quarterInProgress
        ? `Note: ${quarter} ${year} is still in progress. Each metric is compared with the same days last year, up to its latest uploaded day (newest data: ${formatDayMonth(latest)}).`
        : '';
      const nextQuarter = quarter === 'Q4' ? `Q1 ${year + 1}` : `Q${Number(quarter[1]) + 1} ${year}`;

      // Email (Mailchimp): this quarter against the same quarter last year. If the quarter is still
      // in progress, last year is cut off at the same day, so the comparison is like-for-like.
      const mailchimpData = await optional('Mailchimp', () => mailchimp.getCampaigns());
      const campaigns = (mailchimpData?.campaigns || []).map(c => ({ ...c, date: String(c.sentAt || '').slice(0, 10) }));
      const today = new Date().toISOString().slice(0, 10);
      const todayMonth = Number(today.slice(5, 7));
      const emailCutoff = today.startsWith(`${year}-`) && todayMonth >= q.start && todayMonth <= q.end ? today.slice(5) : '12-31';
      const emailFor = y => {
        const list = inQuarter(campaigns, y).filter(c => c.date.slice(5) <= emailCutoff);
        const total = key => list.reduce((t, c) => t + (c[key] || 0), 0);
        const delivered = total('delivered');
        return {
          campaigns: list.length,
          delivered,
          openRate: delivered ? total('uniqueOpens') / delivered : null,
          engagementRate: delivered ? total('uniqueClicks') / delivered : null,
        };
      };
      const email = mailchimpData ? { connected: true, current: emailFor(year), previous: emailFor(prevYear) } : { connected: false };
      const rateText = v => (v === null ? 'not available' : `${(v * 100).toFixed(1)}%`);
      const pointsChange = (c, p) => (c === null || p === null ? 'not available' : `${c - p >= 0 ? '+' : ''}${((c - p) * 100).toFixed(1)} percentage points`);
      let emailBlock;
      if (!email.connected) {
        emailBlock = 'EMAIL (MAILCHIMP): not available (Mailchimp is not connected).';
      } else if (!email.current.campaigns) {
        emailBlock = `EMAIL (MAILCHIMP): no email campaigns were sent in ${quarter} ${year} (${quarter} ${prevYear}: ${email.previous.campaigns}).`;
      } else {
        const ec = email.current;
        const ep = email.previous;
        emailBlock = `EMAIL (MAILCHIMP), compared with ${quarter} ${prevYear}:
${line('Campaigns sent', { current: ec.campaigns, previous: ep.campaigns })}
${line('Emails delivered', { current: ec.delivered, previous: ep.delivered })}
- Engagement rate (subscribers who clicked ÷ emails delivered): ${rateText(ec.engagementRate)} | ${quarter} ${prevYear}: ${rateText(ep.engagementRate)} | change: ${pointsChange(ec.engagementRate, ep.engagementRate)}
- Open rate (can be inflated by Apple Mail privacy features, so treat with caution): ${rateText(ec.openRate)} | ${quarter} ${prevYear}: ${rateText(ep.openRate)} | change: ${pointsChange(ec.openRate, ep.openRate)}`;
      }

      // Glossary entries for the metrics in this report: given to the AI, and listed in the PDF appendix.
      const glossaryIds = [...new Set([
        ...['ig-reach', 'ig-views', 'ig-interactions', 'ig-visits', 'ig-follows', 'fb-views', 'fb-visits', 'fb-interactions'].map(glossary.glossaryIdFor),
        'engagement_rate', // the live Facebook "talking about as a share of followers" figure
        ...otherFigures.map(o => glossary.glossaryIdFor(o.key)),
        ...(email.connected && email.current.campaigns ? ['click_through_rate', 'open_rate'] : []),
        'year_on_year_change',
        ...(otherFigures.length ? ['quarter_on_quarter_change'] : []),
      ].filter(Boolean))];
      // Short version (definitions only): the free AI model runs out of room with the full notes and rules.
      const glossaryBlock = glossary.promptBlock(glossaryIds, { compact: true });

      const prompt = `Write a board-level quarterly engagement report that is analytical, evidence-based and direct.

PERIOD: ${quarter} ${year}, compared with ${quarter} ${prevYear}.
${periodNote}

INSTAGRAM:
${line('Reach (daily reach added up)', ig.reach)}
${line('Views', ig.views)}
${line('Interactions', ig.interactions)}
${line('Profile visits', ig.visits)}
${line('New followers', ig.follows)}
${line('Peak daily reach', ig.peakReach)}

FACEBOOK:
- Followers (live today): ${live.followers}
- Talking about the page (live, last 7 days): ${live.talkingAbout}
- Talking about as a share of followers: ${live.engagementRate}
${line('Page views', fbCsv.views)}
${line('Page visits', fbCsv.visits)}
${line('Interactions', fbCsv.interactions)}
${otherLines.length ? `\nOTHER PLATFORMS FROM UPLOADED EXPORTS (compared with ${prevQ.quarter} ${prevQ.year}):\n${otherLines.join('\n')}\n` : ''}
${emailBlock}
${glossaryBlock ? `\n${glossaryBlock}\n` : ''}
Use these exact sections:
QUARTERLY SUMMARY (2-3 sentences, headline story)
WHAT CHANGED AND WHY (3-4 sentences, analytical; only suggest reasons as possibilities, not facts)
SUCCESSES: ${quarter} ${year} (exactly 3 bullet points with numbers)
AREAS FOR ATTENTION (exactly 2 bullet points with numbers)
RECOMMENDATIONS FOR ${nextQuarter} (exactly 4 actionable bullet points)
RISKS IF NO ACTION TAKEN (exactly 2 bullet points)
OPPORTUNITIES (exactly 2 bullet points)
THINGS NEEDING ATTENTION THIS WEEK (exactly 3 action items starting with a verb)
ONE-LINE EXECUTIVE SUMMARY (one sentence with a number)

Reference numbers in every section. Never use "it is important to". Maximum 450 words.`;

      const report = await askAI(prompt);

      res.json({
        quarter, year, prevYear,
        periodNote,
        data: {
          instagram: {
            current: {
              reach: ig.reach.current, views: ig.views.current, interactions: ig.interactions.current,
              visits: ig.visits.current, follows: ig.follows.current, peakReach: ig.peakReach.current,
            },
            previous: {
              reach: ig.reach.previous, views: ig.views.previous, interactions: ig.interactions.previous,
              visits: ig.visits.previous, follows: ig.follows.previous, peakReach: ig.peakReach.previous,
            },
          },
          facebook: {
            live,
            current: { views: fbCsv.views.current, visits: fbCsv.visits.current, interactions: fbCsv.interactions.current },
            previous: { views: fbCsv.views.previous, visits: fbCsv.visits.previous, interactions: fbCsv.interactions.previous },
          },
          others: otherFigures,
          othersComparedWith: `${prevQ.quarter} ${prevQ.year}`,
          mailchimp: email,
        },
        report,
        glossaryIds,
      });
    } catch (error) {
      console.error('Quarterly report error:', error);
      res.status(500).json({ error: 'The quarterly report could not be generated. Check the server log for details.' });
    }
  });
};
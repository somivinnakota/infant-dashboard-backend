// Mailchimp campaign reports for the dashboard.
// The API key stays on the server (MAILCHIMP_API_KEY in .env / Render); the browser only gets the numbers.

const CACHE_MS = 15 * 60 * 1000; // ask Mailchimp at most every 15 minutes unless "refresh" is pressed
const PAGE_SIZE = 1000;
const FIELDS = [
  'total_items',
  'reports.id', 'reports.campaign_title', 'reports.subject_line', 'reports.type', 'reports.list_id', 'reports.list_name',
  'reports.emails_sent', 'reports.send_time', 'reports.unsubscribed', 'reports.bounces',
  'reports.opens', 'reports.clicks',
].join(',');

let cache = null;

async function mailchimpGet(apiKey, path) {
  const dataCenter = apiKey.split('-').pop(); // the key ends in e.g. "-us21"
  const auth = `Basic ${Buffer.from(`dashboard:${apiKey}`).toString('base64')}`;
  const response = await fetch(`https://${dataCenter}.api.mailchimp.com/3.0/${path}`, { headers: { Authorization: auth } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.detail || `Mailchimp returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// Every page of a Mailchimp list endpoint, e.g. all campaign reports.
async function fetchAll(apiKey, path, key, fields) {
  const items = [];
  for (let offset = 0; ; offset = items.length) { // next page starts after the rows already received
    const sep = path.includes('?') ? '&' : '?';
    const data = await mailchimpGet(apiKey, `${path}${sep}count=${PAGE_SIZE}&offset=${offset}&fields=total_items,${fields}`);
    items.push(...(data[key] || []));
    if (!data[key]?.length || items.length >= data.total_items) break;
  }
  return items;
}

const fetchReports = apiKey => fetchAll(apiKey, 'reports', 'reports', FIELDS.replace('total_items,', ''));

// Each audience with its current subscriber count and month-end subscriber totals.
async function fetchAudiences(apiKey) {
  const lists = await fetchAll(apiKey, 'lists', 'lists', 'lists.id,lists.name,lists.stats.member_count');
  return Promise.all(lists.map(async l => {
    const growth = await mailchimpGet(apiKey, `lists/${l.id}/growth-history?count=1000&fields=history.month,history.subscribed`)
      .catch(() => ({ history: [] }));
    return {
      id: l.id,
      name: l.name,
      subscribers: l.stats?.member_count || 0,
      history: (growth.history || []).map(h => ({ month: h.month, subscribers: h.subscribed || 0 }))
        .sort((a, b) => a.month.localeCompare(b.month)),
    };
  }));
}

function toCampaign(r) {
  const bounced = (r.bounces?.hard_bounces || 0) + (r.bounces?.soft_bounces || 0) + (r.bounces?.syntax_errors || 0);
  return {
    id: r.id,
    title: r.campaign_title || r.subject_line || 'Untitled campaign',
    subject: r.subject_line || '',
    audienceId: r.list_id || '',
    audience: r.list_name || '',
    sentAt: r.send_time,
    sent: r.emails_sent || 0,
    delivered: Math.max((r.emails_sent || 0) - bounced, 0),
    // Replaced by countOpeners below; this summary figure is only used if that lookup fails.
    uniqueOpens: r.opens?.proxy_excluded_unique_opens ?? r.opens?.unique_opens ?? 0,
    uniqueClicks: r.clicks?.unique_subscriber_clicks || 0,
    unsubscribed: r.unsubscribed || 0,
  };
}

// People who opened, counted the way Mailchimp's report screen does: everyone with at least one open
// that wasn't recorded automatically by an email app using a proxy (e.g. Apple Mail Privacy Protection).
// Mailchimp's summary figure (proxy_excluded_unique_opens) can be a few lower than its report screen, so
// it's only a fallback. Only looked up again when a campaign has had a new open since last time.
const openerCache = new Map(); // campaign id -> { lastOpen, count }
async function countOpeners(apiKey, r) {
  if (!r.opens?.unique_opens) return 0;
  const lastOpen = r.opens.last_open || '';
  const known = openerCache.get(r.id);
  if (known && known.lastOpen === lastOpen) return known.count;
  const members = await fetchAll(apiKey, `reports/${r.id}/open-details`, 'members', 'members.proxy_excluded_opens_count');
  // If Mailchimp doesn't give this figure for a campaign, don't guess: use its summary figure instead.
  if (!members.length || members.some(m => typeof m.proxy_excluded_opens_count !== 'number')) return null;
  const count = members.filter(m => m.proxy_excluded_opens_count > 0).length;
  openerCache.set(r.id, { lastOpen, count });
  return count;
}

// Runs fn over items a few at a time (Mailchimp allows only a few requests at once).
async function inBatches(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) results.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return results;
}

// Sent campaigns, oldest first, kept for 15 minutes. Also used by the quarterly and executive reports.
// Returns null when no Mailchimp key is set, so reports can say Mailchimp isn't connected.
async function getCampaigns({ refresh = false } = {}) {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey || !apiKey.includes('-')) return null;
  if (!cache || refresh || Date.now() - cache.at > CACHE_MS) {
    const [reports, audiences] = await Promise.all([
      fetchReports(apiKey),
      fetchAudiences(apiKey).catch(() => []), // optional extra: the campaigns still load without it
    ]);
    const sent = reports.filter(r => r.emails_sent > 0 && r.send_time);
    const openers = await inBatches(sent, 5, r => countOpeners(apiKey, r).catch(() => null)); // null = use the summary figure
    const campaigns = sent
      .map((r, i) => ({ ...toCampaign(r), ...(openers[i] !== null && { uniqueOpens: openers[i] }) }))
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    cache = { at: Date.now(), data: { campaigns, audiences, fetchedAt: new Date().toISOString() } };
  }
  return cache.data;
}

module.exports = function mailchimpRoutes(app) {
  app.get('/api/mailchimp', async (req, res) => {
    try {
      const data = await getCampaigns({ refresh: Boolean(req.query.refresh) });
      if (!data) {
        return res.status(503).json({ error: 'Mailchimp is not set up yet. Add MAILCHIMP_API_KEY to the backend settings.' });
      }
      res.json(data);
    } catch (e) {
      console.error('Mailchimp:', e.message);
      const rejected = e.status === 401 || e.status === 403;
      res.status(rejected ? 401 : 502).json({
        error: rejected
          ? 'Mailchimp rejected the API key. Check MAILCHIMP_API_KEY, or create a new key if it has expired.'
          : `Could not load Mailchimp data: ${e.message}`,
      });
    }
  });
};

module.exports.getCampaigns = getCampaigns;
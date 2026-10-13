// Mailchimp campaign reports for the dashboard.
// The API key stays on the server (MAILCHIMP_API_KEY in .env / Render); the browser only gets the numbers.

const CACHE_MS = 15 * 60 * 1000; // ask Mailchimp at most every 15 minutes unless "refresh" is pressed
const PAGE_SIZE = 1000;
const FIELDS = [
  'total_items',
  'reports.id', 'reports.campaign_title', 'reports.subject_line', 'reports.type', 'reports.list_name',
  'reports.emails_sent', 'reports.send_time', 'reports.unsubscribed', 'reports.bounces',
  'reports.opens', 'reports.clicks',
].join(',');

let cache = null;

async function fetchReports(apiKey) {
  const dataCenter = apiKey.split('-').pop(); // the key ends in e.g. "-us21"
  const auth = `Basic ${Buffer.from(`dashboard:${apiKey}`).toString('base64')}`;
  const reports = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `https://${dataCenter}.api.mailchimp.com/3.0/reports?count=${PAGE_SIZE}&offset=${offset}&fields=${FIELDS}`;
    const response = await fetch(url, { headers: { Authorization: auth } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.detail || `Mailchimp returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    reports.push(...(data.reports || []));
    if (!data.reports?.length || reports.length >= data.total_items) break;
  }
  return reports;
}

function toCampaign(r) {
  const bounced = (r.bounces?.hard_bounces || 0) + (r.bounces?.soft_bounces || 0) + (r.bounces?.syntax_errors || 0);
  return {
    id: r.id,
    title: r.campaign_title || r.subject_line || 'Untitled campaign',
    subject: r.subject_line || '',
    audience: r.list_name || '',
    sentAt: r.send_time,
    sent: r.emails_sent || 0,
    delivered: Math.max((r.emails_sent || 0) - bounced, 0),
    uniqueOpens: r.opens?.unique_opens || 0,
    uniqueClicks: r.clicks?.unique_subscriber_clicks || 0,
    unsubscribed: r.unsubscribed || 0,
  };
}

module.exports = function mailchimpRoutes(app) {
  app.get('/api/mailchimp', async (req, res) => {
    const apiKey = process.env.MAILCHIMP_API_KEY;
    if (!apiKey || !apiKey.includes('-')) {
      return res.status(503).json({ error: 'Mailchimp is not set up yet. Add MAILCHIMP_API_KEY to the backend settings.' });
    }
    try {
      if (!cache || req.query.refresh || Date.now() - cache.at > CACHE_MS) {
        const campaigns = (await fetchReports(apiKey))
          .map(toCampaign)
          .filter(c => c.sent > 0 && c.sentAt)
          .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
        cache = { at: Date.now(), data: { campaigns, fetchedAt: new Date().toISOString() } };
      }
      res.json(cache.data);
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
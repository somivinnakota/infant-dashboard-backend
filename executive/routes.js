// API routes for executive reports. Connected in server.js at /api/executive.
//   GET  /api/executive/periods        periods the data covers, for the picker
//   POST /api/executive/readiness      what a report would include (no AI)
//   POST /api/executive/report         generate, validate and save a report
//   GET  /api/executive/reports        saved reports
//   GET  /api/executive/reports/:id    one saved report
//   POST /api/executive/ask            answer a question from the data

const express = require('express');
const { buildPackage } = require('./package');
const { listPeriods, TYPES } = require('./periods');
const { generateReport, answerQuestion, listReports, getReport, aiSettings } = require('./engine');

module.exports = function executiveRoutes({ loadSocialData, getEventbriteEvents, readImpactData, getFacebookStats }) {
  const router = express.Router();

  const safely = async (label, fn) => {
    try { return await fn(); } catch (error) { console.warn(`Executive report: ${label} unavailable:`, error.message); return null; }
  };

  async function packageFor(body) {
    const type = String(body?.type || '');
    const periodKey = String(body?.period || '');
    if (!TYPES.includes(type)) throw Object.assign(new Error('Choose a report type.'), { status: 400 });
    const [eventbrite, facebook] = await Promise.all([
      safely('Eventbrite', getEventbriteEvents),
      safely('Facebook', getFacebookStats),
    ]);
    const impact = await safely('impact data', async () => readImpactData());
    return buildPackage({
      type,
      periodKey,
      social: loadSocialData(),
      eventbrite,
      impact,
      facebook,
      uploads: body?.uploads && typeof body.uploads === 'object' ? body.uploads : {},
    });
  }

  const fail = (res, error, fallback) => {
    console.error('Executive report error:', error.message);
    const status = error.status || (/not a valid|Unknown report/.test(error.message) ? 400 : 500);
    res.status(status).json({ error: status < 500 ? error.message : fallback });
  };

  router.get('/periods', (req, res) => {
    try {
      const social = loadSocialData();
      const dates = Object.values(social.series).flatMap(rows => (rows.length ? [rows[0].date, rows[rows.length - 1].date] : []));
      const earliest = dates.reduce((min, d) => (d < min ? d : min), '9999-12-31');
      const latest = social.latestDate || new Date().toISOString().slice(0, 10);
      res.json({ periods: listPeriods(dates.length ? earliest : latest, latest), latest, ai: { provider: aiSettings().provider, model: aiSettings().model, plan: aiSettings().plan } });
    } catch (error) { fail(res, error, 'Could not work out the available periods.'); }
  });

  router.post('/readiness', async (req, res) => {
    try {
      const pkg = await packageFor(req.body);
      res.json({
        period: pkg.report.period,
        comparisons: pkg.report.comparisons,
        availability: pkg.availability,
        facts: pkg.facts.length,
        coverage_notes: [...new Set(pkg.facts.flatMap(f => f.notes || []).filter(n => /covers|No reliable|does not go back/.test(n)))].slice(0, 8),
      });
    } catch (error) { fail(res, error, 'Could not check the data for this period.'); }
  });

  router.post('/report', async (req, res) => {
    try {
      const pkg = await packageFor(req.body);
      if (!pkg.facts.length) return res.status(404).json({ error: `There is no dashboard data for ${pkg.report.period.label}.` });
      res.json(await generateReport(pkg));
    } catch (error) { fail(res, error, 'The report could not be generated. Check the server log for details.'); }
  });

  router.get('/reports', (req, res) => res.json({ reports: listReports() }));

  router.get('/reports/:id', (req, res) => {
    const report = getReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'That report was not found.' });
    res.json(report);
  });

  router.post('/ask', async (req, res) => {
    try {
      const question = String(req.body?.question || '').trim();
      if (!question) return res.status(400).json({ error: 'Type a question first.' });
      const pkg = await packageFor(req.body);
      res.json(await answerQuestion(pkg, question));
    } catch (error) { fail(res, error, 'The question could not be answered. Check the server log for details.'); }
  });

  return router;
};
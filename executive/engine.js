// Sends the data to the AI, checks the answer, retries once, and saves reports.
// Settings in backend/.env (all optional):
//   EXECUTIVE_MODEL=openai/gpt-oss-120b     Groq model to use (default shown)
//   EXECUTIVE_PLAN=free                     (default) fits Groq's free plan: compact data, shorter
//                                           reports, and a one-minute wait before any retry.
//   EXECUTIVE_PLAN=full                     full-size data and reports (needs a paid plan).
// It uses the GROQ_API_KEY already in your .env. To use another OpenAI-compatible service instead:
//   EXECUTIVE_PROVIDER=openai-compatible
//   EXECUTIVE_API_URL=https://api.openai.com/v1/chat/completions
//   EXECUTIVE_API_KEY=...
//   EXECUTIVE_MODEL=gpt-4.1

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { SYSTEM_PROMPT, REPORT_BRIEFS, ASK_PROMPT } = require('./prompts');
const { REPORT_SCHEMA, ANSWER_SCHEMA } = require('./schema');
const { validateReport, validateAnswer } = require('./validate');
const { compactReportMessages, compactAskMessages } = require('./compact');
const glossary = require('../glossary');

const SAVED_DIR = path.join(__dirname, 'saved-reports');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRY_WAIT_MS = Number(process.env.EXECUTIVE_RETRY_WAIT_MS) || 61000; // free plan: wait for the per-minute allowance to reset

function aiSettings() {
  const provider = process.env.EXECUTIVE_PROVIDER || 'groq';
  const plan = process.env.EXECUTIVE_PLAN === 'full' ? 'full' : 'free';
  if (provider === 'groq') {
    return {
      provider,
      plan,
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: process.env.GROQ_API_KEY,
      model: process.env.EXECUTIVE_MODEL || 'openai/gpt-oss-120b',
    };
  }
  return {
    provider,
    plan,
    url: process.env.EXECUTIVE_API_URL || 'https://api.openai.com/v1/chat/completions',
    key: process.env.EXECUTIVE_API_KEY,
    model: process.env.EXECUTIVE_MODEL || 'gpt-4.1',
  };
}

// Pulls the JSON object out of a reply, even if the model wrapped it in ``` fences.
function parseJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI did not return JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// One call to the AI.
//   schema: ask for schema-checked JSON (full plan); otherwise plain JSON mode, which uses fewer tokens.
//   maxTokens: the longest reply allowed.
//   lowReasoning: tells Groq's gpt-oss models to think briefly (their thinking counts toward the limit).
// The validator checks the result either way.
async function callModel(messages, { schemaName, schema, maxTokens = 8192, lowReasoning = false } = {}) {
  const s = aiSettings();
  if (!s.key) throw new Error(`No API key set for the ${s.provider} AI provider in backend/.env.`);
  const send = (responseFormat, extra) => axios.post(s.url, {
    model: s.model,
    messages,
    temperature: 0.2,
    max_completion_tokens: maxTokens,
    response_format: responseFormat,
    ...extra,
  }, { headers: { Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' }, timeout: 180000 });

  const attempts = [];
  if (schema) attempts.push([{ type: 'json_schema', json_schema: { name: schemaName, schema } }, {}]);
  if (lowReasoning) attempts.push([{ type: 'json_object' }, { reasoning_effort: 'low' }]);
  attempts.push([{ type: 'json_object' }, {}]);

  let response;
  for (let i = 0; i < attempts.length && !response; i++) {
    try {
      response = await send(...attempts[i]);
    } catch (error) {
      const status = error.response?.status;
      const detail = error.response?.data?.error?.message || error.message;
      if (status === 413 || /request too large/i.test(detail)) {
        throw Object.assign(new Error("This report is too large for your AI plan's limits. On Groq's free plan, set EXECUTIVE_PLAN=free in backend/.env (or remove EXECUTIVE_PLAN) and restart the backend."), { status: 422, detail });
      }
      if (status === 429) {
        // Rate limited: wait as long as the provider asks (up to a minute), then try once more.
        const wait = Math.min(Number(error.response.headers?.['retry-after']) || 30, 60);
        console.warn(`Executive report: rate limited, waiting ${wait}s before trying again.`);
        await sleep(wait * 1000);
        response = await send(...attempts[i]);
      } else if (status !== 400 || i === attempts.length - 1) {
        throw error;
      }
      // A 400 here usually means the model doesn't support that option; the next attempt drops it.
    }
  }
  const content = response.data?.choices?.[0]?.message?.content;
  return { json: parseJson(content), raw: content, model: response.data?.model || s.model, provider: s.provider, usage: response.data?.usage || null };
}

const describeIssues = issues => issues.slice(0, 25).map(i => `- ${i.path}: ${i.problem}`).join('\n');

// Calls the AI, validates, and if there are problems asks once more for a corrected answer.
//   Full plan: the AI sees its previous answer and the list of problems.
//   Free plan: to stay within the per-minute limit, it waits a minute and starts again from the
//   same compact request plus the list of problems to avoid (without its previous answer).
async function runWithValidation({ system, user, schemaName, schema, validate, pkg, maxTokens }) {
  const free = aiSettings().plan === 'free';
  const options = free ? { maxTokens, lowReasoning: true } : { schemaName, schema, maxTokens };
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const started = Date.now();
  let result = await callModel(messages, options);
  let check = validate(result.json, pkg, schema);
  let attempts = 1;

  if (!check.ok) {
    attempts = 2;
    const fix = `Problems found in a previous attempt:\n${describeIssues(check.issues)}\n\nAvoid all of them. Use only figures and ids from the DATA, and describe relationships as association, never cause.`;
    const retry = free
      ? [{ role: 'system', content: system }, { role: 'user', content: `${user}\n\n${fix}` }]
      : [...messages, { role: 'assistant', content: result.raw }, { role: 'user', content: `${fix}\n\nReturn the complete corrected JSON.` }];
    try {
      if (free) await sleep(RETRY_WAIT_MS);
      const second = await callModel(retry, options);
      const secondCheck = validate(second.json, pkg, schema);
      // Keep whichever attempt has fewer problems (a broken second attempt never replaces a usable first one).
      if (secondCheck.ok || secondCheck.issues.length < check.issues.length) { result = second; check = secondCheck; }
    } catch (error) {
      console.warn('Executive report: retry failed:', error.message);
    }
  }
  return { output: result.json, validation: { ok: check.ok, issues: check.issues, attempts }, model: result.model, provider: result.provider, usage: result.usage, ms: Date.now() - started };
}

const packageMessage = pkg => `DATA PACKAGE (authoritative):\n${JSON.stringify(pkg)}`;

// Glossary entries (see glossary/engagement_glossary.json) for the metrics in the package, given to the AI.
function glossaryIdsForPackage(pkg) {
  return [...new Set([
    ...pkg.facts.map(f => glossary.glossaryIdFor(f.id)),
    ...glossary.comparisonIds(pkg.report.comparisons.map(c => c.key), pkg.report.type),
  ].filter(Boolean))];
}

// Glossary entries for the metrics the report actually uses (the facts it cites), for the PDF appendix.
function glossaryIdsForReport(report, pkg) {
  const cited = new Set();
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (k === 'evidence' && Array.isArray(v)) v.forEach(id => cited.add(id));
        else if (k === 'fact_id') cited.add(v);
        else walk(v);
      }
    }
  };
  walk(report);
  const factIds = new Set((pkg?.facts || []).map(f => f.id));
  return [...new Set([
    ...[...cited].filter(id => factIds.has(id)).map(glossary.glossaryIdFor),
    ...glossary.comparisonIds((pkg?.report?.comparisons || []).map(c => c.key), pkg?.report?.type),
  ].filter(Boolean))];
}

async function generateReport(pkg) {
  const free = aiSettings().plan === 'free';
  const glossaryIds = glossaryIdsForPackage(pkg);
  const compact = free ? compactReportMessages(pkg, glossary.promptBlock(glossaryIds, { compact: true })) : null;
  const run = await runWithValidation({
    system: free ? compact.system : `${SYSTEM_PROMPT}\n\nREPORT BRIEF\n${REPORT_BRIEFS[pkg.report.type]}\n\n${glossary.promptBlock(glossaryIds)}`,
    user: free ? compact.user : `${packageMessage(pkg)}\n\nOUTPUT SCHEMA:\n${JSON.stringify(REPORT_SCHEMA)}`,
    maxTokens: free ? 3000 : 8192,
    schemaName: 'executive_report',
    schema: REPORT_SCHEMA,
    validate: validateReport,
    pkg,
  });
  return saveReport({
    id: `${pkg.report.period.key}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    type: pkg.report.type,
    period: pkg.report.period,
    comparisons: pkg.report.comparisons,
    generated_at: new Date().toISOString(),
    model: run.model,
    provider: run.provider,
    plan: aiSettings().plan,
    duration_ms: run.ms,
    data_snapshot: pkg.data_snapshot,
    validation: run.validation,
    report: run.output,
    glossary_ids: glossaryIdsForReport(run.output, pkg), // listed in the PDF's glossary appendix
    package: pkg, // kept so the report shows exactly the figures it was written from
  });
}

async function answerQuestion(pkg, question) {
  const free = aiSettings().plan === 'free';
  const glossaryIds = glossaryIdsForPackage(pkg);
  const compact = free ? compactAskMessages(pkg, question, glossary.promptBlock(glossaryIds, { compact: true })) : null;
  const run = await runWithValidation({
    system: free ? compact.system : `${SYSTEM_PROMPT}\n\n${ASK_PROMPT}\n\n${glossary.promptBlock(glossaryIds)}`,
    user: free ? compact.user : `${packageMessage(pkg)}\n\nQUESTION: ${String(question).slice(0, 500)}\n\nOUTPUT SCHEMA:\n${JSON.stringify(ANSWER_SCHEMA)}`,
    maxTokens: free ? 700 : 2000,
    schemaName: 'dashboard_answer',
    schema: ANSWER_SCHEMA,
    validate: validateAnswer,
    pkg,
  });
  return { ...run.output, validation: run.validation, model: run.model };
}

/* ── Saved reports ───────────────────────────────────────────── */

function saveReport(record) {
  fs.mkdirSync(SAVED_DIR, { recursive: true });
  fs.writeFileSync(path.join(SAVED_DIR, `${record.id}.json`), JSON.stringify(record));
  return record;
}

function listReports() {
  if (!fs.existsSync(SAVED_DIR)) return [];
  return fs.readdirSync(SAVED_DIR).filter(f => f.endsWith('.json')).map(f => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(SAVED_DIR, f), 'utf8'));
      return { id: r.id, type: r.type, period: r.period, generated_at: r.generated_at, model: r.model, validation_ok: r.validation?.ok, flagged: r.validation?.issues?.length || 0 };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.generated_at.localeCompare(a.generated_at));
}

function getReport(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  const file = path.join(SAVED_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Reports saved before the glossary existed get their appendix entries worked out now.
  if (!record.glossary_ids && record.report) record.glossary_ids = glossaryIdsForReport(record.report, record.package);
  return record;
}

module.exports = { generateReport, answerQuestion, listReports, getReport, aiSettings, callModel, parseJson };
// Checks an AI response before anyone sees it:
//   1. it has the required shape (schema)
//   2. every cited id exists in the data package
//   3. every number in the text appears in the data package
//   4. no causal claims ("caused", "led to", ...)
//   5. sections with no data are marked not_available
//   6. risks, opportunities and recommendations cite evidence
// Problems are returned as "issues"; engine.js sends them back to the AI once to correct.

const { evidenceIds } = require('./package');
const { SECTION_AVAILABILITY } = require('./schema');

const CAUSAL = /\b(caused|causes|causing|led to|leads to|leading to|resulted in|results in|resulting in|drove|drives|driven by|due to|because of|thanks to|as a result of)\b/i;
const UNAVAILABLE = ['not_connected', 'not_uploaded', 'no_dataset', 'not_available', 'no_data_for_period'];

/* ── Schema (the subset of JSON Schema used in schema.js) ────── */

function checkShape(value, schema, path, issues) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push({ path, problem: 'should be an object' }); return; }
    for (const key of schema.required || []) {
      if (!(key in value)) issues.push({ path: `${path}.${key}`, problem: 'is missing' });
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) checkShape(value[key], sub, `${path}.${key}`, issues);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) { issues.push({ path, problem: 'should be a list' }); return; }
    value.forEach((item, i) => checkShape(item, schema.items, `${path}[${i}]`, issues));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') issues.push({ path, problem: 'should be text' });
    else if (schema.enum && !schema.enum.includes(value)) issues.push({ path, problem: `should be one of: ${schema.enum.join(', ')}` });
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    issues.push({ path, problem: 'should be true or false' });
  }
}

/* ── Numbers ─────────────────────────────────────────────────── */

// Every number that appears anywhere in the package, plus the usual ways of writing it
// (rounded, as a percentage of a fraction, without a sign).
function allowedNumbers(pkg) {
  const allowed = new Set();
  const add = n => {
    if (!Number.isFinite(n)) return;
    const a = Math.abs(n);
    [a, Math.round(a), Math.round(a * 10) / 10, Math.round(a * 100) / 100, Math.floor(a), Math.ceil(a)].forEach(v => allowed.add(v));
    if (a <= 1) [a * 100, Math.round(a * 100), Math.round(a * 1000) / 10].forEach(v => allowed.add(Math.round(v * 100) / 100));
  };
  const walk = value => {
    if (typeof value === 'number') add(value);
    else if (typeof value === 'string') numbersIn(value).forEach(add);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(pkg);
  for (let n = 0; n <= 4; n++) allowed.add(n); // quarter numbers and small counting words written as digits
  return allowed;
}

function numbersIn(text) {
  return (String(text).match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map(s => Number(s.replace(/,/g, '')))
    .filter(Number.isFinite);
}

/* ── Walk the response's text fields ─────────────────────────── */

function textFields(value, path, out) {
  if (typeof value === 'string') out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => textFields(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (['type', 'evidence_level', 'status', 'priority', 'significance', 'fact_id', 'evidence', 'statement_type'].includes(k)) continue;
      textFields(v, `${path}.${k}`, out);
    }
  }
  return out;
}

function citations(value, path, out) {
  if (Array.isArray(value)) value.forEach((v, i) => citations(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'evidence' && Array.isArray(v)) v.forEach(id => out.push({ path: `${path}.evidence`, id }));
      else if (k === 'fact_id') out.push({ path: `${path}.fact_id`, id: v });
      else citations(v, `${path}.${k}`, out);
    }
  }
  return out;
}

/* ── Main checks ─────────────────────────────────────────────── */

function checkContent(output, pkg, issues) {
  const ids = evidenceIds(pkg);
  const numbers = allowedNumbers(pkg);

  for (const c of citations(output, '$', [])) {
    if (!ids.has(c.id)) issues.push({ path: c.path, problem: `cites "${c.id}", which is not in the data package` });
  }

  for (const field of textFields(output, '$', [])) {
    const unknown = numbersIn(field.text).filter(n => !numbers.has(n) && !numbers.has(Math.round(n * 10) / 10));
    if (unknown.length) issues.push({ path: field.path, problem: `contains numbers not in the data package: ${[...new Set(unknown)].join(', ')}` });
    const causal = field.text.match(CAUSAL);
    if (causal) issues.push({ path: field.path, problem: `states a cause ("${causal[0]}"); the data does not establish causes` });
  }
}

function validateReport(output, pkg, schema) {
  const issues = [];
  checkShape(output, schema, '$', issues);
  if (issues.length) return { ok: false, issues };

  checkContent(output, pkg, issues);

  for (const [name, keys] of Object.entries(SECTION_AVAILABILITY)) {
    const unavailable = keys.every(k => UNAVAILABLE.includes(pkg.availability[k]));
    const sec = output.sections[name];
    if (unavailable && (sec.status !== 'not_available' || sec.findings.length)) {
      issues.push({ path: `$.sections.${name}`, problem: 'has no data in the package, so it must be "not_available" with no findings' });
    }
  }
  ['risks', 'opportunities'].forEach(list => output[list].forEach((item, i) => {
    if (!item.evidence.length) issues.push({ path: `$.${list}[${i}]`, problem: 'cites no evidence' });
  }));
  output.recommendations.forEach((r, i) => {
    if (!r.evidence.length) issues.push({ path: `$.recommendations[${i}]`, problem: 'cites no evidence' });
  });
  if (pkg.report.type === 'annual' && !output.annual_summary.trim()) {
    issues.push({ path: '$.annual_summary', problem: 'is required for an annual report' });
  }
  return { ok: issues.length === 0, issues };
}

function validateAnswer(output, pkg, schema) {
  const issues = [];
  checkShape(output, schema, '$', issues);
  if (issues.length) return { ok: false, issues };
  checkContent(output, pkg, issues);
  if (!output.insufficient_data && !output.evidence.length) {
    issues.push({ path: '$.evidence', problem: 'an answer from the data must cite at least one id' });
  }
  return { ok: issues.length === 0, issues };
}

module.exports = { validateReport, validateAnswer, allowedNumbers, numbersIn, checkShape };
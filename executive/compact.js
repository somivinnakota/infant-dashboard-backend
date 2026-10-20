// Free-plan mode: fits each AI request inside Groq's free limit of 8,000 tokens per minute.
// The full data package is still built and still used by the validator; the AI just receives
// a compact text version of it: one line per figure instead of verbose JSON.
//
// Budget per request (roughly): about 4,000 tokens sent + 3,000 tokens back.

const INPUT_BUDGET_TOKENS = 4000;
const estimateTokens = text => Math.ceil(String(text).length / 3.3); // cautious: real counts are usually lower

const COMPACT_RULES = `You are INFANT's Executive Data Analysis Assistant (INFANT: maternal and child health research centre, University College Cork). Write evidence-based insights for senior management from the DATA below.

RULES
- The DATA is your only source. No outside knowledge. Never invent figures, campaigns, events, awards, causes or dates.
- Quote figures exactly as written in the DATA. Never calculate new numbers.
- Areas listed under NOT AVAILABLE must be reported as not available, never guessed.
- Never say one thing caused, drove, led to or resulted in another. Use "coincided with" or "is associated with" and say the data does not establish cause. If the cause is unknown, say so.
- Mention notes such as partial periods and small bases when you use those figures.
- Treat declines and "no change" as findings. Do not soften them.
- type: "fact" (straight from the data), "observation" (pattern across figures), "interpretation" (hedged meaning).
- evidence_level: "high" (shown directly), "medium" (needs interpretation), "low" (possible, unconfirmed).
- evidence: list the ids (the text before the first "|" on each DATA line) you relied on. Only ids from the DATA.
- Every risk, opportunity and recommendation needs at least one evidence id.
- British English, third person, concise, no hype or filler, plain text only.`;

const COMPACT_SHAPE = `Return ONLY a JSON object with exactly these keys:
{"executive_summary":{"text":"","evidence":[]},
"key_findings":[F],
"kpi_analysis":[{"fact_id":"","interpretation":"","significance":"major|notable|minor"}],
"sections":{"website":S,"social":S,"email":S,"content":S,"media":S,"publications":S,"events":S,"conferences":S,"kpis":S},
"trends":[F],"cross_dataset":[F],"risks":[F],"opportunities":[F],
"recommendations":[{"recommendation":"","evidence":[],"reasoning":"","expected_benefit":"","priority":"high|medium|low"}],
"data_gaps":[""],"best_performing":[F],"annual_summary":""}
where F = {"statement":"","type":"fact|observation|interpretation","evidence_level":"high|medium|low","evidence":["id"]}
and S = {"status":"analysed|not_available","summary":"","findings":[F]}`;

const COMPACT_BRIEFS = {
  quarterly: 'QUARTERLY report. executive_summary up to 100 words. key_findings 3-4. kpi_analysis up to 6. Each section: one-sentence summary, at most 2 findings. trends 1-2. cross_dataset 0-1. risks 2. opportunities 2. recommendations 3. best_performing [] and annual_summary "".',
  'six-month': 'SIX-MONTH report. Use the MONTHLY lines for direction of travel. executive_summary up to 110 words. key_findings 3-4. kpi_analysis up to 6. Each section: one-sentence summary, at most 2 findings. trends 2-3. risks 2. opportunities 2. recommendations 3. best_performing [] and annual_summary "".',
  annual: 'ANNUAL report. executive_summary up to 100 words. key_findings 3-4. kpi_analysis up to 6. Each section: one-sentence summary, at most 1 finding. trends 2. risks 2. opportunities 2. recommendations 3. best_performing 2 (cite post ids). annual_summary up to 130 words of polished annual-report prose.',
};

const COMPACT_ASK = `Answer the QUESTION in under 100 words using only the DATA. If the DATA cannot answer it, set insufficient_data true and answer exactly: "I don't have enough information in the dashboard data to answer that."
Return ONLY JSON: {"answer":"","insufficient_data":false,"statement_type":"fact|observation|interpretation|recommendation","evidence_level":"high|medium|low","evidence":["id"]}`;

const short = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function factLine(f, comparisons) {
  const parts = [f.id, short(f.label, 60), f.current.display];
  for (const c of comparisons) {
    const v = f.vs?.[c.key];
    if (v) parts.push(`vs ${c.label} ${v.display} (${v.change_pct_display}${f.unit === 'percent' ? `, ${v.change_display}` : ''})`);
  }
  const notes = [...(f.notes || []), ...Object.values(f.vs || {}).filter(Boolean).map(v => v.note).filter(Boolean)];
  if (notes.length) parts.push(`note: ${short([...new Set(notes)].join(' '), 110)}`);
  return parts.join(' | ');
}

// Builds the DATA text in parts, most important first, dropping optional parts if over budget.
function compactData(pkg, { includeMonthly }) {
  const { report } = pkg;
  const header = `PERIOD: ${report.period.label} (${report.period.start} to ${report.period.end}); compared with ${report.comparisons.map(c => c.label).join(' and ')}.`;
  const unavailable = Object.entries(pkg.availability).filter(([, v]) => v !== 'available').map(([k, v]) => `${k} (${v.replace(/_/g, ' ')})`);
  const facts = pkg.facts.map(f => factLine(f, report.comparisons));

  const optional = [];
  if (includeMonthly) {
    const monthLines = Object.entries(pkg.monthly)
      .filter(([, rows]) => rows.length)
      .slice(0, 6)
      .map(([id, rows]) => `${id} | ${rows.filter(r => r.month >= report.period.start.slice(0, 7)).map(r => `${r.month} ${Math.round(r.value).toLocaleString('en-IE')}`).join('; ')}`);
    if (monthLines.length) optional.push(['MONTHLY (current period)', monthLines]);
  }
  const posts = Object.values(pkg.content).flatMap(l => [
    ...l.top.slice(0, 3).map(p => `${p.id} | top ${l.platform} post ${p.date} | ${short(p.title, 70)} | ${Object.entries(p.metrics).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(', ')}`),
    ...l.bottom.slice(0, 1).map(p => `${p.id} | weakest ${l.platform} post ${p.date} | ${short(p.title, 70)} | ${Object.entries(p.metrics).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(', ')}`),
  ]);
  if (posts.length) optional.push(['POSTS', posts]);
  const events = (pkg.events.in_period || []).slice(0, 4).map(e => `${e.id} | ${e.date} | ${short(e.name, 60)} | ${e.status}`);
  if (events.length) optional.push(['EVENTS', events]);
  const emails = (pkg.email?.in_period || []).slice(0, 3).map(c => `${c.id} | email campaign ${c.date} | ${short(c.title, 60)} | delivered ${c.delivered}, open rate ${c.open_rate}, engagement rate ${c.engagement_rate}`);
  if (emails.length) optional.push(['EMAIL CAMPAIGNS (best engagement first)', emails]);
  const journals = (pkg.publications.top_journals || []).slice(0, 3).map(j => `${short(j.journal, 50)}: ${j.publications}`);
  if (journals.length) optional.push(['TOP JOURNALS', [journals.join('; ')]]);
  const uploads = Object.entries(pkg.uploads).flatMap(([k, u]) => (u.categories || []).slice(0, 2).map(c => `${k} by ${c.column}: ${c.top.slice(0, 4).map(t => `${short(t.name, 25)} ${t.entries}`).join(', ')}`));
  if (uploads.length) optional.push(['UPLOADED SHEETS', uploads]);
  const audience = pkg.audience.slice(0, 3).map(a => `${a.id} | ${a.platform} ${short(a.label, 40)} (snapshot) | ${a.top.slice(0, 3).map(t => `${short(t.name, 25)} ${t.value}`).join(', ')}`);
  if (audience.length) optional.push(['AUDIENCE', audience]);
  if (pkg.context.length) optional.push(['CONTEXT (not period-specific)', [pkg.context.map(c => `${c.id}: ${c.label} ${c.display}`).join('; ')]]);

  const core = [
    header,
    `NOT AVAILABLE: ${unavailable.join(', ') || 'none'}`,
    'FIGURES (id | measure | this period | comparisons | notes):',
    ...facts,
  ].join('\n');

  // Add optional parts in order of usefulness while the request stays within budget.
  let text = core;
  for (const [title, lines] of optional) {
    const next = `${text}\n${title}:\n${lines.join('\n')}`;
    if (estimateTokens(next) + 1700 > INPUT_BUDGET_TOKENS) break; // 1,700 ≈ rules + format + brief
    text = next;
  }
  return text;
}

function compactReportMessages(pkg) {
  const type = pkg.report.type;
  const system = `${COMPACT_RULES}\n\n${COMPACT_SHAPE}\n\n${COMPACT_BRIEFS[type]}`;
  const user = `DATA:\n${compactData(pkg, { includeMonthly: type !== 'quarterly' })}`;
  return { system, user, estimate: estimateTokens(system) + estimateTokens(user) };
}

function compactAskMessages(pkg, question) {
  const system = `${COMPACT_RULES}\n\n${COMPACT_ASK}`;
  const user = `DATA:\n${compactData(pkg, { includeMonthly: false })}\n\nQUESTION: ${short(question, 300)}`;
  return { system, user, estimate: estimateTokens(system) + estimateTokens(user) };
}

module.exports = { compactReportMessages, compactAskMessages, estimateTokens, INPUT_BUDGET_TOKENS };
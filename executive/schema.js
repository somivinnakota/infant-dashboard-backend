// The exact JSON shape the AI must return. validate.js checks every response against it.

const finding = {
  type: 'object',
  required: ['statement', 'type', 'evidence_level', 'evidence'],
  properties: {
    statement: { type: 'string' },
    type: { type: 'string', enum: ['fact', 'observation', 'interpretation'] },
    evidence_level: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'array', items: { type: 'string' } },
  },
};

const section = {
  type: 'object',
  required: ['status', 'summary', 'findings'],
  properties: {
    status: { type: 'string', enum: ['analysed', 'not_available'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: finding },
  },
};

const SECTION_NAMES = ['website', 'social', 'email', 'content', 'media', 'publications', 'events', 'conferences', 'kpis'];

const REPORT_SCHEMA = {
  type: 'object',
  required: ['executive_summary', 'key_findings', 'kpi_analysis', 'sections', 'trends', 'cross_dataset', 'risks', 'opportunities', 'recommendations', 'data_gaps', 'best_performing', 'annual_summary'],
  properties: {
    executive_summary: {
      type: 'object',
      required: ['text', 'evidence'],
      properties: { text: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
    },
    key_findings: { type: 'array', items: finding },
    kpi_analysis: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fact_id', 'interpretation', 'significance'],
        properties: {
          fact_id: { type: 'string' },
          interpretation: { type: 'string' },
          significance: { type: 'string', enum: ['major', 'notable', 'minor'] },
        },
      },
    },
    sections: {
      type: 'object',
      required: SECTION_NAMES,
      properties: Object.fromEntries(SECTION_NAMES.map(name => [name, section])),
    },
    trends: { type: 'array', items: finding },
    cross_dataset: { type: 'array', items: finding },
    risks: { type: 'array', items: finding },
    opportunities: { type: 'array', items: finding },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['recommendation', 'evidence', 'reasoning', 'expected_benefit', 'priority'],
        properties: {
          recommendation: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          reasoning: { type: 'string' },
          expected_benefit: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    data_gaps: { type: 'array', items: { type: 'string' } },
    best_performing: { type: 'array', items: finding },
    annual_summary: { type: 'string' },
  },
};

const ANSWER_SCHEMA = {
  type: 'object',
  required: ['answer', 'insufficient_data', 'statement_type', 'evidence_level', 'evidence'],
  properties: {
    answer: { type: 'string' },
    insufficient_data: { type: 'boolean' },
    statement_type: { type: 'string', enum: ['fact', 'observation', 'interpretation', 'recommendation'] },
    evidence_level: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'array', items: { type: 'string' } },
  },
};

// Which availability entries switch each report section off.
const SECTION_AVAILABILITY = {
  website: ['website'],
  email: ['mailchimp'],
  media: ['media'],
  kpis: ['kpis'],
  conferences: ['conferences'],
  publications: ['publications'],
};

module.exports = { REPORT_SCHEMA, ANSWER_SCHEMA, SECTION_NAMES, SECTION_AVAILABILITY };
// INFANT's verified publication list, built only from research databases.
//
// STEP 1 - find candidates (papers that might be INFANT's):
//   - Scopus: papers whose addresses mention INFANT and Cork, or INFANT's full names.
//   - PubMed: papers whose addresses mention INFANT (or its full names) and Cork / Ireland.
//   - Scopus: every paper by the INFANT researchers listed in impact-data.json.
//
// STEP 2 - check every candidate individually, the way a person would:
//   fetch the paper's full list of author addresses and look for an address that NAMES INFANT
//   ("INFANT", "Infant Centre", "Infant Research Centre" or a full name) in Cork / UCC / Ireland.
//   The word "infant" on its own isn't enough: "Women's and Infant's Hospital", "Infant Jesus Hospital"
//   or "Maternal-Infant" departments are other institutions.
//   Address sources, in order: PubMed's full record, the institutions Scopus lists for the paper,
//   the publisher's record at Crossref, then OpenAlex (for papers none of those could verify).
//
// Every paper ends up with one status:
//   verified      - an author's address names INFANT, and it is a research article or review (COUNTED)
//   other_output  - an author's address names INFANT, but it is a letter, editorial, conference paper,
//                   preprint, book etc. (listed, not counted)
//   needs_review  - the addresses could not be retrieved, so nobody can confirm it yet (listed, not counted)
//   investigator  - a paper by one of the listed researchers (the roster in impact-data.json) that could
//                   not be verified automatically (listed, not counted; it can be added by hand)
//   not_infant    - the addresses were checked and none names INFANT (listed, not counted)
//
// LISTED RESEARCHERS: a paper by someone on the roster is also verified when THAT AUTHOR'S OWN address
// on the paper names UCC, CUMH or INFANT. A UCC address belonging to a co-author is not enough.
//
// BY HAND: any listed paper can be added to, or removed from, the counted collection on the
// Publications page. Those decisions are saved in publication-overrides.json and survive rebuilds.
// Verified papers keep the address that proves it ("evidence"), so anyone can check.
// Each paper is dated by when it was first published (online first, if earlier than the journal issue).
//
// Rebuilt once a day (or on request). The last finished list is saved to publications-cache.json,
// so a restart shows it straight away. Needs ELSEVIER_API_KEY in backend/.env (and on Render).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { dataPath } = require('./data-dir');

const FIRST_YEAR = 2013; // INFANT was founded in 2013
const REFRESH_MS = 24 * 60 * 60 * 1000;
const MIN_MANUAL_REFRESH_MS = 5 * 60 * 1000;
// Raise this when the saved list needs new information (2 = every author's name, 3 = listed
// researchers and their own addresses). A list saved
// by an older version is rebuilt straight away instead of waiting a day.
const LIST_VERSION = 3;
const TIMEOUT = 45000;
const CACHE_FILE = dataPath('publications-cache.json', path.join(__dirname, 'publications-cache.json'));
const OVERRIDES_FILE = dataPath('publication-overrides.json', path.join(__dirname, 'publication-overrides.json'));

// Document types that count towards INFANT's publication total. Everything else is an "other output".
const COUNTED_TYPES = ['Article', 'Review'];

const SCOPUS_URL = 'https://api.elsevier.com/content/search/scopus';
const SCOPUS_PAGE = 200; // papers per request; falls back to 25 if Scopus won't allow 200
const SCOPUS_SMALL_PAGE = 25;
const SCOPUS_MAX = 5000; // Scopus's limit for one search
const SCOPUS_INFANT = '((AFFIL(INFANT) AND AFFIL(Cork)) OR AFFIL("Irish Centre for Fetal and Neonatal Translational Research") OR AFFIL("Irish Centre for Maternal and Child Health Research"))';

const PUBMED_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const PUBMED_INFANT = '("INFANT"[ad] OR "Irish Centre for Fetal and Neonatal Translational Research"[ad] OR "Irish Centre for Maternal and Child Health Research"[ad])'
  + ' AND (Cork[ad] OR Ireland[ad])';

const CROSSREF_URL = 'https://api.crossref.org/works/';

/* ── Does one address name INFANT? ───────────────────────────── */

// INFANT's name: "INFANT" in capitals, "Infant Centre" / "Infant Research Centre" / "Infant SFI Centre"
// in any capitals, or one of its full names. "Infant Centre" must be a name on its own: at the start of
// the address or after a comma, semicolon, bracket, "and", "the" or "at". So other institutions such as
// "Mother-Milk-Infant Center" (San Diego), "Centre for Infant…" or "…and Infant Hospital" don't match.
const INFANT_IN_CAPITALS = /\bINFANT\b/;
const INFANT_NAMES = /(?:^|[,;:(\d‡§*†]|\b(?:and|the|at))\s*infant (?:research |sfi )?cent(?:re|er)\b|irish cent(?:re|er) for fetal and neonatal translational research|irish cent(?:re|er) for maternal and child health research/i;
const namesTheCentre = address => INFANT_IN_CAPITALS.test(address) || INFANT_NAMES.test(address);
// A sign that it's the centre in Cork.
const IN_CORK = /\bCork\b|\bUCC\b|University College Cork|\bIreland\b/i;
const CORK_OR_UCC = /\bCork\b|\bUCC\b|University College Cork/i;
const namesInfant = address => namesTheCentre(address) && IN_CORK.test(address);

// The address that proves a paper is INFANT's: one naming INFANT in Cork / UCC / Ireland, or, when the
// address is only "Infant Research Centre.", one naming INFANT while another address of the same author
// list is in Cork / UCC.
function infantEvidence(addresses) {
  const named = (addresses || []).filter(namesTheCentre);
  return named.find(a => IN_CORK.test(a)) || (named.length && addresses.some(a => CORK_OR_UCC.test(a)) ? named[0] : undefined);
}

/* ── Listed researchers (the roster in impact-data.json) ─────── */

// For a listed researcher, their own address naming UCC or CUMH is enough (as well as INFANT).
const UCC_OR_CUMH = /University College Cork|\bUCC\b|National University of Ireland,? Cork|Cork University Maternity Hospital|\bCUMH\b/i;
const investigatorAddress = address => namesTheCentre(address) || UCC_OR_CUMH.test(address);

// A name as plain lower-case words: "Keelin O’Donoghue" -> ["keelin", "o'donoghue"].
const nameWords = name => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’`]/g, "'")
  .toLowerCase().replace(/[^a-z' -]/g, ' ').split(/\s+/).filter(Boolean);

// The surname and first-name initials to look for: "William (Liam) Marnane" -> marnane, [w, l].
function nameParts(name) {
  const words = nameWords(name);
  if (words.length < 2) return { surname: '', initials: [] };
  return { surname: words[words.length - 1], initials: [...new Set(words.slice(0, -1).map(w => w[0]))] };
}

// Is this author (as named on a paper) the listed researcher? Surname plus a first-name initial, so
// "William P Marnane", "L. Marnane" and "Juan Trujillo Wurttele" all match. Only ever asked about
// papers Scopus or PubMed already returned for that researcher.
function isAuthor(inv, authorName) {
  if (!inv.surname) return false;
  const words = nameWords(authorName);
  const at = words.indexOf(inv.surname);
  return at >= 0 && words.some((w, i) => i !== at && inv.initials.includes(w[0]));
}

// The roster: named entries from "investigators" (one person can have several Scopus profiles, or
// none yet), plus every other ID in "researcherIds" as a person whose name is learnt from their papers.
function buildRoster({ researcherIds = [], investigators = [] } = {}) {
  const roster = investigators.map(i => ({
    name: String(i.name || '').trim(), scopusIds: (i.scopusIds || []).map(String), pubmedAuthor: i.pubmedAuthor || '',
  }));
  const listed = new Set(roster.flatMap(r => r.scopusIds));
  for (const id of researcherIds.map(String)) {
    if (!listed.has(id)) { roster.push({ name: '', scopusIds: [id], pubmedAuthor: '' }); listed.add(id); }
  }
  return roster.map(r => ({ id: r.scopusIds[0] ? `scopus.${r.scopusIds[0]}` : `name.${shortHash(r.name)}`, ...r, ...nameParts(r.name) }));
}

// For roster entries that are only a Scopus ID: the author who appears on (nearly) all of that
// profile's papers is the researcher. Needs at least five papers to be sure.
function learnNames(roster, papers) {
  for (const inv of roster.filter(r => !r.surname)) {
    const mine = papers.filter(p => p.investigators?.includes(inv.id) && p.authorNames?.length);
    const seenOn = new Map();
    for (const p of mine) {
      const onThisPaper = new Set();
      for (const full of p.authorNames) {
        const words = nameWords(full);
        if (words.length < 2) continue;
        const key = `${words[words.length - 1]}|${words[0][0]}`;
        if (onThisPaper.has(key)) continue;
        onThisPaper.add(key);
        const entry = seenOn.get(key) || { papers: 0, spellings: {} };
        entry.papers += 1;
        entry.spellings[full] = (entry.spellings[full] || 0) + 1;
        seenOn.set(key, entry);
      }
    }
    const [key, best] = [...seenOn.entries()].sort((a, b) => b[1].papers - a[1].papers)[0] || [];
    if (!best || mine.length < 5 || best.papers < mine.length * 0.6) continue;
    const [surname, initial] = key.split('|');
    inv.surname = surname;
    inv.initials = [initial];
    inv.name = Object.entries(best.spellings).sort((a, b) => b[1] - a[1])[0][0];
    inv.nameLearned = true;
  }
}

// The listed researcher's own address that names INFANT, UCC or CUMH, if the paper has one.
function investigatorEvidence(paper, roster) {
  for (const inv of roster.filter(r => r.surname && paper.investigators?.includes(r.id))) {
    for (const author of paper.authorAddresses || []) {
      if (!isAuthor(inv, author.name)) continue;
      const address = author.addresses.find(investigatorAddress);
      if (address) return { address, source: author.source, author: inv.name };
    }
  }
  return null;
}

/* ── Small helpers ───────────────────────────────────────────── */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shortHash = text => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
const pad = n => String(n).padStart(2, '0');
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const cleanDoi = doi => {
  const m = String(doi || '').trim().toLowerCase().match(/10\.\d{4,9}\/[^\s"'<>]+/);
  return m ? m[0].replace(/[.,;)\]]+$/, '') : '';
};
const titleKey = title => String(title || '').toLowerCase()
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}
const stripTags = text => decodeEntities(String(text || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// The short author line shown on the page: the first three names, then "et al.".
const shortAuthorList = names => (names.length ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ' et al.' : ''}` : '');

// The earliest of several 'YYYY-MM-DD' dates.
const earliest = dates => dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d || '')).sort()[0] || null;

/* ── Step 1: candidates from Scopus ──────────────────────────── */

let scopusPageSize = SCOPUS_PAGE;

async function scopusSearch(query, apiKey) {
  const entries = [];
  let total = Infinity;
  for (let start = 0; start < Math.min(total, SCOPUS_MAX);) {
    let data;
    const count = scopusPageSize; // the page size THIS request asks for
    try {
      ({ data } = await axios.get(SCOPUS_URL, {
        params: { query, start, count, httpAccept: 'application/json', apiKey },
        // Off UCC's network, Scopus Search needs the institutional token Elsevier issues to the library.
        headers: process.env.ELSEVIER_INSTTOKEN ? { 'X-ELS-Insttoken': process.env.ELSEVIER_INSTTOKEN } : {},
        timeout: TIMEOUT,
      }));
    } catch (error) {
      // Off the university network (e.g. on Render) Scopus allows only 25 results per request.
      // Switch down and retry. Checked against this request's own page size, because two searches
      // run at once and the other one may already have switched the setting down.
      if (error.response?.status === 400 && count > SCOPUS_SMALL_PAGE) {
        scopusPageSize = SCOPUS_SMALL_PAGE;
        continue;
      }
      throw error;
    }
    const results = data?.['search-results'] || {};
    total = Number(results['opensearch:totalResults']) || 0;
    const page = (results.entry || []).filter(e => !e.error);
    entries.push(...page);
    if (!page.length) break;
    start += page.length;
    await sleep(120); // stay well inside Scopus's rate limit
  }
  return { entries, total };
}

const SCOPUS_ONLY_KNOWS = ['Conference paper', 'Conference review', 'Book', 'Book chapter'];
const SCOPUS_TYPES = { ar: 'Article', re: 'Review', sh: 'Review', le: 'Letter', ed: 'Editorial', no: 'Note', cp: 'Conference paper', cr: 'Conference review', ch: 'Book chapter', bk: 'Book', er: 'Correction', tb: 'Retraction', dp: 'Data paper' };

function fromScopus(e) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(e['prism:coverDate'] || '') ? e['prism:coverDate'] : null;
  const affiliations = (Array.isArray(e.affiliation) ? e.affiliation : e.affiliation ? [e.affiliation] : [])
    .map(a => [a.affilname, a['affiliation-city'], a['affiliation-country']].filter(Boolean).join(', '));
  return {
    title: stripTags(e['dc:title']),
    journal: e['prism:publicationName'] || '',
    authors: e['dc:creator'] || '',
    issueDate: date,
    doi: cleanDoi(e['prism:doi']),
    pmid: e['pubmed-id'] ? String(e['pubmed-id']) : '',
    eid: e.eid || '',
    type: SCOPUS_TYPES[e.subtype] || e.subtypeDescription || '',
    scopusType: SCOPUS_TYPES[e.subtype] || '',
    scopusAffiliations: affiliations,
    openAccess: e.openaccessFlag === true || e.openaccess === '1',
    citations: e['citedby-count'] !== undefined && e['citedby-count'] !== null ? Number(e['citedby-count']) || 0 : null, // Scopus's count
  };
}

/* ── Step 1: candidates from PubMed ──────────────────────────── */

async function pubmedSearch() {
  const { data } = await axios.get(`${PUBMED_URL}/esearch.fcgi`, {
    params: { db: 'pubmed', term: `${PUBMED_INFANT} AND ${FIRST_YEAR}:3000[dp]`, retmax: 9999, retmode: 'json' },
    timeout: TIMEOUT,
  });
  return { ids: data?.esearchresult?.idlist || [], total: Number(data?.esearchresult?.count) || 0 };
}

// Papers by a listed researcher who has no Scopus ID on the roster yet ("pubmedAuthor": "Trujillo J").
// Limited to papers with a Cork address, because a name on its own can be several people.
async function pubmedAuthorSearch(author) {
  const term = `"${String(author).replace(/"/g, '')}"[Author] AND (INFANT[ad] OR "University College Cork"[ad] OR UCC[ad] OR "Cork University Maternity Hospital"[ad]) AND ${FIRST_YEAR}:3000[dp]`;
  const { data } = await axios.get(`${PUBMED_URL}/esearch.fcgi`, {
    params: { db: 'pubmed', term, retmax: 9999, retmode: 'json' }, timeout: TIMEOUT,
  });
  return data?.esearchresult?.idlist || [];
}

/* ── Step 2: full PubMed records (addresses, dates, type) ────── */

function pubmedDate(block) {
  if (!block) return null;
  const year = block.match(/<Year>(\d{4})<\/Year>/)?.[1];
  if (!year) {
    const medline = block.match(/<MedlineDate>(\d{4})/)?.[1]; // e.g. "2025 Jan-Feb"
    return medline ? `${medline}-01-01` : null;
  }
  const m = block.match(/<Month>([^<]+)<\/Month>/)?.[1] || '1';
  const month = /^\d+$/.test(m) ? Number(m) : MONTHS[m.slice(0, 3).toLowerCase()] || 1;
  const day = Number(block.match(/<Day>(\d+)<\/Day>/)?.[1] || 1);
  return `${year}-${pad(month)}-${pad(day)}`;
}

function pubmedType(types) {
  const has = t => types.some(x => x.toLowerCase() === t.toLowerCase());
  if (has('Published Erratum')) return 'Correction';
  if (has('Retraction of Publication')) return 'Retraction';
  if (has('Preprint')) return 'Preprint';
  if (has('Review') || has('Systematic Review') || has('Meta-Analysis')) return 'Review';
  if (has('Letter')) return 'Letter';
  if (has('Editorial')) return 'Editorial';
  if (has('Comment')) return 'Comment';
  if (has('News') || has('Interview') || has('Biography')) return 'Other';
  return 'Article'; // Journal Article, Clinical Trial, Case Reports, Randomized Controlled Trial, ...
}

function parsePubmedArticle(xml) {
  const pmid = xml.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
  if (!pmid) return null;
  const types = [...xml.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g)].map(m => m[1]);
  // Every author: "Trujillo J" for the short line on the page, "Juan Trujillo" for searching.
  const authors = [...xml.matchAll(/<Author[\s>][\s\S]*?<\/Author>/g)].map(a => {
    const last = a[0].match(/<LastName>([^<]+)<\/LastName>/)?.[1];
    const first = a[0].match(/<ForeName>([^<]+)<\/ForeName>/)?.[1];
    const initials = a[0].match(/<Initials>([^<]+)<\/Initials>/)?.[1];
    if (!last) {
      const group = stripTags(a[0].match(/<CollectiveName>([\s\S]*?)<\/CollectiveName>/)?.[1]);
      return group ? { short: group, full: group } : null;
    }
    return {
      short: `${decodeEntities(last)} ${initials || ''}`.trim(),
      full: first ? `${decodeEntities(first)} ${decodeEntities(last)}` : `${decodeEntities(last)} ${initials || ''}`.trim(),
      addresses: [...a[0].matchAll(/<Affiliation>([\s\S]*?)<\/Affiliation>/g)].map(m => stripTags(m[1])),
    };
  }).filter(Boolean);
  return {
    pmid,
    title: stripTags(xml.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1]).replace(/\.$/, ''),
    journal: stripTags(xml.match(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/)?.[1]),
    authors: shortAuthorList(authors.map(a => a.short)),
    authorNames: authors.map(a => a.full),
    // Which address belongs to which author (for the listed-researcher check).
    authorAddresses: authors.filter(a => a.addresses?.length).map(a => ({ name: a.full, addresses: a.addresses })),
    doi: cleanDoi(xml.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/)?.[1] || xml.match(/<ELocationID EIdType="doi"[^>]*>([^<]+)<\/ELocationID>/)?.[1]),
    onlineDate: pubmedDate(xml.match(/<ArticleDate[^>]*>([\s\S]*?)<\/ArticleDate>/)?.[1]),
    issueDate: pubmedDate(xml.match(/<PubDate>([\s\S]*?)<\/PubDate>/)?.[1]),
    type: pubmedType(types),
    addresses: [...xml.matchAll(/<Affiliation>([\s\S]*?)<\/Affiliation>/g)].map(m => stripTags(m[1])),
    openAccess: /<ArticleId IdType="pmc">/.test(xml),
  };
}

async function pubmedRecords(pmids) {
  const records = new Map();
  for (let i = 0; i < pmids.length; i += 200) {
    const batch = pmids.slice(i, i + 200);
    const { data } = await axios.post(`${PUBMED_URL}/efetch.fcgi`,
      new URLSearchParams({ db: 'pubmed', id: batch.join(','), retmode: 'xml' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TIMEOUT, responseType: 'text' });
    for (const article of String(data).split(/<\/PubmedArticle>/)) {
      const record = parsePubmedArticle(article);
      if (record) records.set(record.pmid, record);
    }
    await sleep(400); // PubMed allows 3 requests a second without a key
  }
  return records;
}

/* ── Step 2: the publisher's record at Crossref (papers not in PubMed) ── */

const crossrefDate = parts => {
  const [y, m = 1, d = 1] = parts?.['date-parts']?.[0] || [];
  return y ? `${y}-${pad(m)}-${pad(d)}` : null;
};

async function crossrefRecord(doi) {
  const { data } = await axios.get(`${CROSSREF_URL}${encodeURIComponent(doi)}`, {
    params: { mailto: 'infant-dashboard@ucc.ie' }, timeout: TIMEOUT,
  });
  const work = data?.message || {};
  return {
    addresses: (work.author || []).flatMap(a => (a.affiliation || []).map(x => x.name)).filter(Boolean),
    authorNames: (work.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
    authorAddresses: (work.author || [])
      .map(a => ({ name: [a.given, a.family].filter(Boolean).join(' '), addresses: (a.affiliation || []).map(x => x.name).filter(Boolean) }))
      .filter(a => a.name && a.addresses.length),
    onlineDate: crossrefDate(work['published-online']),
    issueDate: crossrefDate(work['published-print']) || crossrefDate(work.issued),
  };
}

async function crossrefRecords(dois) {
  const records = new Map();
  for (let i = 0; i < dois.length; i += 5) {
    await Promise.all(dois.slice(i, i + 5).map(async doi => {
      try { records.set(doi, await crossrefRecord(doi)); } catch { /* not found: stays unchecked */ }
    }));
    await sleep(250);
  }
  return records;
}

/* ── Step 2: author addresses from OpenAlex (papers the other sources couldn't verify) ── */

const OPENALEX_URL = 'https://api.openalex.org/works';

async function openalexBatch(dois) {
  const { data } = await axios.get(OPENALEX_URL, {
    params: { filter: `doi:${dois.join('|')}`, 'per-page': dois.length, select: 'doi,authorships', mailto: 'infant-dashboard@ucc.ie' },
    timeout: TIMEOUT,
  });
  return data?.results || [];
}

async function openalexRecords(dois) {
  const records = new Map();
  const save = work => {
    const doi = cleanDoi(work.doi);
    const addresses = (work.authorships || []).flatMap(a => a.raw_affiliation_strings || []).filter(Boolean);
    const authorNames = (work.authorships || []).map(a => a.author?.display_name).filter(Boolean);
    const authorAddresses = (work.authorships || [])
      .map(a => ({ name: a.author?.display_name || '', addresses: (a.raw_affiliation_strings || []).filter(Boolean) }))
      .filter(a => a.name && a.addresses.length);
    if (doi) records.set(doi, { addresses, authorNames, authorAddresses });
  };
  for (let i = 0; i < dois.length; i += 50) {
    const batch = dois.slice(i, i + 50);
    try {
      (await openalexBatch(batch)).forEach(save);
    } catch {
      // One unusual DOI can spoil a batch: look the papers up one at a time instead.
      for (const doi of batch) {
        try { (await openalexBatch([doi])).forEach(save); } catch { /* not found: stays unchecked */ }
      }
    }
    await sleep(200);
  }
  return records;
}

/* ── Merging the same paper from different searches ──────────── */

function mergeInto(papers, index, record, source) {
  const keys = [record.doi && `doi:${record.doi}`, record.pmid && `pmid:${record.pmid}`, titleKey(record.title) && `title:${titleKey(record.title)}`].filter(Boolean);
  let paper = keys.map(k => index.get(k)).find(Boolean);
  if (!paper) {
    paper = { id: `pub.${shortHash(keys[0] || record.title)}`, foundBy: {} };
    papers.push(paper);
  }
  for (const [field, value] of Object.entries(record)) {
    if (field === 'openAccess') paper.openAccess = paper.openAccess || value;
    else if (field === 'citations') { if (value !== null) paper.citations = Math.max(paper.citations ?? 0, value); }
    else if (field === 'scopusAffiliations') paper.scopusAffiliations = [...(paper.scopusAffiliations || []), ...value];
    else if (field === 'investigators') paper.investigators = [...new Set([...(paper.investigators || []), ...value])];
    else if (value && !paper[field]) paper[field] = value;
  }
  paper.foundBy[source] = true;
  [paper.doi && `doi:${paper.doi}`, paper.pmid && `pmid:${paper.pmid}`, ...keys].filter(Boolean).forEach(k => index.set(k, paper));
}

// Elsevier explains a refusal in one of two formats; show its own words rather than "status code 403".
function elsevierReason(error) {
  const body = error.response?.data;
  const status = error.response?.status;
  const said = body?.['service-error']?.status?.statusText
    || body?.['error-response']?.['error-message']
    || (typeof body?.error === 'string' ? body.error : null)
    || (typeof body === 'string' && body.trim() && !body.trim().startsWith('<') ? body.trim().slice(0, 150) : null);
  const code = body?.['service-error']?.status?.statusCode || body?.['error-response']?.['error-code'];
  const hint = status === 401 ? 'Key not recognised. ' : status === 403 ? 'Key refused by Elsevier. ' : status === 429 ? 'Weekly quota used up. ' : '';
  return `${hint}${said ? `${code ? `${code}: ` : ''}${said}` : error.message}`;
}

/* ── Building the list ───────────────────────────────────────── */

async function build(options = {}) {
  const roster = buildRoster(options);
  const withAddresses = (list, source) => (list || []).map(a => ({ ...a, source }));
  const apiKey = process.env.ELSEVIER_API_KEY;
  const sources = {};
  const papers = [];
  const index = new Map();
  const attempt = async (name, fn) => {
    try { return { ok: true, ...(await fn()) }; } catch (error) {
      const detail = elsevierReason(error);
      console.warn(`Publications: ${name} unavailable:`, String(detail).slice(0, 200));
      return { ok: false, error: String(detail).slice(0, 200) };
    }
  };
  const needKey = () => { if (!apiKey) throw new Error('ELSEVIER_API_KEY is not set in the backend settings'); };

  // Step 1: the three candidate searches, at the same time.
  const [scopus, pubmed, researchers] = await Promise.all([
    attempt('Scopus search', async () => {
      needKey();
      const { entries, total } = await scopusSearch(`${SCOPUS_INFANT} AND PUBYEAR > ${FIRST_YEAR - 1}`, apiKey);
      return { found: entries.length, total, entries };
    }),
    attempt('PubMed search', async () => {
      const { ids, total } = await pubmedSearch();
      return { found: ids.length, total, ids };
    }),
    attempt('Scopus researcher search', async () => {
      needKey();
      if (!roster.some(r => r.scopusIds.length)) throw new Error('no researcher IDs in impact-data.json');
      // One search per researcher, so every paper records whose it is (Scopus search results name
      // only the first author). A person with two Scopus profiles is searched under both.
      const entries = [];
      for (const inv of roster.filter(r => r.scopusIds.length)) {
        const authors = inv.scopusIds.map(id => `AU-ID(${id})`).join(' OR ');
        const result = await scopusSearch(`(${authors}) AND PUBYEAR > ${FIRST_YEAR - 1}`, apiKey);
        result.entries.forEach(entry => entries.push({ entry, investigator: inv.id }));
      }
      const found = new Set(entries.map(x => x.entry.eid)).size;
      return { found, total: found, entries, researchers: roster.length };
    }),
  ]);
  // Listed researchers without a Scopus ID yet: found by name in PubMed instead.
  const byName = roster.filter(r => r.pubmedAuthor);
  const named = byName.length ? await attempt('PubMed researcher search', async () => {
    const entries = [];
    for (const inv of byName) {
      (await pubmedAuthorSearch(inv.pubmedAuthor)).forEach(pmid => entries.push({ pmid, investigator: inv.id }));
      await sleep(400);
    }
    return { found: entries.length, entries, researchers: byName.length };
  }) : null;
  (scopus.entries || []).forEach(e => mergeInto(papers, index, fromScopus(e), 'scopus'));
  (researchers.entries || []).forEach(x => mergeInto(papers, index, { ...fromScopus(x.entry), investigators: [x.investigator] }, 'researcher'));
  (pubmed.ids || []).forEach(pmid => mergeInto(papers, index, { pmid }, 'pubmed'));
  (named?.entries || []).forEach(x => mergeInto(papers, index, { pmid: x.pmid, investigators: [x.investigator] }, 'researcher'));
  const strip = ({ entries, ids, ...rest }) => rest;
  sources.scopus = strip(scopus);
  sources.pubmed = strip(pubmed);
  sources.researchers = strip(researchers);
  if (named) sources.researchersPubmed = strip(named);

  // Step 2a: full PubMed records for every candidate that has a PubMed ID.
  const pmids = [...new Set(papers.map(p => p.pmid).filter(Boolean))];
  const pubmedFull = await attempt('PubMed records', async () => ({ records: await pubmedRecords(pmids) }));
  const records = pubmedFull.records || new Map();
  sources.pubmedRecords = { ok: pubmedFull.ok, found: records.size, error: pubmedFull.error };
  for (const p of papers) {
    const r = p.pmid && records.get(p.pmid);
    if (!r) continue;
    p.addresses = r.addresses;
    p.authorAddresses = withAddresses(r.authorAddresses, 'PubMed');
    p.onlineDate = r.onlineDate;
    p.issueDate = p.issueDate || r.issueDate;
    // PubMed's publication types are the most detailed, except that PubMed files conference
    // proceedings and books as journal articles; Scopus knows those, so trust it for them.
    p.type = SCOPUS_ONLY_KNOWS.includes(p.scopusType) ? p.scopusType : r.type;
    for (const field of ['title', 'journal', 'doi']) if (!p[field] && r[field]) p[field] = r[field];
    // Scopus search results only name the first author, so PubMed's full list replaces it.
    if (r.authorNames?.length) { p.authors = r.authors; p.authorNames = r.authorNames; }
    p.openAccess = p.openAccess || r.openAccess;
  }

  // Step 2b: the same paper can appear twice if one search had its DOI and the other only its PubMed ID.
  const seen = new Map();
  const unique = [];
  for (const p of papers) {
    const keys = [p.doi && `doi:${p.doi}`, p.pmid && `pmid:${p.pmid}`].filter(Boolean);
    const twin = keys.map(k => seen.get(k)).find(Boolean);
    if (twin) {
      Object.assign(twin.foundBy, p.foundBy);
      if (p.investigators) twin.investigators = [...new Set([...(twin.investigators || []), ...p.investigators])];
      for (const [field, value] of Object.entries(p)) if (value && !twin[field]) twin[field] = value;
      keys.forEach(k => seen.set(k, twin));
      continue;
    }
    keys.forEach(k => seen.set(k, p));
    unique.push(p);
  }

  // Step 2c: check each paper's addresses. Not in PubMed? The institutions Scopus lists, then Crossref.
  const verify = (p, addresses, source) => {
    const hit = infantEvidence(addresses);
    if (hit && !p.evidence) { p.evidence = hit; p.evidenceSource = source; }
  };
  for (const p of unique) {
    verify(p, p.addresses, 'PubMed');
    verify(p, p.scopusAffiliations, 'Scopus');
  }
  const toCrossref = unique.filter(p => !p.evidence && !p.addresses?.length && p.doi).map(p => p.doi);
  const crossref = await attempt('Crossref records', async () => ({ records: await crossrefRecords(toCrossref) }));
  const publisher = crossref.records || new Map();
  sources.crossref = { ok: crossref.ok, checked: toCrossref.length, found: publisher.size, error: crossref.error };
  for (const p of unique) {
    const r = p.doi && publisher.get(p.doi);
    if (!r) continue;
    p.onlineDate = p.onlineDate || r.onlineDate;
    p.issueDate = p.issueDate || r.issueDate;
    if (r.addresses.length && !p.addresses?.length) p.addresses = r.addresses;
    p.authorAddresses = [...(p.authorAddresses || []), ...withAddresses(r.authorAddresses, 'Crossref')];
    if (r.authorNames?.length && !p.authorNames?.length) { p.authorNames = r.authorNames; p.authors = shortAuthorList(r.authorNames); }
    verify(p, r.addresses, 'Crossref');
  }

  // Step 2d: OpenAlex, for papers with a DOI that the sources above couldn't verify (it often has
  // addresses PubMed leaves out, e.g. a second affiliation for the same author), and for papers
  // still without a full author list (e.g. found only by Scopus, which names just the first author).
  const toOpenalex = unique.filter(p => p.doi && (!p.evidence || !p.authorNames?.length)).map(p => p.doi);
  const openalex = await attempt('OpenAlex records', async () => ({ records: await openalexRecords(toOpenalex) }));
  const oaRecords = openalex.records || new Map();
  sources.openalex = { ok: openalex.ok, checked: toOpenalex.length, found: oaRecords.size, error: openalex.error };
  for (const p of unique) {
    const r = p.doi && oaRecords.get(p.doi);
    if (!r) continue;
    if (r.authorNames?.length && !p.authorNames?.length) { p.authorNames = r.authorNames; p.authors = shortAuthorList(r.authorNames); }
    p.authorAddresses = [...(p.authorAddresses || []), ...withAddresses(r.authorAddresses, 'OpenAlex')];
    if (!r.addresses?.length) continue;
    verify(p, r.addresses, 'OpenAlex');
    if (!p.addresses?.length) p.addresses = r.addresses;
  }

  // Step 2e: listed researchers. Learn the names of those listed by Scopus ID only, then verify a
  // researcher's paper when their own address on it names INFANT, UCC or CUMH.
  learnNames(roster, unique);
  for (const p of unique) {
    if (p.evidence || !p.investigators?.length) continue;
    const hit = investigatorEvidence(p, roster);
    if (hit) { p.evidence = hit.address; p.evidenceSource = hit.source; p.evidenceAuthor = hit.author; }
  }

  // Status, first publication date and year for every paper.
  for (const p of unique) {
    p.date = earliest([p.onlineDate, p.issueDate]);
    p.year = p.date ? Number(p.date.slice(0, 4)) : null;
    p.type = p.type || 'Article';
    if (p.evidence) p.status = COUNTED_TYPES.includes(p.type) ? 'verified' : 'other_output';
    else if (!p.addresses?.length && (p.foundBy.scopus || p.foundBy.pubmed)) p.status = 'needs_review'; // found by an INFANT search, but its addresses aren't available
    else if (p.investigators?.length) p.status = 'investigator'; // a listed researcher's paper, not verified automatically
    else p.status = 'not_infant'; // addresses checked and none names INFANT
    delete p.scopusAffiliations;
    delete p.scopusType;
    delete p.addresses;
    delete p.authorAddresses;
  }

  const listed = unique.filter(p => p.year && p.year >= FIRST_YEAR && !['Correction', 'Retraction'].includes(p.type));
  const byYear = {};
  for (const p of listed) {
    const y = (byYear[p.year] = byYear[p.year] || { verified: 0, otherOutputs: 0, needsReview: 0, investigator: 0, notInfant: 0 });
    if (p.status === 'verified') y.verified += 1;
    else if (p.status === 'other_output') y.otherOutputs += 1;
    else if (p.status === 'needs_review') y.needsReview += 1;
    else if (p.status === 'investigator') y.investigator += 1;
    else y.notInfant += 1;
  }
  const count = status => listed.filter(p => p.status === status).length;
  return {
    version: LIST_VERSION,
    updatedAt: new Date().toISOString(),
    firstYear: FIRST_YEAR,
    countedTypes: COUNTED_TYPES,
    totalVerified: count('verified'),
    otherOutputs: count('other_output'),
    needsReview: count('needs_review'),
    investigatorPapers: count('investigator'),
    // The roster, with the names learnt for researchers listed by Scopus ID only.
    investigators: roster.map(inv => ({ id: inv.id, name: inv.name || null, nameLearned: Boolean(inv.nameLearned), scopusIds: inv.scopusIds })),
    byYear,
    sources,
    papers: listed.sort((a, b) => b.date.localeCompare(a.date) || (a.title || '').localeCompare(b.title || '')),
  };
}

/* ── Cache and public functions ──────────────────────────────── */

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}
function writeCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data)); } catch (error) { console.warn('Publications: could not save the cache:', error.message); }
}

// Starts with the last saved list, if there is one, so pages don't wait after a restart.
let state = { data: readCache(), building: null, lastStarted: 0 };
const usable = data => Boolean(data.sources.scopus?.ok || data.sources.pubmed?.ok);

// Starts a rebuild if the list is missing, older than a day, or a refresh was asked for.
function refresh(options, { force = false } = {}) {
  const age = state.data ? Date.now() - Date.parse(state.data.updatedAt) : Infinity;
  const outdated = state.data && state.data.version !== LIST_VERSION;
  const canStart = Date.now() - state.lastStarted > MIN_MANUAL_REFRESH_MS;
  const due = age > REFRESH_MS || ((force || outdated) && canStart);
  if (!state.building && (due || !state.data)) {
    state.lastStarted = Date.now();
    state.building = build(options)
      .then(data => {
        // Keep the previous list if every database failed this time, or if Scopus failed now but
        // worked before: a PubMed-only list would quietly drop the papers only Scopus finds.
        // The same goes for the researcher search: without it, the listed researchers' papers vanish.
        const lostScopus = (state.data?.sources?.scopus?.ok && !data.sources.scopus?.ok)
          || (state.data?.version === LIST_VERSION && state.data?.sources?.researchers?.ok && !data.sources.researchers?.ok);
        if (lostScopus || (!usable(data) && state.data)) {
          state.data = { ...state.data, lastAttempt: { at: data.updatedAt, sources: data.sources } };
        } else {
          state.data = data;
          if (usable(data)) writeCache(data);
        }
        if (state.data.lastAttempt?.at === data.updatedAt) {
          console.warn(`Publications: update incomplete (${Object.entries(data.sources).filter(([, x]) => !x.ok).map(([k, x]) => `${k}: ${x.error}`).join('; ')}). Keeping the list from ${state.data.updatedAt}.`);
        } else {
          console.log(`Publications: ${data.totalVerified} verified INFANT publications since ${FIRST_YEAR} `
            + `(plus ${data.otherOutputs} other outputs, ${data.needsReview} needing review).`);
        }
        return state.data;
      })
      .catch(error => { console.error('Publications build failed:', error.stack || error.message); return state.data; })
      .finally(() => { state.building = null; });
  }
  return state.data ? Promise.resolve(state.data) : state.building;
}

/* ── Papers added or removed by hand ─────────────────────────── */

// { "doi:10.1002/x": { action: "include" | "exclude", at: "2026-11-13T10:00:00.000Z" } }
// Keyed by DOI or PubMed ID (not the list's own id), so a decision still applies after a rebuild.
let overrides = (() => { try { return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')); } catch { return {}; } })();
const overrideKey = p => (p.doi ? `doi:${p.doi}` : p.pmid ? `pmid:${p.pmid}` : p.id);

function setOverride(key, action) {
  if (!['include', 'exclude', null].includes(action)) throw new Error('action must be "include", "exclude" or null');
  const next = { ...overrides };
  if (action) next[key] = { action, at: new Date().toISOString() }; else delete next[key];
  fs.writeFileSync(`${OVERRIDES_FILE}.tmp`, JSON.stringify(next, null, 1));
  fs.renameSync(`${OVERRIDES_FILE}.tmp`, OVERRIDES_FILE);
  overrides = next;
  viewed = null;
}

// The list as the pages and reports see it: every paper says whether it is counted and why.
//   collection: 'automatic' (verified), 'added' (by hand), 'removed' (verified, taken out by hand) or null.
let viewed = null;
function view(data) {
  if (!data) return data;
  if (viewed?.from === data) return viewed.result;
  const byYear = Object.fromEntries(Object.entries(data.byYear || {}).map(([year, v]) => [year, { ...v, counted: 0, added: 0 }]));
  const papers = data.papers.map(p => {
    const key = overrideKey(p);
    const action = overrides[key]?.action;
    const automatic = p.status === 'verified';
    const counted = action === 'include' ? true : action === 'exclude' ? false : automatic;
    const collection = counted ? (automatic ? 'automatic' : 'added') : (automatic ? 'removed' : null);
    if (counted && byYear[p.year]) { byYear[p.year].counted += 1; if (!automatic) byYear[p.year].added += 1; }
    return { ...p, key, counted, collection };
  });
  const result = {
    ...data, papers, byYear,
    totalCounted: papers.filter(p => p.counted).length,
    manuallyAdded: papers.filter(p => p.collection === 'added').length,
    manuallyRemoved: papers.filter(p => p.collection === 'removed').length,
  };
  viewed = { from: data, result };
  return result;
}

// The latest list, waiting for the first build if there isn't one yet.
async function getPublications(options) {
  const pending = refresh(options);
  return view(state.data || await pending);
}

const isBuilding = () => Boolean(state.building);
const latest = () => view(state.data);

// Verified papers in the shape the executive reports use.
async function getPublicationItems(options) {
  const data = await getPublications(options);
  if (!data) throw new Error('The publication list is not available.');
  return data.papers
    .filter(p => p.counted && p.date)
    .map(p => ({ id: p.id, date: p.date, title: p.title, journal: p.journal, open_access: Boolean(p.openAccess) }));
}

module.exports = {
  getPublications, getPublicationItems, refresh, isBuilding, latest, build, setOverride, view,
  buildRoster, learnNames, isAuthor, investigatorEvidence, investigatorAddress,
  namesInfant, parsePubmedArticle, cleanDoi, titleKey, FIRST_YEAR, COUNTED_TYPES,
};
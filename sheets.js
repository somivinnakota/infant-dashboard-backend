// Shared storage for the uploaded sheets: KPI tracker, Press and media, Calendar of events,
// Conference list. Connected in server.js.
//
// A new upload is MERGED into what is saved, rather than replacing it:
//   - rows that aren't saved yet are added
//   - a cell with a different value replaces the saved one (that's how errors get fixed)
//   - a blank cell keeps the saved value, so a file with gaps can't wipe out data
//   - saved rows missing from the new file are kept, so a file with only recent rows deletes nothing
//   - new columns are added
// "Replace everything" (mode: 'replace') is there for starting again from one file.
//
// Rows are matched by a key: the KPI number for the KPI tracker, outlet + headline for press,
// and for the other sheets the name, title and date columns it can find (see keyFor).
// Every upload is previewed first, and the last 10 versions are kept so an upload can be undone.
//
//   GET    /api/sheets/:page            the saved sheet and its history
//   POST   /api/sheets/:page/preview    what an upload would change   { upload, mode }
//   POST   /api/sheets/:page            merge (or replace) and save   { upload, mode }
//   POST   /api/sheets/:page/undo       go back to the version before the last change
//   DELETE /api/sheets/:page            clear the sheet (can be undone)

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./data-dir');

const SHEETS_DIR = path.join(DATA_DIR || __dirname, 'sheets');
const MAX_VERSIONS = 10;
const MAX_ROWS = 20000;

// The pages, by the name the website uses for them, and how each one's rows are matched.
const PAGES = {
  'kpi-tracker': 'kpis',
  'press-and-media': 'press',
  'calendar-of-events': 'events',
  'conference-list': 'conferences',
};

/* ── Comparing cells and rows ──────────────────────────────────── */

const isBlank = v => v === null || v === undefined || String(v).trim() === '';
// For matching: lower case, single spaces, no accents. "RTÉ" and "rte" are the same outlet.
const plain = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
// Values that differ only in capitals, spacing or accents aren't listed as corrections
// (the new spelling is still saved).
const same = (a, b) => plain(a) === plain(b);

const KPI_ID = /^\d+(\.\d+)*$/;

function filledValues(sheet, header) {
  return sheet.rows.map(r => r[header]).filter(v => !isBlank(v));
}

// Which columns identify a row in this sheet. Returns { columns, label } or null if none fit.
function keyFor(page, sheet) {
  // The first header matching any of the patterns, trying them in order of preference.
  const find = (...patterns) => patterns.map(p => sheet.headers.find(h => p.test(h))).find(Boolean);

  if (page === 'kpis') {
    // The KPI number column: 1, 1.1, 1.2 … (the same rule the KPI tracker page uses).
    const id = sheet.headers.find(h => {
      const values = filledValues(sheet, h).map(v => String(v).trim());
      return values.length >= 3 && values.filter(v => KPI_ID.test(v)).length / values.length >= 0.8;
    });
    if (id) return { columns: [id], label: `the KPI number (${id})` };
  }

  if (page === 'press') {
    const outlet = find(/outlet/i, /publication|newspaper/i, /media|source/i);
    const headline = find(/headline/i, /title/i, /story|article/i);
    if (outlet && headline) return { columns: [outlet, headline], label: `${outlet} + ${headline}` };
  }

  // Any sheet: a name or title column, plus a date column when there is one
  // (the same event can run on several dates).
  const name = find(/event|conference/i, /title|headline/i, /name|presenter|speaker|outlet/i);
  const date = find(/date/i, /\bwhen\b|\bday\b/i);
  const columns = [name, date].filter(Boolean);
  if (columns.length) return { columns, label: columns.join(' + ') };
  return null;
}

// Gives every row its key. With no key columns, the whole row is the key: rows are then only
// ever added, never corrected. Rows above the first keyed row (e.g. "2026" / "Target" header lines
// in the KPI tracker) get no key: they are part of the file's layout, and the new file's win.
// A row further down with an empty key falls back to the whole row, so it is never lost.
function keyRows(sheet, key) {
  const seen = {};
  let dataStarted = false;
  const wholeRow = row => sheet.headers.map(h => plain(row[h]));
  return sheet.rows.map(row => {
    let parts = key ? key.columns.map(c => plain(row[c])) : wholeRow(row);
    if (parts.every(p => p === '')) {
      if (!dataStarted) return null;
      parts = ['row', ...wholeRow(row)];
    }
    dataStarted = true;
    const base = parts.join(' | ');
    seen[base] = (seen[base] || 0) + 1;
    return `${base} #${seen[base]}`; // the 2nd row with the same key matches the 2nd saved one
  });
}

// What a person calls this row in the preview, e.g. "1.2 Number of publications".
function rowName(row, sheet, key) {
  const useful = (key ? key.columns : sheet.headers).map(c => row[c]).filter(v => !isBlank(v));
  return useful.slice(0, 2).join(' · ').slice(0, 90) || 'A row';
}

/* ── Merging one sheet ─────────────────────────────────────────── */

// Returns the merged sheet and what changed. The new file decides the order and layout;
// saved rows it leaves out are kept, placed after the row they followed before.
function mergeSheet(page, saved, incoming) {
  const key = keyFor(page, incoming) || keyFor(page, saved);
  const savedKeys = keyRows(saved, key);
  const incomingKeys = keyRows(incoming, key);
  const savedByKey = new Map(savedKeys.map((k, i) => [k, i]).filter(([k]) => k));

  const headers = [...incoming.headers, ...saved.headers.filter(h => !incoming.headers.includes(h))];
  const newColumns = incoming.headers.filter(h => saved.headers.length && !saved.headers.includes(h));
  const changes = { added: [], corrected: [], kept: 0, unchanged: 0, newColumns, matchedBy: key ? key.label : 'every column' };

  // Start from the new file: fill its blanks from the saved row, note the corrections.
  const merged = incoming.rows.map((row, i) => {
    const k = incomingKeys[i];
    const old = k && savedByKey.has(k) ? saved.rows[savedByKey.get(k)] : null;
    if (!k) return { ...row };
    if (!old) { changes.added.push(rowName(row, incoming, key)); return { ...row }; }
    const out = {};
    let corrected = false;
    for (const h of headers) {
      const now = row[h];
      const before = old[h];
      if (isBlank(now)) out[h] = before ?? now ?? '';
      else {
        out[h] = now;
        if (!isBlank(before) && !same(now, before)) {
          corrected = true;
          changes.corrected.push({ row: rowName(old, saved, key), column: h, from: String(before), to: String(now) });
        }
      }
    }
    if (!corrected) changes.unchanged += 1;
    return out;
  });

  // Saved rows the new file doesn't have: keep them, right after the row they used to follow.
  const position = new Map(incomingKeys.map((k, i) => [k, i]).filter(([k]) => k));
  const insertAfter = new Map(); // index in `merged` (-1 = before the first keyed row) → rows to insert
  let previous = null;
  savedKeys.forEach((k, i) => {
    if (!k) return;
    if (position.has(k)) { previous = position.get(k); return; }
    const at = previous ?? -1;
    if (!insertAfter.has(at)) insertAfter.set(at, []);
    insertAfter.get(at).push(saved.rows[i]);
    changes.kept += 1;
  });

  // Rebuild the rows and the layout (section headings and notes) in order.
  const firstKeyed = incomingKeys.findIndex(Boolean);
  const layoutIn = incoming.layout || incoming.rows.map((_, index) => ({ type: 'row', index }));
  const rows = [];
  const layout = [];
  const pushRow = row => { layout.push({ type: 'row', index: rows.length }); rows.push(Object.fromEntries(headers.map(h => [h, row[h] ?? '']))); };
  for (const item of layoutIn) {
    if (item.type !== 'row') { layout.push(item); continue; }
    if (item.index === firstKeyed) (insertAfter.get(-1) || []).forEach(pushRow);
    pushRow(merged[item.index]);
    (insertAfter.get(item.index) || []).forEach(pushRow);
  }
  if (firstKeyed === -1) (insertAfter.get(-1) || []).forEach(pushRow); // the new file had no data rows

  return { sheet: { name: incoming.name, headers, rows, layout }, changes };
}

/* ── Merging a whole workbook ──────────────────────────────────── */

// Sheets are matched by name. Sheets only in the saved workbook are kept.
function mergeWorkbook(page, saved, upload, mode = 'merge') {
  const summary = { sheets: [], added: 0, corrected: 0, kept: 0, unchanged: 0, replaced: mode === 'replace' };
  if (!saved || mode === 'replace') {
    const rows = upload.sheets.reduce((n, s) => n + s.rows.length, 0);
    summary.added = rows;
    summary.sheets = upload.sheets.map(s => ({ name: s.name, rows: s.rows.length, matchedBy: keyFor(page, s)?.label || 'every column' }));
    return { workbook: { fileName: upload.fileName, sheets: upload.sheets }, summary, previousRows: saved ? saved.sheets.reduce((n, s) => n + s.rows.length, 0) : 0 };
  }

  const byName = new Map(saved.sheets.map(s => [plain(s.name), s]));
  const sheets = upload.sheets.map(incoming => {
    const old = byName.get(plain(incoming.name));
    byName.delete(plain(incoming.name));
    if (!old) {
      summary.added += incoming.rows.length;
      summary.sheets.push({ name: incoming.name, newSheet: true, rows: incoming.rows.length });
      return incoming;
    }
    const { sheet, changes } = mergeSheet(page, old, incoming);
    summary.added += changes.added.length;
    summary.corrected += changes.corrected.length;
    summary.kept += changes.kept;
    summary.unchanged += changes.unchanged;
    summary.sheets.push({ name: incoming.name, ...changes, added: changes.added.slice(0, 50), addedCount: changes.added.length, corrected: changes.corrected.slice(0, 200), correctedCount: changes.corrected.length });
    return sheet;
  });
  sheets.push(...byName.values()); // sheets the new file doesn't have
  return { workbook: { fileName: upload.fileName, sheets }, summary };
}

/* ── Saving ────────────────────────────────────────────────────── */

const fileFor = page => path.join(SHEETS_DIR, `${page}.json`);

function readPage(page) {
  try { return JSON.parse(fs.readFileSync(fileFor(page), 'utf8')); } catch { return { current: null, versions: [] }; }
}

// Written to a temporary file first, so a crash mid-save can't corrupt the saved sheet.
function writePage(page, data) {
  fs.mkdirSync(SHEETS_DIR, { recursive: true });
  const temp = `${fileFor(page)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data));
  fs.renameSync(temp, fileFor(page));
}

// The current sheet becomes the newest saved version, so it can be brought back.
function saveVersion(data, next) {
  const versions = data.current ? [data.current, ...data.versions].slice(0, MAX_VERSIONS) : data.versions;
  return { current: next, versions };
}

function describe(data) {
  const entry = v => (v ? { at: v.savedAt, fileName: v.workbook?.fileName || null, change: v.change } : null);
  return {
    workbook: data.current?.workbook || null,
    history: [data.current, ...data.versions].filter(Boolean).map(entry),
    canUndo: Boolean(data.current),
  };
}

// Checks an upload from the website: { fileName, sheets: [{ name, headers, rows, layout }] }.
function validUpload(upload) {
  if (!upload || typeof upload.fileName !== 'string' || !Array.isArray(upload.sheets) || !upload.sheets.length) return null;
  let total = 0;
  for (const s of upload.sheets) {
    if (typeof s?.name !== 'string' || !Array.isArray(s.headers) || !Array.isArray(s.rows)) return null;
    total += s.rows.length;
  }
  if (total > MAX_ROWS) return null;
  return {
    fileName: upload.fileName.slice(0, 200),
    sheets: upload.sheets.map(s => ({ name: s.name, headers: s.headers.map(String), rows: s.rows, ...(Array.isArray(s.layout) && { layout: s.layout }) })),
  };
}

function changeText(summary, mode) {
  if (mode === 'replace') return `Replaced with ${summary.added} rows`;
  if (mode === 'clear') return 'Cleared';
  if (mode === 'move') return 'Moved from a browser';
  return `${summary.added} added, ${summary.corrected} corrected`;
}

/* ── Routes ────────────────────────────────────────────────────── */

module.exports = function sheetRoutes(app) {
  const pageFrom = (req, res) => {
    const page = PAGES[req.params.page];
    if (!page) res.status(404).json({ error: 'There is no sheet with that name.' });
    return page;
  };
  const uploadFrom = (req, res) => {
    const upload = validUpload(req.body?.upload);
    if (!upload) res.status(400).json({ error: `The file could not be read as a sheet, or it has more than ${MAX_ROWS.toLocaleString('en-IE')} rows.` });
    return upload;
  };
  const failed = (res, error, what) => {
    console.error(`Sheets: ${what} failed:`, error.message);
    res.status(500).json({ error: `The sheet could not be ${what}. Check the server log for details.` });
  };

  app.get('/api/sheets/:page', (req, res) => {
    if (!pageFrom(req, res)) return;
    res.json(describe(readPage(req.params.page)));
  });

  app.post('/api/sheets/:page/preview', (req, res) => {
    const page = pageFrom(req, res);
    const upload = page && uploadFrom(req, res);
    if (!upload) return;
    const current = readPage(req.params.page).current?.workbook || null;
    const { summary, previousRows } = mergeWorkbook(page, current, upload, req.body.mode);
    res.json({ summary, previousRows: previousRows ?? null, hasSaved: Boolean(current) });
  });

  app.post('/api/sheets/:page', (req, res) => {
    const page = pageFrom(req, res);
    const upload = page && uploadFrom(req, res);
    if (!upload) return;
    try {
      const data = readPage(req.params.page);
      const mode = req.body.mode === 'replace' ? 'replace' : req.body.mode === 'move' ? 'move' : 'merge';
      const { workbook, summary } = mergeWorkbook(page, data.current?.workbook || null, upload, mode === 'replace' ? 'replace' : 'merge');
      const next = { workbook, savedAt: new Date().toISOString(), change: changeText(summary, mode) };
      const saved = saveVersion(data, next);
      writePage(req.params.page, saved);
      res.json(describe(saved));
    } catch (error) { failed(res, error, 'saved'); }
  });

  app.post('/api/sheets/:page/undo', (req, res) => {
    if (!pageFrom(req, res)) return;
    try {
      const data = readPage(req.params.page);
      if (!data.current) return res.status(400).json({ error: 'There is nothing to undo.' });
      const [previous = null, ...rest] = data.versions;
      const restored = { current: previous, versions: rest };
      writePage(req.params.page, restored);
      res.json(describe(restored));
    } catch (error) { failed(res, error, 'restored'); }
  });

  app.delete('/api/sheets/:page', (req, res) => {
    if (!pageFrom(req, res)) return;
    try {
      const data = readPage(req.params.page);
      if (!data.current?.workbook) return res.json(describe(data));
      // Clearing is saved as an empty version, so Undo brings the sheet back.
      const cleared = saveVersion(data, { workbook: null, savedAt: new Date().toISOString(), change: 'Cleared' });
      writePage(req.params.page, cleared);
      res.json(describe(cleared));
    } catch (error) { failed(res, error, 'cleared'); }
  });
};

// Exported for tests.
module.exports.mergeWorkbook = mergeWorkbook;
module.exports.keyFor = keyFor;
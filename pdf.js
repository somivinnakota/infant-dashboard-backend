// Turns the report shown on screen into a PDF, so the PDF always matches what the user sees.
// Connected in server.js.
//   POST /api/pdf    { title, subtitle, report, glossaryIds }

const PDFDocument = require('pdfkit');
const glossary = require('./glossary');
const { clip } = require('./format');

// Standard PDF fonts can't draw emoji or most symbols, so swap or remove them.
function pdfSafe(text) {
  return text
    .replace(/→/g, '->').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/−/g, '-')
    .replace(/▲/g, 'up ').replace(/▼/g, 'down ')
    .replace(/[^\t\n\r\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC]/g, '');
}

function stripMarkdown(text) {
  return text
    .replace(/^\s*[*+]\s+/gm, '- ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*|__|`/g, '');
}

const isHeading = line => line.length <= 90 && /[A-Z]/.test(line) && line === line.toUpperCase();

module.exports = function pdfRoutes(app) {
  app.post('/api/pdf', (req, res) => {
    const title = pdfSafe(clip(String(req.body?.title || 'Report'), 120));
    const subtitle = pdfSafe(clip(String(req.body?.subtitle || ''), 200));
    const report = pdfSafe(stripMarkdown(clip(String(req.body?.report || ''), 30000)));
    if (!report.trim()) return res.status(400).json({ error: 'No report text was sent.' });

    const fileName = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'Report'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);
    const width = doc.page.width - 100;
    const generated = new Date().toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });

    doc.rect(0, 0, doc.page.width, 80).fill('#53266a'); // INFANT purple
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('INFANT Research Centre', 50, 22);
    doc.font('Helvetica').fontSize(10).fillColor('#e4d6ec').text(title, 50, 46, { width });
    doc.fontSize(9).text(`Generated ${generated}${subtitle ? ` · ${subtitle}` : ''}`, 50, 62, { width });
    doc.y = 105;

    for (const raw of report.split('\n')) {
      const line = raw.trim();
      if (!line) { doc.moveDown(0.4); continue; }
      if (isHeading(line)) {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#53266a').text(line, 50, doc.y, { width });
        doc.moveDown(0.2);
      } else if (/^[-•]\s+/.test(line)) {
        doc.font('Helvetica').fontSize(9.5).fillColor('#374151')
          .text(`•  ${line.replace(/^[-•]\s+/, '')}`, 62, doc.y, { width: width - 12, lineGap: 2 });
      } else {
        doc.font('Helvetica').fontSize(9.5).fillColor('#374151').text(line, 50, doc.y, { width, lineGap: 2 });
      }
    }

    // Appendix: definitions of the metrics used in this report, taken from the central glossary.
    const ids = Array.isArray(req.body?.glossaryIds) ? req.body.glossaryIds.map(String).slice(0, 60) : [];
    const appendix = glossary.entriesFor(ids);
    if (appendix.length) {
      const source = glossary.loadGlossary();
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#53266a').text('APPENDIX: GLOSSARY OF METRICS USED IN THIS REPORT', 50, 50, { width });
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(8.5).fillColor('#6b7280')
        .text(pdfSafe(`Definitions from the ${source?.title || 'INFANT Engagement Metrics Glossary'}${source?.schema_version ? `, version ${source.schema_version}` : ''}.`), 50, doc.y, { width });
      doc.moveDown(0.6);
      for (const m of appendix) {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#374151').text(pdfSafe(m.term), 50, doc.y, { width, continued: true })
          .font('Helvetica').fillColor('#9ca3af').text(pdfSafe(`  ·  ${m.category}`));
        doc.font('Helvetica').fontSize(9.5).fillColor('#374151').text(pdfSafe(m.definition), 50, doc.y, { width, lineGap: 2 });
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#4b5563').text(pdfSafe(`Why it matters: ${m.why_it_matters}`), 50, doc.y, { width, lineGap: 2 });
        doc.moveDown(0.6);
      }
    }

    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(8).fillColor('#9ca3af')
      .text('INFANT Research Centre · University College Cork · infantcentre.ie', 50, doc.y, { width, align: 'center' });
    doc.end();
  });
};
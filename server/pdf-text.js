// Plain-text extraction from a text-based PDF, reconstructing reading
// order: items grouped into lines by y (half-point tolerance), lines top
// to bottom, items within a line left to right. This is exactly how the
// chart paste fixture was produced, so a downloaded chart PDF and a pasted
// chart feed the SAME parser with the SAME text shape.
//
// Node-only (pdfjs-dist legacy build). Not used by the program parser,
// which needs raw coordinates (two-page spreads, column panels) rather
// than flattened lines.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Extract a PDF (path or Uint8Array) to line-reconstructed text. */
export async function extractPdfLines(source) {
  const doc = await getDocument({
    ...(typeof source === 'string' ? { url: source } : { data: source }),
    useSystemFonts: true,
  }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const items = tc.items
      .filter((i) => i.str.trim())
      .map((i) => ({ s: i.str, x: i.transform[4], y: Math.round(i.transform[5] * 2) / 2 }));
    const lines = new Map();
    for (const it of items) {
      if (!lines.has(it.y)) lines.set(it.y, []);
      lines.get(it.y).push(it);
    }
    pages.push([...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, arr]) => arr.sort((a, b) => a.x - b.x).map((i) => i.s).join(' '))
      .join('\n'));
  }
  return pages.join('\n');
}

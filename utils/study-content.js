const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

const MAX_PDF_PAGES = 24;
const MAX_PPTX_SLIDES = 30;
const MAX_PPTX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_PPTX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_LENGTH = 24000;

function cleanText(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function cleanPageText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\S\r\n]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT_LENGTH);
}

async function extractPdf(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const loadingTask = pdfjs.getDocument({ data, disableWorker: true, verbosity: 0 });
  const document = await loadingTask.promise;
  const pages = [];
  try {
    const pageLimit = Math.min(document.numPages, MAX_PDF_PAGES);
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = [];
      let currentLine = [];
      let previousY;
      for (const item of content.items) {
        if (typeof item.str !== 'string' || !item.str.trim()) continue;
        const y = item.transform?.[5];
        if (Number.isFinite(y) && Number.isFinite(previousY) && Math.abs(y - previousY) > 2) {
          if (currentLine.length) lines.push(currentLine.join(' '));
          currentLine = [];
        }
        currentLine.push(item.str);
        if (Number.isFinite(y)) previousY = y;
      }
      if (currentLine.length) lines.push(currentLine.join(' '));
      const text = cleanPageText(lines.join('\n'));
      if (text) pages.push({ page: pageNumber, text });
      page.cleanup();
      if (pages.reduce((total, current) => total + current.text.length, 0) >= MAX_TEXT_LENGTH) break;
    }
    return {
      text: cleanText(pages.map((page) => page.text).join(' ')),
      pages,
      truncated: document.numPages > pageLimit,
    };
  } finally {
    await loadingTask.destroy();
  }
}

function decodeXmlText(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code.toLowerCase()];
  });
}

function textFromSlideXml(xml) {
  const paragraphs = [];
  const paragraphPattern = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi;
  let paragraph;
  while ((paragraph = paragraphPattern.exec(xml))) {
    const strings = [];
    const textPattern = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi;
    let text;
    while ((text = textPattern.exec(paragraph[1]))) {
      strings.push(decodeXmlText(text[1].replace(/<[^>]*>/g, '')));
    }
    if (strings.length) paragraphs.push(strings.join(''));
  }
  return cleanText(paragraphs.join('. '));
}

function extractPptx(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, decodeStrings: true }, (openError, zip) => {
      if (openError) return reject(openError);

      const slides = [];
      let totalBytes = 0;
      let slideCount = 0;
      let truncated = false;
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        zip.close();
        if (error) reject(error);
        else resolve(result);
      };

      zip.on('error', (error) => finish(error));
      zip.on('end', () => {
        slides.sort((left, right) => left.page - right.page);
        finish(null, {
          text: cleanText(slides.map((slide) => slide.text).join(' ')),
          pages: slides,
          truncated: truncated || slideCount > MAX_PPTX_SLIDES,
        });
      });
      zip.on('entry', (entry) => {
        const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(entry.fileName);
        if (!match) {
          zip.readEntry();
          return;
        }
        if (slideCount >= MAX_PPTX_SLIDES || entry.uncompressedSize > MAX_PPTX_ENTRY_BYTES ||
            totalBytes + entry.uncompressedSize > MAX_PPTX_TOTAL_BYTES) {
          truncated = true;
          slideCount += 1;
          zip.readEntry();
          return;
        }

        slideCount += 1;
        totalBytes += entry.uncompressedSize;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return finish(streamError);
          const chunks = [];
          let bytes = 0;
          stream.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_PPTX_ENTRY_BYTES || totalBytes > MAX_PPTX_TOTAL_BYTES) {
              stream.destroy(new Error('PowerPoint slide text exceeds the extraction limit.'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', (error) => finish(error));
          stream.on('end', () => {
            const text = textFromSlideXml(Buffer.concat(chunks).toString('utf8'));
            if (text) slides.push({ page: Number(match[1]), text });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function extractStudyContent(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.pdf') return extractPdf(filePath);
  if (extension === '.pptx') return extractPptx(filePath);
  return { text: '', pages: [], unsupported: true, truncated: false };
}

module.exports = { extractStudyContent };

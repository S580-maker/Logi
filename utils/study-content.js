const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

const MAX_PDF_PAGES = 24;
const MAX_PPTX_SLIDES = 30;
const MAX_PPTX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_PPTX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_DOCX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_DOCX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 20000;
const MAX_DOCX_SECTIONS = 24;
const MAX_TEXT_LENGTH = 24000;
const MAX_TEXT_SECTIONS = 24;

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

function textFromDocumentXml(xml) {
  const paragraphs = [];
  const paragraphPattern = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gi;
  let paragraph;
  while ((paragraph = paragraphPattern.exec(xml))) {
    const runs = [];
    const textPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi;
    let text;
    while ((text = textPattern.exec(paragraph[1]))) {
      runs.push(decodeXmlText(text[1].replace(/<[^>]*>/g, '')));
    }
    if (runs.length) paragraphs.push(runs.join(''));
  }
  return paragraphs;
}

function extractDocx(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, decodeStrings: true }, (openError, zip) => {
      if (openError) return reject(openError);

      let documentXml = '';
      let totalBytes = 0;
      let entryCount = 0;
      let documentFound = false;
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
        if (!documentFound) {
          return finish(new Error('The Word document is missing its main document content.'));
        }
        const paragraphs = textFromDocumentXml(documentXml);
        const pages = [];
        let pageText = [];
        let pageLength = 0;
        let extractedLength = 0;
        let pageNumber = 1;
        for (const paragraph of paragraphs) {
          const chunks = paragraph.match(/[\s\S]{1,1800}/g) || [];
          for (const chunk of chunks) {
            if (extractedLength + chunk.length > MAX_TEXT_LENGTH) {
              const remaining = MAX_TEXT_LENGTH - extractedLength;
              if (remaining > 0) {
                pageText.push(chunk.slice(0, remaining));
                pageLength += remaining;
                extractedLength += remaining;
              }
              break;
            }
            if (pageLength && pageLength + chunk.length > 1800) {
              pages.push({ page: pageNumber, text: cleanPageText(pageText.join('\n')) });
              pageNumber += 1;
              pageText = [];
              pageLength = 0;
            }
            pageText.push(chunk);
            pageLength += chunk.length;
            extractedLength += chunk.length;
            if (pages.length >= MAX_DOCX_SECTIONS || extractedLength >= MAX_TEXT_LENGTH) break;
          }
          if (pages.length >= MAX_DOCX_SECTIONS || extractedLength >= MAX_TEXT_LENGTH) break;
        }
        if (pageText.length && pages.length < MAX_DOCX_SECTIONS) {
          pages.push({ page: pageNumber, text: cleanPageText(pageText.join('\n')) });
        }
        const boundedPages = pages.filter((page) => page.text);
        finish(null, {
          text: cleanText(boundedPages.map((page) => page.text).join(' ')),
          pages: boundedPages,
          truncated: entryCount >= MAX_DOCX_ENTRIES ||
            totalBytes >= MAX_DOCX_TOTAL_BYTES ||
            extractedLength >= MAX_TEXT_LENGTH ||
            pages.length >= MAX_DOCX_SECTIONS,
        });
      });
      zip.on('entry', (entry) => {
        entryCount += 1;
        if (entryCount > MAX_DOCX_ENTRIES) {
          return finish(new Error('The Word document contains too many archive entries.'));
        }
        if (entry.fileName !== 'word/document.xml') {
          zip.readEntry();
          return;
        }
        documentFound = true;
        if (entry.uncompressedSize > MAX_DOCX_ENTRY_BYTES ||
            totalBytes + entry.uncompressedSize > MAX_DOCX_TOTAL_BYTES) {
          return finish(new Error('The Word document is too large to extract safely.'));
        }
        totalBytes += entry.uncompressedSize;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return finish(streamError);
          const chunks = [];
          let bytes = 0;
          stream.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_DOCX_ENTRY_BYTES) {
              stream.destroy(new Error('The Word document content exceeds the extraction limit.'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', (error) => finish(error));
          stream.on('end', () => {
            documentXml = Buffer.concat(chunks).toString('utf8');
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
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

async function extractTextFile(filePath) {
  const text = await fs.promises.readFile(filePath, 'utf8');
  if (text.includes('\u0000')) throw new Error('Text files cannot contain binary data.');
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const sections = [];
  let offset = 0;
  while (offset < normalized.length && sections.length < MAX_TEXT_SECTIONS) {
    const end = Math.min(offset + 1200, normalized.length);
    const boundary = normalized.lastIndexOf('\n', end);
    const nextOffset = boundary > offset + 300 ? boundary + 1 : end;
    const section = normalized.slice(offset, nextOffset).trim();
    if (section) sections.push({ page: sections.length + 1, text: section });
    offset = nextOffset;
  }
  const pages = sections.map((section) => ({
    ...section,
    text: section.text.slice(0, MAX_TEXT_LENGTH),
  }));
  return {
    text: cleanText(pages.map((section) => section.text).join(' ')),
    pages,
    truncated: offset < normalized.length,
  };
}

async function extractStudyContent(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.pdf') return extractPdf(filePath);
  if (extension === '.pptx') return extractPptx(filePath);
  if (extension === '.docx') return extractDocx(filePath);
  if (extension === '.txt') return extractTextFile(filePath);
  return { text: '', pages: [], unsupported: true, truncated: false };
}

module.exports = { extractStudyContent };

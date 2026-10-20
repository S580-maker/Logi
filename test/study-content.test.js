const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { extractStudyContent } = require('../utils/study-content');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(fileName, contents) {
  const name = Buffer.from(fileName);
  const data = Buffer.from(contents);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localEntry = Buffer.concat([local, name, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralEntry = Buffer.concat([central, name]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralEntry.length, 12);
  end.writeUInt32LE(localEntry.length, 16);
  return Buffer.concat([localEntry, centralEntry, end]);
}

test('Word document extraction creates bounded, citeable text sections', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'logiauth-docx-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const documentPath = path.join(directory, 'lecture.docx');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body><w:p><w:r><w:t>Learning &amp; memory</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Retrieval practice strengthens durable recall.</w:t></w:r></w:p>',
    '</w:body></w:document>',
  ].join('');
  await fs.writeFile(documentPath, makeStoredZip('word/document.xml', xml));

  const result = await extractStudyContent(documentPath);
  assert.match(result.text, /Learning & memory/);
  assert.match(result.text, /Retrieval practice strengthens durable recall/);
  assert.equal(result.pages[0].page, 1);
  assert.equal(result.truncated, false);
});

test('Word document extraction rejects ZIP files without Word document content', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'logiauth-invalid-docx-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const documentPath = path.join(directory, 'not-a-word-document.docx');
  await fs.writeFile(documentPath, makeStoredZip('notes.txt', 'not a Word document'));
  await assert.rejects(
    extractStudyContent(documentPath),
    /missing its main document content/
  );
});

test('plain-text transcript extraction creates bounded, citeable sections', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'logiauth-text-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const textPath = path.join(directory, 'transcript.txt');
  await fs.writeFile(textPath, 'Opening idea\n\nThe second section explains a useful example.');

  const result = await extractStudyContent(textPath);
  assert.match(result.text, /Opening idea/);
  assert.match(result.text, /useful example/);
  assert.equal(result.pages[0].page, 1);
  assert.equal(result.truncated, false);
});

test('plain-text extraction rejects binary data and reports bounded truncation', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'logiauth-bounded-text-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binaryPath = path.join(directory, 'binary.txt');
  const longTextPath = path.join(directory, 'long.txt');
  await fs.writeFile(binaryPath, Buffer.from([0x61, 0, 0x62]));
  await fs.writeFile(longTextPath, 'lecture content '.repeat(4000));

  await assert.rejects(extractStudyContent(binaryPath), /binary data/);
  const result = await extractStudyContent(longTextPath);
  assert.equal(result.text.length, 24000);
  assert.equal(result.truncated, true);
  assert.ok(result.pages.length <= 24);
});

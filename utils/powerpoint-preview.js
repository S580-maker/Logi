const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const previewDir = path.join(__dirname, '..', 'storage', 'previews');
const converterScript = path.join(__dirname, 'convert-powerpoint.ps1');
const conversionPromises = new Map();

fs.mkdirSync(previewDir, { recursive: true });

function getPreviewPath(storageName) {
  const safeName = path.basename(storageName, path.extname(storageName));
  if (!/^[\w-]+$/.test(safeName)) throw new Error('Invalid stored presentation name.');
  return path.join(previewDir, `${safeName}.pdf`);
}

async function convertPowerPoint(storageName) {
  const outputPath = getPreviewPath(storageName);
  const existing = await fs.promises.stat(outputPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isFile() && existing.size > 0) return outputPath;

  const inFlight = conversionPromises.get(outputPath);
  if (inFlight) return inFlight;

  const inputPath = path.join(__dirname, '..', 'storage', 'slides', path.basename(storageName));
  const conversion = (async () => {
    const temporaryPath = path.join(previewDir, `${path.basename(outputPath, '.pdf')}-${process.pid}-${Date.now()}.pdf`);
    try {
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-STA',
          '-File',
          converterScript,
          '-InputPath',
          inputPath,
          '-OutputPath',
          temporaryPath,
        ],
        { timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true }
      );
      await fs.promises.rename(temporaryPath, outputPath);
      return outputPath;
    } catch (error) {
      await fs.promises.unlink(temporaryPath).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOENT') {
          console.error('Could not remove incomplete presentation preview:', cleanupError.message);
        }
      });
      const detail = error.stderr?.trim() || error.message;
      console.error('Could not convert PowerPoint for preview:', detail);
      throw new Error('Could not render this PowerPoint. Check that Microsoft PowerPoint is installed and try again.');
    }
  })();

  conversionPromises.set(outputPath, conversion);
  try {
    return await conversion;
  } finally {
    if (conversionPromises.get(outputPath) === conversion) conversionPromises.delete(outputPath);
  }
}

async function removePowerPointPreview(storageName) {
  const previewPath = getPreviewPath(storageName);
  try {
    await fs.promises.unlink(previewPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = { convertPowerPoint, removePowerPointPreview };

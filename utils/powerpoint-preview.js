const { execFile } = require('child_process');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const storageDir = process.env.VERCEL
  ? path.join(os.tmpdir(), 'logiauth-storage')
  : path.join(__dirname, '..', 'storage');
const previewDir = path.join(storageDir, 'previews');
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

  const inputPath = path.join(storageDir, 'slides', path.basename(storageName));
  const conversion = (async () => {
    const temporaryPath = path.join(previewDir, `${path.basename(outputPath, '.pdf')}-${process.pid}-${Date.now()}.pdf`);
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'logi-powerpoint-'));
    try {
      if (process.platform === 'win32') {
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
      } else if (process.platform === 'linux') {
        await execFileAsync(
          'libreoffice',
          [
            `-env:UserInstallation=${pathToFileURL(temporaryDirectory).href}`,
            '--headless',
            '--convert-to',
            'pdf',
            '--outdir',
            temporaryDirectory,
            inputPath,
          ],
          { timeout: 120000, maxBuffer: 1024 * 1024 }
        );
        const convertedPath = path.join(
          temporaryDirectory,
          `${path.basename(inputPath, path.extname(inputPath))}.pdf`
        );
        const convertedFile = await fs.promises.stat(convertedPath);
        if (!convertedFile.isFile() || convertedFile.size === 0) {
          throw new Error('LibreOffice did not produce a PDF preview.');
        }
        await fs.promises.copyFile(convertedPath, temporaryPath);
      } else {
        throw new Error(`PowerPoint previews are not supported on ${process.platform}.`);
      }
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
      throw new Error('Could not render this PowerPoint. Check that PowerPoint or LibreOffice is installed and try again.');
    } finally {
      await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
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

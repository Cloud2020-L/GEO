import { brotliCompress, gzip } from 'node:zlib';
import { constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const distDir = path.resolve(process.cwd(), 'dist');
const compressibleExts = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.svg',
  '.txt',
  '.webmanifest',
  '.xml',
]);

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(fullPath) : fullPath;
    }),
  );

  return files.flat();
}

async function compressFile(filePath) {
  const ext = path.extname(filePath);
  if (!compressibleExts.has(ext)) return null;

  const fileStat = await stat(filePath);
  if (fileStat.size < 1024) return null;

  const source = await readFile(filePath);
  const [gzipBuffer, brotliBuffer] = await Promise.all([
    gzipAsync(source, { level: 9 }),
    brotliAsync(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
  ]);

  await Promise.all([
    writeFile(`${filePath}.gz`, gzipBuffer),
    writeFile(`${filePath}.br`, brotliBuffer),
  ]);

  return {
    filePath,
    original: source.length,
    gzip: gzipBuffer.length,
    brotli: brotliBuffer.length,
  };
}

const files = await listFiles(distDir);
const results = (await Promise.all(files.map(compressFile))).filter(Boolean);
const saved = results.reduce((total, item) => total + item.original - item.brotli, 0);

console.log(`compressed ${results.length} files in dist, best-case saved ${(saved / 1024).toFixed(1)} KiB`);

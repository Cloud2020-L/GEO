import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dryRun = process.argv.includes('--dry-run');
const root = fileURLToPath(new URL('..', import.meta.url));
const paths = ['dist', 'dist-admin', 'dist-client', '_site', 'node_modules/.vite'];

async function removePath(path) {
  const target = resolve(root, path);
  if (!existsSync(target)) return;

  if (dryRun) {
    console.log(`[dry-run] remove ${target}`);
    return;
  }

  await rm(target, { recursive: true, force: true });
  console.log(`removed ${target}`);
}

for (const path of paths) {
  await removePath(path);
}

console.log('frontend clean-generated complete');

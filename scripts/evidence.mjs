import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values, positionals } = parseArgs({
  options: { out: { type: 'string', default: 'docs/evidence' } },
  allowPositionals: true,
});
const mode = positionals[0];
if (positionals.length !== 1 || !['record', 'check'].includes(mode)) {
  throw new Error('Usage: node scripts/evidence.mjs record|check [--out directory]');
}
const out = resolve(root, values.out);

if (mode === 'record') {
  // Sequential examples first, then the concurrent examples in a subdirectory.
  const runs = [
    ['--out', out],
    ['--scenario', 'examples/concurrent.ts', '--out', join(out, 'concurrent')],
  ];
  for (const args of runs) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: root,
      stdio: 'inherit',
    });
    if (child.error) throw child.error;
    if (child.status !== 0 && child.status !== 1) process.exit(child.status ?? 2);
    // A contract violation or an unexpected operation is a valid experiment result.
    if (child.status === 1) process.exitCode = 1;
  }
}

// Pin executable inputs and build/test configuration; exclude generated reports and caches.
const directories = ['src', 'examples', 'tests', 'scripts', '.github', 'assets'];
const files = directories.flatMap((directory) =>
  readdirSync(join(root, directory), { recursive: true })
    .map((file) => join(directory, file))
    .filter((file) => statSync(join(root, file)).isFile())
    .map((file) => file.split(sep).join('/')),
);
files.push(
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'vite.config.ts',
  'playwright.config.ts',
  'biome.json',
  '.npmrc',
  '.nvmrc',
  'index.html',
);
const rows = files
  .sort()
  .map((file) => {
    const hash = createHash('sha256')
      .update(readFileSync(join(root, file)))
      .digest('hex');
    return `${hash}  ${file}`;
  })
  .join('\n');
const manifest = `${rows}\n`;
const path = join(out, 'sources.sha256');
if (mode === 'record') {
  writeFileSync(path, manifest);
  console.log(`Recorded ${files.length} input checksums.`);
} else {
  if (readFileSync(path, 'utf8') !== manifest) {
    throw new Error(
      'Recorded example inputs changed. Run npm run examples:record, inspect its reports, and commit the refreshed evidence.',
    );
  }
  console.log(`Verified ${files.length} recorded input checksums.`);
}

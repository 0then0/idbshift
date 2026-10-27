import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

function cli(args: string[], script = 'src/cli.ts') {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += String(data);
    });
    child.stderr.on('data', (data) => {
      output += String(data);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('CLI executes user scenario, exports offline reports and opt-in Playwright trace', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  const out = testInfo.outputPath('cli');
  const result = await cli(['--scenario', 'examples/minimal.ts', '--out', out, '--trace']);
  expect(result.code, result.output).toBe(0);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  expect(report.histories[0].verdict).toBe('passed');
  expect((await stat(join(out, 'trace-1.zip'))).size).toBeGreaterThan(0);
  expect(await readFile(join(out, 'report.html'), 'utf8')).toContain('Version history report');
  expect(JSON.stringify(report)).not.toContain(process.cwd());
});

test('CLI does not hide original violation behind exit zero or retries', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  const out = testInfo.outputPath('examples');
  const result = await cli(['--out', out]);
  expect(result.code, result.output).toBe(1);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  expect(report.histories.map((h: { verdict: string }) => h.verdict)).toEqual([
    'passed',
    'contract-violation',
    'passed',
    'passed',
    'expected-refusal',
  ]);
});

test('CLI configuration error uses exit 2', async () => {
  expect((await cli(['--unknown'])).code).toBe(2);
});

test('Example recorder captures genuine outcomes and detects changed input manifests', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  const out = testInfo.outputPath('recorded');
  const result = await cli(['record', '--out', out], 'scripts/evidence.mjs');
  expect(result.code, result.output).toBe(1);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  expect(report.histories[1].verdict).toBe('contract-violation');
  const hashes = await readFile(join(out, 'sources.sha256'), 'utf8');
  const runnerHash = createHash('sha256')
    .update(await readFile('src/runner.ts'))
    .digest('hex');
  expect(hashes).toContain(`${runnerHash}  src/runner.ts`);
  expect(hashes).not.toContain(process.cwd());
  expect((await cli(['check', '--out', out], 'scripts/evidence.mjs')).code).toBe(0);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(out, 'sources.sha256'), hashes.replace(runnerHash, '0'.repeat(64)));
  const stale = await cli(['check', '--out', out], 'scripts/evidence.mjs');
  expect(stale.code).not.toBe(0);
  expect(stale.output).toContain('Recorded example inputs changed');
});

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';

// An absolute loader lets the CLI run from another working directory.
const tsx = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const scriptRoot = process.cwd();

function cli(
  args: string[],
  script = 'src/cli.ts',
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<{ code: number | null; output: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, resolve(scriptRoot, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += String(data);
    });
    child.stderr.on('data', (data) => {
      output += String(data);
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, output }));
  });
}

test('CLI executes user scenario, exports offline reports and opt-in Playwright trace', async ({
  browserName,
}, testInfo) => {
  const out = testInfo.outputPath('cli');
  const result = await cli([
    '--scenario',
    'examples/minimal.ts',
    '--browser',
    browserName,
    '--out',
    out,
    '--trace',
  ]);
  expect(result.code, result.output).toBe(0);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  expect(report.histories[0].verdict).toBe('passed');
  expect(result.output).toContain(`Browser: ${browserName} `);
  expect((await stat(join(out, 'trace-1.zip'))).size).toBeGreaterThan(0);
  expect(await readFile(join(out, 'report.html'), 'utf8')).toContain('Version history report');
  expect(JSON.stringify(report)).not.toContain(process.cwd());
});

test('CLI does not hide original violation behind exit zero or retries', async ({
  browser,
  browserName,
}, testInfo) => {
  const out = testInfo.outputPath('examples');
  const result = await cli(['--browser', browserName, '--out', out]);
  expect(result.code, result.output).toBe(1);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  // The CLI launches its own browser from the same Playwright installation as this project.
  expect(result.output).toContain(`Browser: ${browserName} ${browser.version()}`);
  for (const history of report.histories)
    expect(history.environment).toMatchObject({
      browser: browserName,
      browserVersion: browser.version(),
    });
  expect(report.histories.map((h: { verdict: string }) => h.verdict)).toEqual([
    'passed',
    'contract-violation',
    'passed',
    'passed',
    'expected-refusal',
    'passed',
  ]);
  // The aborted-migration history runs through the standard CLI in the selected engine.
  const recovery = report.histories[5];
  expect(recovery.history).toBe('native-aborted-migration-recovery');
  expect(recovery.stages.map((s: { status: string }) => s.status)).toEqual([
    'passed',
    'expected-open-error',
    'passed',
    'passed',
  ]);
  expect(recovery.stages[1].openError.actual.name).toBe('AbortError');
  const text = await readFile(join(out, 'report.txt'), 'utf8');
  expect(text).toContain('expected AbortError, observed AbortError');
  expect(text).toContain('retry-B / Final records are exact: passed');
  const html = await readFile(join(out, 'report.html'), 'utf8');
  expect(html).toContain('Recovery evidence after abort-B');
  expect(html).toContain('Index created by the aborted upgrade is absent');
});

test('CLI runs the concurrent examples and reports an unexpected operation without hiding it', async ({
  browserName,
}, testInfo) => {
  const out = testInfo.outputPath('concurrent');
  const result = await cli([
    '--scenario',
    'examples/concurrent.ts',
    '--browser',
    browserName,
    '--out',
    out,
  ]);
  expect(result.code, result.output).toBe(1);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  expect(report.histories).toEqual([]);
  for (const history of report.concurrentHistories) {
    expect(history.environment.browser).toBe(browserName);
    expect(history.limitations.join(' ')).toContain(`one disposable ${browserName} context`);
  }
  expect(report.concurrentHistories.map((h: { verdict: string }) => h.verdict)).toEqual([
    'passed',
    'unexpected-operation',
    'expected-refusal',
    'passed',
  ]);
  expect(await readFile(join(out, 'report.txt'), 'utf8')).toContain('concurrent');
  expect(JSON.stringify(report)).not.toContain(process.cwd());
});

test('CLI configuration error uses exit 2', async () => {
  expect((await cli(['--unknown'])).code).toBe(2);
});

test('Example recorder captures genuine outcomes and detects changed input manifests', async ({
  browserName,
}, testInfo) => {
  const out = testInfo.outputPath('recorded');
  const result = await cli(
    ['record', '--browser', browserName, '--out', out],
    'scripts/evidence.mjs',
  );
  expect(result.code, result.output).toBe(1);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  expect(report.histories[1].verdict).toBe('contract-violation');
  expect(report.histories[1].environment.browser).toBe(browserName);
  const concurrent = JSON.parse(await readFile(join(out, 'concurrent', 'report.json'), 'utf8'));
  expect(concurrent.concurrentHistories[0].environment.browser).toBe(browserName);
  expect(concurrent.concurrentHistories).toHaveLength(4);
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

test('Without --browser and --out the CLI keeps Chromium and the reports directory', async ({
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The default engine is Chromium; checked in its project');
  const cwd = await mkdtemp(join(tmpdir(), 'idbshift-default-'));
  try {
    const result = await cli(
      ['--scenario', resolve('examples/minimal.ts'), '--root', scriptRoot],
      'src/cli.ts',
      { cwd },
    );
    expect(result.code, result.output).toBe(0);
    const report = JSON.parse(await readFile(join(cwd, 'reports', 'report.json'), 'utf8'));
    expect(report.histories[0].environment.browser).toBe('chromium');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Without --out a non-default engine writes to its own reports subdirectory', async ({
  browserName,
}) => {
  test.skip(browserName === 'chromium', 'Chromium keeps the historical reports directory');
  const cwd = await mkdtemp(join(tmpdir(), 'idbshift-engine-'));
  try {
    const result = await cli(
      [
        '--scenario',
        resolve('examples/minimal.ts'),
        '--root',
        scriptRoot,
        '--browser',
        browserName,
      ],
      'src/cli.ts',
      { cwd },
    );
    expect(result.code, result.output).toBe(0);
    const report = JSON.parse(
      await readFile(join(cwd, 'reports', browserName, 'report.json'), 'utf8'),
    );
    expect(report.histories[0].environment.browser).toBe(browserName);
    await expect(stat(join(cwd, 'reports', 'report.json'))).rejects.toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('An unknown engine is rejected before the scenario is loaded or a browser starts', async () => {
  const out = test.info().outputPath('unknown');
  for (const name of ['safari', 'Chromium', 'chrome', '']) {
    const result = await cli([
      '--scenario',
      'missing-scenario.ts',
      '--browser',
      name,
      '--out',
      out,
    ]);
    expect(result.code, result.output).toBe(2);
    expect(result.output).toContain('ConfigurationError: Unknown browser');
    expect(result.output).toContain('chromium, firefox, webkit');
    expect(result.output).not.toContain('Browser:');
  }
  await expect(stat(out)).rejects.toThrow();
});

test('A missing browser binary is a setup error that names the engine and its install command', async ({
  browserName,
}, testInfo) => {
  const out = testInfo.outputPath('missing');
  const empty = testInfo.outputPath('no-browsers');
  const result = await cli(
    ['--scenario', 'examples/minimal.ts', '--browser', browserName, '--out', out],
    'src/cli.ts',
    { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty } },
  );
  // Exit 2 is setup, distinct from exit 1 for an application contract result.
  expect(result.code, result.output).toBe(2);
  expect(result.output).toContain(
    `BrowserLaunchError: The ${browserName} browser is not installed`,
  );
  expect(result.output).toContain(`npx playwright install`);
  expect(result.output).toContain(` ${browserName}`);
  expect(result.output).not.toContain(process.cwd());
  await expect(stat(join(out, 'report.json'))).rejects.toThrow();
});

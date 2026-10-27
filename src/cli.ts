import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { runHistory } from './runner.js';
import { startAdapterServer } from './server.js';
import { summarize, writeReports } from './report.js';
import type { History, HistoryResult } from './types.js';

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'examples/histories.ts' },
      out: { type: 'string', default: 'reports' },
      root: { type: 'string', default: process.cwd() },
      trace: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npm run experiment -- --scenario examples/histories.ts --out reports [--root .] [--trace]',
    );
    return;
  }
  const { histories } = (await import(pathToFileURL(resolve(values.scenario)).href)) as {
    histories: History[];
  };
  if (!Array.isArray(histories) || !histories.length)
    throw new Error('Scenario must export a nonempty histories array');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const results: HistoryResult[] = [];
  const host = await startAdapterServer(resolve(values.root));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    for (const [index, history] of histories.entries()) {
      // Create output directory before tracing. Filenames never contain untrusted history ids.
      if (values.trace) await writeReports(results, resolve(values.out));
      results.push(
        await runHistory(browser, history, {
          origin: host.origin,
          signal: controller.signal,
          tracePath: values.trace ? resolve(values.out, `trace-${index + 1}.zip`) : undefined,
        }),
      );
      await writeReports(results, resolve(values.out));
      if (controller.signal.aborted) break;
    }
    console.log(summarize(results));
    console.log(`Report: ${resolve(values.out, 'report.html')}`);
    process.exitCode = controller.signal.aborted
      ? 130
      : results.some((r) => !['passed', 'expected-refusal'].includes(r.verdict))
        ? 1
        : 0;
  } finally {
    try {
      await browser?.close();
    } finally {
      await host.close();
    }
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : 'Experiment setup failed',
  );
  process.exitCode = 2;
});

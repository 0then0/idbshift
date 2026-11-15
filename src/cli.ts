import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit, type Browser } from '@playwright/test';
import { dependencies, safeMessage } from './common.js';
import { isConcurrentHistory, runConcurrentHistory } from './concurrent.js';
import { runHistory } from './runner.js';
import { startAdapterServer } from './server.js';
import { summarize, writeReports } from './report.js';
import type {
  ConcurrentHistory,
  ConcurrentHistoryResult,
  History,
  HistoryResult,
} from './types.js';

const engines = { chromium, firefox, webkit } as const;
type Engine = keyof typeof engines;
const isEngine = (value: string): value is Engine => Object.hasOwn(engines, value);

class SetupError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** A launch failure is a setup error (exit 2), never a verdict about the application. */
async function launch(engine: Engine): Promise<Browser> {
  try {
    return await engines[engine].launch();
  } catch (error) {
    const message = error instanceof Error ? safeMessage(error.message) : 'Unknown error';
    const install = `npx playwright install${process.platform === 'linux' ? ' --with-deps' : ''} ${engine}`;
    throw new SetupError(
      'BrowserLaunchError',
      message.includes("Executable doesn't exist")
        ? `The ${engine} browser is not installed for Playwright ${dependencies.playwright}. Install it with: ${install}`
        : `Could not launch ${engine} with Playwright ${dependencies.playwright}: ${message.replace(/^browserType\.launch: /, '')}. If the browser is missing or outdated, run: ${install}`,
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'examples/histories.ts' },
      out: { type: 'string' },
      root: { type: 'string', default: process.cwd() },
      browser: { type: 'string', default: 'chromium' },
      trace: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npm run experiment -- --scenario examples/histories.ts [--browser chromium|firefox|webkit] [--out reports] [--root .] [--trace]\n' +
        'One run uses one engine. Without --out, Chromium writes to reports/ and other engines to reports/<engine>/.',
    );
    return;
  }
  const engine = values.browser;
  if (!isEngine(engine))
    throw new SetupError(
      'ConfigurationError',
      `Unknown browser "${engine.slice(0, 40)}". Use one of: ${Object.keys(engines).join(', ')}`,
    );
  // Chromium keeps the historical default; other engines never overwrite its reports or traces.
  const out = resolve(values.out ?? (engine === 'chromium' ? 'reports' : `reports/${engine}`));
  const { histories } = (await import(pathToFileURL(resolve(values.scenario)).href)) as {
    histories: (History | ConcurrentHistory)[];
  };
  if (!Array.isArray(histories) || !histories.length)
    throw new Error('Scenario must export a nonempty histories array');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const results: (HistoryResult | ConcurrentHistoryResult)[] = [];
  const host = await startAdapterServer(resolve(values.root));
  let browser: Browser | undefined;
  try {
    browser = await launch(engine);
    console.log(`Browser: ${browser.browserType().name()} ${browser.version()}`);
    for (const [index, history] of histories.entries()) {
      // Create output directory before tracing. Filenames never contain untrusted history ids.
      if (values.trace) await writeReports(results, out);
      const runOptions = {
        origin: host.origin,
        signal: controller.signal,
        tracePath: values.trace ? resolve(out, `trace-${index + 1}.zip`) : undefined,
      };
      results.push(
        isConcurrentHistory(history)
          ? await runConcurrentHistory(browser, history, runOptions)
          : await runHistory(browser, history, runOptions),
      );
      await writeReports(results, out);
      if (controller.signal.aborted) break;
    }
    console.log(summarize(results));
    console.log(`Report: ${resolve(out, 'report.html')}`);
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

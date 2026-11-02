import { test as base, expect } from '@playwright/test';
import { isConcurrentHistory, runConcurrentHistory } from './concurrent.js';
import { runHistory, type RunOptions } from './runner.js';
import { writeReports } from './report.js';
import { startAdapterServer } from './server.js';
import type {
  ConcurrentHistory,
  ConcurrentHistoryResult,
  History,
  HistoryResult,
} from './types.js';

type FixtureOptions = Omit<RunOptions, 'origin' | 'step'>;
export interface IdbshiftRunner {
  (history: History, options?: FixtureOptions): Promise<HistoryResult>;
  (history: ConcurrentHistory, options?: FixtureOptions): Promise<ConcurrentHistoryResult>;
}

export const test = base.extend<{ idbshift: IdbshiftRunner }>({
  idbshift: async ({ browser }, use, testInfo) => {
    const host = await startAdapterServer();
    const cancellation = new AbortController();
    let run = 0;
    try {
      const runner = async (
        history: History | ConcurrentHistory,
        options: FixtureOptions = {},
      ): Promise<HistoryResult | ConcurrentHistoryResult> => {
        const runOptions: RunOptions = {
          ...options,
          origin: host.origin,
          signal: options.signal ?? cancellation.signal,
          step: (name, body) => test.step(name, body),
        };
        const report = isConcurrentHistory(history)
          ? await runConcurrentHistory(browser, history, runOptions)
          : await runHistory(browser, history, runOptions);
        const paths = await writeReports([report], testInfo.outputPath(`history-${++run}`));
        for (const [kind, path] of Object.entries(paths))
          await testInfo.attach(`IDBShift ${history.id} (${kind})`, {
            path,
            contentType:
              kind === 'json' ? 'application/json' : kind === 'html' ? 'text/html' : 'text/plain',
          });
        return report;
      };
      await use(runner as IdbshiftRunner);
    } finally {
      cancellation.abort();
      await host.close();
    }
  },
});
export { expect };

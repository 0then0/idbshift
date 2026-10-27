import { test as base, expect } from '@playwright/test';
import { runHistory, type RunOptions } from './runner.js';
import { writeReports } from './report.js';
import { startAdapterServer } from './server.js';
import type { History, HistoryResult } from './types.js';

export const test = base.extend<{
  idbshift: (
    history: History,
    options?: Omit<RunOptions, 'origin' | 'step'>,
  ) => Promise<HistoryResult>;
}>({
  idbshift: async ({ browser }, use, testInfo) => {
    const host = await startAdapterServer();
    const cancellation = new AbortController();
    let run = 0;
    try {
      await use(async (history, options = {}) => {
        const report = await runHistory(browser, history, {
          ...options,
          origin: host.origin,
          signal: options.signal ?? cancellation.signal,
          step: (name, body) => test.step(name, body),
        });
        const paths = await writeReports([report], testInfo.outputPath(`history-${++run}`));
        for (const [kind, path] of Object.entries(paths))
          await testInfo.attach(`IDBShift ${history.id} (${kind})`, {
            path,
            contentType:
              kind === 'json' ? 'application/json' : kind === 'html' ? 'text/html' : 'text/plain',
          });
        return report;
      });
    } finally {
      cancellation.abort();
      await host.close();
    }
  },
});
export { expect };

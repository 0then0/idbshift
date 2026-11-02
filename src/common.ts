import { createRequire } from 'node:module';
import type { Diagnostic } from './types.js';

const require = createRequire(import.meta.url);
export const toolVersion = '0.2.0';
export const dependencies = Object.fromEntries(
  ['@playwright/test', 'playwright', 'playwright-core', 'vite', 'dexie'].map((name) => {
    try {
      return [name, (require(`${name}/package.json`) as { version: string }).version];
    } catch {
      return [name, 'not installed'];
    }
  }),
);

export class RunFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

export function safeMessage(message: string): string {
  let safe = message.split('\n')[0] ?? 'Unknown error';
  for (const path of [process.cwd(), process.env.HOME, process.env.USERPROFILE]) {
    if (path) safe = safe.replaceAll(path, '[local path]');
  }
  return safe.slice(0, 2000);
}

export function diagnostic(error: unknown, phase: string): Diagnostic {
  // No stack, page logs, cookies, storage state, or database dump in default diagnostics.
  return {
    kind: error instanceof RunFailure ? error.kind : error instanceof Error ? error.name : 'Error',
    message:
      error instanceof Error ? safeMessage(error.message) : 'Non-Error thrown by adapter or check',
    phase,
  };
}

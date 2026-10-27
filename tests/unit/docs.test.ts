import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const files = [
  ...readdirSync(root).filter((file) => file.endsWith('.md')),
  ...readdirSync(join(root, 'docs'), { recursive: true, encoding: 'utf8' })
    .map((file) => join('docs', file))
    .filter((file) => file.endsWith('.md')),
  '.github/PULL_REQUEST_TEMPLATE.md',
];

test('Local documentation links point to existing project files', () => {
  let checked = 0;
  for (const file of files) {
    const markdown = readFileSync(join(root, file), 'utf8');
    for (const link of markdown.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = link[1];
      if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
      const path = decodeURIComponent(target.split('#')[0] ?? '');
      assert.ok(statSync(resolve(root, dirname(file), path)).isFile(), `${file}: ${target}`);
      checked++;
    }
  }
  assert.ok(checked > 20, 'Documentation link scan did not cover the project guides');
});

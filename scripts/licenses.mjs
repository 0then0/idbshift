import { readFileSync, writeFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const allowed = new Set([
  'MIT',
  'MIT OR Apache-2.0',
  'Apache-2.0',
  'ISC',
  'BSD-3-Clause',
  'MPL-2.0',
]);
const components = Object.entries(lock.packages)
  .filter(([path]) => path)
  .map(([path, pkg]) => {
    if (!allowed.has(pkg.license))
      throw new Error(`Review required for ${path}: ${pkg.license ?? 'unknown license'}`);
    return { name: path.split('node_modules/').at(-1), version: pkg.version, license: pkg.license };
  })
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));
if (process.argv.includes('--write')) {
  writeFileSync(
    new URL('../docs/dependency-licenses.json', import.meta.url),
    `${JSON.stringify(components, null, 2)}\n`,
  );
}
const inventory = JSON.parse(
  readFileSync(new URL('../docs/dependency-licenses.json', import.meta.url), 'utf8'),
);
if (JSON.stringify(components) !== JSON.stringify(inventory))
  throw new Error(
    'Dependency license inventory is stale; review the changes and run npm run licenses:update',
  );
console.log(
  `${components.length} locked components reviewed: ${[...new Set(components.map((c) => c.license))].join(', ')}`,
);

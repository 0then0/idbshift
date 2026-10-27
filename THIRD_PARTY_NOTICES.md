# Third-party notices

IDBShift source and its original project icon are licensed under [Apache-2.0](LICENSE). Dependencies retain their own copyrights and licenses; the project license does not relicense them.

The [dependency inventory](docs/dependency-licenses.json) records every locked direct/transitive package, including optional platform binaries. Run `npm run licenses` to compare it with the lockfile and reject unreviewed license identifiers. The reviewed identifiers are MIT, Apache-2.0, MIT OR Apache-2.0, ISC, BSD-3-Clause, and MPL-2.0. MIT may be selected for dual MIT/Apache components.

## Main components

- Playwright, Playwright Test, playwright-core, Dexie, and TypeScript: Apache-2.0.
- Vite, tsx, and Node type definitions: MIT.
- Biome and its CLI packages: MIT OR Apache-2.0.
- Lightning CSS and its platform binaries: MPL-2.0. These are unmodified toolchain dependencies. Their npm distributions and [upstream repository](https://github.com/parcel-bundler/lightningcss) provide corresponding source and notices. Preserve file-level source obligations when distributing modified MPL-covered files.

Installed packages contain the authoritative upstream license texts and notices. Preserve them when redistributing dependencies or compiled distributions.

Chromium and FFmpeg downloaded by Playwright carry separate third-party notices in their distributions. Browser binaries are not vendored or included in the IDBShift build output; retain their notices if redistributing them.

## Example attribution

The Dexie example is a newly written adaptation of the application compatibility risk described in [Dexie #2097](https://github.com/dexie/Dexie.js/issues/2097). The project icon is original and does not reproduce an upstream logo or trademark.

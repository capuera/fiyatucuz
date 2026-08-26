/**
 * ADIM 13.1 — production runtime / Windows compatibility.
 *
 * These tests defend the fix for the "compiled dist fails to boot" blocker
 * from the ADIM 13 report. They do not spin up the API; they assert the
 * invariants that made the compiled runtime work:
 *
 *   - internal workspace packages have compiled `dist/*` entries that
 *     match their `main` / `types` / `exports`,
 *   - the compiled `services/api/dist/index.js` exists after build,
 *   - `main`, `types`, and every `exports` `default` all resolve into
 *     `dist/` — never `src/`,
 *   - workspace-consumers of these packages will get compiled JS at
 *     runtime, source `.ts` only via the `development` condition.
 *
 * A separate suite (feeds-archive-windows.test.ts) exercises path handling
 * against Windows-style archive roots even though the tests run on macOS.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Manifest {
  name: string;
  main?: string;
  types?: string;
  exports?: Record<string, Record<string, string>>;
}

function loadManifest(pkgDir: string): Manifest {
  return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Manifest;
}

const INTERNAL_RUNTIME_PACKAGES = [
  { name: '@fiyatucuz/config', dir: 'packages/config' },
  { name: '@fiyatucuz/db', dir: 'packages/db' },
  { name: '@fiyatucuz/types', dir: 'packages/types' },
  { name: '@fiyatucuz/validation', dir: 'packages/validation' },
] as const;

describe('production runtime: workspace package exports (ADIM 13.1)', () => {
  for (const pkg of INTERNAL_RUNTIME_PACKAGES) {
    it(`${pkg.name}: main / types / exports resolve to dist/*, not src/*`, () => {
      const m = loadManifest(join(REPO_ROOT, pkg.dir));
      expect(m.name).toBe(pkg.name);
      expect(m.main).toBeDefined();
      expect(m.main!.startsWith('./dist/')).toBe(true);
      expect(m.types).toBeDefined();
      expect(m.types!.endsWith('.d.ts')).toBe(true);
      expect(m.types!.startsWith('./dist/')).toBe(true);

      // Every export's `default` / `types` must land under dist — otherwise
      // production `node dist/index.js` in a consumer would try to load
      // `packages/<pkg>/src/index.ts` and fail (this was the blocker).
      const exp = m.exports;
      expect(exp).toBeDefined();
      for (const [key, entry] of Object.entries(exp!)) {
        expect(entry.default, `${pkg.name} ${key} default`).toBeDefined();
        expect(entry.default!.startsWith('./dist/'), `${pkg.name} ${key} default → dist`).toBe(true);
        expect(entry.types, `${pkg.name} ${key} types`).toBeDefined();
        expect(entry.types!.startsWith('./dist/'), `${pkg.name} ${key} types → dist`).toBe(true);
      }
    });

    it(`${pkg.name}: has a "development" export condition pointing at src/*.ts (workspace dev ergonomics)`, () => {
      const m = loadManifest(join(REPO_ROOT, pkg.dir));
      for (const [key, entry] of Object.entries(m.exports!)) {
        expect(entry.development, `${pkg.name} ${key} development`).toBeDefined();
        expect(entry.development!.endsWith('.ts'), `${pkg.name} ${key} development → .ts`).toBe(true);
        expect(entry.development!.startsWith('./src/'), `${pkg.name} ${key} development → src`).toBe(true);
      }
    });

    it(`${pkg.name}: compiled dist entry exists on disk (build must have run)`, () => {
      const m = loadManifest(join(REPO_ROOT, pkg.dir));
      const abs = join(REPO_ROOT, pkg.dir, m.main!);
      expect(existsSync(abs), `expected compiled entry at ${abs}`).toBe(true);
    });
  }
});

describe('production runtime: services/api compiled entry (ADIM 13.1)', () => {
  it('services/api dist/index.js exists after build', () => {
    const p = join(REPO_ROOT, 'services', 'api', 'dist', 'index.js');
    expect(existsSync(p), `expected ${p}`).toBe(true);
  });

  it('the compiled dist/index.js imports workspace packages by bare specifier (not by src path)', () => {
    const p = join(REPO_ROOT, 'services', 'api', 'dist', 'index.js');
    const src = readFileSync(p, 'utf8');
    // Uses `@fiyatucuz/db` bare specifier (Node then follows the exports map).
    expect(src).toMatch(/from ['"]@fiyatucuz\/db['"]/);
    // Must NEVER reach into another package's src via a relative walk.
    expect(src).not.toMatch(/from ['"]\.\.\/\.\.\/packages\/db\/src/);
  });

  it('start script runs compiled JS via node (no tsx / ts-node in production)', () => {
    const m = loadManifest(join(REPO_ROOT, 'services', 'api')) as unknown as {
      scripts: Record<string, string>;
    };
    const start = m.scripts.start;
    expect(start).toBeDefined();
    expect(start).toMatch(/^node /);
    expect(start).toMatch(/dist\/index\.js/);
    expect(start).not.toMatch(/tsx/);
    expect(start).not.toMatch(/ts-node/);
  });
});

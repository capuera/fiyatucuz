// Tests for the Prettier baseline gate (ADIM 15A-6B). Run with:
//   node --test scripts/ci/test/check-format.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASELINE_FILE, evaluateFormatGate, parseBaseline } from '../check-format.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = join(ROOT, 'scripts', 'ci', 'check-format.mjs');

describe('evaluateFormatGate', () => {
  const baseline = ['old/a.ts', 'old/b.ts'];

  it('passes when only baseline files are unformatted', () => {
    const r = evaluateFormatGate({ unformatted: ['old/a.ts', 'old/b.ts'], baseline });
    assert.deepEqual(r, { ok: true, newDebt: [], staleBaseline: [], changedBaseline: [] });
  });

  it('rejects a new unformatted file (new debt)', () => {
    const r = evaluateFormatGate({ unformatted: ['old/a.ts', 'old/b.ts', 'new/c.ts'], baseline });
    assert.equal(r.ok, false);
    assert.deepEqual(r.newDebt, ['new/c.ts']);
  });

  it('rejects a stale baseline entry (formatted or deleted file): the list only shrinks', () => {
    const r = evaluateFormatGate({ unformatted: ['old/a.ts'], baseline });
    assert.equal(r.ok, false);
    assert.deepEqual(r.staleBaseline, ['old/b.ts']);
  });

  it('with a changed-files list: a changed baseline file must be formatted', () => {
    const r = evaluateFormatGate({
      unformatted: ['old/a.ts', 'old/b.ts'],
      baseline,
      changed: ['old/a.ts', 'src/x.ts'],
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.changedBaseline, ['old/a.ts']);
    // Not applied when no reference is given.
    assert.equal(evaluateFormatGate({ unformatted: baseline, baseline, changed: null }).ok, true);
    // Unchanged baseline files are fine.
    assert.equal(
      evaluateFormatGate({ unformatted: baseline, baseline, changed: ['src/x.ts'] }).ok,
      true,
    );
  });
});

describe('parseBaseline', () => {
  it('ignores comments and blank lines, sorts, handles CRLF', () => {
    assert.deepEqual(parseBaseline('# c\r\nb.ts\r\n\r\na.ts\n'), ['a.ts', 'b.ts']);
  });

  it('rejects duplicate entries', () => {
    assert.throws(() => parseBaseline('a.ts\na.ts\n'), /duplicate/);
  });
});

describe('repository baseline', () => {
  const entries = parseBaseline(readFileSync(BASELINE_FILE, 'utf8'));

  it('lists only existing files', () => {
    for (const f of entries) assert.ok(existsSync(join(ROOT, f)), f);
  });

  it('never grandfathers deployment, release or CI tooling', () => {
    const forbidden = entries.filter((f) => /^(scripts\/(deploy|release|ci)\/|\.github\/)/.test(f));
    assert.deepEqual(forbidden, []);
  });

  it('did not grow beyond the 74 files recorded at introduction (ADIM 15A-6B)', () => {
    assert.ok(entries.length <= 74, `baseline has ${entries.length} entries`);
  });
});

describe('CLI', () => {
  it('rejects unknown arguments and unknown refs with exit 2', () => {
    const usage = spawnSync(process.execPath, [CLI, '--bogus'], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
    const ref = spawnSync(process.execPath, [CLI, '--changed-since', 'no-such-ref-15a6b'], {
      encoding: 'utf8',
    });
    assert.equal(ref.status, 2);
    assert.match(ref.stderr, /unknown git ref/);
  });
});

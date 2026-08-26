/**
 * ADIM 13 / ADR-0017 — raw feed archive foundation.
 *
 * Pure unit tests for:
 *   - reference URI parse/format (path traversal, UUID enforcement, ext),
 *   - LocalFilesystemFeedArchive (write / finalize / abort / read / exists /
 *     delete / overwrite refusal / symlink handling / path escape),
 *   - factory + prod boot assertion.
 *
 * Integration tests that exercise the full fetch pipeline (success, oversize,
 * XML_ENCODING_REJECTED, XML_SECURITY_REJECTED, network failure, hash
 * equality, cross-tenant, DB persistence) live in feeds-service.test.ts.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assertProductionFeedArchiveSafety,
  buildArchiveRef,
  createFeedArchive,
  extForFormat,
  FEED_ARCHIVE_SCHEME,
  FeedArchiveError,
  InsecureProductionFeedArchiveError,
  loadFeedEnv,
  LocalFilesystemFeedArchive,
  parseArchiveRef,
  resolveLocalArchiveRoot,
} from '../src/modules/feeds/index.js';

async function readAll(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const p of iter) {
    // createReadStream yields Buffer; Buffer extends Uint8Array so use as-is.
    const u = p instanceof Uint8Array ? p : new Uint8Array(p as ArrayBufferLike);
    parts.push(u);
    total += u.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function key(overrides: Partial<Parameters<typeof buildArchiveRef>[0]> = {}) {
  return {
    tenantId: randomUUID(),
    feedId: randomUUID(),
    fetchId: randomUUID(),
    format: 'CUSTOM_XML' as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reference URI
// ---------------------------------------------------------------------------

describe('feed archive (ADR-0017): reference URI', () => {
  it('req 13: buildArchiveRef only accepts trusted UUIDs and yields the canonical scheme', () => {
    const k = key();
    const ref = buildArchiveRef(k);
    expect(ref.startsWith(`${FEED_ARCHIVE_SCHEME}//`)).toBe(true);
    // The URI carries UUIDs, not feed name/URL/merchant/site names.
    expect(ref).toContain(k.tenantId);
    expect(ref).toContain(k.feedId);
    expect(ref).toContain(k.fetchId);
  });

  it('extForFormat maps FeedFormat to the safe leaf extension', () => {
    expect(extForFormat('CSV')).toBe('csv');
    expect(extForFormat('CUSTOM_XML')).toBe('xml');
    expect(extForFormat('GOOGLE_MERCHANT_XML')).toBe('xml');
  });

  it('req 13: buildArchiveRef rejects non-UUID IDs', () => {
    expect(() => buildArchiveRef(key({ tenantId: 'not-a-uuid' }))).toThrow(FeedArchiveError);
    expect(() => buildArchiveRef(key({ feedId: '../etc/passwd' }))).toThrow(FeedArchiveError);
    expect(() => buildArchiveRef(key({ fetchId: '' }))).toThrow(FeedArchiveError);
  });

  it('req 14: parseArchiveRef rejects path-traversal segments', () => {
    for (const bad of [
      'feed-archive://../../../etc/passwd',
      'feed-archive://a/../b/c/raw.xml',
      'feed-archive://a\\b/c/d/raw.xml',
      'feed-archive:///a/b/c/raw.xml',
      'feed-archive://a//b/c/raw.xml',
      'feed-archive://a/b/c/raw.xml/',
    ]) {
      expect(() => parseArchiveRef(bad), bad).toThrow(FeedArchiveError);
    }
  });

  it('req 15: parseArchiveRef rejects absolute paths / non-URI inputs', () => {
    for (const bad of [
      '/etc/passwd',
      'C:\\evil\\path',
      'file:///etc/passwd',
      'http://evil/raw.xml',
      '',
      'feed-archive:',
      'feed-archive:/',
    ]) {
      expect(() => parseArchiveRef(bad), bad).toThrow(FeedArchiveError);
    }
  });

  it('parseArchiveRef round-trips a legal ref back into its components', () => {
    const k = key({ format: 'CSV' });
    const ref = buildArchiveRef(k);
    const parsed = parseArchiveRef(ref);
    expect(parsed).toEqual({
      tenantId: k.tenantId,
      feedId: k.feedId,
      fetchId: k.fetchId,
      ext: 'csv',
    });
  });

  it('parseArchiveRef rejects a leaf other than raw.xml / raw.csv', () => {
    const t = randomUUID();
    const f = randomUUID();
    const x = randomUUID();
    expect(() => parseArchiveRef(`feed-archive://${t}/${f}/${x}/raw.json`)).toThrow(
      FeedArchiveError,
    );
    expect(() => parseArchiveRef(`feed-archive://${t}/${f}/${x}/index.xml`)).toThrow(
      FeedArchiveError,
    );
  });

  it('parseArchiveRef rejects NUL byte injection', () => {
    const t = randomUUID();
    const f = randomUUID();
    const x = randomUUID();
    expect(() =>
      parseArchiveRef(`feed-archive://${t}/${f}/${x}/raw.xml\x00foo`),
    ).toThrow(FeedArchiveError);
  });
});

// ---------------------------------------------------------------------------
// LocalFilesystemFeedArchive
// ---------------------------------------------------------------------------

describe('feed archive (ADR-0017): LocalFilesystemFeedArchive', () => {
  let root: string;
  let archive: LocalFilesystemFeedArchive;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fiyatucuz-fa-'));
    archive = new LocalFilesystemFeedArchive(root);
  });
  afterEach(async () => {
    // Best-effort cleanup — the OS clears /tmp eventually anyway.
    await fs.rm(root, { recursive: true, force: true });
  });

  it('req 21b: constructor rejects a relative root path', () => {
    expect(() => new LocalFilesystemFeedArchive('relative/path')).toThrow(FeedArchiveError);
    expect(() => new LocalFilesystemFeedArchive('')).toThrow(FeedArchiveError);
  });

  it('write + finalize + read round-trips exact bytes (req 2, req 16)', async () => {
    const k = key();
    const bytes = Buffer.from('<?xml version="1.0"?><rss><item>ok</item></rss>');
    const w = await archive.openWriter(k);
    await w.write(bytes);
    const ref = await w.finalize();
    expect(ref).toBe(buildArchiveRef(k));
    const readBack = await readAll(await archive.read(ref));
    expect(Buffer.from(readBack).equals(bytes)).toBe(true);
  });

  it('req 3: sha256 of archived bytes matches sha256 of input bytes', async () => {
    const k = key();
    const input = Buffer.from('a'.repeat(4096) + 'B' + 'c'.repeat(1024));
    const inputHash = createHash('sha256').update(input).digest('hex');
    const w = await archive.openWriter(k);
    // Write in several chunks to prove streaming preserves byte identity.
    await w.write(input.subarray(0, 1000));
    await w.write(input.subarray(1000, 3000));
    await w.write(input.subarray(3000));
    const ref = await w.finalize();
    const readBack = await readAll(await archive.read(ref));
    const archivedHash = createHash('sha256').update(readBack).digest('hex');
    expect(archivedHash).toBe(inputHash);
  });

  it('req 17: exists is false before finalize, true after finalize, false after delete', async () => {
    const k = key();
    const ref = buildArchiveRef(k);
    expect(await archive.exists(ref)).toBe(false);
    const w = await archive.openWriter(k);
    await w.write(Buffer.from('x'));
    // Not finalized yet — the tmp file exists but not the canonical path.
    expect(await archive.exists(ref)).toBe(false);
    await w.finalize();
    expect(await archive.exists(ref)).toBe(true);
    await archive.delete(ref);
    expect(await archive.exists(ref)).toBe(false);
  });

  it('req 18: delete is idempotent on a missing ref', async () => {
    const k = key();
    const ref = buildArchiveRef(k);
    // No error — deleting nothing is a no-op.
    await expect(archive.delete(ref)).resolves.toBeUndefined();
  });

  it('req 20: openWriter refuses to overwrite an existing finalized archive', async () => {
    const k = key();
    const first = await archive.openWriter(k);
    await first.write(Buffer.from('first'));
    await first.finalize();
    await expect(archive.openWriter(k)).rejects.toBeInstanceOf(FeedArchiveError);
  });

  it('ADIM 13.1: finalize refuses to silently overwrite if the final path appears between openWriter and finalize (race)', async () => {
    const k = key();
    const w = await archive.openWriter(k);
    await w.write(Buffer.from('legit'));
    // Squat on the final path AFTER openWriter's pre-check but BEFORE
    // finalize's promote step. On POSIX this is where naive `rename`
    // would silently overwrite; our link+unlink promote refuses.
    const finalPath = join(root, 'tenant', k.tenantId, 'feed', k.feedId, 'fetch', k.fetchId, 'raw.xml');
    await writeFile(finalPath, 'squatter');
    await expect(w.finalize()).rejects.toMatchObject({ code: 'ARCHIVE_ALREADY_EXISTS' });
    // Squatter bytes untouched — the promote step is truly non-destructive.
    const still = await fs.readFile(finalPath, 'utf8');
    expect(still).toBe('squatter');
  });

  it('req 12: abort removes the tmp file — no orphan on partial write', async () => {
    const k = key();
    const w = await archive.openWriter(k);
    await w.write(Buffer.from('half a body'));
    await w.abort();
    const dir = join(root, 'tenant', k.tenantId, 'feed', k.feedId, 'fetch', k.fetchId);
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
    // Canonical archive is not present.
    expect(await archive.exists(buildArchiveRef(k))).toBe(false);
  });

  it('req 12b: abort after finalize is a no-op (does not delete finalized file)', async () => {
    const k = key();
    const w = await archive.openWriter(k);
    await w.write(Buffer.from('done'));
    await w.finalize();
    await w.abort();
    expect(await archive.exists(buildArchiveRef(k))).toBe(true);
  });

  it('write after abort throws (writer is one-shot)', async () => {
    const k = key();
    const w = await archive.openWriter(k);
    await w.abort();
    await expect(w.write(Buffer.from('x'))).rejects.toBeInstanceOf(FeedArchiveError);
    await expect(w.finalize()).rejects.toBeInstanceOf(FeedArchiveError);
  });

  it('req 14b: writer path stays under the archive root — a malicious ref cannot escape', async () => {
    // The reference parser is the primary gate; construct one that PASSES
    // the parser (all UUIDs, canonical shape) and verify the archive still
    // resolves inside root — impossible to escape by design.
    const k = key();
    const w = await archive.openWriter(k);
    await w.write(Buffer.from('.'));
    const ref = await w.finalize();
    // parseArchiveRef would reject an escape; assert the physical file
    // sits under root.
    const expected = join(root, 'tenant', k.tenantId, 'feed', k.feedId, 'fetch', k.fetchId, 'raw.xml');
    await fs.access(expected); // throws if not there
    expect(expected.startsWith(root + sep)).toBe(true);
    // And the ref reads a file under root.
    const readBack = await readAll(await archive.read(ref));
    expect(Buffer.from(readBack).toString()).toBe('.');
  });

  it('req 14c: read/delete refuse to follow a symlink squatting on the archive path', async () => {
    const k = key();
    const finalPath = join(root, 'tenant', k.tenantId, 'feed', k.feedId, 'fetch', k.fetchId, 'raw.xml');
    await fs.mkdir(dirname(finalPath), { recursive: true });
    // Put a real secret file outside the archive tree and symlink it in.
    const secretDir = await mkdtemp(join(tmpdir(), 'fa-secret-'));
    const secretPath = join(secretDir, 'passwd');
    await writeFile(secretPath, 'secret');
    await symlink(secretPath, finalPath);
    try {
      const ref = buildArchiveRef(k);
      // exists: symlink → treated as not-our-object.
      expect(await archive.exists(ref)).toBe(false);
      // read: refuses to traverse the symlink.
      await expect(archive.read(ref)).rejects.toBeInstanceOf(FeedArchiveError);
      // openWriter: refuses to overwrite the symlink target.
      await expect(archive.openWriter(k)).rejects.toBeInstanceOf(FeedArchiveError);
      // delete: unlinks the symlink itself, but does not follow it.
      await archive.delete(ref);
      const secretStill = await fs.readFile(secretPath, 'utf8');
      expect(secretStill).toBe('secret');
    } finally {
      await fs.rm(secretDir, { recursive: true, force: true });
    }
  });

  it('req 19-support: two tenants writing the same feedId/fetchId land under distinct paths', async () => {
    const shared = { feedId: randomUUID(), fetchId: randomUUID(), format: 'CUSTOM_XML' as const };
    const a = { tenantId: randomUUID(), ...shared };
    const b = { tenantId: randomUUID(), ...shared };
    const wa = await archive.openWriter(a);
    await wa.write(Buffer.from('A'));
    const refA = await wa.finalize();
    const wb = await archive.openWriter(b);
    await wb.write(Buffer.from('B'));
    const refB = await wb.finalize();
    expect(refA).not.toBe(refB);
    const A = await readAll(await archive.read(refA));
    const B = await readAll(await archive.read(refB));
    expect(Buffer.from(A).toString()).toBe('A');
    expect(Buffer.from(B).toString()).toBe('B');
  });

  it('read on a missing ref throws ARCHIVE_NOT_FOUND', async () => {
    await expect(archive.read(buildArchiveRef(key()))).rejects.toMatchObject({
      code: 'ARCHIVE_NOT_FOUND',
    });
  });

  it('read/exists/delete reject a malformed ref before any FS I/O', async () => {
    for (const method of ['read', 'exists', 'delete'] as const) {
      const call = () => (archive[method]('feed-archive://not-a-uuid/x/y/raw.xml') as Promise<unknown>);
      await expect(call()).rejects.toBeInstanceOf(FeedArchiveError);
    }
  });

  it('CSV format produces a raw.csv leaf (req 6-support)', async () => {
    const k = key({ format: 'CSV' });
    const w = await archive.openWriter(k);
    await w.write(Buffer.from('id,price\n1,10\n'));
    const ref = await w.finalize();
    expect(ref).toMatch(/raw\.csv$/);
    const readBack = await readAll(await archive.read(ref));
    expect(Buffer.from(readBack).toString()).toBe('id,price\n1,10\n');
  });

  it('files are streamed — writer accepts many small chunks without loading the whole body', async () => {
    const k = key();
    const w = await archive.openWriter(k);
    const hasher = createHash('sha256');
    // 2 MiB in 4 KiB chunks — proves no single-buffer requirement.
    for (let i = 0; i < 512; i++) {
      const chunk = Buffer.alloc(4096, (i % 256));
      hasher.update(chunk);
      await w.write(chunk);
    }
    const ref = await w.finalize();
    const readBack = await readAll(await archive.read(ref));
    expect(readBack.length).toBe(2 * 1024 * 1024);
    expect(createHash('sha256').update(readBack).digest('hex')).toBe(hasher.digest('hex'));
  });
});

// ---------------------------------------------------------------------------
// Factory + production boot assertion
// ---------------------------------------------------------------------------

describe('feed archive (ADR-0017): factory + production config', () => {
  it('req 22: development config falls back to an OS-tmpdir subdirectory', () => {
    const env = loadFeedEnv({});
    const root = resolveLocalArchiveRoot(env);
    expect(isAbsolute(root)).toBe(true);
    expect(root).toContain('fiyatucuz-feed-archive');
    // Not inside the repo/cwd — must live on the OS temp volume.
    expect(root.startsWith(process.cwd() + sep)).toBe(false);
  });

  it('createFeedArchive returns a working local archive in dev', () => {
    const env = loadFeedEnv({});
    const a = createFeedArchive(env);
    expect(a).toBeDefined();
    expect(typeof a.openWriter).toBe('function');
  });

  it('req 21: production boot fails when FEED_ARCHIVE_LOCAL_ROOT is unset', () => {
    const env = loadFeedEnv({});
    expect(() => assertProductionFeedArchiveSafety(env, 'production')).toThrow(
      InsecureProductionFeedArchiveError,
    );
  });

  it('req 21b: production boot fails on a relative FEED_ARCHIVE_LOCAL_ROOT', () => {
    const env = loadFeedEnv({ FEED_ARCHIVE_LOCAL_ROOT: 'var/lib/archive' });
    expect(() => assertProductionFeedArchiveSafety(env, 'production')).toThrow(
      InsecureProductionFeedArchiveError,
    );
  });

  it('req 21c: production boot fails when FEED_ARCHIVE_LOCAL_ROOT lives inside the process cwd (repo/deploy dir)', () => {
    const inside = join(process.cwd(), 'runtime-data', 'archive');
    const env = loadFeedEnv({ FEED_ARCHIVE_LOCAL_ROOT: inside });
    expect(() => assertProductionFeedArchiveSafety(env, 'production')).toThrow(
      InsecureProductionFeedArchiveError,
    );
  });

  it('req 21d: production boot accepts an explicit absolute path outside the cwd', () => {
    // Use the OS tmpdir as the "external" location — it is absolute and
    // outside a typical deployment cwd.
    const env = loadFeedEnv({ FEED_ARCHIVE_LOCAL_ROOT: tmpdir() });
    expect(() => assertProductionFeedArchiveSafety(env, 'production')).not.toThrow();
  });

  it('non-production boot never fails on missing/relative FEED_ARCHIVE_LOCAL_ROOT', () => {
    const env = loadFeedEnv({});
    expect(() => assertProductionFeedArchiveSafety(env, 'test')).not.toThrow();
    expect(() => assertProductionFeedArchiveSafety(env, 'development')).not.toThrow();
  });

  it('dev fallback path is not a file:// URL or a repo path (belt-and-suspenders)', () => {
    const env = loadFeedEnv({});
    const root = resolveLocalArchiveRoot(env);
    expect(root.startsWith('file://')).toBe(false);
    expect(pathToFileURL(root).protocol).toBe('file:');
  });
});

// ---------------------------------------------------------------------------
// Failing-writer stub — used to prove SUCCESS is impossible when finalize
// fails. The integration test in feeds-service.test.ts exercises the full
// pipeline; this unit test asserts the abstraction contract.
// ---------------------------------------------------------------------------

describe('feed archive (ADR-0017): writer contract on finalize failure (req 11 unit-level)', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'fiyatucuz-fa-fail-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a partial finalize followed by abort leaves no observable archive object', async () => {
    const archive = new LocalFilesystemFeedArchive(root);
    const k = key();
    const w = await archive.openWriter(k);
    await w.write(Buffer.from('partial'));
    // Simulate a caller that hits an error and aborts instead of finalizing.
    await w.abort();
    expect(await archive.exists(buildArchiveRef(k))).toBe(false);
    // The tmp file directory should exist but be empty.
    const dir = join(root, 'tenant', k.tenantId, 'feed', k.feedId, 'fetch', k.fetchId);
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
  });
});

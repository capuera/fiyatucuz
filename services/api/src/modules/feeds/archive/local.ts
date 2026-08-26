/**
 * Local-filesystem archive adapter (ADR-0017 §Local adapter).
 *
 * Layout under the configured root:
 *
 *   <root>/tenant/<tenantId>/feed/<feedId>/fetch/<fetchId>/raw.<ext>
 *
 * Path construction always goes through `node:path` (`join`, `resolve`,
 * `dirname`, `sep`) so the same code produces:
 *   POSIX:   /var/lib/fiyatucuz/feed-archive/tenant/<id>/feed/<id>/…
 *   Windows: D:\FiyatUcuzData\FeedArchive\tenant\<id>\feed\<id>\…
 *
 * Write discipline:
 *   1. mkdir -p target directory with 0700 (POSIX; on Windows the mode is
 *      largely a no-op — directory ACLs are configured out-of-band).
 *   2. open the tmp path with `wx` (O_CREAT|O_EXCL) and mode 0600 so we
 *      never open an attacker-planted symlink at the tmp filename.
 *   3. stream chunks via FileHandle.write.
 *   4. on finalize: fsync → close → cross-platform atomic promote:
 *        - POSIX: link(tmp, final) + unlink(tmp). link fails-if-exists,
 *          matching the never-overwrite invariant that POSIX `rename`
 *          would silently violate.
 *        - Windows: rename(tmp, final). NTFS `MoveFile` fails when the
 *          destination exists, so no MOVEFILE_REPLACE_EXISTING is used.
 *   5. on abort or partial-finalize failure: unlink the tmp file.
 *
 * The final object only becomes visible under its canonical name after
 * the promote step — a partial archive is never mistaken for a successful
 * one on either platform.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
  buildArchiveRef,
  parseArchiveRef,
  type FeedArchiveExt,
} from './reference.js';
import {
  FeedArchiveError,
  type FeedArchive,
  type FeedArchiveKey,
  type FeedArchiveRef,
  type FeedArchiveWriter,
} from './types.js';

export class LocalFilesystemFeedArchive implements FeedArchive {
  private readonly root: string;

  constructor(root: string) {
    if (typeof root !== 'string' || root.length === 0) {
      throw new FeedArchiveError(
        'ARCHIVE_ROOT_INVALID',
        'FEED_ARCHIVE_LOCAL_ROOT must be a non-empty absolute path',
      );
    }
    if (!isAbsolute(root)) {
      throw new FeedArchiveError(
        'ARCHIVE_ROOT_INVALID',
        `FEED_ARCHIVE_LOCAL_ROOT must be absolute; got "${root}"`,
      );
    }
    this.root = resolve(root);
  }

  async openWriter(key: FeedArchiveKey): Promise<FeedArchiveWriter> {
    const ref = buildArchiveRef(key);
    const finalPath = this.resolveRefPath(ref);
    await this.assertSafeTarget(finalPath);
    await fs.mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });

    // Unique tmp name per attempt so retries never collide. The tmp file
    // lives in the same directory as the final path so `rename` is
    // guaranteed to be same-filesystem (POSIX) or same-volume (Windows).
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    let handle: FileHandle;
    try {
      // `wx` = O_CREAT | O_EXCL — refuses to open if `tmpPath` already
      // exists, closing a symlink-race window on the tmp filename.
      handle = await open(tmpPath, 'wx', 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new FeedArchiveError('ARCHIVE_WRITE_FAILED', 'temp path collision (very unlikely)');
      }
      throw new FeedArchiveError(
        'ARCHIVE_WRITE_FAILED',
        `open failed: ${(err as Error).message}`,
      );
    }
    return new LocalArchiveWriter({ handle, tmpPath, finalPath, ref });
  }

  async read(ref: FeedArchiveRef): Promise<AsyncIterable<Uint8Array>> {
    const p = this.resolveRefPath(ref);
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) {
        throw new FeedArchiveError(
          'ARCHIVE_UNSAFE_PATH',
          'refusing to read through symlink at archive path',
        );
      }
    } catch (err) {
      if (err instanceof FeedArchiveError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new FeedArchiveError('ARCHIVE_NOT_FOUND', `no archive at ${ref}`);
      }
      throw new FeedArchiveError(
        'ARCHIVE_READ_FAILED',
        `stat failed: ${(err as Error).message}`,
      );
    }
    return createReadStream(p);
  }

  async exists(ref: FeedArchiveRef): Promise<boolean> {
    const p = this.resolveRefPath(ref);
    try {
      const st = await fs.lstat(p);
      // A symlink at the archive path is treated as "not our object".
      return !st.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async delete(ref: FeedArchiveRef): Promise<void> {
    const p = this.resolveRefPath(ref);
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) {
        // Refuse to follow — but the symlink entry itself can be removed
        // safely (unlink does not traverse).
        await fs.unlink(p);
        return;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw new FeedArchiveError(
        'ARCHIVE_WRITE_FAILED',
        `lstat failed: ${(err as Error).message}`,
      );
    }
    try {
      await fs.unlink(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw new FeedArchiveError(
        'ARCHIVE_WRITE_FAILED',
        `unlink failed: ${(err as Error).message}`,
      );
    }
  }

  // -- internals ----------------------------------------------------------

  /** Resolve a validated archive ref to an absolute path under `this.root`. */
  private resolveRefPath(ref: FeedArchiveRef): string {
    const parsed = parseArchiveRef(ref);
    return this.buildAbsolutePath(parsed.tenantId, parsed.feedId, parsed.fetchId, parsed.ext);
  }

  private buildAbsolutePath(
    tenantId: string,
    feedId: string,
    fetchId: string,
    ext: FeedArchiveExt,
  ): string {
    const target = join(
      this.root,
      'tenant', tenantId,
      'feed', feedId,
      'fetch', fetchId,
      `raw.${ext}`,
    );
    const abs = resolve(target);
    const rootWithSep = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (!abs.startsWith(rootWithSep)) {
      throw new FeedArchiveError('ARCHIVE_UNSAFE_PATH', 'resolved path escapes archive root');
    }
    return abs;
  }

  /**
   * Reject creating a writer when the target already exists (accidental
   * overwrite) or when a symlink squats on the target path.
   */
  private async assertSafeTarget(finalPath: string): Promise<void> {
    try {
      const st = await fs.lstat(finalPath);
      if (st.isSymbolicLink()) {
        throw new FeedArchiveError(
          'ARCHIVE_UNSAFE_PATH',
          'refusing to overwrite symlink at archive target',
        );
      }
      throw new FeedArchiveError('ARCHIVE_ALREADY_EXISTS', 'archive already exists');
    } catch (err) {
      if (err instanceof FeedArchiveError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw new FeedArchiveError(
        'ARCHIVE_WRITE_FAILED',
        `lstat failed: ${(err as Error).message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

class LocalArchiveWriter implements FeedArchiveWriter {
  private aborted = false;
  private finalized = false;
  private readonly handle: FileHandle;
  private readonly tmpPath: string;
  private readonly finalPath: string;
  private readonly ref: FeedArchiveRef;

  constructor(args: {
    handle: FileHandle;
    tmpPath: string;
    finalPath: string;
    ref: FeedArchiveRef;
  }) {
    this.handle = args.handle;
    this.tmpPath = args.tmpPath;
    this.finalPath = args.finalPath;
    this.ref = args.ref;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.aborted) {
      throw new FeedArchiveError('ARCHIVE_WRITE_FAILED', 'writer has been aborted');
    }
    if (this.finalized) {
      throw new FeedArchiveError('ARCHIVE_WRITE_FAILED', 'writer already finalized');
    }
    if (chunk.length === 0) return;
    try {
      await this.handle.write(chunk);
    } catch (err) {
      // On the first write failure, self-abort so callers who forget to
      // call abort still leave no tmp file behind.
      await this.abort();
      throw new FeedArchiveError(
        'ARCHIVE_WRITE_FAILED',
        `write failed: ${(err as Error).message}`,
      );
    }
  }

  async finalize(): Promise<FeedArchiveRef> {
    if (this.aborted) {
      throw new FeedArchiveError('ARCHIVE_WRITE_FAILED', 'writer has been aborted');
    }
    if (this.finalized) return this.ref;
    try {
      // fsync guarantees the bytes hit the disk before we promote the
      // tmp file to its final name.
      await this.handle.sync();
      await this.handle.close();
      await promoteTmpToFinal(this.tmpPath, this.finalPath);
      this.finalized = true;
      return this.ref;
    } catch (err) {
      // Best-effort cleanup — if promotion failed the tmp file is stale.
      try {
        await fs.unlink(this.tmpPath);
      } catch {
        /* ignore */
      }
      if (err instanceof FeedArchiveError) throw err;
      throw new FeedArchiveError(
        'ARCHIVE_WRITE_FAILED',
        `finalize failed: ${(err as Error).message}`,
      );
    }
  }

  async abort(): Promise<void> {
    if (this.finalized || this.aborted) return;
    this.aborted = true;
    try {
      await this.handle.close();
    } catch {
      /* handle may already be closed */
    }
    try {
      await fs.unlink(this.tmpPath);
    } catch {
      /* tmp file may not exist yet */
    }
  }
}

/**
 * Cross-platform "promote tmp to final" that ALWAYS refuses to overwrite an
 * existing file at `finalPath`.
 *
 * - POSIX: `rename` silently overwrites, which would silently violate the
 *   never-overwrite invariant. Use `link(tmp, final) + unlink(tmp)` instead:
 *   `link` returns EEXIST atomically when `final` already exists.
 * - Windows: NTFS `MoveFile` (behind `fs.rename` without
 *   `MOVEFILE_REPLACE_EXISTING`) already fails-if-exists. `link` on Windows
 *   requires elevated privileges on some volumes; avoid it here.
 */
async function promoteTmpToFinal(tmpPath: string, finalPath: string): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await fs.rename(tmpPath, finalPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
        throw new FeedArchiveError(
          'ARCHIVE_ALREADY_EXISTS',
          `refusing to overwrite existing archive at ${finalPath}`,
        );
      }
      throw err;
    }
  }
  // POSIX path.
  try {
    await fs.link(tmpPath, finalPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new FeedArchiveError(
        'ARCHIVE_ALREADY_EXISTS',
        `refusing to overwrite existing archive at ${finalPath}`,
      );
    }
    throw err;
  }
  try {
    await fs.unlink(tmpPath);
  } catch {
    // If the tmp unlink races with something else, the archive itself is
    // still valid (it's a separate inode via link). Leave the tmp for
    // manual/GC cleanup rather than fail the write.
  }
}

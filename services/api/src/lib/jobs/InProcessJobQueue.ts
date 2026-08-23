import type { Logger } from 'pino';

import type { Job, JobHandler, JobQueue } from './JobQueue.js';

/**
 * Default JobQueue implementation. Executes handlers in-process, no
 * persistence. Intended as a placeholder so callers can program to
 * `JobQueue` from day one.
 *
 * `enqueue` is fire-and-forget (schedules the handler via `setImmediate` and
 * returns immediately). This matches the abstract JobQueue contract: real
 * durable implementations (BullMQ + Redis) also return quickly after
 * persisting the job, and callers such as `POST /v1/…/fetch` rely on the
 * ability to respond `202 Accepted` without blocking on the actual work.
 *
 * Handler exceptions are swallowed after being logged — a background job's
 * failure must never crash the process. Do not use this in production for
 * any workload that must survive a restart or scale out.
 */
export class InProcessJobQueue implements JobQueue {
  private readonly handlers = new Map<string, JobHandler<unknown>>();
  // In-flight tracker for tests that want to await job settlement without
  // exposing scheduling internals to the JobQueue contract.
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly logger: Logger) {}

  async enqueue<T>(job: Job<T>): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      this.logger.warn({ jobName: job.name }, 'no handler registered for job; dropping');
      return;
    }
    const jobRef = job as Job<unknown>;
    // Schedule after the current tick so the caller (typically an HTTP
    // handler) can return before the handler runs.
    const done = new Promise<void>((resolve) => {
      setImmediate(() => {
        handler(jobRef)
          .catch((err) => {
            this.logger.error({ err, jobName: jobRef.name }, 'in-process job failed');
          })
          .finally(() => {
            resolve();
          });
      });
    });
    this.inflight.add(done);
    void done.finally(() => this.inflight.delete(done));
  }

  register<T>(name: string, handler: JobHandler<T>): void {
    this.handlers.set(name, handler as JobHandler<unknown>);
  }

  async start(): Promise<void> {
    // Nothing to do; execution happens on enqueue.
  }

  async stop(): Promise<void> {
    // Wait for in-flight jobs so a caller-initiated shutdown does not
    // truncate a running handler mid-way.
    await Promise.allSettled([...this.inflight]);
    this.handlers.clear();
  }

  /**
   * Test-only helper. Awaits every currently-scheduled handler. Not on the
   * abstract interface — production code must not depend on it.
   */
  async awaitIdle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }
}

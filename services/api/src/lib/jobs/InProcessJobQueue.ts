import type { Logger } from 'pino';

import type { Job, JobHandler, JobQueue } from './JobQueue.js';

/**
 * Default JobQueue implementation. Executes handlers in-process, immediately, no persistence.
 * Intended as a placeholder so callers can program to `JobQueue` from day one.
 * Do not use this in production for any workload that must survive a restart or scale out.
 */
export class InProcessJobQueue implements JobQueue {
  private readonly handlers = new Map<string, JobHandler<unknown>>();

  constructor(private readonly logger: Logger) {}

  async enqueue<T>(job: Job<T>): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      this.logger.warn({ jobName: job.name }, 'no handler registered for job; dropping');
      return;
    }
    try {
      await handler(job as Job<unknown>);
    } catch (err) {
      this.logger.error({ err, jobName: job.name }, 'in-process job failed');
    }
  }

  register<T>(name: string, handler: JobHandler<T>): void {
    this.handlers.set(name, handler as JobHandler<unknown>);
  }

  async start(): Promise<void> {
    // Nothing to do; execution happens on enqueue.
  }

  async stop(): Promise<void> {
    this.handlers.clear();
  }
}

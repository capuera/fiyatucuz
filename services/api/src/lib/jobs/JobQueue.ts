// JobQueue abstraction — see adr/0009-jobs-abstraction-first.md.
// The concrete durable implementation (BullMQ + Redis leading candidate) is introduced
// when the first real async workload lands. Callers program to this interface only.

export interface Job<T = unknown> {
  readonly name: string;
  readonly payload: T;
  readonly runAt?: Date;
  readonly idempotencyKey?: string;
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>;

export interface JobQueue {
  enqueue<T>(job: Job<T>): Promise<void>;
  register<T>(name: string, handler: JobHandler<T>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

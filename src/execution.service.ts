import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ConnectorResult } from './connector.service.js';
import { RedisService } from './redis.service.js';
import { log } from './log.js';

export { log };

/** Serializable job payload. Secrets are never put on the queue; the runner resolves them. */
export type ExecJob = { tenantId: string; approvalId: string; traceId: string; toolId: string; input: Record<string, unknown> };
type Handlers = { run: (job: ExecJob) => Promise<ConnectorResult>; done: (job: ExecJob, r: ConnectorResult) => Promise<void> };

/**
 * Execution worker. With REDIS_URL it uses BullMQ (durable, retried, multi-instance);
 * otherwise it falls back to an in-process sequential queue.
 */
@Injectable()
export class ExecutionService implements OnModuleDestroy {
  private handlers?: Handlers;
  private readonly local: ExecJob[] = [];
  private running = false;
  private idle: Array<() => void> = [];
  private queue?: Queue;
  private worker?: Worker;

  constructor(private readonly redis: RedisService) {}

  bind(h: Handlers) {
    this.handlers = h;
    if (!process.env.REDIS_URL) return;
    // Redis connects asynchronously; start BullMQ as soon as it is ready.
    if (this.redis.enabled) this.startBull();
    else this.redis.client?.once('ready', () => { if (!this.worker) this.startBull(); });
  }

  private startBull() {
    const name = process.env.EXEC_QUEUE ?? 'agent-gate-exec';
    this.queue = new Queue(name, { connection: this.redis.duplicate() });
    this.worker = new Worker(name, async j => {
      const job = j.data as ExecJob;
      const r = await this.handlers!.run(job);
      // Let BullMQ retry transient upstream failures; finalize only on success or last attempt.
      const last = j.attemptsMade + 1 >= (j.opts.attempts ?? 1);
      if (!r.ok && !last && r.attempts > 0) throw new Error(r.error ?? 'execution failed');
      await this.handlers!.done(job, r);
      return r;
    }, { connection: this.redis.duplicate(), concurrency: Number(process.env.EXEC_CONCURRENCY ?? 4) });
    this.worker.on('error', e => log('error', 'bull_worker_error', { error: e.message }));
    log('info', 'bullmq_worker_started', { queue: name });
  }

  async enqueue(job: ExecJob) {
    if (this.queue && this.redis.enabled) {
      await this.queue.add('execute', job, { attempts: Number(process.env.EXEC_ATTEMPTS ?? 3), backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 5000, jobId: `${job.tenantId}-${job.approvalId}` });
      return;
    }
    if (this.local.length >= 1000) throw new Error('Execution queue is full.');
    this.local.push(job);
    void this.drain();
  }

  async counts(): Promise<{ waiting: number; failed: number }> {
    if (this.queue && this.redis.enabled) {
      const c = await this.queue.getJobCounts('waiting', 'delayed', 'failed');
      return { waiting: (c.waiting ?? 0) + (c.delayed ?? 0), failed: c.failed ?? 0 };
    }
    return { waiting: this.local.length, failed: 0 };
  }

  get mode() { return this.queue && this.redis.enabled ? 'bullmq' : 'in-process'; }

  /** Resolves when the in-process queue is empty (tests / graceful shutdown). */
  whenIdle() {
    return this.running || this.local.length ? new Promise<void>(r => this.idle.push(r)) : Promise.resolve();
  }

  private async drain() {
    if (this.running || !this.handlers) return;
    this.running = true;
    while (this.local.length) {
      const job = this.local.shift()!;
      let r: ConnectorResult;
      try { r = await this.handlers.run(job); } catch (e) { r = { ok: false, error: (e as Error).message, attempts: 1 }; }
      try { await this.handlers.done(job, r); } catch (e) { log('error', 'execution_callback_failed', { error: (e as Error).message }); }
    }
    this.running = false;
    this.idle.splice(0).forEach(r => r());
  }

  async onModuleDestroy() { await this.worker?.close(); await this.queue?.close(); }
}

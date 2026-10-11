import { Injectable } from '@nestjs/common';
import { ConnectorService, ConnectorResult } from './connector.service.js';
import type { StoredTool } from './database.service.js';

type Job = { tool: StoredTool; input: Record<string, unknown>; done: (r: ConnectorResult) => Promise<void> | void };

/**
 * Execution worker. Approved jobs are queued and processed sequentially with a
 * bounded backlog. Swap `enqueue` for a BullMQ producer to distribute work.
 */
@Injectable()
export class ExecutionService {
  private readonly queue: Job[] = [];
  private running = false;
  private idle: Array<() => void> = [];

  constructor(private readonly connector: ConnectorService) {}

  enqueue(job: Job) {
    if (this.queue.length >= 1000) throw new Error('Execution queue is full.');
    this.queue.push(job);
    void this.drain();
  }

  /** Resolves when the queue is empty (used by tests and graceful shutdown). */
  whenIdle() {
    return this.running || this.queue.length ? new Promise<void>(r => this.idle.push(r)) : Promise.resolve();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      let result: ConnectorResult;
      try { result = await this.connector.execute(job.tool, job.input); }
      catch (e) { result = { ok: false, error: (e as Error).message, attempts: 1 }; }
      try { await job.done(result); } catch (e) { log('error', 'execution_callback_failed', { error: (e as Error).message }); }
    }
    this.running = false;
    this.idle.splice(0).forEach(r => r());
  }
}

export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}

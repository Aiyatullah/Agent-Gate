import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { log } from './log.js';

/** Optional Redis connection. `REDIS_URL` unset (or unreachable) => `client` is undefined and callers use in-memory fallbacks. */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client?: Redis;
  private usable = Boolean(process.env.REDIS_URL);

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) return;
    this.client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true, retryStrategy: n => (n > 3 ? null : 500 * n) });
    this.client.on('error', e => { if (this.usable) { this.usable = false; log('warn', 'redis_unavailable', { error: e.message }); } });
    this.client.on('ready', () => { this.usable = true; log('info', 'redis_ready'); });
    this.client.connect().catch(() => { this.usable = false; });
  }

  get enabled() { return this.usable && this.client?.status === 'ready'; }

  /** A fresh connection for BullMQ (workers need blocking connections). */
  duplicate() { return this.client!.duplicate({ maxRetriesPerRequest: null }); }

  async status() {
    if (!process.env.REDIS_URL) return { connected: false, mode: 'in-memory' };
    return { connected: this.enabled, mode: this.enabled ? 'redis' : 'in-memory (redis unreachable)' };
  }

  async onModuleDestroy() { this.client?.disconnect(); }
}

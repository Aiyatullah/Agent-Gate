import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from './redis.service.js';
import { MetricsService } from './metrics.service.js';

const LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 30);

/** Fixed-window per-minute limiter. Redis-backed when available (shared across instances), in-memory otherwise. */
@Injectable()
export class RateLimitService {
  private readonly mem = new Map<string, number[]>();

  constructor(private readonly redis: RedisService, private readonly metrics?: MetricsService) {}

  async check(tenantId: string, actorId: string) {
    const key = `${tenantId}:${actorId}`;
    if (this.redis.enabled) {
      try {
        const k = `ag:rl:${key}:${Math.floor(Date.now() / 60000)}`;
        const n = await this.redis.client!.incr(k);
        if (n === 1) await this.redis.client!.expire(k, 90);
        if (n > LIMIT) this.reject();
        return;
      } catch (e) { if (e instanceof HttpException) throw e; /* fall through to memory */ }
    }
    const now = Date.now();
    const prior = (this.mem.get(key) ?? []).filter(t => t > now - 60000);
    if (prior.length >= LIMIT) this.reject();
    prior.push(now);
    this.mem.set(key, prior);
  }

  private reject(): never {
    this.metrics?.inc('agent_gate_rate_limited_total');
    throw new HttpException(`Tenant agent limit: ${LIMIT} tool calls/minute.`, HttpStatus.TOO_MANY_REQUESTS);
  }
}

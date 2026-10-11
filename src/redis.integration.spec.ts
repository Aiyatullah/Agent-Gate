import { describe, expect, it } from 'vitest';
import { AppService } from './app.service.js';
import { ConnectorService } from './connector.service.js';
import { ExecutionService } from './execution.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { RedisService } from './redis.service.js';
import { MetricsService } from './metrics.service.js';

// Runs only when REDIS_URL points at a live Redis (CI service container or local).
describe.skipIf(!process.env.REDIS_URL)('redis + bullmq', () => {
  const admin = { sub: 'a1', tenantId: `t-${Date.now()}`, role: 'admin' as const, scopes: ['tools:read', 'tools:email:send'] };

  it('shares rate limits via redis and executes approved jobs through BullMQ', async () => {
    const redis = new RedisService();
    for (let i = 0; i < 50 && !redis.enabled; i++) await new Promise(r => setTimeout(r, 100));
    expect(redis.enabled).toBe(true);
    const exec = new ExecutionService(redis);
    const s = new AppService(undefined, exec, new RateLimitService(redis), new ConnectorService(), new MetricsService());
    expect(exec.mode).toBe('bullmq');

    const r = await s.invoke(admin, 'email-send', { to: 'a@b.c' }) as { approvalId: string };
    await s.decide(admin, r.approvalId, true);
    for (let i = 0; i < 50; i++) {
      if ((await s.listApprovals(admin))[0].executionStatus === 'completed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect((await s.listApprovals(admin))[0].executionStatus).toBe('completed');

    const limiter = new RateLimitService(redis);
    for (let i = 0; i < 30; i++) await limiter.check('rl-t', 'u');
    await expect(limiter.check('rl-t', 'u')).rejects.toThrow(/limit/);
    await exec.onModuleDestroy(); await redis.onModuleDestroy();
  }, 15000);
});

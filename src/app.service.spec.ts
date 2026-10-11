import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppService } from './app.service.js';
import { ConnectorService } from './connector.service.js';
import { ExecutionService } from './execution.service.js';
import { RedisService } from './redis.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { ProviderService } from './provider.service.js';
import { MetricsService } from './metrics.service.js';

const admin = { sub: 'a1', tenantId: 'tenant-a', role: 'admin' as const, scopes: ['tools:read', 'tools:email:send'] };
const otherAdmin = { ...admin, tenantId: 'tenant-b' };
const viewer = { sub: 'v1', tenantId: 'tenant-a', role: 'viewer' as const, scopes: [] };

const make = () => {
  const redis = new RedisService();
  const connector = new ConnectorService();
  const exec = new ExecutionService(redis);
  return { s: new AppService(undefined, exec, new RateLimitService(redis), connector, new MetricsService(), new ProviderService()), exec };
};

describe('policy gateway', () => {
  it('allows a scoped low-risk tool call and audits it', async () => {
    const { s } = make();
    expect((await s.invoke(admin, 'weather-proxy')).decision).toBe('allowed');
    expect((await s.listAudit(admin))[0].decision).toBe('allowed');
  });

  it('denies a viewer before execution', async () => {
    const { s } = make();
    await expect(s.invoke(viewer, 'weather-proxy')).rejects.toThrow(ForbiddenException);
    expect((await s.listAudit(admin))[0].decision).toBe('denied');
  });

  it('queues a high-risk call, then executes it on approval', async () => {
    const { s, exec } = make();
    const r = await s.invoke(admin, 'email-send', { to: 'a@b.c' }) as { decision: string; approvalId: string };
    expect(r.decision).toBe('pending_approval');
    expect((await s.decide(admin, r.approvalId, true)).status).toBe('approved');
    await exec.whenIdle();
    const [approval] = await s.listApprovals(admin);
    expect(approval.executionStatus).toBe('completed');
    expect((await s.listAudit(admin))[0].executionStatus).toBe('completed');
  });

  it('never dispatches a denied approval', async () => {
    const { s, exec } = make();
    const r = await s.invoke(admin, 'email-send') as { approvalId: string };
    const out = await s.decide(admin, r.approvalId, false);
    await exec.whenIdle();
    expect(out.executionStatus).toBe('blocked');
  });

  it('refuses to decide an approval twice', async () => {
    const { s } = make();
    const r = await s.invoke(admin, 'email-send') as { approvalId: string };
    await s.decide(admin, r.approvalId, true);
    await expect(s.decide(admin, r.approvalId, false)).rejects.toThrow(ConflictException);
  });

  it('isolates approvals and audit logs between tenants', async () => {
    const { s } = make();
    const r = await s.invoke(admin, 'email-send') as { approvalId: string };
    expect(await s.listApprovals(otherAdmin)).toHaveLength(0);
    expect(await s.listAudit(otherAdmin)).toHaveLength(0);
    await expect(s.decide(otherAdmin, r.approvalId, true)).rejects.toThrow(NotFoundException);
  });

  it('rate limits after 30 calls per minute', async () => {
    const { s } = make();
    for (let i = 0; i < 30; i++) await s.invoke(admin, 'weather-proxy');
    await expect(s.invoke(admin, 'weather-proxy')).rejects.toThrow(/limit/);
  });

  it('paginates audit logs', async () => {
    const { s } = make();
    for (let i = 0; i < 5; i++) await s.invoke(admin, 'weather-proxy');
    expect(await s.listAudit(admin, 2, 0)).toHaveLength(2);
    expect(await s.listAudit(admin, 2, 4)).toHaveLength(1);
  });

  it('replays without re-executing the tool', async () => {
    const { s } = make();
    await s.invoke(admin, 'weather-proxy');
    const [t] = await s.listAudit(admin);
    const spy = vi.spyOn(ConnectorService.prototype, 'execute');
    const out = await s.replay(admin, t.id);
    expect(out.sideEffectsReplayed).toBe(false);
    expect(out.comparison.map(c => c.provider)).toEqual(['mock-primary', 'mock-fallback']);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('connector', () => {
  const c = new ConnectorService();
  afterEach(() => { delete process.env.OUTBOUND_ALLOWLIST; vi.restoreAllMocks(); });

  it('rejects http, credentials, and unlisted hosts', async () => {
    process.env.OUTBOUND_ALLOWLIST = 'api.example.com';
    await expect(c.validateEndpoint('http://api.example.com/x')).rejects.toThrow(/https/);
    await expect(c.validateEndpoint('https://u:p@api.example.com/x')).rejects.toThrow(/credentials/);
    await expect(c.validateEndpoint('https://evil.com/x')).rejects.toThrow(/allowlist/);
  });

  it('rejects everything when no allowlist is configured', async () => {
    await expect(c.validateEndpoint('https://api.example.com/x')).rejects.toThrow(/allowlisted/);
  });

  it('blocks private IP targets even if allowlisted', async () => {
    process.env.OUTBOUND_ALLOWLIST = '169.254.169.254';
    await expect(c.validateEndpoint('https://169.254.169.254/latest')).rejects.toThrow(/private/);
  });

  it('enforces required input fields', async () => {
    const r = await c.execute({ id: 't', name: 't', slug: 't', kind: 'rest', scopes: [], risk: 'low', description: '', status: 'active', approvalMode: 'auto', inputRequired: ['q'] }, {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/q/);
  });
});

describe('providers', () => {
  it('falls back to the next provider when the first fails', async () => {
    const p = new ProviderService();
    const { selected, attempts } = await p.complete('hi', ['nope', 'mock-primary']);
    expect(attempts[0].ok).toBe(false);
    expect(selected?.provider).toBe('mock-primary');
  });
});

describe('secrets', () => {
  it('round-trips and rejects tampering', async () => {
    process.env.SECRETS_KEY = 'unit-test-key';
    const { encryptSecret, decryptSecret } = await import('./secrets.js');
    const blob = encryptSecret('s3cret');
    expect(blob).not.toContain('s3cret');
    expect(decryptSecret(blob)).toBe('s3cret');
    expect(() => decryptSecret(blob.replace(/.$/, c => (c === 'A' ? 'B' : 'A')))).toThrow();
  });
});

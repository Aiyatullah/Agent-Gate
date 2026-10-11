import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppService } from './app.service.js';

const admin = { sub: 'a1', tenantId: 'tenant-a', role: 'admin' as const, scopes: ['tools:read', 'tools:email:send'] };
const viewer = { sub: 'v1', tenantId: 'tenant-a', role: 'viewer' as const, scopes: [] };
describe('policy gateway', () => {
  it('allows a scoped low-risk tool call and audits it', async () => { const s=new AppService(); expect((await s.invoke(admin,'weather-proxy')).decision).toBe('allowed'); expect(s.listAudit(admin)[0].decision).toBe('allowed'); });
  it('denies a viewer before execution', async () => { const s=new AppService(); await expect(s.invoke(viewer,'weather-proxy')).rejects.toThrow(ForbiddenException); });
  it('queues a high-risk tool call and lets an admin approve it', async () => { const s=new AppService(); const result=await s.invoke(admin,'email-send') as { decision: string; approvalId: string }; expect(result.decision).toBe('pending_approval'); expect(s.decide(admin,result.approvalId,true).status).toBe('approved'); });
});

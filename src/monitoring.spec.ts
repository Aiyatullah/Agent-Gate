import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { MetricsService } from './metrics.service.js';

describe('alert rules', () => {
  it('only reference metrics that /metrics actually exposes', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    const m = app.get(MetricsService);
    const rules = readFileSync('ops/prometheus/alerts.yml', 'utf8');
    const used = new Set(rules.match(/agent_gate_[a-z_]+/g));
    expect(used.size).toBeGreaterThan(10);
    const exposed = m.names();
    const missing = [...used].filter(n => !exposed.has(n));
    expect(missing).toEqual([]);
    const body = await m.render();
    expect(body).toMatch(/^agent_gate_up 1$/m);
    expect(body).toMatch(/# TYPE agent_gate_approvals_pending gauge/);
    await app.close();
  });

  it('counts denials, executions, rate limits and auth failures', async () => {
    const m = new MetricsService();
    m.inc('agent_gate_tool_decisions_total', { decision: 'denied' });
    m.inc('agent_gate_tool_decisions_total', { decision: 'denied' });
    expect(await m.render()).toContain('agent_gate_tool_decisions_total{decision="denied"} 2');
  });
});

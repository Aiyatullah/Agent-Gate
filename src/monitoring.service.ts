import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppService } from './app.service.js';
import { DatabaseService } from './database.service.js';
import { ExecutionService } from './execution.service.js';
import { MetricsService } from './metrics.service.js';
import { RedisService } from './redis.service.js';

/** Registers operational gauges and metric help text. Alert rules in ops/prometheus/alerts.yml reference these names. */
@Injectable()
export class MonitoringService implements OnModuleInit {
  constructor(
    private readonly m: MetricsService, private readonly app: AppService, private readonly db: DatabaseService,
    private readonly redis: RedisService, private readonly exec: ExecutionService,
  ) {}

  onModuleInit() {
    const m = this.m;
    m.describe('agent_gate_tool_calls_total', 'Tool invocations received.');
    m.describe('agent_gate_tool_decisions_total', 'Policy decisions by outcome (allowed, denied, failed, pending_approval, ...).');
    m.describe('agent_gate_executions_total', 'Approved executions by final status.');
    m.describe('agent_gate_rate_limited_total', 'Calls rejected by the rate limiter.');
    m.describe('agent_gate_auth_failures_total', 'Requests rejected for missing or invalid credentials.');
    m.describe('agent_gate_mcp_requests_total', 'Remote MCP requests by auth outcome.');
    m.describe('agent_gate_api_keys_created_total', 'MCP API keys created.');

    for (const d of ['allowed', 'denied', 'failed', 'pending_approval']) m.init('agent_gate_tool_decisions_total', { decision: d });
    for (const st of ['completed', 'failed']) m.init('agent_gate_executions_total', { status: st });
    for (const o of ['authenticated', 'unauthorized']) m.init('agent_gate_mcp_requests_total', { outcome: o });
    for (const n of ['agent_gate_tool_calls_total', 'agent_gate_rate_limited_total', 'agent_gate_auth_failures_total', 'agent_gate_api_keys_created_total']) m.init(n);

    m.gauge('agent_gate_up', 'Always 1 while the process serves requests.', () => 1);
    m.gauge('agent_gate_uptime_seconds', 'Process uptime.', () => Math.round(process.uptime()));
    m.gauge('agent_gate_process_resident_memory_bytes', 'Resident memory of the API process.', () => process.memoryUsage().rss);
    m.gauge('agent_gate_db_configured', '1 when DATABASE_URL is set.', () => (this.db.enabled ? 1 : 0));
    m.gauge('agent_gate_db_up', '1 when Postgres answers (0 if configured but failing).', async () => {
      if (!this.db.enabled) return 1;
      try { return (await this.db.status()).connected ? 1 : 0; } catch { return 0; }
    });
    m.gauge('agent_gate_redis_configured', '1 when REDIS_URL is set.', () => (process.env.REDIS_URL ? 1 : 0));
    m.gauge('agent_gate_redis_up', '1 when Redis is connected (1 if not configured).', () => (process.env.REDIS_URL ? (this.redis.enabled ? 1 : 0) : 1));
    m.gauge('agent_gate_exec_queue_bullmq', '1 when executions run on BullMQ, 0 for the in-process fallback.', () => (this.exec.mode === 'bullmq' ? 1 : 0));
    m.gauge('agent_gate_exec_queue_waiting', 'Execution jobs waiting or delayed.', async () => (await this.exec.counts()).waiting);
    m.gauge('agent_gate_exec_queue_failed', 'Execution jobs in the failed set.', async () => (await this.exec.counts()).failed);
    m.gauge('agent_gate_approvals_pending', 'Approval requests awaiting an admin decision.', async () => (await this.app.pendingStats()).count);
    m.gauge('agent_gate_oldest_pending_approval_age_seconds', 'Age of the oldest pending approval (0 if none).', async () => (await this.app.pendingStats()).oldestAgeSec);
  }
}

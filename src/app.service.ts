import { ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DatabaseService, StoredTool, StoredTrace, StoredApproval } from './database.service.js';

export type Role = 'admin' | 'agent' | 'viewer';
export type Tool = StoredTool;

type Actor = { sub: string; tenantId: string; role: Role; scopes: string[]; actorName?: string; client?: string };
type Input = Record<string, unknown>;

const fallbackTools: Tool[] = [
  { id: 'weather-proxy', name: 'Weather REST proxy', slug: 'weather-proxy', kind: 'rest', scopes: ['tools:read'], risk: 'low', description: 'Fetches a normalized weather forecast.', status: 'active', approvalMode: 'auto' },
  { id: 'email-send', name: 'Send email', slug: 'email-send', kind: 'mcp', scopes: ['tools:email:send'], risk: 'high', description: 'MCP descriptor for a side-effecting email action.', status: 'active', approvalMode: 'required' },
];

const seedUsers = [
  { id: 'user-admin-01', name: 'Aiyatullah Admin', email: 'admin@acme.example', role: 'admin', status: 'active', agent: 'Orchestrator' },
  { id: 'agent-research-01', name: 'Research Agent', email: 'research-agent@acme.example', role: 'agent', status: 'active', agent: 'Claude Code' },
  { id: 'user-viewer-01', name: 'Audit Viewer', email: 'viewer@acme.example', role: 'viewer', status: 'active', agent: 'Codex CLI' },
];

@Injectable()
export class AppService {
  // In-memory fallback used when DATABASE_URL is not set
  private readonly memTraces: StoredTrace[] = [];
  private readonly memApprovals: StoredApproval[] = [];
  private readonly requests = new Map<string, number[]>();

  constructor(@Optional() private readonly db?: DatabaseService) {}

  health() { return { status: 'ok', service: 'agent-gate', at: new Date().toISOString() }; }

  // ── Tools ────────────────────────────────────────────────────────────────

  async rawTools(a: Actor) {
    if (!this.db?.enabled) return fallbackTools;
    const t = await this.db.listTools(a.tenantId);
    return t.length ? t : fallbackTools;
  }

  async listTools(a: Actor) {
    return (await this.rawTools(a)).filter(t =>
      (a.role === 'admin' || t.status === 'active') &&
      (a.role === 'admin' || t.scopes.some(s => a.scopes.includes(s))),
    );
  }

  async createTool(a: Actor, input: Omit<Tool, 'id'>) {
    if (a.role !== 'admin') throw new ForbiddenException('Only tenant admins can register tools.');
    if (!this.db?.enabled) throw new HttpException('Database is required to register tools.', HttpStatus.SERVICE_UNAVAILABLE);
    const tool = await this.db.createTool(a.tenantId, input);
    await this.trace(a, tool, 'tool_registered', 'Tool configuration saved.', {}, 'completed', 0);
    return tool;
  }

  async updateTool(a: Actor, id: string, patch: Partial<Pick<Tool, 'status' | 'approvalMode' | 'risk' | 'name' | 'description'>>) {
    if (a.role !== 'admin') throw new ForbiddenException('Only tenant admins can update tools.');
    if (!this.db?.enabled) throw new HttpException('Database is required to update tools.', HttpStatus.SERVICE_UNAVAILABLE);
    return this.db.updateTool(a.tenantId, id, patch);
  }

  async deleteTool(a: Actor, id: string) {
    if (a.role !== 'admin') throw new ForbiddenException('Only tenant admins can delete tools.');
    if (!this.db?.enabled) throw new HttpException('Database is required to delete tools.', HttpStatus.SERVICE_UNAVAILABLE);
    await this.db.deleteTool(a.tenantId, id);
    return { deleted: true };
  }

  // ── Audit logs ───────────────────────────────────────────────────────────

  async listAudit(a: Actor) {
    if (this.db && await this.db.migration4Ready()) return this.db.listAuditLogs(a.tenantId);
    return this.memTraces.filter(x => x.tenantId === a.tenantId).slice(0, 50);
  }

  // ── Approvals ────────────────────────────────────────────────────────────

  async listApprovals(a: Actor) {
    if (this.db && await this.db.migration4Ready()) return this.db.listApprovals(a.tenantId);
    return this.memApprovals.filter(x => x.tenantId === a.tenantId);
  }

  // ── Users (in-memory seed) ───────────────────────────────────────────────

  listUsers(a: Actor) {
    if (a.role !== 'admin') throw new ForbiddenException('Only tenant admins can list identities.');
    return seedUsers;
  }

  // ── Tool invocation ──────────────────────────────────────────────────────

  async invoke(a: Actor, toolId: string, input: Input = {}) {
    this.limit(a);
    const t = (await this.rawTools(a)).find(x => x.id === toolId || x.slug === toolId);
    if (!t) throw new NotFoundException('Tool is not registered for this tenant');

    const denied =
      t.status !== 'active' ||
      t.approvalMode === 'deny' ||
      a.role === 'viewer' ||
      (a.role !== 'admin' && !t.scopes.every(s => a.scopes.includes(s)));

    if (denied) {
      await this.trace(a, t, 'denied', 'Role, scope, or tool lifecycle policy denied this call.', input, 'blocked', 0);
      throw new ForbiddenException({ code: 'POLICY_DENIED', message: 'Your role, scopes, or tool policy do not permit this call.' });
    }

    if (t.risk === 'high' || t.approvalMode === 'required') {
      const tr = await this.trace(a, t, 'pending_approval', 'High-risk tool requires tenant-admin approval.', input, 'waiting_for_approval', 0);
      const approval: Omit<StoredApproval, 'id'> = {
        traceId: tr.traceId, tenantId: a.tenantId, toolId: t.id, toolName: t.name,
        actorName: tr.actorName, actorClient: tr.actorClient, inputSummary: tr.inputSummary,
        policyReason: tr.policyReason, status: 'pending', executionStatus: 'waiting_for_approval',
        createdAt: new Date().toISOString(),
      };
      if (this.db && await this.db.migration4Ready()) {
        const saved = await this.db.createApproval(a.tenantId, approval);
        return { decision: 'pending_approval', approvalId: saved.id, traceId: tr.traceId };
      }
      const mem: StoredApproval = { ...approval, id: crypto.randomUUID() };
      this.memApprovals.unshift(mem);
      return { decision: 'pending_approval', approvalId: mem.id, traceId: tr.traceId };
    }

    const tr = await this.trace(a, t, 'allowed', 'Tool scope and active policy passed.', input, 'completed', 12, 'mock-primary');
    return { decision: 'allowed', traceId: tr.traceId, output: { tool: t.name, source: 'mock-primary' } };
  }

  // ── Approval decision ────────────────────────────────────────────────────

  async decide(a: Actor, id: string, approve: boolean) {
    if (a.role !== 'admin') throw new ForbiddenException('Only tenant admins can decide approvals.');
    const status = approve ? 'approved' : 'denied';
    const executionStatus = approve ? 'approved_pending_execution' : 'blocked';
    const approvedBy = a.actorName ?? 'Tenant Admin';

    if (this.db && await this.db.migration4Ready()) {
      const updated = await this.db.updateApproval(id, { status, executionStatus, approvedBy });
      await this.db.updateAuditLog(updated.traceId, {
        decision: status, executionStatus,
        policyReason: approve ? 'Approved by tenant administrator.' : 'Denied by tenant administrator.',
        latencyMs: 8,
      });
      return updated;
    }

    const x = this.memApprovals.find(i => i.id === id && i.tenantId === a.tenantId);
    if (!x) throw new NotFoundException('Approval request was not found.');
    x.status = status as 'approved' | 'denied';
    x.executionStatus = executionStatus;
    x.approvedBy = approvedBy;
    const trace = this.memTraces.find(t => t.traceId === x.traceId);
    if (trace) {
      trace.decision = status;
      trace.executionStatus = executionStatus;
      trace.policyReason = approve ? 'Approved by tenant administrator.' : 'Denied by tenant administrator.';
      trace.latencyMs = 8;
    }
    return x;
  }

  // ── Replay ───────────────────────────────────────────────────────────────

  async replay(a: Actor, id: string) {
    const traces = await this.listAudit(a);
    const trace = traces.find(x => x.id === id);
    if (!trace) throw new NotFoundException('Trace was not found.');
    return {
      traceId: trace.traceId, toolName: trace.toolName,
      comparison: [
        { provider: 'mock-primary', result: 'allowed', latencyMs: 12, costUsd: 0.0002 },
        { provider: 'mock-fallback', result: 'allowed', latencyMs: 19, costUsd: 0.0001 },
      ],
    };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async trace(a: Actor, t: Tool, decision: string, policyReason: string, input: Input, executionStatus: string, latencyMs: number, provider?: string): Promise<StoredTrace> {
    const now = new Date().toISOString();
    const tr: Omit<StoredTrace, 'id'> = {
      traceId: `tr_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
      tenantId: a.tenantId, actorId: a.sub,
      actorName: a.actorName ?? (a.role === 'admin' ? 'Aiyatullah Admin' : 'Research Agent'),
      actorClient: a.client ?? (a.role === 'agent' ? 'Claude Code' : 'Dashboard'),
      toolId: t.id, toolName: t.name,
      inputSummary: this.summarize(input), decision, policyReason,
      executionStatus, latencyMs, provider, createdAt: now,
    };
    if (this.db && await this.db.migration4Ready()) return this.db.createAuditLog(a.tenantId, tr);
    const mem: StoredTrace = { ...tr, id: crypto.randomUUID() };
    this.memTraces.unshift(mem);
    return mem;
  }

  private summarize(input: Input) {
    const pairs = Object.entries(input)
      .filter(([k]) => !['password', 'token', 'secret', 'authorization'].includes(k.toLowerCase()))
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ').slice(0, 90)}`);
    return pairs.length ? pairs.join(' · ') : 'No arguments';
  }

  private limit(a: Actor) {
    const now = Date.now(), key = `${a.tenantId}:${a.sub}`;
    const prior = (this.requests.get(key) ?? []).filter(t => t > now - 60000);
    if (prior.length >= 30) throw new HttpException('Tenant agent limit: 30 tool calls/minute.', HttpStatus.TOO_MANY_REQUESTS);
    prior.push(now);
    this.requests.set(key, prior);
  }
}

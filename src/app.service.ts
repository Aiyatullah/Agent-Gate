import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DatabaseService, StoredTool, StoredTrace, StoredApproval } from './database.service.js';
import { ExecutionService, log } from './execution.service.js';
import type { ConnectorResult } from './connector.service.js';

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

  constructor(@Optional() private readonly db?: DatabaseService, @Optional() private readonly exec?: ExecutionService) {}

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

  async listAudit(a: Actor, limit = 50, offset = 0) {
    const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200), o = Math.max(Math.trunc(offset) || 0, 0);
    if (this.db && await this.db.migration4Ready()) return this.db.listAuditLogs(a.tenantId, n, o);
    return this.memTraces.filter(x => x.tenantId === a.tenantId).slice(o, o + n);
  }

  // ── Approvals ────────────────────────────────────────────────────────────

  async listApprovals(a: Actor) {
    if (this.db && await this.db.migration4Ready()) return this.db.listApprovals(a.tenantId);
    return this.memApprovals.filter(x => x.tenantId === a.tenantId).map(({ input: _i, ...rest }) => rest);
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
        createdAt: new Date().toISOString(), input,
      };
      if (this.db && await this.db.migration4Ready()) {
        const saved = await this.db.createApproval(a.tenantId, approval);
        log('info', 'approval_requested', { tenantId: a.tenantId, tool: t.slug, traceId: tr.traceId });
        return { decision: 'pending_approval', approvalId: saved.id, traceId: tr.traceId };
      }
      const mem: StoredApproval = { ...approval, id: crypto.randomUUID() };
      this.memApprovals.unshift(mem);
      return { decision: 'pending_approval', approvalId: mem.id, traceId: tr.traceId };
    }

    const started = Date.now();
    const r = this.exec ? await this.runNow(t, input) : undefined;
    const ok = r ? r.ok : true;
    const tr = await this.trace(a, t, ok ? 'allowed' : 'failed', ok ? 'Tool scope and active policy passed.' : `Execution failed: ${r?.error}`, input, ok ? 'completed' : 'failed', Date.now() - started, r?.simulated === false ? 'connector' : 'mock-primary', r?.output);
    log('info', 'tool_invoked', { tenantId: a.tenantId, tool: t.slug, decision: tr.decision, traceId: tr.traceId });
    return { decision: tr.decision, traceId: tr.traceId, output: r?.output ?? { tool: t.name, source: 'mock-primary' }, ...(ok ? {} : { error: r?.error }) };
  }

  // ── Approval decision ────────────────────────────────────────────────────

  async decide(a: Actor, id: string, approve: boolean) {
    if (a.role !== 'admin') throw new ForbiddenException('Only tenant admins can decide approvals.');
    const status = approve ? 'approved' : 'denied';
    const executionStatus = approve ? 'approved_pending_execution' : 'blocked';
    const approvedBy = a.actorName ?? 'Tenant Admin';
    const reason = approve ? 'Approved by tenant administrator.' : 'Denied by tenant administrator.';
    const useDb = Boolean(this.db && await this.db.migration4Ready());

    let x: StoredApproval | undefined;
    if (useDb) {
      const current = (await this.db!.listApprovals(a.tenantId)).find(i => i.id === id);
      if (!current) throw new NotFoundException('Approval request was not found.');
      if (current.status !== 'pending') throw new ConflictException('Approval was already decided.');
      x = await this.db!.updateApproval(a.tenantId, id, { status, executionStatus, approvedBy });
      await this.db!.updateAuditLog(a.tenantId, x.traceId, { decision: status, executionStatus, policyReason: reason, latencyMs: 8 });
    } else {
      x = this.memApprovals.find(i => i.id === id && i.tenantId === a.tenantId);
      if (!x) throw new NotFoundException('Approval request was not found.');
      if (x.status !== 'pending') throw new ConflictException('Approval was already decided.');
      x.status = status; x.executionStatus = executionStatus; x.approvedBy = approvedBy;
      const trace = this.memTraces.find(t => t.traceId === x!.traceId);
      if (trace) Object.assign(trace, { decision: status, executionStatus, policyReason: reason, latencyMs: 8 });
    }
    log('info', 'approval_decided', { tenantId: a.tenantId, approvalId: id, status });
    if (approve) await this.dispatch(a, x, useDb);
    const { input: _omit, ...safe } = x;
    return safe;
  }

  /** Queues an approved call on the execution worker; status moves to completed/failed asynchronously. */
  private async dispatch(a: Actor, x: StoredApproval, useDb: boolean) {
    if (!this.exec) return;
    const tool = (await this.rawTools(a)).find(t => t.id === x.toolId);
    if (!tool) { await this.finish(a, x, useDb, { ok: false, error: 'Tool no longer exists.', attempts: 0 }); return; }
    const input = x.input ?? (useDb ? await this.db!.getApprovalInput(a.tenantId, x.id) : {});
    this.exec.enqueue({ tool, input, done: r => this.finish(a, x, useDb, r) });
  }

  private async finish(a: Actor, x: StoredApproval, useDb: boolean, r: ConnectorResult) {
    const executionStatus = r.ok ? 'completed' : 'failed';
    x.executionStatus = executionStatus;
    const policyReason = r.ok ? 'Approved and executed.' : `Approved but execution failed: ${r.error}`;
    if (useDb) {
      await this.db!.updateApproval(a.tenantId, x.id, { status: 'approved', executionStatus, approvedBy: x.approvedBy ?? 'Tenant Admin' });
      await this.db!.updateAuditLog(a.tenantId, x.traceId, { executionStatus, policyReason, output: r.output, error: r.error });
    } else {
      const trace = this.memTraces.find(t => t.traceId === x.traceId);
      if (trace) Object.assign(trace, { executionStatus, policyReason, output: r.output });
    }
    log(r.ok ? 'info' : 'error', 'execution_finished', { tenantId: a.tenantId, approvalId: x.id, executionStatus, attempts: r.attempts, error: r.error });
  }

  private async runNow(t: Tool, input: Input): Promise<ConnectorResult & { simulated?: boolean }> {
    const done = new Promise<ConnectorResult>(res => this.exec!.enqueue({ tool: t, input, done: res }));
    const r = await done;
    return { ...r, simulated: r.simulated ?? false };
  }

  // ── Replay ───────────────────────────────────────────────────────────────

  /**
   * Safe replay: re-evaluates the recorded policy decision only. Tools are never
   * re-executed, so side-effecting calls cannot fire twice.
   */
  async replay(a: Actor, id: string) {
    const trace = (await this.listAudit(a, 200)).find(x => x.id === id);
    if (!trace) throw new NotFoundException('Trace was not found.');
    return {
      traceId: trace.traceId, toolName: trace.toolName, sideEffectsReplayed: false,
      original: { decision: trace.decision, executionStatus: trace.executionStatus, provider: trace.provider ?? null, latencyMs: trace.latencyMs, output: trace.output ?? null },
      comparison: [
        { provider: trace.provider ?? 'mock-primary', result: trace.decision, latencyMs: trace.latencyMs, costUsd: 0.0002 },
        { provider: 'mock-fallback', result: trace.decision, latencyMs: trace.latencyMs + 7, costUsd: 0.0001 },
      ],
    };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async trace(a: Actor, t: Tool, decision: string, policyReason: string, input: Input, executionStatus: string, latencyMs: number, provider?: string, output?: unknown): Promise<StoredTrace> {
    const now = new Date().toISOString();
    const tr: Omit<StoredTrace, 'id'> = {
      traceId: `tr_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
      tenantId: a.tenantId, actorId: a.sub,
      actorName: a.actorName ?? (a.role === 'admin' ? 'Aiyatullah Admin' : 'Research Agent'),
      actorClient: a.client ?? (a.role === 'agent' ? 'Claude Code' : 'Dashboard'),
      toolId: t.id, toolName: t.name,
      inputSummary: this.summarize(input), decision, policyReason,
      executionStatus, latencyMs, provider, createdAt: now, output,
    };
    if (this.db && await this.db.migration4Ready()) {
      const saved = await this.db.createAuditLog(a.tenantId, tr);
      if (output !== undefined) await this.db.updateAuditLog(a.tenantId, saved.traceId, { output });
      return saved;
    }
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

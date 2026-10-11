import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DatabaseService, StoredTool, StoredTrace, StoredApproval } from './database.service.js';
import { ExecutionService, ExecJob } from './execution.service.js';
import { ConnectorService, ConnectorResult } from './connector.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { MetricsService } from './metrics.service.js';
import { log } from './log.js';
import { ProviderService } from './provider.service.js';
import { AuthService } from './auth.service.js';

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

  constructor(
    @Optional() private readonly db?: DatabaseService,
    @Optional() private readonly exec?: ExecutionService,
    @Optional() private readonly rate?: RateLimitService,
    @Optional() private readonly connector?: ConnectorService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly providers?: ProviderService,
    @Optional() private readonly authSvc?: AuthService,
  ) {
    this.exec?.bind({ run: j => this.runJob(j), done: (j, r) => this.finish(j.tenantId, j.approvalId, j.traceId, r) });
  }

  health() { return { status: 'ok', service: 'agent-gate', at: new Date().toISOString() }; }

  // ── Tools ────────────────────────────────────────────────────────────────

  async rawTools(a: Pick<Actor, 'tenantId'>) {
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
    if (input.endpoint && this.connector) {
      try { await this.connector.validateEndpoint(input.endpoint); } catch (e) { throw new BadRequestException((e as Error).message); }
    }
    if (input.secret && !process.env.SECRETS_KEY) throw new BadRequestException('SECRETS_KEY must be configured to store tool secrets.');
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

  /** Pending approvals across all tenants, for metrics only. */
  async pendingStats() {
    if (this.db && await this.db.migration4Ready()) return this.db.pendingApprovalStats();
    const p = this.memApprovals.filter(x => x.status === 'pending');
    const oldest = p.length ? Math.min(...p.map(x => Date.parse(x.createdAt))) : Date.now();
    return { count: p.length, oldestAgeSec: Math.round((Date.now() - oldest) / 1000) };
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

  async listUsers(a: Actor) {
    if (a.role !== 'admin') throw new ForbiddenException('Only tenant admins can list identities.');
    if (!this.authSvc) return seedUsers;
    const real = await this.authSvc.listUsers(a.tenantId);
    return real.length ? real : seedUsers;
  }

  async setUserRole(a: Actor, userId: string, role: Role) {
    if (a.role !== 'admin') throw new ForbiddenException('Only tenant admins can assign access.');
    if (!['admin', 'agent', 'viewer'].includes(role)) throw new BadRequestException('Role must be admin, agent, or viewer.');
    if (userId === a.sub && role !== 'admin') throw new BadRequestException('You cannot remove your own admin access.');
    const r = await this.authSvc?.setRole(a.tenantId, userId, role);
    if (!r) throw new NotFoundException('User was not found in this tenant.');
    log('info', 'role_assigned', { tenantId: a.tenantId, userId, role });
    return r;
  }

  // ── Tool invocation ──────────────────────────────────────────────────────

  async invoke(a: Actor, toolId: string, input: Input = {}) {
    await this.rate?.check(a.tenantId, a.sub);
    this.metrics?.inc('agent_gate_tool_calls_total');
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
    const r = this.connector ? await this.runNow(a.tenantId, t, input) : undefined;
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
    const input = x.input ?? (useDb ? await this.db!.getApprovalInput(a.tenantId, x.id) : {});
    await this.exec.enqueue({ tenantId: a.tenantId, approvalId: x.id, traceId: x.traceId, toolId: x.toolId, input });
  }

  private async toolWithSecret(tenantId: string, toolId: string) {
    const tool = (await this.rawTools({ tenantId })).find(t => t.id === toolId);
    if (!tool) return {};
    const secret = this.db?.enabled && tool.hasSecret ? await this.db.getToolSecret(tenantId, tool.id) : undefined;
    return { tool, secret };
  }

  private async runJob(j: ExecJob): Promise<ConnectorResult> {
    const { tool, secret } = await this.toolWithSecret(j.tenantId, j.toolId);
    if (!tool) return { ok: false, error: 'Tool no longer exists.', attempts: 0 };
    return this.connector!.execute(tool, j.input, secret);
  }

  private async finish(tenantId: string, approvalId: string, traceId: string, r: ConnectorResult) {
    const executionStatus = r.ok ? 'completed' : 'failed';
    const policyReason = r.ok ? 'Approved and executed.' : `Approved but execution failed: ${r.error}`;
    if (this.db && await this.db.migration4Ready()) {
      await this.db.updateApproval(tenantId, approvalId, { status: 'approved', executionStatus });
      await this.db.updateAuditLog(tenantId, traceId, { executionStatus, policyReason, output: r.output, error: r.error });
    } else {
      const x = this.memApprovals.find(i => i.id === approvalId && i.tenantId === tenantId);
      if (x) x.executionStatus = executionStatus;
      const trace = this.memTraces.find(t => t.traceId === traceId);
      if (trace) Object.assign(trace, { executionStatus, policyReason, output: r.output });
    }
    this.metrics?.inc('agent_gate_executions_total', { status: executionStatus });
    log(r.ok ? 'info' : 'error', 'execution_finished', { tenantId, approvalId, executionStatus, attempts: r.attempts, error: r.error });
  }

  private async runNow(tenantId: string, t: Tool, input: Input): Promise<ConnectorResult> {
    const secret = this.db?.enabled && t.hasSecret ? await this.db.getToolSecret(tenantId, t.id) : undefined;
    const r = await this.connector!.execute(t, input, secret);
    return { ...r, simulated: r.simulated ?? false };
  }

  // ── Replay ───────────────────────────────────────────────────────────────

  /**
   * Safe replay/evaluation: asks one or more providers to review the recorded policy decision using
   * only sanitized trace metadata. Tools are never re-executed and raw input is never sent.
   */
  async replay(a: Actor, id: string, opts: { providers?: string[]; prompt?: string } = {}) {
    const trace = (await this.listAudit(a, 200)).find(x => x.id === id);
    if (!trace) throw new NotFoundException('Trace was not found.');
    const prompt = `${opts.prompt?.slice(0, 500) ?? 'Review this AI-agent tool policy decision and say whether it looks correct.'}\n` +
      `Tool: ${trace.toolName}\nDecision: ${trace.decision}\nReason: ${trace.policyReason}\nInput summary: ${trace.inputSummary}`;
    const names = opts.providers?.length ? opts.providers : this.providers?.available() ?? ['mock-primary', 'mock-fallback'];
    const results = this.providers ? await Promise.all(names.map(n => this.providers!.run(n, prompt))) : [];
    return {
      traceId: trace.traceId, toolName: trace.toolName, sideEffectsReplayed: false,
      original: { decision: trace.decision, executionStatus: trace.executionStatus, provider: trace.provider ?? null, latencyMs: trace.latencyMs, output: trace.output ?? null },
      comparison: results.map(r => ({ provider: r.provider, result: r.ok ? r.text : `error: ${r.error}`, latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd })),
    };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async trace(a: Actor, t: Tool, decision: string, policyReason: string, input: Input, executionStatus: string, latencyMs: number, provider?: string, output?: unknown): Promise<StoredTrace> {
    this.metrics?.inc('agent_gate_tool_decisions_total', { decision });
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
}

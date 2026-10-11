import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

export type StoredTool = {
  id: string; name: string; slug: string; kind: 'rest' | 'mcp';
  scopes: string[]; risk: 'low' | 'high'; description: string;
  status: 'draft' | 'active' | 'disabled'; approvalMode: 'auto' | 'required' | 'deny';
  endpoint?: string;
};

export type StoredTrace = {
  id: string; traceId: string; tenantId: string; actorId: string;
  actorName: string; actorClient: string; toolId: string; toolName: string;
  inputSummary: string; decision: string; policyReason: string;
  executionStatus: string; latencyMs: number; createdAt: string; provider?: string;
};

export type StoredApproval = {
  id: string; traceId: string; tenantId: string; toolId: string; toolName: string;
  actorName: string; actorClient: string; inputSummary: string; policyReason: string;
  status: 'pending' | 'approved' | 'denied'; executionStatus: string;
  createdAt: string; approvedBy?: string;
};

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : undefined;

  /** true only if pool exists AND migration 4 columns are present */
  private _migration4: boolean | null = null;

  async migration4Ready(): Promise<boolean> {
    if (!this.pool) return false;
    if (this._migration4 !== null) return this._migration4;
    try {
      await this.pool.query('select trace_id from public.audit_logs limit 0');
      this._migration4 = true;
    } catch {
      this._migration4 = false;
    }
    return this._migration4;
  }

  get enabled() { return Boolean(this.pool); }

  async status() {
    if (!this.pool) return { connected: false, mode: 'local-memory' };
    await this.pool.query('select 1');
    return { connected: true, mode: 'postgres' };
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  async listTools(tenantId: string): Promise<StoredTool[]> {
    if (!this.pool) return [];
    const r = await this.pool.query(
      `select id::text, name, slug, kind, scopes, risk,
              descriptor->>'description' description, status,
              approval_mode "approvalMode", endpoint
       from public.tools where tenant_id=$1 order by created_at desc`,
      [tenantId],
    );
    return r.rows;
  }

  async createTool(tenantId: string, tool: Omit<StoredTool, 'id'>): Promise<StoredTool> {
    if (!this.pool) throw new Error('Database is not configured.');
    const r = await this.pool.query(
      `insert into public.tools
         (tenant_id,name,slug,kind,scopes,risk,descriptor,status,approval_mode,endpoint)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning id::text, name, slug, kind, scopes, risk,
                 descriptor->>'description' description, status,
                 approval_mode "approvalMode", endpoint`,
      [tenantId, tool.name, tool.slug, tool.kind, tool.scopes, tool.risk,
        JSON.stringify({ description: tool.description }), tool.status, tool.approvalMode, tool.endpoint ?? null],
    );
    return r.rows[0];
  }

  async updateTool(tenantId: string, id: string, patch: Partial<Pick<StoredTool, 'status' | 'approvalMode' | 'risk' | 'name' | 'description'>>): Promise<StoredTool> {
    if (!this.pool) throw new Error('Database is not configured.');
    const sets: string[] = [];
    const vals: unknown[] = [tenantId, id];
    if (patch.status !== undefined) { sets.push(`status=$${vals.push(patch.status)}`); }
    if (patch.approvalMode !== undefined) { sets.push(`approval_mode=$${vals.push(patch.approvalMode)}`); }
    if (patch.risk !== undefined) { sets.push(`risk=$${vals.push(patch.risk)}`); }
    if (patch.name !== undefined) { sets.push(`name=$${vals.push(patch.name)}`); }
    if (patch.description !== undefined) { sets.push(`descriptor=jsonb_set(descriptor,'{description}',$${vals.push(JSON.stringify(patch.description))}::jsonb)`); }
    if (sets.length === 0) throw new Error('No fields to update.');
    const r = await this.pool.query(
      `update public.tools set ${sets.join(',')}
       where tenant_id=$1 and id=$2::uuid
       returning id::text, name, slug, kind, scopes, risk,
                 descriptor->>'description' description, status,
                 approval_mode "approvalMode", endpoint`,
      vals,
    );
    if (!r.rows[0]) throw new Error('Tool not found.');
    return r.rows[0];
  }

  async deleteTool(tenantId: string, id: string): Promise<void> {
    if (!this.pool) throw new Error('Database is not configured.');
    await this.pool.query('delete from public.tools where tenant_id=$1 and id=$2::uuid', [tenantId, id]);
  }

  // ── Audit logs ───────────────────────────────────────────────────────────

  async createAuditLog(tenantId: string, trace: Omit<StoredTrace, 'id'>): Promise<StoredTrace> {
    if (!this.pool) throw new Error('Database is not configured.');
    // Graceful no-op if migration 4 hasn't been applied yet
    try { await this.pool.query('select trace_id from public.audit_logs limit 0'); }
    catch { return { ...trace, id: crypto.randomUUID() }; }
    const r = await this.pool.query(
      `insert into public.audit_logs
         (tenant_id, actor_id, tool_id, tool_name, trace_id, actor_name, actor_client,
          input_summary, decision, policy_reason, execution_status, latency_ms, provider, input, created_at)
       values ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       returning id::text, trace_id "traceId", tool_name "toolName",
                 actor_name "actorName", actor_client "actorClient",
                 input_summary "inputSummary", decision, policy_reason "policyReason",
                 execution_status "executionStatus", latency_ms "latencyMs",
                 created_at::text "createdAt", provider`,
      [tenantId, trace.actorId, trace.toolId.includes('-') ? trace.toolId : null,
        trace.toolName, trace.traceId, trace.actorName, trace.actorClient,
        trace.inputSummary, trace.decision, trace.policyReason, trace.executionStatus,
        trace.latencyMs, trace.provider ?? null, '{}', trace.createdAt],
    );
    return { ...r.rows[0], tenantId, actorId: trace.actorId, toolId: trace.toolId };
  }

  async updateAuditLog(traceId: string, patch: Partial<Pick<StoredTrace, 'decision' | 'executionStatus' | 'policyReason' | 'latencyMs'>>): Promise<void> {
    if (!this.pool) return;
    const sets: string[] = [];
    const vals: unknown[] = [traceId];
    if (patch.decision !== undefined) sets.push(`decision=$${vals.push(patch.decision)}`);
    if (patch.executionStatus !== undefined) sets.push(`execution_status=$${vals.push(patch.executionStatus)}`);
    if (patch.policyReason !== undefined) sets.push(`policy_reason=$${vals.push(patch.policyReason)}`);
    if (patch.latencyMs !== undefined) sets.push(`latency_ms=$${vals.push(patch.latencyMs)}`);
    if (sets.length === 0) return;
    await this.pool.query(`update public.audit_logs set ${sets.join(',')} where trace_id=$1`, vals);
  }

  async listAuditLogs(tenantId: string, limit = 50): Promise<StoredTrace[]> {
    if (!this.pool) return [];
    try { await this.pool.query('select trace_id from public.audit_logs limit 0'); }
    catch { return []; }
    const r = await this.pool.query(
      `select id::text, trace_id "traceId", tool_name "toolName",
              actor_name "actorName", actor_client "actorClient",
              input_summary "inputSummary", decision, policy_reason "policyReason",
              execution_status "executionStatus", coalesce(latency_ms,0) "latencyMs",
              created_at::text "createdAt", provider,
              tenant_id::text "tenantId", actor_id::text "actorId",
              coalesce(tool_id::text,'') "toolId"
       from public.audit_logs where tenant_id=$1
       order by created_at desc limit $2`,
      [tenantId, limit],
    );
    return r.rows;
  }

  // ── Approvals ────────────────────────────────────────────────────────────

  async createApproval(tenantId: string, approval: Omit<StoredApproval, 'id'>): Promise<StoredApproval> {
    if (!this.pool) throw new Error('Database is not configured.');
    // Graceful no-op if migration 4 hasn't been applied yet
    try { await this.pool.query('select trace_id from public.approval_requests limit 0'); }
    catch { return { ...approval, id: crypto.randomUUID() }; }
    const r = await this.pool.query(
      `insert into public.approval_requests
         (tenant_id, tool_id, tool_name, trace_id, actor_name, actor_client,
          input_summary, policy_reason, status, execution_status, created_at)
       values ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id::text, trace_id "traceId", tool_id::text "toolId", tool_name "toolName",
                 actor_name "actorName", actor_client "actorClient",
                 input_summary "inputSummary", policy_reason "policyReason",
                 status, execution_status "executionStatus",
                 created_at::text "createdAt", approved_by "approvedBy"`,
      [tenantId, approval.toolId.includes('-') ? approval.toolId : null,
        approval.toolName, approval.traceId, approval.actorName, approval.actorClient,
        approval.inputSummary, approval.policyReason, approval.status,
        approval.executionStatus, approval.createdAt],
    );
    return { ...r.rows[0], tenantId };
  }

  async updateApproval(id: string, patch: { status: string; executionStatus: string; approvedBy: string }): Promise<StoredApproval> {
    if (!this.pool) throw new Error('Database is not configured.');
    const r = await this.pool.query(
      `update public.approval_requests
       set status=$2, execution_status=$3, approved_by=$4
       where id=$1::uuid
       returning id::text, trace_id "traceId", tool_id::text "toolId", tool_name "toolName",
                 actor_name "actorName", actor_client "actorClient",
                 input_summary "inputSummary", policy_reason "policyReason",
                 status, execution_status "executionStatus",
                 created_at::text "createdAt", approved_by "approvedBy",
                 tenant_id::text "tenantId"`,
      [id, patch.status, patch.executionStatus, patch.approvedBy],
    );
    if (!r.rows[0]) throw new Error('Approval not found.');
    return r.rows[0];
  }

  async listApprovals(tenantId: string): Promise<StoredApproval[]> {
    if (!this.pool) return [];
    try { await this.pool.query('select trace_id from public.approval_requests limit 0'); }
    catch { return []; }
    const r = await this.pool.query(
      `select id::text, trace_id "traceId", tool_id::text "toolId", tool_name "toolName",
              actor_name "actorName", actor_client "actorClient",
              input_summary "inputSummary", policy_reason "policyReason",
              status, execution_status "executionStatus",
              created_at::text "createdAt", approved_by "approvedBy"
       from public.approval_requests where tenant_id=$1
       order by created_at desc limit 50`,
      [tenantId],
    );
    return r.rows.map(row => ({ ...row, tenantId }));
  }

  async onModuleDestroy() { await this.pool?.end(); }
}

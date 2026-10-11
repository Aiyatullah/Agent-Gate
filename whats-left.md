# Agent Gate — what's done vs. what's left

## Already built / working

- NestJS API, OpenAPI, health route
- Next.js admin dashboard with working sidebar
- Tenant tool registry stored in Supabase
- Seed tenant, users, and tools
- JWT demo authentication and RBAC roles
- Scoped tool discovery
- High-risk approval queue (in-memory with Supabase path ready)
- Human-readable approval and audit trace UI
- MCP stdio server for Claude CLI
- Real MCP request → Agent Gate approval flow
- Tool registration from the UI
- Rate-limit logic
- Docker, CI, README/API groundwork from earlier phases
- **Edit / disable / delete tool workflow** (`PATCH /tools/:id`, `DELETE /tools/:id` + UI modals)
- **Refresh button + auto-poll** (5 s interval, pause/resume toggle, last-updated timestamp)
- **Empty states** on every table/list
- **Search / filter** on audit logs
- **CSV export** of audit logs
- **Architecture diagram** (built-in SVG in the Architecture tab: current vs. target callout)
- **Error state** with dismiss button on notice banner
- **`supabase/migrations/202610110004_persist_operations.sql`** — adds `trace_id`, `actor_name`, `actor_client`, `tool_name`, `input_summary`, `policy_reason`, `execution_status` columns to `audit_logs` and `approval_requests`; service detects columns at startup and routes to DB when present, otherwise stays in-memory

## Still on the plate before calling it production-level

> Items 1–10 from the original plan; status updated.

### 1. ✅ Persist operational data in Supabase  
Migration file written (`202610110004_persist_operations.sql`). `DatabaseService` exposes
`createAuditLog`, `updateAuditLog`, `listAuditLogs`, `createApproval`, `updateApproval`,
`listApprovals`. `AppService` routes to DB when `migration4Ready()` returns true (columns
present), otherwise uses in-memory. **Run the migration to activate full persistence.**

### 2. Real authentication/login  
The dashboard issues demo JWTs. Build real Supabase Auth login, logout, session handling,
tenant membership, and admin/agent/viewer access assignment.

### 3. ✅ Real execution worker (in-process)
`ExecutionService` queues approved calls and runs them through `ConnectorService`; records move
`approved_pending_execution` → `completed` / `failed` (output + error saved to `audit_logs`).
Tools without an endpoint stay governed dry-runs. Remaining: swap the in-process queue for
BullMQ so jobs survive restarts (see item 4). Requires migration `202610110005_execution_worker.sql`.

### 4. Redis + BullMQ  
Current rate limiting is in memory. Redis should own distributed rate limits,
approval/execution jobs, retries, and failure handling.

### 5. Real remote MCP endpoint  
Current Claude setup uses local `npx tsx mcp/server.ts` over stdio. For production, expose
a secured Streamable HTTP MCP route:
`https://api.yourdomain.com/mcp`  
Needs per-client authentication (OAuth/API keys/service identities) and must map each
caller to a tenant, role, and scopes.

### 6. ✅ Connect registered tools to real targets (partial)
Done: https-only endpoints, `OUTBOUND_ALLOWLIST` host allowlist, private-IP/SSRF block, no
redirects, timeout + retry with backoff (`CONNECTOR_TIMEOUT_MS`, `CONNECTOR_MAX_ATTEMPTS`),
required-input validation. Pending: encrypted per-tool secrets.

### 7. Provider fallback  
Current provider/replay output is mock data. Add real Claude/OpenAI provider adapters,
fallback behavior, token/cost capture, and provider selection in traces.

### 8. Replay/evaluation harness (partial)
Replay now returns the saved original decision/output and never re-executes tools
(`sideEffectsReplayed: false`). Pending: real provider comparison (item 7).

### 9. Complete multi-tenant enforcement (partial)
Fixed: approval decisions and audit updates are now tenant-scoped in SQL (previously an admin
of another tenant could decide by id), and decisions are single-shot (409 on repeat).
Pending: per-request RLS context and membership lookup (depends on item 2).

### 10. ✅ Production polish (partial)  
- ✅ Edit/disable/delete tool workflow  
- ✅ Search/filter/pagination for traces (search done; pagination pending)  
- ✅ Error states and empty states  
- ✅ Audit export (CSV)  
- ✅ Architecture diagram and write-up  
- ✅ Pagination for audit logs (`GET /audit-logs?limit=&offset=`)
- ✅ Unit + e2e tests (13 unit, 4 e2e) covering policy, approvals, tenant isolation, connector
- ✅ Structured JSON logs for invocations, approvals, and executions
- Deployment configuration and secret management — pending
- Monitoring/alerts — pending

---

### Current vs. Target (honest summary)

| | Current | Target |
|---|---|---|
| MCP transport | stdio (local `npx tsx`) | Streamable HTTP, per-client auth |
| Auth | demo JWTs | Supabase Auth (real login/logout) |
| Approvals/audit | in-memory (persisted to DB once migration 4 is applied) | always Supabase, multi-tenant RLS |
| Execution | in-process worker + guarded connector | BullMQ worker, encrypted secrets |
| Rate limiting | in-memory per-process | Redis distributed |
| Tools | allowlisted REST proxy | + encrypted secrets |

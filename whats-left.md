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

### 2. ✅ Real authentication/login (Better Auth)
Email/password sign-up/sign-in at `/api/auth/*`, bearer session tokens, dashboard login screen.
Roles are server-assigned (`ADMIN_EMAILS` bootstrap, everyone else `viewer`); admins assign access with
`PATCH /users/:id/role`. Tables are auto-created in Postgres on boot (`AUTH_AUTO_MIGRATE=false` to disable);
without `DATABASE_URL` it uses Better Auth's in-memory store. Demo JWTs are off by default in production.

### 3. ✅ Real execution worker
Approved calls run through the connector and move to `completed` / `failed`. Uses BullMQ when `REDIS_URL` is set
(durable, retried with backoff, multi-instance), otherwise an in-process queue.

### 4. ✅ Redis + BullMQ
`REDIS_URL` enables distributed rate limits (`RATE_LIMIT_PER_MINUTE`) and the BullMQ execution queue. Unset or
unreachable Redis falls back to in-memory. Verified against a live Redis (`src/redis.integration.spec.ts`, CI service).

### 5. ✅ Remote MCP endpoint
`POST /mcp` (Streamable HTTP, stateless). Per-client API keys from `MCP_CLIENTS` map to tenant/role/scopes; set
`MCP_PUBLIC_URL` for the public address. See `docs/mcp-clients.md`. Not implemented: OAuth flow for MCP clients.

### 6. ✅ Connect registered tools to real targets
https-only, host allowlist, SSRF block, timeouts/retries, input validation, and per-tool secrets encrypted with
AES-256-GCM (`SECRETS_KEY`), sent as a Bearer header and never returned by the API.

### 7. ✅ Provider adapters
Anthropic and OpenAI adapters with ordered fallback (`PROVIDER_ORDER`), token + cost capture. Mock providers when
no API keys are set. Used by replay. Not live-tested here (no API keys in this environment).

### 8. ✅ Replay/evaluation harness
`POST /audit-logs/:id/replay` `{providers?, prompt?}` sends only sanitized trace metadata to each provider and
never re-executes tools.

### 9. ✅ Multi-tenant enforcement
Tenant-scoped SQL everywhere, plus optional database-enforced RLS (`DB_RLS=true` runs each query as role
`authenticated` with `app.tenant_id` set). Not tested against Supabase here; enable in staging first.

### 10. Production polish
- ✅ Edit/disable/delete, search, pagination, CSV export, empty/error states, architecture diagram
- ✅ Unit, e2e, and Redis integration tests; CI runs them with a Redis service
- ✅ Structured JSON logs; `GET /metrics` (Prometheus text, optional `METRICS_TOKEN`)
- ✅ docker-compose with Redis, healthchecks, restart policy
- Pending: hosted deployment, alert rules on `/metrics`, API-key management UI

---

### Current vs. Target (honest summary)

| | Current | Target |
|---|---|---|
| MCP transport | stdio + Streamable HTTP with API keys | + OAuth |
| Auth | Better Auth sessions (demo JWTs dev-only) | + OAuth/SSO |
| Approvals/audit | in-memory (persisted to DB once migration 4 is applied) | always Supabase, multi-tenant RLS |
| Execution | BullMQ (Redis) or in-process + guarded connector, encrypted secrets | — |
| Rate limiting | Redis when `REDIS_URL` set, else in-memory | — |
| Tools | allowlisted REST proxy | + encrypted secrets |

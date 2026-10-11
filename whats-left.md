# Agent Gate — status, test plan, and setup

Branch: `claude/gifted-newton-4r3vo4`. Automated checks at the time of writing: 20 unit + 8 e2e tests pass (Redis integration test is skipped unless `REDIS_URL` points at a live Redis; it was run and passed against a local Redis), `oxlint` clean, API and web both build.

## 1. What's done

| Area | Status |
|---|---|
| NestJS API, OpenAPI (`/docs`), health (`/health` shows db/redis/queue mode) | ✅ |
| Next.js dashboard: registry, approvals, audit (search, CSV, pagination API), identities, architecture, empty/error states, auto-poll | ✅ |
| Tool registry in Supabase; edit / disable / delete; per-tool endpoint, required inputs, **encrypted bearer secret** | ✅ |
| Policy gate: scopes, roles, approval modes, tenant isolation; decisions are single-shot (409 on repeat) | ✅ |
| **Real login (Better Auth)**: email/password, bearer sessions, login screen, roles assigned server-side (`ADMIN_EMAILS`, `PATCH /users/:id/role`) | ✅ |
| **Execution worker**: approved calls run through the guarded connector → `completed` / `failed`; **BullMQ** when `REDIS_URL` is set, in-process otherwise | ✅ |
| **Redis**: distributed rate limiting + BullMQ; automatic in-memory fallback if unset/unreachable | ✅ |
| **Connector guardrails**: https only, host allowlist, private-IP/SSRF block, no redirects, timeout, retry/backoff, required-input check | ✅ |
| **Remote MCP** `POST /mcp` (Streamable HTTP, stateless) + stdio server kept | ✅ |
| **MCP API-key management (new)**: dashboard "API keys" page, create (shown once, stored as SHA-256 hash), revoke, last-used, per-key role (`agent`/`viewer`) and scopes, 50-key cap, admin-only, tenant-scoped; REST `GET/POST /api-keys`, `DELETE /api-keys/:id`; static `MCP_CLIENTS` keys still honored | ✅ |
| **Metrics (new/expanded)** `GET /metrics` (Prometheus text, optional `METRICS_TOKEN`): decisions, executions, rate-limit hits, auth failures, MCP auth outcomes, DB/Redis up, queue depth/failed, pending approvals + oldest age, memory, uptime | ✅ |
| **Alert rules (new)** `ops/prometheus/alerts.yml` — 16 rules (availability, DB/Redis, execution failures/ratio, queue backlog, stuck approvals, denial spike, rate-limit spike, auth/MCP probing); `prometheus.yml`, `alertmanager.yml`; `docker compose --profile monitoring up`. A unit test fails if a rule references a metric the API doesn't expose | ✅ |
| Provider adapters (Anthropic/OpenAI) with fallback, tokens + cost; safe replay (never re-executes tools) | ✅ (mock providers when no keys) |
| Optional DB-enforced RLS (`DB_RLS=true`) | ✅ code, ⚠️ not run against Supabase |
| Docker, compose (API + web + Redis + healthchecks), CI with Redis service, structured JSON logs | ✅ |

## 2. What's still open

- **Hosted deployment** (no cloud target was provided) — compose file is ready, nothing is deployed.
- **OAuth for MCP clients** (API keys only today) and **SSO / social login** (email+password only).
- **Alertmanager receiver**: `ops/alertmanager/alertmanager.yml` has a placeholder webhook URL.
- **Email verification / password reset** for Better Auth (needs an email provider).
- Live verification of: Supabase migrations 5–6, `DB_RLS=true`, Anthropic/OpenAI adapters (no keys/DB in the build environment).
- Key rotation helper for `SECRETS_KEY` (changing it invalidates stored tool secrets).

## 3. What to test (manual checklist)

1. **Migrations**: apply `supabase/migrations/202610110005_execution_worker.sql` and `…0006_mcp_api_keys.sql`. `GET /health` → `database.connected: true`.
2. **Login**: open the dashboard → create an account with an email listed in `ADMIN_EMAILS` → you land as admin. Sign up a second email → it is a viewer (writes return 403). Promote it via Identities API: `PATCH /users/<id>/role {"role":"agent"}`.
3. **API keys**: dashboard → *API keys* → Create key → copy it from the one-time dialog → confirm the list only shows `agk_xxxx…`. Then:
   `curl -X POST $API/mcp -H 'x-api-key: <key>' -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → 200. Revoke the key → same call → 401. Check *Last used* updates.
4. **Claude Code over HTTP**: `claude mcp add --transport http agent-gate $MCP_PUBLIC_URL --header "x-api-key: <key>"`, then ask it to list tools and request an email; approve it in the dashboard.
5. **Execution**: register a REST tool with an https endpoint on `OUTBOUND_ALLOWLIST` (+ a secret). Call it as an agent → approve → audit row shows `completed` and output. Point it at a bad host → `failed` with the reason. Try `http://` or a private IP → registration/execution is rejected.
6. **Redis**: set `REDIS_URL` → `/health` shows `redis.mode: "redis"`, `executionQueue: "bullmq"`. Stop Redis → API stays up, `/health` reports in-memory fallback, alert `AgentGateRedisDown` fires after 5 min.
7. **Rate limit**: fire >30 calls/min from one identity → 429, `agent_gate_rate_limited_total` increments.
8. **Metrics/alerts**: `curl -H "Authorization: Bearer $METRICS_TOKEN" $API/metrics`; run `docker compose --profile monitoring up`, open Prometheus `:9090/alerts` (16 rules loaded), Alertmanager `:9093`. Force a firing alert, e.g. leave an approval pending (lower the 3600 s threshold temporarily) or stop the API (`AgentGateDown`).
9. **RLS (staging only)**: set `DB_RLS=true`, repeat the flows above; every query should still succeed. A request for another tenant's approval id must 404.
10. **Replay**: `POST /audit-logs/<id>/replay` → `sideEffectsReplayed:false`; with `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` set, real tokens/cost appear.

Run locally: `npm test`, `npm run test:e2e`, `REDIS_URL=redis://localhost:6379 npm test` (adds the BullMQ integration test), `npm run lint`.

## 4. What to set up

1. **Supabase/Postgres**: run all migrations in `supabase/migrations/` in order (1→6). Better Auth creates its own `user/session/account/verification` tables on first boot (`AUTH_AUTO_MIGRATE=false` to do it yourself). Keep RLS enabled on them in Supabase.
2. **Secrets** (generate each with `openssl rand -base64 48`): `JWT_SECRET`, `BETTER_AUTH_SECRET`, `SECRETS_KEY`, `METRICS_TOKEN`.
3. **Production flags**: `NODE_ENV=production`, `ALLOW_DEMO_AUTH=false`, `WEB_ORIGIN` = dashboard URL, `BETTER_AUTH_URL` = API URL, `ADMIN_EMAILS` = your admin address(es) (set *before* that person signs up).
4. **Redis**: provision one (Upstash, Redis Cloud, ElastiCache…) and set `REDIS_URL`. Needed for multi-instance rate limits and durable executions.
5. **Remote MCP**: set `MCP_PUBLIC_URL` (e.g. `https://api.yourdomain.com/mcp`) behind HTTPS, then create keys in the dashboard. Don't put real keys in `.env`.
6. **Real tools**: set `OUTBOUND_ALLOWLIST` to the exact hosts tools may call.
7. **Monitoring**: write the same `METRICS_TOKEN` into `ops/prometheus/metrics_token` (the committed file holds a placeholder), set the webhook in `ops/alertmanager/alertmanager.yml`, then `docker compose --profile monitoring up -d`. If you use hosted Prometheus/Grafana, import `ops/prometheus/alerts.yml` as-is.
8. **Providers (optional)**: `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`, plus `PROVIDER_ORDER`.

### Environment reference
See `.env.example` — every variable is documented there, marked `[R]` required for production or `[O]` optional.

| Variable | Purpose | Default if unset |
|---|---|---|
| `DATABASE_URL` | Supabase/Postgres | in-memory mode (nothing persists, no tool registration) |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ADMIN_EMAILS`, `DEFAULT_TENANT_ID`, `ALLOW_DEMO_AUTH`, `AUTH_AUTO_MIGRATE` | login | memory users, demo tokens on outside production |
| `REDIS_URL`, `EXEC_QUEUE`, `EXEC_CONCURRENCY`, `EXEC_ATTEMPTS`, `RATE_LIMIT_PER_MINUTE` | BullMQ + rate limits | in-memory fallbacks, 30 calls/min |
| `OUTBOUND_ALLOWLIST`, `CONNECTOR_TIMEOUT_MS`, `CONNECTOR_MAX_ATTEMPTS`, `SECRETS_KEY` | tool connector + secrets | all outbound calls refused; secrets can't be stored |
| `MCP_PUBLIC_URL`, `MCP_CLIENTS` | remote MCP | endpoint works with dashboard-created keys |
| `ANTHROPIC_*`, `OPENAI_*`, `PROVIDER_ORDER`, `PROVIDER_PRICES` | replay providers | mock providers |
| `METRICS_TOKEN` | protects `/metrics` | `/metrics` is open — set it in production |
| `DB_RLS` | DB-enforced tenant isolation | off |

## 5. Current vs. target

| | Current | Target |
|---|---|---|
| MCP transport | stdio + Streamable HTTP with managed API keys | + OAuth |
| Auth | Better Auth sessions (demo JWTs dev-only) | + SSO, email verification |
| Approvals/audit | Supabase once migrations are applied; memory otherwise | always Supabase with `DB_RLS=true` |
| Execution | BullMQ (Redis) or in-process, guarded connector, encrypted secrets | same, verified in hosted env |
| Rate limiting | Redis when configured | — |
| Monitoring | `/metrics` + 16 alert rules + compose profile | hosted Prometheus/Grafana with a real receiver |

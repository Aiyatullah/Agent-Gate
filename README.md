# Agent Gate

Agent Gate is a multi-tenant control plane for AI agents invoking REST and MCP tools. It proves the safety path that matters in production: identify the caller, evaluate scope policy, queue high-risk actions for a human, and retain an attributable trace.

## What works today

| Capability | Demonstration |
| --- | --- |
| Tool registry | REST and MCP-style tool descriptors with scope filtering |
| RBAC | `admin`, `agent`, and `viewer` identities signed as JWTs for local demo |
| Policy gateway | clear allow/deny decisions before a tool executes |
| HITL | high-risk email action waits in a tenant approval queue |
| Observability | allow, deny, approval and provider labels appear in traces |
| Replay/evaluation | replay endpoint compares deterministic primary/fallback mock providers |
| Data isolation | Supabase schema and row-level-security policy migration |

## Architecture

See [the one-page architecture write-up](docs/architecture.md). The runtime path is:

`agent -> JWT -> policy/RBAC -> REST or MCP adapter -> audit trace`

## Run locally

Prerequisites: Node 22+, npm, and a Postgres/Supabase URL. Copy `.env.example` to `.env` and set `DATABASE_URL` and a long `JWT_SECRET`.

```powershell
# API
npm install --legacy-peer-deps
npm run start:dev

# dashboard, separate terminal
cd apps/web
npm install --legacy-peer-deps
npm run dev -- -p 3001
```

- Dashboard: `http://localhost:3001`
- API docs: `http://localhost:3000/docs`
- Health: `http://localhost:3000/health`

## Demo script

1. Open the dashboard and click **Test risky action**.
2. The email tool changes from an attempted action into a pending approval.
3. Approve or deny it from the approval queue.
4. View each policy decision in the trace table.
5. In Swagger, use `POST /auth/demo-token` to mint a bearer token; invoke `POST /tools/weather-proxy/calls` for an allowed call or `POST /tools/email-send/calls` for a paused call.

Import [the Postman collection](postman/Agent-Gate.postman_collection.json) for the same flow.

## Verification

```powershell
npm run build
npm test
npm run test:e2e
cd apps/web; npm run build
```

## Docker

Docker is included for API reproducibility. `docker build -t agent-gate-api .` builds the service. `docker compose up --build` runs API and dashboard together. For an actual deployment, supply secrets through the platform secret manager rather than an `.env` file.

## Production next steps

The demo has a real Supabase schema but intentionally retains deterministic in-memory registry and trace data so it runs without seed records. The next production hardening step is repository-backed persistence with a transaction-local tenant context taken only from a verified issuer/JWKS token. Redis/BullMQ is the intended distributed rate-limit and asynchronous approval delivery layer.

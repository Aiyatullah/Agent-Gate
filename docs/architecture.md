# Agent Gate architecture

```text
Agent / dashboard -> JWT -> Nest policy gateway -> REST or MCP adapter
                              |      |                 |
                              |      +-> approval queue +-> primary / fallback provider
                              +-> audit trace -> Postgres / Supabase
```

Every request carries a verified tenant claim. The gateway evaluates role and required tool scopes before an adapter is called. Side-effecting tools return `pending_approval`; only a tenant admin can resolve the request. The audit trail records allow, deny and approval decisions.

## Security choices

- The browser has no database secret; it only receives `NEXT_PUBLIC_API_URL`.
- Tenant data has Supabase RLS enabled. In production, repositories must set a transaction-local tenant context from a verified token; client input is never trusted for tenant choice.
- Service credentials remain server-side in `.env`, which Git ignores.
- Demo JWTs exist only for local demonstrations. Production must validate issuer/JWKS and use a long random `JWT_SECRET` only for internal tokens.

## Trade-offs

The starter keeps the tool registry and policy state deterministic in memory so an interviewer can run it without seed data. The applied Supabase schema is ready for persistence. Redis/BullMQ is deliberately an interface boundary for distributed limiting and queued approval delivery rather than an unnecessary dependency for the demo.

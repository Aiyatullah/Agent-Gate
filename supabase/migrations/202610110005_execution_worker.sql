-- Execution worker support: keep the approved input so the worker can dispatch it.
alter table public.approval_requests add column if not exists input jsonb not null default '{}'::jsonb;
alter table public.audit_logs add column if not exists output jsonb;
alter table public.audit_logs add column if not exists error text;
create index if not exists audit_logs_tenant_created_idx on public.audit_logs(tenant_id, created_at desc);

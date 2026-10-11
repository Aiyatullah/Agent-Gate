-- Extend audit_logs with full trace columns
alter table public.audit_logs
  add column if not exists trace_id   text,
  add column if not exists actor_name text,
  add column if not exists actor_client text,
  add column if not exists tool_name  text,
  add column if not exists input_summary text,
  add column if not exists policy_reason text,
  add column if not exists execution_status text not null default 'completed';

create index if not exists audit_logs_tenant_created
  on public.audit_logs(tenant_id, created_at desc);

-- Extend approval_requests with full approval columns
alter table public.approval_requests
  add column if not exists trace_id   text,
  add column if not exists tool_name  text,
  add column if not exists actor_name text,
  add column if not exists actor_client text,
  add column if not exists input_summary text,
  add column if not exists policy_reason text,
  add column if not exists execution_status text not null default 'waiting_for_approval',
  add column if not exists approved_by text;

create index if not exists approval_requests_tenant_status
  on public.approval_requests(tenant_id, status, created_at desc);

-- Allow service-role writes to bypass RLS for the API
create policy "service role bypass" on public.audit_logs
  for all to service_role using (true) with check (true);

create policy "service role bypass" on public.approval_requests
  for all to service_role using (true) with check (true);

create policy "service role bypass" on public.tools
  for all to service_role using (true) with check (true);

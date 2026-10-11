insert into public.tenants (id, name) values ('00000000-0000-0000-0000-000000000001', 'Acme') on conflict (id) do nothing;
create table if not exists public.agent_identities (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id), display_name text not null, email text not null, role text not null check (role in ('admin','agent','viewer')), client_type text not null, status text not null default 'active', created_at timestamptz not null default now(), unique (tenant_id, email));
alter table public.agent_identities enable row level security;
create policy "tenant isolation identities" on public.agent_identities for all to authenticated using (tenant_id::text = current_setting('app.tenant_id', true)) with check (tenant_id::text = current_setting('app.tenant_id', true));
insert into public.agent_identities (tenant_id, display_name, email, role, client_type) values
('00000000-0000-0000-0000-000000000001', 'Aiyatullah Admin', 'admin@acme.example', 'admin', 'Dashboard'),
('00000000-0000-0000-0000-000000000001', 'Research Agent', 'research-agent@acme.example', 'agent', 'Claude Code'),
('00000000-0000-0000-0000-000000000001', 'Audit Viewer', 'viewer@acme.example', 'viewer', 'Codex CLI')
on conflict (tenant_id, email) do nothing;

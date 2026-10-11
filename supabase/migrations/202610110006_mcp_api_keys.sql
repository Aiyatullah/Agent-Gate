-- Managed MCP API keys. Only a SHA-256 hash is stored; the plaintext key is shown once at creation.
create table if not exists public.mcp_api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  prefix text not null,
  role text not null check (role in ('agent','viewer')),
  scopes text[] not null default '{}',
  created_by text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists mcp_api_keys_tenant_idx on public.mcp_api_keys(tenant_id, created_at desc);
alter table public.mcp_api_keys enable row level security;
drop policy if exists "tenant isolation api keys" on public.mcp_api_keys;
create policy "tenant isolation api keys" on public.mcp_api_keys for all to authenticated
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

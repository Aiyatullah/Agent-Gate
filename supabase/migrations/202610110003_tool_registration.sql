alter table public.tools add column if not exists slug text;
alter table public.tools add column if not exists status text not null default 'draft' check (status in ('draft','active','disabled'));
alter table public.tools add column if not exists approval_mode text not null default 'required' check (approval_mode in ('auto','required','deny'));
alter table public.tools add column if not exists endpoint text;
create unique index if not exists tools_tenant_slug_key on public.tools(tenant_id, slug) where slug is not null;
insert into public.tools (id, tenant_id, name, slug, kind, scopes, risk, descriptor, status, approval_mode) values
('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Weather REST proxy','weather-proxy','rest',array['tools:read'],'low','{"description":"Fetches a normalized weather forecast."}'::jsonb,'active','auto'),
('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Send email','email-send','mcp',array['tools:email:send'],'high','{"description":"MCP descriptor for a side-effecting email action."}'::jsonb,'active','required')
on conflict (id) do nothing;

'use client';
import { FormEvent, useEffect, useState } from 'react';

type Tool = { id: string; name: string; slug: string; kind: string; risk: string; scopes: string[]; description: string; status: string; approvalMode: string; endpoint?: string };
type Audit = { id: string; traceId: string; toolName: string; actorName: string; actorClient: string; inputSummary: string; decision: string; policyReason: string; executionStatus: string; latencyMs: number; createdAt: string };
type Approval = { id: string; traceId: string; toolName: string; actorName: string; actorClient: string; inputSummary: string; policyReason: string; status: string; executionStatus: string; createdAt: string; approvedBy?: string };
type User = { id: string; name: string; email: string; role: string; status: string; agent: string };

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const NAV = ['Overview', 'Tool registry', 'Policies', 'Approvals', 'Audit logs', 'Identities', 'Architecture', 'Usage'];
const POLL_MS = 5000;

const Badge = ({ value }: { value: string }) => (
  <span className={`status ${/allow|active|completed|approved/.test(value) ? 'allowed' : /pending|approval|waiting|high/.test(value) ? 'pending' : /deny|block|disabled|draft/.test(value) ? 'denied' : 'info'}`}>
    {value.replaceAll('_', ' ')}
  </span>
);

const fmt = (x: string) => new Date(x).toLocaleString();

const Empty = ({ msg }: { msg: string }) => (
  <p className="p-8 text-center editorial text-xl" style={{ color: 'var(--text-2)' }}>{msg}</p>
);

export default function Home() {
  const [active, setActive] = useState('Overview');
  const [tools, setTools] = useState<Tool[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState(false);
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [trace, setTrace] = useState<Audit | null>(null);
  const [editTool, setEditTool] = useState<Tool | null>(null);
  const [auditSearch, setAuditSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const [needLogin, setNeedLogin] = useState(false);
  const [authMode, setAuthMode] = useState<'in' | 'up'>('in');
  const stored = () => { try { return localStorage.getItem('ag_token'); } catch { return null; } };

  const signOut = () => { try { localStorage.removeItem('ag_token'); } catch { /* ignore */ } setNeedLogin(true); setTools([]); setAudit([]); setApprovals([]); setUsers([]); };

  const submitAuth = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await fetch(`${API}/api/auth/sign-${authMode === 'in' ? 'in' : 'up'}/email`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: f.get('email'), password: f.get('password'), name: f.get('name') || String(f.get('email')).split('@')[0] }),
    });
    const t = r.headers.get('set-auth-token');
    if (!r.ok || !t) { setNotice((await r.json().catch(() => ({}))).message ?? 'Sign-in failed'); return; }
    try { localStorage.setItem('ag_token', t); } catch { /* ignore */ }
    setNotice(''); setNeedLogin(false); await load();
  };

  const token = async () => {
    const saved = stored();
    if (saved) return saved;
    const r = await fetch(`${API}/auth/demo-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) });
    if (!r.ok) { setNeedLogin(true); throw Error('Please sign in.'); }
    return (await r.json()).accessToken as string;
  };

  const req = async (path: string, method = 'GET', body?: unknown) => {
    const t = await token();
    const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { try { localStorage.removeItem('ag_token'); } catch { /* ignore */ } setNeedLogin(true); }
    if (!r.ok) throw Error((await r.json()).message ?? 'Request failed');
    return r.json();
  };

  const load = async () => {
    try {
      const [t, a, p, u] = await Promise.all([req('/tools'), req('/audit-logs'), req('/approvals'), req('/users')]);
      setTools(t); setAudit(a); setApprovals(p); setUsers(u);
      setLastRefreshed(new Date());
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not load Agent Gate');
    }
  };

  // Initial load
  useEffect(() => { void load(); }, []);

  // Auto-poll
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [autoRefresh]);

  const invoke = async () => {
    setBusy(true);
    try {
      await req('/tools/email-send/calls', 'POST', { to: 'demo@example.com', subject: 'Governed test', body: 'Dashboard test action.' });
      setActive('Approvals');
      setNotice('Risky action is waiting for admin approval. No email was sent.');
      await load();
    } finally { setBusy(false); }
  };

  const decide = async (id: string, d: string) => {
    setBusy(true);
    try {
      await req(`/approvals/${id}/${d}`, 'POST');
      setNotice(`Request ${d}d. The decision is recorded; this demo does not dispatch email.`);
      await load();
    } finally { setBusy(false); }
  };

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true);
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name'));
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    try {
      await req('/tools', 'POST', { name, slug, kind: f.get('kind'), description: f.get('description'), scopes: String(f.get('scopes')).split(',').map(x => x.trim()).filter(Boolean), risk: f.get('risk'), status: f.get('status'), approvalMode: f.get('approvalMode'), endpoint: f.get('endpoint') || undefined, secret: f.get('secret') || undefined, inputRequired: String(f.get('inputRequired') ?? '').split(',').map(x => x.trim()).filter(Boolean) });
      setForm(false); setNotice('Tool registered and governed by tenant policy.'); await load();
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not register tool'); }
    finally { setBusy(false); }
  };

  const saveTool = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); if (!editTool) return; setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await req(`/tools/${editTool.id}`, 'PATCH', { status: f.get('status'), approvalMode: f.get('approvalMode'), risk: f.get('risk') });
      setEditTool(null); setNotice('Tool updated.'); await load();
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not update tool'); }
    finally { setBusy(false); }
  };

  const removeTool = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await req(`/tools/${id}`, 'DELETE'); setNotice('Tool deleted.'); await load();
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not delete tool'); }
    finally { setBusy(false); }
  };

  const exportCSV = () => {
    const rows = [['Trace ID', 'Tool', 'Actor', 'Client', 'Decision', 'Execution', 'Latency ms', 'Time']];
    audit.forEach(a => rows.push([a.traceId, a.toolName, a.actorName, a.actorClient, a.decision, a.executionStatus, String(a.latencyMs), a.createdAt]));
    const csv = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `audit-${Date.now()}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const filteredAudit = auditSearch
    ? audit.filter(a => [a.toolName, a.actorName, a.traceId, a.decision].some(v => v?.toLowerCase().includes(auditSearch.toLowerCase())))
    : audit;

  const pendingCount = approvals.filter(a => a.status === 'pending').length;

  if (needLogin) {
    return (
      <main className="mx-auto mt-24 max-w-sm p-6">
        <form className="panel grid gap-3 p-6" onSubmit={e => void submitAuth(e)}>
          <h1 className="editorial text-3xl">Agent Gate</h1>
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>{authMode === 'in' ? 'Sign in to your tenant.' : 'Create an account. New accounts start as viewers until an admin assigns access.'}</p>
          {authMode === 'up' && <label>Name<input name="name" autoComplete="name" /></label>}
          <label>Email<input required type="email" name="email" autoComplete="email" /></label>
          <label>Password<input required type="password" name="password" minLength={10} autoComplete={authMode === 'in' ? 'current-password' : 'new-password'} /></label>
          {notice && <p role="alert" className="text-sm">{notice}</p>}
          <button className="primary" type="submit">{authMode === 'in' ? 'Sign in' : 'Create account'}</button>
          <button type="button" className="secondary" onClick={() => { setAuthMode(authMode === 'in' ? 'up' : 'in'); setNotice(''); }}>{authMode === 'in' ? 'Need an account?' : 'Have an account?'}</button>
        </form>
      </main>
    );
  }

  // ── Sections ─────────────────────────────────────────────────────────────

  const Overview = (
    <div className="grid gap-4 md:grid-cols-4">
      {([['Active tools', tools.filter(t => t.status === 'active').length], ['Needs approval', pendingCount], ['Decision traces', audit.length], ['Tenant identities', users.length]] as [string, number][]).map(([n, v]) => (
        <article className="panel p-5" key={n}>
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>{n}</p>
          <p className="mt-3 text-3xl font-semibold">{v}</p>
        </article>
      ))}
    </div>
  );

  const Registry = (
    <div className="panel overflow-x-auto">
      <div className="flex items-center justify-between border-b p-5" style={{ borderColor: 'var(--line)' }}>
        <div><p className="text-xl font-semibold">Tool registry</p><p style={{ color: 'var(--text-2)' }}>Register REST or MCP tools, then choose their approval policy.</p></div>
        <button className="primary" onClick={() => setForm(true)}>Register tool</button>
        {stored() && <button className="secondary ml-2" onClick={signOut}>Sign out</button>}
      </div>
      {tools.length === 0
        ? <Empty msg="No tools registered yet. Register your first tool to get started." />
        : (
          <table className="w-full min-w-[800px] text-left">
            <thead style={{ background: 'var(--raised)', color: 'var(--text-3)' }}>
              <tr><th className="p-4">Tool</th><th>Protocol</th><th>Scopes</th><th>Policy</th><th>Status</th><th className="text-right pr-4">Actions</th></tr>
            </thead>
            <tbody>
              {tools.map(t => (
                <tr key={t.id} className="border-t" style={{ borderColor: 'var(--line)' }}>
                  <td className="p-4"><b>{t.name}</b><p className="text-xs" style={{ color: 'var(--text-3)' }}>{t.description}</p></td>
                  <td>{t.kind}</td>
                  <td>{t.scopes.map(s => <code className="scope mr-1" key={s}>{s}</code>)}</td>
                  <td>{t.approvalMode}</td>
                  <td><Badge value={t.status} /></td>
                  <td className="p-4 text-right">
                    <button className="secondary mr-2" onClick={() => setEditTool(t)}>Edit</button>
                    <button disabled={busy} className="secondary" style={{ color: 'var(--denied, #c0392b)' }} onClick={() => void removeTool(t.id, t.name)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );

  const ApprovalsSection = (
    <div className="panel">
      <div className="border-b p-5" style={{ borderColor: 'var(--line)' }}>
        <p className="text-xl font-semibold">Approval queue</p>
        <p style={{ color: 'var(--text-2)' }}>High-risk actions cannot execute until a tenant admin decides.</p>
      </div>
      {approvals.length === 0
        ? <Empty msg="No actions require your attention." />
        : approvals.map(a => (
          <article key={a.id} className="border-b p-5" style={{ borderColor: 'var(--line)' }}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-3xl">
                <div className="flex flex-wrap gap-2"><b>{a.toolName}</b><Badge value={a.status} /><Badge value={a.executionStatus} /></div>
                <p className="mt-2 text-sm" style={{ color: 'var(--text-2)' }}>Requested by <b>{a.actorName}</b> via {a.actorClient} · {fmt(a.createdAt)}</p>
                <p className="mt-2 rounded-md px-3 py-2 text-sm" style={{ background: 'var(--raised)' }}><span style={{ color: 'var(--text-3)' }}>Request: </span>{a.inputSummary}</p>
                <p className="mt-2 text-xs" style={{ color: 'var(--text-3)' }}>{a.policyReason} · Trace <span className="mono">{a.traceId}</span>{a.approvedBy ? ` · Decided by ${a.approvedBy}` : ''}</p>
              </div>
              {a.status === 'pending' && (
                <div className="flex gap-2">
                  <button disabled={busy} className="primary" onClick={() => void decide(a.id, 'approve')}>Approve</button>
                  <button disabled={busy} className="secondary" onClick={() => void decide(a.id, 'deny')}>Deny</button>
                </div>
              )}
            </div>
          </article>
        ))}
    </div>
  );

  const AuditSection = (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5" style={{ borderColor: 'var(--line)' }}>
        <div>
          <p className="text-xl font-semibold">Decision traces</p>
          <p style={{ color: 'var(--text-2)' }}>Every decision is attributable. Risky calls must be requested again instead of replayed.</p>
        </div>
        <div className="flex gap-2">
          <input className="rounded-md border px-3 py-1.5 text-sm" style={{ borderColor: 'var(--line)', background: 'var(--raised)' }} placeholder="Search traces…" value={auditSearch} onChange={e => setAuditSearch(e.target.value)} />
          <button className="secondary" onClick={exportCSV}>Export CSV</button>
        </div>
      </div>
      {filteredAudit.length === 0
        ? <Empty msg={auditSearch ? 'No traces match your search.' : 'No decision traces yet. Invoke a tool to see traces here.'} />
        : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left">
              <thead style={{ background: 'var(--raised)', color: 'var(--text-3)' }}>
                <tr><th className="p-4">Tool</th><th>Requested by</th><th>Safe input summary</th><th>Decision</th><th>Execution</th><th>Time</th><th /></tr>
              </thead>
              <tbody>
                {filteredAudit.map(a => (
                  <tr key={a.id} className="border-t align-top" style={{ borderColor: 'var(--line)' }}>
                    <td className="p-4"><b>{a.toolName}</b><p className="mono mt-1 text-[10px]" style={{ color: 'var(--text-3)' }}>{a.traceId}</p></td>
                    <td className="p-4 text-sm"><b>{a.actorName}</b><p style={{ color: 'var(--text-3)' }}>{a.actorClient}</p></td>
                    <td className="p-4 text-sm" style={{ maxWidth: 260 }}>{a.inputSummary}</td>
                    <td className="p-4"><Badge value={a.decision} /><p className="mt-2 text-xs" style={{ color: 'var(--text-3)' }}>{a.policyReason}</p></td>
                    <td className="p-4"><Badge value={a.executionStatus} /><p className="mono mt-2 text-xs">{a.latencyMs} ms</p></td>
                    <td className="p-4 text-xs" style={{ color: 'var(--text-3)' }}>{fmt(a.createdAt)}</td>
                    <td className="p-4"><button className="secondary" onClick={() => setTrace(a)}>View trace</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {trace && (
        <section className="m-5 rounded-lg border p-4" style={{ borderColor: 'var(--line)', background: 'var(--raised)' }}>
          <div className="flex justify-between"><b>Trace {trace.traceId}</b><button onClick={() => setTrace(null)}>×</button></div>
          <p className="mt-3 text-sm"><b>{trace.toolName}</b> requested by {trace.actorName} via {trace.actorClient}.</p>
          <p className="mt-2 text-sm">{trace.inputSummary}</p>
          <p className="mt-2 text-xs" style={{ color: 'var(--text-3)' }}>{trace.policyReason}</p>
        </section>
      )}
    </div>
  );

  const Identities = (
    <div className="panel overflow-x-auto">
      <div className="border-b p-5" style={{ borderColor: 'var(--line)' }}>
        <p className="text-xl font-semibold">Identities & access</p>
        <p style={{ color: 'var(--text-2)' }}>Roles decide who can manage, invoke, or observe Agent Gate.</p>
      </div>
      {users.length === 0
        ? <Empty msg="No identities found." />
        : (
          <table className="w-full text-left">
            <thead style={{ background: 'var(--raised)', color: 'var(--text-3)' }}>
              <tr><th className="p-4">Identity</th><th>Role</th><th>Client</th><th>Status</th></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-t" style={{ borderColor: 'var(--line)' }}>
                  <td className="p-4"><b>{u.name}</b><p className="text-xs" style={{ color: 'var(--text-3)' }}>{u.email}</p></td>
                  <td><Badge value={u.role} /></td>
                  <td>{u.agent}</td>
                  <td><Badge value={u.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );

  const Policies = (
    <div className="grid gap-4 md:grid-cols-3">
      {([['Tool scope gate', 'Allowed only when identity has the matching scope.'], ['Human approval', 'High-risk action pauses for an admin decision.'], ['Tenant isolation', 'Supabase RLS limits each tenant to its own records.']] as [string, string][]).map(([n, d]) => (
        <article className="panel p-5" key={n}><Badge value="enforced" /><h2 className="mt-4 text-lg font-semibold">{n}</h2><p className="mt-2" style={{ color: 'var(--text-2)' }}>{d}</p></article>
      ))}
    </div>
  );

  const Architecture = (
    <div className="panel p-6">
      <p className="text-xl font-semibold">Architecture</p>
      <p className="mt-1 mb-6" style={{ color: 'var(--text-2)' }}>Request flow from agent → Agent Gate → governed tool execution.</p>
      <div className="overflow-x-auto">
        <svg viewBox="0 0 820 340" className="w-full max-w-3xl" style={{ fontFamily: 'var(--font-instrument-sans, sans-serif)' }}>
          {/* Nodes */}
          {([
            [30, 130, 120, 80, '#12151F', '#fff', 'Claude Agent', '(MCP client)'],
            [220, 130, 140, 80, '#1a1f2e', '#fff', 'Agent Gate', 'NestJS API'],
            [440, 60, 130, 70, '#0d3349', '#fff', 'Approval', 'Queue'],
            [440, 180, 130, 70, '#1a3d1a', '#fff', 'Audit', 'Logger'],
            [650, 130, 130, 80, '#2d1a0a', '#fff', 'Governed', 'Tool'],
          ] as [number, number, number, number, string, string, string, string][]).map(([x, y, w, h, fill, text, l1, l2]) => (
            <g key={l1}>
              <rect x={x} y={y} width={w} height={h} rx={10} fill={fill} />
              <text x={x + w / 2} y={y + h / 2 - 8} textAnchor="middle" fill={text} fontSize={13} fontWeight="600">{l1}</text>
              <text x={x + w / 2} y={y + h / 2 + 10} textAnchor="middle" fill={text} fontSize={11} opacity={0.7}>{l2}</text>
            </g>
          ))}
          {/* Arrows */}
          <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#555" /></marker></defs>
          {([
            [150, 170, 220, 170, 'invoke()'],
            [360, 155, 440, 95, 'high-risk?'],
            [360, 185, 440, 205, 'always'],
            [505, 95, 650, 165, 'on approve'],
            [570, 170, 650, 170, 'execute'],
          ] as [number, number, number, number, string][]).map(([x1, y1, x2, y2, label]) => (
            <g key={label}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#555" strokeWidth={1.5} markerEnd="url(#arr)" />
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" fill="#888" fontSize={10}>{label}</text>
            </g>
          ))}
          {/* Legend */}
          <text x={30} y={310} fontSize={11} fill="#888">Current: local stdio MCP · demo JWTs · in-memory fallback (no DATABASE_URL)</text>
          <text x={30} y={328} fontSize={11} fill="#888">Target: remote HTTP MCP · Supabase Auth · Redis/BullMQ workers · all data persisted</text>
        </svg>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line)' }}>
          <p className="font-semibold text-sm mb-2">✅ Current (working demo)</p>
          <ul className="text-sm space-y-1" style={{ color: 'var(--text-2)' }}>
            {['NestJS API + OpenAPI + health route', 'Next.js admin dashboard', 'Supabase tool registry + RLS', 'JWT demo auth + RBAC roles', 'Scoped tool discovery', 'High-risk approval queue', 'Audit trace UI', 'MCP stdio server for Claude CLI', 'Rate-limit logic (30/min/agent)', 'Tool registration from UI', 'Persist approvals + audit to Supabase (migration 4)', 'Edit / delete tools'].map(f => <li key={f}>· {f}</li>)}
          </ul>
        </div>
        <div className="rounded-lg border p-4" style={{ borderColor: 'var(--line)' }}>
          <p className="font-semibold text-sm mb-2">🔜 Target (production)</p>
          <ul className="text-sm space-y-1" style={{ color: 'var(--text-2)' }}>
            {['Hosted deploy with managed Redis + Postgres', 'Alerting rules on /metrics', 'Per-user API-key management UI'].map(f => <li key={f}>· {f}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );

  const Usage = (
    <div className="panel p-6">
      <p className="text-xl font-semibold">Usage & limits</p>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {([['30', 'calls per agent/minute'], ['2', 'provider replay variants'], ['100%', 'tenant-scoped data model']] as [string, string][]).map(([n, d]) => (
          <div key={n}><p className="mono text-2xl">{n}</p><p style={{ color: 'var(--text-2)' }}>{d}</p></div>
        ))}
      </div>
    </div>
  );

  const sections: Record<string, React.ReactNode> = {
    Overview, 'Tool registry': Registry, Policies, Approvals: ApprovalsSection,
    'Audit logs': AuditSection, Identities, Architecture, Usage,
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen">
      {/* Sidebar */}
      <aside className="fixed hidden h-full w-[248px] border-r bg-white p-5 lg:block" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#12151F] text-white">G</span>
          <div><b>AgentGate</b><p className="text-xs" style={{ color: 'var(--text-3)' }}>Acme · Production</p></div>
        </div>
        <nav className="mt-10 space-y-1">
          {NAV.map(n => (
            <button key={n} onClick={() => setActive(n)} className="w-full rounded-lg px-3 py-2 text-left" style={{ background: active === n ? 'var(--elev)' : 'transparent', color: active === n ? 'var(--text)' : 'var(--text-2)' }}>
              {n}
              {n === 'Approvals' && pendingCount > 0 && <span className="float-right status pending">{pendingCount}</span>}
            </button>
          ))}
        </nav>
        <div className="absolute bottom-5 left-5 right-5 space-y-2">
          {lastRefreshed && <p className="text-xs text-center" style={{ color: 'var(--text-3)' }}>Updated {lastRefreshed.toLocaleTimeString()}</p>}
          <button className="secondary w-full" onClick={() => setAutoRefresh(v => !v)}>
            {autoRefresh ? '⏸ Pause auto-refresh' : '▶ Resume auto-refresh'}
          </button>
          <button className="secondary w-full" onClick={() => setGuide(true)}>How Agent Gate works</button>
        </div>
      </aside>

      {/* Main */}
      <div className="lg:ml-[248px]">
        <header className="flex items-center justify-between border-b bg-white px-6 py-4" style={{ borderColor: 'var(--line)' }}>
          <div>
            <p className="text-xs uppercase tracking-[.08em]" style={{ color: 'var(--text-3)' }}>Control plane</p>
            <h1 className="text-2xl font-semibold">{active}</h1>
          </div>
          <div className="flex gap-2">
            <button className="secondary" disabled={busy} onClick={() => void load()} title="Refresh now">↻ Refresh</button>
            <button className="secondary" onClick={() => void invoke()}>Test risky action</button>
            <button className="primary" onClick={() => setGuide(true)}>How it works</button>
          </div>
        </header>

        <div className="mx-auto max-w-[1280px] p-6 md:p-10">
          {notice && (
            <p className="mb-5 flex items-start justify-between rounded-lg border p-3" style={{ borderColor: 'var(--line)', background: 'var(--raised)' }}>
              <span>{notice}</span>
              <button className="ml-4 text-xs" style={{ color: 'var(--text-3)' }} onClick={() => setNotice('')}>✕</button>
            </p>
          )}
          {sections[active]}
        </div>
      </div>

      {/* Register tool modal */}
      {form && (
        <div className="fixed inset-0 grid place-items-center bg-black/20 p-4">
          <form onSubmit={create} className="panel w-full max-w-xl p-6">
            <div className="flex justify-between">
              <div><h2 className="text-xl font-semibold">Register a tool</h2><p style={{ color: 'var(--text-2)' }}>New high-risk tools should start as a draft.</p></div>
              <button type="button" onClick={() => setForm(false)}>×</button>
            </div>
            <div className="mt-5 grid gap-3">
              <label>Name<input required name="name" placeholder="Send customer email" /></label>
              <label>Description<textarea required name="description" placeholder="What it does and when agents should use it." /></label>
              <div className="grid grid-cols-2 gap-3">
                <label>Type<select name="kind"><option value="mcp">MCP server</option><option value="rest">REST API</option></select></label>
                <label>Risk<select name="risk"><option value="high">High</option><option value="low">Low</option></select></label>
              </div>
              <label>Endpoint or MCP URL / command<input name="endpoint" placeholder="https://example.com/mcp" /></label>
              <label>Bearer secret (stored encrypted, never shown again)<input name="secret" type="password" autoComplete="off" /></label>
              <label>Required input fields (comma separated)<input name="inputRequired" placeholder="to, subject" /></label>
              <label>Required scopes<input required name="scopes" defaultValue="tools:custom:use" /></label>
              <div className="grid grid-cols-2 gap-3">
                <label>Status<select name="status"><option value="draft">Draft</option><option value="active">Active</option><option value="disabled">Disabled</option></select></label>
                <label>Approval<select name="approvalMode"><option value="required">Require admin approval</option><option value="auto">Auto allow</option><option value="deny">Deny by default</option></select></label>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="secondary" onClick={() => setForm(false)}>Cancel</button>
              <button disabled={busy} className="primary">Register tool</button>
            </div>
          </form>
        </div>
      )}

      {/* Edit tool modal */}
      {editTool && (
        <div className="fixed inset-0 grid place-items-center bg-black/20 p-4">
          <form onSubmit={saveTool} className="panel w-full max-w-md p-6">
            <div className="flex justify-between">
              <div><h2 className="text-xl font-semibold">Edit tool</h2><p style={{ color: 'var(--text-2)' }}>{editTool.name}</p></div>
              <button type="button" onClick={() => setEditTool(null)}>×</button>
            </div>
            <div className="mt-5 grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <label>Status
                  <select name="status" defaultValue={editTool.status}>
                    <option value="draft">Draft</option>
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </label>
                <label>Risk
                  <select name="risk" defaultValue={editTool.risk}>
                    <option value="high">High</option>
                    <option value="low">Low</option>
                  </select>
                </label>
              </div>
              <label>Approval
                <select name="approvalMode" defaultValue={editTool.approvalMode}>
                  <option value="required">Require admin approval</option>
                  <option value="auto">Auto allow</option>
                  <option value="deny">Deny by default</option>
                </select>
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="secondary" onClick={() => setEditTool(null)}>Cancel</button>
              <button disabled={busy} className="primary">Save changes</button>
            </div>
          </form>
        </div>
      )}

      {/* How it works guide */}
      {guide && (
        <div className="fixed inset-0 grid place-items-center bg-black/20 p-4">
          <section className="panel w-full max-w-2xl p-7">
            <button className="float-right" onClick={() => setGuide(false)}>×</button>
            <p className="text-xs uppercase tracking-[.08em]" style={{ color: 'var(--primary)' }}>Onboarding guide</p>
            <h2 className="editorial mt-2 text-3xl">Every tool your agents can reach, <i style={{ color: 'var(--primary)' }}>governed.</i></h2>
            <ol className="mt-6 grid gap-4">
              {([
                ['1. Register a tool', 'Admins connect REST APIs or MCP servers and choose scopes, status and risk.'],
                ['2. Give access', 'Admins assign a role and tool scopes to each person or agent.'],
                ['3. Invoke safely', 'Agent Gate checks tenant, role, scope and policy before dispatch.'],
                ['4. Approve risk', 'High-risk calls pause until an admin approves or denies them.'],
                ['5. Trace everything', 'Audit logs record the actor, tool, decision, provider and latency.'],
              ] as [string, string][]).map(([n, d]) => <li key={n}><b>{n}</b><p style={{ color: 'var(--text-2)' }}>{d}</p></li>)}
            </ol>
            <button className="primary mt-6" onClick={() => setGuide(false)}>Got it</button>
          </section>
        </div>
      )}
    </main>
  );
}

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { setupAuth } from '../src/setup.js';

describe('Agent Gate (e2e)', () => {
  let app: INestApplication;
  const token = async (body: object = {}) =>
    (await request(app.getHttpServer()).post('/auth/demo-token').send(body).expect(201)).body.accessToken as string;

  beforeEach(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    process.env.ADMIN_EMAILS = 'boss@acme.example';
    process.env.MCP_CLIENTS = JSON.stringify([{ name: 'Test Agent', key: 'k-test', role: 'agent', scopes: ['tools:read', 'tools:email:send'] }]);
    app = module.createNestApplication({ bodyParser: false });
    setupAuth(app);
    await app.init();
  });
  afterEach(async () => { await app.close(); });

  it('reports a healthy gateway', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/tools').expect(401);
  });

  it('runs the approval flow end to end', async () => {
    const admin = await token();
    const call = await request(app.getHttpServer()).post('/tools/email-send/calls')
      .set('Authorization', `Bearer ${admin}`).send({ to: 'x@y.z' }).expect(201);
    expect(call.body.decision).toBe('pending_approval');
    await request(app.getHttpServer()).post(`/approvals/${call.body.approvalId}/approve`)
      .set('Authorization', `Bearer ${admin}`).expect(201);
    const logs = await request(app.getHttpServer()).get('/audit-logs?limit=5')
      .set('Authorization', `Bearer ${admin}`).expect(200);
    expect(logs.body.length).toBeGreaterThan(0);
  });

  it('blocks a viewer from calling tools', async () => {
    const viewer = await token({ role: 'viewer', scopes: [] });
    await request(app.getHttpServer()).post('/tools/weather-proxy/calls')
      .set('Authorization', `Bearer ${viewer}`).send({}).expect(403);
  });

  const signUp = async (email: string) => {
    const res = await request(app.getHttpServer()).post('/api/auth/sign-up/email')
      .set('Origin', 'http://localhost:3001').send({ email, password: 'correct-horse-battery', name: 'Tester' });
    expect(res.status).toBe(200);
    return (res.headers['set-auth-token'] ?? res.body.token) as string;
  };

  it('supports real sign-up with Better Auth; roles come from ADMIN_EMAILS, not the client', async () => {
    const viewer = await signUp('someone@acme.example');
    const admin = await signUp('boss@acme.example');
    await request(app.getHttpServer()).post('/tools/weather-proxy/calls').set('Authorization', `Bearer ${viewer}`).send({}).expect(403);
    await request(app.getHttpServer()).post('/tools/weather-proxy/calls').set('Authorization', `Bearer ${admin}`).send({}).expect(201);
    const users = await request(app.getHttpServer()).get('/users').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(users.body.map((u: { email: string }) => u.email)).toContain('someone@acme.example');
    await request(app.getHttpServer()).get('/users').set('Authorization', `Bearer ${viewer}`).expect(403);
  });

  it('serves remote MCP over HTTP with per-client API keys', async () => {
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agentgate_request_email_send', arguments: { to: 'a@b.co', subject: 's', body: 'b' } } };
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    await request(app.getHttpServer()).post('/mcp').set(headers).send(rpc).expect(401);
    const ok = await request(app.getHttpServer()).post('/mcp').set(headers).set('x-api-key', 'k-test').send(rpc).expect(200);
    expect(ok.text).toContain('pending_approval');
  });

  it('manages MCP API keys end to end: create, use on /mcp, revoke', async () => {
    const admin = await token();
    const created = await request(app.getHttpServer()).post('/api-keys').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Dashboard-made', role: 'agent', scopes: ['tools:read', 'tools:email:send'] }).expect(201);
    const key = created.body.key as string;
    expect(key).toMatch(/^agk_/);
    const list = await request(app.getHttpServer()).get('/api-keys').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(key);

    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agentgate_list_governed_tools', arguments: {} } };
    await request(app.getHttpServer()).post('/mcp').set(headers).set('x-api-key', key).send(rpc).expect(200);

    await request(app.getHttpServer()).delete(`/api-keys/${created.body.id}`).set('Authorization', `Bearer ${admin}`).expect(200);
    await request(app.getHttpServer()).post('/mcp').set(headers).set('x-api-key', key).send(rpc).expect(401);

    const viewer = await token({ role: 'viewer', scopes: [] });
    await request(app.getHttpServer()).get('/api-keys').set('Authorization', `Bearer ${viewer}`).expect(403);
  });

  it('exposes Prometheus metrics, protected by METRICS_TOKEN when set', async () => {
    const open = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(open.text).toContain('agent_gate_up 1');
    expect(open.text).toContain('agent_gate_mcp_requests_total');
    process.env.METRICS_TOKEN = 'm-token';
    await request(app.getHttpServer()).get('/metrics').expect(401);
    await request(app.getHttpServer()).get('/metrics').set('Authorization', 'Bearer m-token').expect(200);
    delete process.env.METRICS_TOKEN;
  });
});

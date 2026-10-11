import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('Agent Gate (e2e)', () => {
  let app: INestApplication;
  const token = async (body: object = {}) =>
    (await request(app.getHttpServer()).post('/auth/demo-token').send(body).expect(201)).body.accessToken as string;

  beforeEach(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
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
});

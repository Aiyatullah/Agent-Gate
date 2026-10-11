import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
describe('Agent Gate (e2e)', () => { let app: INestApplication; beforeEach(async()=>{const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=module.createNestApplication();await app.init()});it('reports a healthy gateway',async()=>{const res=await request(app.getHttpServer()).get('/health').expect(200);expect(res.body.status).toBe('ok')});afterEach(async()=>{await app.close()}) });

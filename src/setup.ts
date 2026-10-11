import { INestApplication } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import { json } from 'express';
import { AuthService } from './auth.service.js';

/** Mounts Better Auth ahead of the JSON body parser (it needs the raw stream). Create the app with `{ bodyParser: false }`. */
export function setupAuth(app: INestApplication) {
  const auth = app.get(AuthService).auth;
  const http = app.getHttpAdapter().getInstance();
  http.all('/api/auth/{*any}', toNodeHandler(auth));
  http.use(json({ limit: '1mb' }));
}

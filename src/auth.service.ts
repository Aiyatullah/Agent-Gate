import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { log } from './log.js';
import type { Role } from './app.service.js';

export type Actor = { sub: string; tenantId: string; role: Role; scopes: string[]; actorName?: string; client?: string };

export const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID ?? '00000000-0000-0000-0000-000000000001';
const scopesFor = (role: Role) => (role === 'viewer' ? ['tools:read'] : ['tools:read', 'tools:email:send']);
const adminEmails = () => (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export function createAuth() {
  const url = process.env.DATABASE_URL;
  return betterAuth({
    appName: 'Agent Gate',
    baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
    secret: process.env.BETTER_AUTH_SECRET ?? process.env.JWT_SECRET ?? 'local-development-secret-change-me',
    // No DATABASE_URL => Better Auth's in-memory adapter (local dev / tests).
    database: url ? new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } }) : undefined,
    trustedOrigins: [process.env.WEB_ORIGIN ?? 'http://localhost:3001'],
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'viewer', input: false },
        tenantId: { type: 'string', defaultValue: DEFAULT_TENANT, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Roles are never client-supplied: ADMIN_EMAILS bootstrap admins, everyone else starts as viewer.
          before: async u => ({ data: { ...u, role: adminEmails().includes(String(u.email).toLowerCase()) ? 'admin' : 'viewer', tenantId: DEFAULT_TENANT } }),
        },
      },
    },
    plugins: [bearer()],
  });
}

@Injectable()
export class AuthService implements OnModuleInit {
  readonly auth = createAuth();

  constructor(private readonly jwt: JwtService) {}

  async onModuleInit() {
    if (!process.env.DATABASE_URL || process.env.AUTH_AUTO_MIGRATE === 'false') return;
    try {
      const { runMigrations } = await getMigrations(this.auth.options);
      await runMigrations();
      log('info', 'auth_migrations_applied');
    } catch (e) { log('error', 'auth_migration_failed', { error: (e as Error).message }); }
  }

  get demoEnabled() { return process.env.ALLOW_DEMO_AUTH ? process.env.ALLOW_DEMO_AUTH === 'true' : process.env.NODE_ENV !== 'production'; }

  /** Resolves a bearer token (Better Auth session token, or a demo JWT when enabled) to an Actor. */
  async actor(authorization?: string): Promise<Actor> {
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException('A valid bearer token is required.');
    const token = authorization.slice(7);
    if (this.demoEnabled && token.split('.').length === 3) {
      try { return this.jwt.verify(token); } catch { /* fall through to session lookup */ }
    }
    const session = await this.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }).catch(() => null);
    if (!session) throw new UnauthorizedException('A valid bearer token is required.');
    const u = session.user as typeof session.user & { role?: Role; tenantId?: string };
    const role = (u.role ?? 'viewer') as Role;
    return { sub: u.id, tenantId: u.tenantId ?? DEFAULT_TENANT, role, scopes: scopesFor(role), actorName: u.name, client: 'Dashboard' };
  }

  async listUsers(tenantId: string) {
    const ctx = await this.auth.$context;
    const users = await ctx.internalAdapter.listUsers(200);
    return (users as Array<Record<string, unknown>>)
      .filter(u => (u.tenantId ?? DEFAULT_TENANT) === tenantId)
      .map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role ?? 'viewer', status: 'active', agent: '—' }));
  }

  async setRole(tenantId: string, userId: string, role: Role) {
    const ctx = await this.auth.$context;
    const u = await ctx.internalAdapter.findUserById(userId) as Record<string, unknown> | null;
    if (!u || (u.tenantId ?? DEFAULT_TENANT) !== tenantId) return null;
    await ctx.internalAdapter.updateUser(userId, { role });
    return { id: userId, role };
  }
}

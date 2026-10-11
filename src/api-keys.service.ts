import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseService, StoredApiKey } from './database.service.js';
import { Actor, DEFAULT_TENANT } from './auth.service.js';
import { MetricsService } from './metrics.service.js';
import { log } from './log.js';

type EnvClient = { name: string; key: string; tenantId?: string; role?: Actor['role']; scopes?: string[] };
const sha = (v: string) => createHash('sha256').update(v).digest();
const hex = (v: string) => sha(v).toString('hex');
const MAX_KEYS = 50;

/** Manages MCP API keys. DB-backed when migration 6 is applied, in-memory otherwise. Static keys from MCP_CLIENTS still work. */
@Injectable()
export class ApiKeysService {
  private readonly mem = new Map<string, StoredApiKey & { keyHash: string }>();

  constructor(@Optional() private readonly db?: DatabaseService, @Optional() private readonly metrics?: MetricsService) {}

  private admin(a: Actor) { if (a.role !== 'admin') throw new ForbiddenException('Only tenant admins can manage API keys.'); }
  private async useDb() { return Boolean(this.db && await this.db.apiKeysReady()); }

  async list(a: Actor) {
    this.admin(a);
    if (await this.useDb()) return this.db!.listApiKeys(a.tenantId);
    return [...this.mem.values()].filter(k => k.tenantId === a.tenantId).map(({ keyHash: _h, ...k }) => k).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  }

  /** Returns the plaintext key exactly once. */
  async create(a: Actor, input: { name?: string; role?: string; scopes?: string[] }) {
    this.admin(a);
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 60) throw new BadRequestException('Name is required (max 60 characters).');
    const role = input.role ?? 'agent';
    if (role !== 'agent' && role !== 'viewer') throw new BadRequestException('API keys can only be agent or viewer; admin access requires a user login.');
    const scopes = [...new Set((input.scopes ?? ['tools:read']).map(s => String(s).trim()).filter(Boolean))];
    if (scopes.length > 20 || scopes.some(s => !/^[a-z0-9:_*.-]{1,64}$/i.test(s))) throw new BadRequestException('Scopes must be short identifiers like tools:read (max 20).');
    if ((await this.list(a)).filter(k => !k.revokedAt).length >= MAX_KEYS) throw new BadRequestException(`Limit of ${MAX_KEYS} active keys reached; revoke one first.`);

    const key = `agk_${randomBytes(32).toString('base64url')}`;
    const meta = { name, prefix: key.slice(0, 8), role: role as 'agent' | 'viewer', scopes, createdBy: a.actorName ?? a.sub };
    let saved: StoredApiKey;
    if (await this.useDb()) saved = await this.db!.createApiKey(a.tenantId, { ...meta, keyHash: hex(key) });
    else {
      saved = { id: crypto.randomUUID(), tenantId: a.tenantId, createdAt: new Date().toISOString(), ...meta };
      this.mem.set(saved.id, { ...saved, keyHash: hex(key) });
    }
    this.metrics?.inc('agent_gate_api_keys_created_total');
    log('info', 'api_key_created', { tenantId: a.tenantId, keyId: saved.id, role });
    return { ...saved, key };
  }

  async revoke(a: Actor, id: string) {
    this.admin(a);
    let ok: boolean;
    if (await this.useDb()) ok = await this.db!.revokeApiKey(a.tenantId, id);
    else {
      const k = this.mem.get(id);
      ok = Boolean(k && k.tenantId === a.tenantId && !k.revokedAt);
      if (ok) k!.revokedAt = new Date().toISOString();
    }
    if (!ok) throw new NotFoundException('Active API key was not found.');
    log('info', 'api_key_revoked', { tenantId: a.tenantId, keyId: id });
    return { revoked: true };
  }

  /** Resolves a presented key to an Actor (env-defined clients first, then managed keys). */
  async resolve(key: string): Promise<Actor | undefined> {
    let env: EnvClient[] = [];
    try { env = JSON.parse(process.env.MCP_CLIENTS ?? '[]') as EnvClient[]; } catch { /* ignore malformed env */ }
    const hit = env.find(c => c.key && timingSafeEqual(sha(c.key), sha(key)));
    if (hit) return { sub: `mcp:${hit.name}`, tenantId: hit.tenantId ?? DEFAULT_TENANT, role: hit.role ?? 'agent', scopes: hit.scopes ?? ['tools:read'], actorName: hit.name, client: hit.name };

    if (!key.startsWith('agk_')) return undefined;
    const h = hex(key);
    let k: StoredApiKey | undefined;
    if (await this.useDb()) k = await this.db!.findApiKeyByHash(h);
    else {
      const m = [...this.mem.values()].find(x => x.keyHash === h && !x.revokedAt);
      if (m) { m.lastUsedAt = new Date().toISOString(); k = m; }
    }
    if (!k) return undefined;
    return { sub: `mcp:${k.id}`, tenantId: k.tenantId, role: k.role, scopes: k.scopes, actorName: k.name, client: k.name };
  }
}

import { Injectable } from '@nestjs/common';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { StoredTool } from './database.service.js';

export type ConnectorResult = { ok: boolean; output?: unknown; error?: string; attempts: number; simulated?: boolean };

const TIMEOUT_MS = Number(process.env.CONNECTOR_TIMEOUT_MS ?? 5000);
const MAX_ATTEMPTS = Number(process.env.CONNECTOR_MAX_ATTEMPTS ?? 3);

const isPrivate = (ip: string) =>
  /^(10\.|127\.|169\.254\.|192\.168\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ||
  ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);

/** Validates and executes a registered tool's outbound endpoint with an allowlist, timeout and retries. */
@Injectable()
export class ConnectorService {
  private allowlist() {
    return (process.env.OUTBOUND_ALLOWLIST ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }

  /** Throws if the endpoint is not a safe outbound target. */
  async validateEndpoint(endpoint: string): Promise<URL> {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error('Endpoint is not a valid URL.'); }
    if (url.protocol !== 'https:') throw new Error('Endpoint must use https.');
    if (url.username || url.password) throw new Error('Endpoint must not embed credentials.');
    const host = url.hostname.toLowerCase();
    const allow = this.allowlist();
    if (!allow.length) throw new Error('No outbound hosts are allowlisted (set OUTBOUND_ALLOWLIST).');
    if (!allow.some(h => host === h || host.endsWith(`.${h}`))) throw new Error(`Host ${host} is not on the outbound allowlist.`);
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addrs.some(a => isPrivate(a.address))) throw new Error('Endpoint resolves to a private address.');
    return url;
  }

  /** Validates input against the tool's optional JSON-schema-lite `required` list. */
  validateInput(tool: StoredTool, input: Record<string, unknown>) {
    const missing = (tool.inputRequired ?? []).filter(k => input[k] === undefined);
    if (missing.length) throw new Error(`Missing required input: ${missing.join(', ')}`);
  }

  async execute(tool: StoredTool, input: Record<string, unknown>, secret?: string): Promise<ConnectorResult> {
    try { this.validateInput(tool, input); } catch (e) { return { ok: false, error: (e as Error).message, attempts: 0 }; }
    if (!tool.endpoint) return { ok: true, simulated: true, attempts: 0, output: { tool: tool.name, note: 'No endpoint configured; governed dry-run.' } };
    let url: URL;
    try { url = await this.validateEndpoint(tool.endpoint); } catch (e) { return { ok: false, error: (e as Error).message, attempts: 0 }; }

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
          body: JSON.stringify(input), signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) return { ok: true, attempts: attempt, output: await res.json().catch(() => ({ status: res.status })) };
        lastError = `Upstream responded ${res.status}`;
        if (res.status < 500) break; // 4xx is not retryable
      } catch (e) { lastError = (e as Error).message; }
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
    }
    return { ok: false, error: lastError, attempts: MAX_ATTEMPTS };
  }
}

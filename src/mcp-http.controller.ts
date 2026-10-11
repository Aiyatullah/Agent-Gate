import { All, Controller, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppService } from './app.service.js';
import { Actor, AuthService, DEFAULT_TENANT } from './auth.service.js';
import { log } from './log.js';

type McpClient = { name: string; key: string; tenantId?: string; role?: Actor['role']; scopes?: string[] };

const sha = (v: string) => createHash('sha256').update(v).digest();

/** Per-client API keys from MCP_CLIENTS (JSON array). Each key maps to a tenant, role, and scopes. */
function clients(): McpClient[] {
  try { return JSON.parse(process.env.MCP_CLIENTS ?? '[]') as McpClient[]; } catch { return []; }
}

export function resolveApiKey(key: string): Actor | undefined {
  const hit = clients().find(c => c.key && timingSafeEqual(sha(c.key), sha(key)));
  if (!hit) return undefined;
  const role = hit.role ?? 'agent';
  return { sub: `mcp:${hit.name}`, tenantId: hit.tenantId ?? DEFAULT_TENANT, role, scopes: hit.scopes ?? ['tools:read'], actorName: hit.name, client: hit.name };
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

function buildServer(svc: AppService, actor: Actor) {
  const server = new McpServer({ name: 'agent-gate', version: '0.2.0' }, { instructions: 'Use agentgate_list_governed_tools before invoking an action. High-risk tools create an approval request that a tenant admin must approve.' });
  server.registerTool('agentgate_list_governed_tools', { title: 'List governed tools', description: 'List the tools this client may call.', inputSchema: {} },
    async () => text(await svc.listTools(actor)));
  server.registerTool('agentgate_call_tool', { title: 'Call a governed tool', description: 'Invoke a registered tool by id or slug. High-risk tools return pending_approval.', inputSchema: { tool: z.string().min(1), input: z.record(z.string(), z.unknown()).optional() } },
    async ({ tool, input }) => {
      try { return text(await svc.invoke(actor, tool, input ?? {})); }
      catch (e) { return { ...text(`Denied or failed: ${(e as Error).message}`), isError: true }; }
    });
  server.registerTool('agentgate_request_email_send', { title: 'Request governed email action', description: 'Creates a high-risk call that enters the approval queue.', inputSchema: { to: z.string().email(), subject: z.string().min(1), body: z.string().min(1) } },
    async input => {
      try { return text(await svc.invoke(actor, 'email-send', input)); }
      catch (e) { return { ...text(`Denied or failed: ${(e as Error).message}`), isError: true }; }
    });
  return server;
}

/** Remote MCP over Streamable HTTP (stateless). Public URL: MCP_PUBLIC_URL (e.g. https://api.example.com/mcp). */
@ApiExcludeController()
@Controller('mcp')
export class McpHttpController {
  constructor(private readonly svc: AppService, private readonly auth: AuthService) {}

  @All()
  async handle(@Req() req: Request, @Res() res: Response) {
    const key = (req.headers['x-api-key'] as string | undefined) ?? req.headers.authorization?.replace(/^Bearer /, '');
    let actor = key ? resolveApiKey(key) : undefined;
    if (!actor && req.headers.authorization) actor = await this.auth.actor(req.headers.authorization).catch(() => undefined);
    if (!actor) {
      res.status(401).set('WWW-Authenticate', 'Bearer realm="agent-gate"').json({ jsonrpc: '2.0', error: { code: -32001, message: 'A valid MCP API key or session token is required.' }, id: null });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server).' }, id: null });
      return;
    }
    const server = buildServer(this.svc, actor);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log('error', 'mcp_http_error', { error: (e as Error).message });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
}

# Connect a real MCP client

Agent Gate includes a local stdio MCP server at `mcp/server.ts`. It exposes two real tools:

- `agentgate_list_governed_tools` fetches the live scoped registry from the Nest API.
- `agentgate_request_email_send` calls the live high-risk API route. It creates an approval request; it cannot send an email until an admin approves it in the dashboard.

Start the API before launching any MCP client:

```powershell
npm run start:dev
```

## Claude Code

From the project root, add the server for this project:

```powershell
claude mcp add --scope project agent-gate -- npx tsx mcp/server.ts
claude mcp list
```

Then ask Claude Code: `Use agentgate_list_governed_tools, then request a governed email to demo@example.com.` Open the Agent Gate dashboard to approve or deny the resulting request.

## Codex CLI

From the project root:

```powershell
codex mcp add agent-gate -- npx tsx mcp/server.ts
codex mcp list
```

The project also includes `.mcp.json` for MCP-aware project clients. In Codex, ask: `List Agent Gate tools and request a governed email send.`

## Verify without an AI client

```powershell
npm run mcp:smoke
```

This launches the server via stdio, performs the protocol handshake, lists its tools, invokes the registry tool, and invokes the high-risk request tool. Review the new pending request in Dashboard → Approvals.

## Safety model

This sample server intentionally exposes no shell, filesystem, or raw database tools. Its tools can only call the explicit Agent Gate API routes. A production deployment should use per-client identity, a real issuer/JWKS validator, an authenticated remote Streamable HTTP transport, and a provider credential vault.

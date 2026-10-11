export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}

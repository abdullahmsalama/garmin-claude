// Remote MCP server (Streamable HTTP, stateless, JSON responses). Only reached with a valid OAuth
// token: the OAuthProvider checks it before this handler runs.
import { TOOLS, runTool } from './tools.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Read-only access to the owner\'s Garmin Connect data (activities, sleep, HRV, stress, Body Battery, training load, VO2 max, weight). Dates are YYYY-MM-DD in local time. Start with get_summary for an overview; use get_status if data looks missing.';

const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg, env) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcErr(msg?.id, -32600, 'Invalid request');
  const { id, method, params } = msg;
  if (id === undefined) return null; // a notification: nothing to answer
  if (method === 'initialize') {
    const v = VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[1];
    return rpc(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'garmin-mcp', title: 'Garmin (private)', version: '1.0.0' }, instructions: INSTRUCTIONS });
  }
  if (method === 'ping') return rpc(id, {});
  if (method === 'tools/list') {
    return rpc(id, { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === params?.name);
    if (!tool) return rpcErr(id, -32602, `Unknown tool: ${params?.name}`);
    try {
      const out = await runTool(env, tool, params.arguments);
      return rpc(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      console.log('tool error', tool.name, e.stack || e.message);
      return rpc(id, { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true });
    }
  }
  return rpcErr(id, -32601, `Method not found: ${method}`);
}

export const mcpHandler = {
  async fetch(request, env, ctx) {
    if (ctx?.props?.owner !== true) return new Response('Forbidden', { status: 403 });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    let body;
    try { body = await request.json(); } catch { return Response.json(rpcErr(null, -32700, 'Parse error'), { status: 400 }); }
    const batch = Array.isArray(body);
    const out = (await Promise.all((batch ? body : [body]).map(m => handle(m, env)))).filter(Boolean);
    if (!out.length) return new Response(null, { status: 202 });
    return Response.json(batch ? out : out[0]);
  },
};

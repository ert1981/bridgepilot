/**
 * Minimal remote MCP server (Streamable HTTP transport, JSON responses) with x402 pay-per-call.
 *
 * Clients POST JSON-RPC 2.0 messages to /mcp; each request gets one `application/json` response (allowed by
 * the Streamable HTTP transport), notifications get 202. GET /mcp (server-initiated SSE) is not offered: 405.
 * Stateless, no session id.
 *
 * Payments follow the x402 MCP transport (github.com/coinbase/x402 specs/transports-v2/mcp.md): a paid tool
 * called without payment returns `isError: true` with the x402 v2 PaymentRequired object in
 * `structuredContent` and JSON-encoded in `content[0].text`; the client retries with the PaymentPayload in
 * `params._meta["x402/payment"]`; the settled result carries `_meta["x402/payment-response"]`.
 */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const PAYMENT_META = 'x402/payment';
export const PAYMENT_RESPONSE_META = 'x402/payment-response';

export interface CallToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpTool<C> {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  price?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, meta: Record<string, unknown>, ctx: C) => Promise<CallToolResult>;
}

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export function textResult(obj: unknown, meta?: Record<string, unknown>): CallToolResult {
  const structured = JSON.parse(JSON.stringify(obj, replacer)) as unknown;
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured && typeof structured === 'object' && !Array.isArray(structured) ? (structured as Record<string, unknown>) : { result: structured },
    isError: false,
    ...(meta ? { _meta: meta } : {}),
  };
}

export function errorResult(message: string, details?: unknown): CallToolResult {
  const obj = { error: message, ...(details !== undefined ? { details } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(obj, replacer) }], structuredContent: JSON.parse(JSON.stringify(obj, replacer)), isError: true };
}

export function paymentRequiredResult(pr: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(pr) }], structuredContent: pr, isError: true };
}

type Rpc = { jsonrpc: '2.0'; id: unknown; result?: unknown; error?: { code: number; message: string } };
const err = (id: unknown, code: number, message: string): Rpc => ({ jsonrpc: '2.0', id, error: { code, message } });

export class McpServer<C> {
  private readonly tools = new Map<string, McpTool<C>>();
  constructor(
    private readonly info: { name: string; title: string; version: string },
    private readonly instructions: string,
    tools: McpTool<C>[],
  ) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  /** Returns [HTTP status, JSON body | undefined for 202]. */
  async handle(raw: string, ctx: C): Promise<[number, Rpc | undefined]> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw || 'null');
    } catch {
      return [400, err(null, -32700, 'Parse error')];
    }
    if (Array.isArray(msg)) return [400, err(null, -32600, 'JSON-RPC batching is not supported')];
    if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0') return [400, err(null, -32600, 'Invalid Request')];
    const m = msg as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof m.method !== 'string' || !('id' in m)) return [202, undefined]; // notification or client response
    return [200, await this.dispatch(m.id, m.method, m.params ?? {}, ctx)];
  }

  private async dispatch(id: unknown, method: string, params: unknown, ctx: C): Promise<Rpc> {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return err(id, -32602, 'params must be an object');
    const p = params as Record<string, unknown>;
    switch (method) {
      case 'initialize': {
        const asked = String(p.protocolVersion ?? '');
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: this.info,
            instructions: this.instructions,
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0', id,
          result: {
            tools: [...this.tools.values()].map((t) => ({
              name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
              annotations: { title: t.title, readOnlyHint: true, openWorldHint: true },
              ...(t.price ? { _meta: { x402: t.price } } : {}),
            })),
          },
        };
      case 'tools/call': {
        const tool = this.tools.get(String(p.name ?? ''));
        if (!tool) return err(id, -32602, `Unknown tool: ${String(p.name ?? '')}`);
        const args = p.arguments ?? {};
        const meta = p._meta ?? {};
        if (typeof args !== 'object' || Array.isArray(args) || typeof meta !== 'object' || Array.isArray(meta)) return err(id, -32602, 'arguments and _meta must be objects');
        return { jsonrpc: '2.0', id, result: await tool.handler(args as Record<string, unknown>, meta as Record<string, unknown>, ctx) };
      }
      default:
        return err(id, -32601, `Method not found: ${method}`);
    }
  }
}

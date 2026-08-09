/**
 * MCP endpoint — this is the URL you paste into VoiceOS.
 *
 * Streamable HTTP transport, hand-rolled JSON-RPC 2.0. Responds as plain JSON
 * or as a single SSE frame depending on what the client asks for in `Accept`,
 * which covers both shapes of client without pulling in the SDK.
 */

import { viewerFor } from "@/lib/auth";
import { SERVER_INFO, SERVER_INSTRUCTIONS, callTool, listTools } from "@/lib/mcp";
import { probe } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROTOCOL_VERSION = "2025-06-18";

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type RpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

async function handle(
  req: RpcRequest,
  ownerId: string | null,
): Promise<RpcResponse | null> {
  const id = req.id ?? null;
  const reply = (result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): RpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (req.method) {
    case "initialize":
      // Warm the brain so the first real question isn't the one that pays for it.
      void probe();
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response

    case "ping":
      return reply({});

    case "tools/list":
      return reply({ tools: listTools() });

    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      if (!name) return fail(-32602, "missing tool name");
      // Every tool reads or writes somebody's interns, drafts or questions, so
      // there is no anonymous call. `initialize`, `ping` and `tools/list` stay
      // open — they describe the server, not anyone's work.
      if (!ownerId) {
        return fail(
          -32001,
          "not signed in: send the Intern auth token as `Authorization: Bearer <token>`",
        );
      }
      return reply(await callTool(name, args, { ownerId }));
    }

    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });

    default:
      return fail(-32601, `method not found: ${req.method}`);
  }
}

export async function POST(request: Request) {
  let body: RpcRequest | RpcRequest[];
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { status: 400, headers: CORS },
    );
  }

  const viewer = await viewerFor(request);

  const batch = Array.isArray(body);
  const requests: RpcRequest[] = batch ? (body as RpcRequest[]) : [body as RpcRequest];
  const responses: RpcResponse[] = [];
  for (const req of requests) {
    const res = await handle(req, viewer?.userId ?? null);
    if (res) responses.push(res);
  }

  // Notifications only — nothing to say back.
  if (!responses.length) return new Response(null, { status: 202, headers: CORS });

  const payload = batch ? responses : responses[0];
  const accept = request.headers.get("accept") ?? "";

  if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
      headers: {
        ...CORS,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  return Response.json(payload, { headers: CORS });
}

/**
 * Clients that open a server→client stream get one that stays open. Intern
 * pushes nothing unprompted today; the keepalive stops the client treating an
 * idle connection as a dead server.
 */
export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(ping);
        }
      }, 20_000);
    },
  });
  return new Response(stream, {
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function DELETE() {
  return new Response(null, { status: 204, headers: CORS });
}

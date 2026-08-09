/**
 * Thin client for the Scout backend (`scout/` — Agno AgentOS on :8000).
 *
 * Every call is defensive: Scout is an optional dependency of the cockpit.
 * If it isn't up, callers fall back to the simulator.
 */

import type { ContextStatus, Graph, GraphEdge, GraphNode } from "./types";

export const SCOUT_URL = (
  process.env.SCOUT_API_URL ?? "http://localhost:8000"
).replace(/\/$/, "");

const AGENT_ID = process.env.SCOUT_AGENT_ID ?? "scout";

async function req(
  path: string,
  init: RequestInit = {},
  timeoutMs = 6000,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(`${SCOUT_URL}${path}`, {
      ...init,
      signal: ctl.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function health(): Promise<boolean> {
  try {
    const res = await req("/health", {}, 2500);
    return res.ok;
  } catch {
    return false;
  }
}

type RawContext = {
  id?: string;
  name?: string;
  status?: { ok?: boolean; detail?: string } | boolean;
  ok?: boolean;
  detail?: string;
  tools?: string[];
};

export async function contexts(): Promise<ContextStatus[]> {
  try {
    const res = await req("/contexts", {}, 8000);
    if (!res.ok) return [];
    const rows = (await res.json()) as RawContext[];
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const status = typeof row.status === "object" ? row.status : undefined;
      return {
        id: row.id ?? row.name ?? "unknown",
        name: row.name ?? row.id ?? "unknown",
        ok: status?.ok ?? row.ok ?? row.status === true,
        detail: status?.detail ?? row.detail,
        tools: Array.isArray(row.tools) ? row.tools : [],
      };
    });
  } catch {
    return [];
  }
}

/**
 * Pull the brain graph.
 *
 * Prefers `/brain/graph` (added to `scout/app/router.py` by this project — it
 * reads the `scout` schema and the wiki directly). Falls back to deriving a
 * shallow graph from `/contexts` so a stock Scout still renders something.
 */
export async function graph(): Promise<Graph | null> {
  try {
    const res = await req("/brain/graph", {}, 12000);
    if (res.ok) {
      const data = (await res.json()) as {
        nodes?: GraphNode[];
        edges?: GraphEdge[];
      };
      if (Array.isArray(data.nodes) && data.nodes.length) {
        return {
          nodes: data.nodes,
          edges: data.edges ?? [],
          mode: "live",
          generatedAt: Date.now(),
        };
      }
    }
  } catch {
    /* fall through */
  }

  const ctxs = await contexts();
  if (!ctxs.length) return null;
  const nodes: GraphNode[] = [
    { id: "brain", label: "brain", kind: "intern", weight: 9 },
    ...ctxs.map<GraphNode>((c) => ({
      id: `src:${c.id}`,
      label: c.id,
      kind: "source",
      weight: 5,
      detail: c.detail,
    })),
  ];
  const edges: GraphEdge[] = ctxs.map((c) => ({
    source: "brain",
    target: `src:${c.id}`,
    rel: "provides",
  }));
  return { nodes, edges, mode: "live", generatedAt: Date.now() };
}

export type ScoutEvent = {
  event?: string;
  content?: unknown;
  /**
   * Which run emitted this. Scout's context providers are agents of their own,
   * and their runs stream down the *same* HTTP response as the top-level one —
   * so events from four concurrent runs arrive interleaved chunk by chunk.
   * Anything accumulating `content` has to key on this or it splices sentences
   * from different agents together.
   */
  run_id?: string;
  /** Set on a sub-agent's events; absent on the top-level run. */
  parent_run_id?: string | null;
  /** `scout`, `knowledge-read`, `crm-read`, `workspace`… */
  agent_id?: string;
  tool?: {
    tool_name?: string;
    tool_args?: unknown;
    result?: unknown;
    /** Set by agno when the call itself failed, not when it returned nothing. */
    tool_call_error?: boolean;
  };
  tools?: { tool_name?: string }[];
  [k: string]: unknown;
};

export type Lane = { label: string; main: boolean; text: string };

/**
 * Split a run stream into one output lane per run.
 *
 * Scout's context providers are agents in their own right, and their runs come
 * down the *same* HTTP response as the top-level one: one measured brief
 * alternated between four concurrent runs 794 times. A single accumulator
 * therefore spliced them mid-sentence — "StatusThe wiki contains: only one
 * unknown/not source found" — which on a projector reads as the thing being
 * broken. Keyed on `run_id` each agent's prose stays whole, and sub-agent lines
 * say whose they are.
 */
export function lanes(sink: (text: string) => void) {
  const open = new Map<string, Lane>();
  const key = (ev: ScoutEvent) => String(ev.run_id ?? "main");

  const drain = (k: string) => {
    const lane = open.get(k);
    if (!lane) return;
    open.delete(k);
    const text = lane.text.trim();
    if (text) sink(lane.label + text);
  };

  return {
    /** The lane this event belongs to, opened on first sight. */
    lane(ev: ScoutEvent): Lane {
      const k = key(ev);
      let lane = open.get(k);
      if (!lane) {
        // Only the top-level run has no parent. Everything else is a context
        // provider answering one `query_*` call.
        const main = !ev.parent_run_id;
        lane = { label: main ? "" : `${ev.agent_id ?? k} · `, main, text: "" };
        open.set(k, lane);
      }
      return lane;
    },
    flush: (ev: ScoutEvent) => drain(key(ev)),
    /** Everything still mid-sentence — end of stream, or an error. */
    flushAll: () => {
      for (const k of [...open.keys()]) drain(k);
    },
  };
}

/**
 * Stream an agent run. Yields decoded agno run events.
 *
 * AgentOS accepts form-encoded run requests at `/agents/{id}/runs`.
 */
export async function* runStream(
  message: string,
  opts: { sessionId: string; userId?: string; signal?: AbortSignal },
): AsyncGenerator<ScoutEvent> {
  const body = new URLSearchParams({
    message,
    stream: "true",
    session_id: opts.sessionId,
    user_id: opts.userId ?? "cockpit",
  });

  const res = await fetch(`${SCOUT_URL}/agents/${AGENT_ID}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: opts.signal,
    cache: "no-store",
  });

  if (!res.ok || !res.body) {
    throw new Error(`scout run failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // Agno emits SSE frames; some deployments emit bare NDJSON. Handle both.
  function* parse(chunk: string): Generator<ScoutEvent> {
    for (const line of chunk.split("\n")) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload) as ScoutEvent;
      } catch {
        /* partial or non-JSON keepalive — skip */
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const frames = buf.split(/\n\n/);
    buf = frames.pop() ?? "";
    for (const frame of frames) yield* parse(frame);
  }

  // The tail matters. Whatever is left has no trailing blank line, so the loop
  // above never emitted it — and the last frame of a run is RunCompleted, the
  // one event carrying the final answer. Dropping it meant every intern
  // finished with its tool calls logged and no summary, so nothing was ever
  // parsed out of the result and nothing reached the brain.
  yield* parse(buf + decoder.decode());
}

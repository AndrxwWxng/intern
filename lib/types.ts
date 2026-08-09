/**
 * Shared types for the Scout cockpit.
 *
 * The cockpit talks to a running Scout (the Python company-brain agent in
 * `scout/`). When Scout is unreachable the same shapes are produced by the
 * local simulator in `lib/sim.ts`, so the UI never has a dead state.
 */

export type Mode = "live" | "sim";

// ---------------------------------------------------------------------------
// Graph — the company brain
// ---------------------------------------------------------------------------

export type NodeKind =
  | "source"
  | "contact"
  | "project"
  | "note"
  | "followup"
  | "wiki"
  | "tag"
  | "intern"
  | "action";

export type GraphNode = {
  id: string;
  label: string;
  kind: NodeKind;
  /** Rough importance — drives node radius. */
  weight?: number;
  detail?: string;
  meta?: Record<string, string | number | null>;
};

export type GraphEdge = {
  source: string;
  target: string;
  /** Free-form relation label, e.g. "tagged", "owns", "cites". */
  rel?: string;
};

export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mode: Mode;
  generatedAt: number;
};

// ---------------------------------------------------------------------------
// Interns — long-running subagents
// ---------------------------------------------------------------------------

export type InternStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type Artifact = {
  kind: "note" | "wiki" | "contact" | "project" | "followup" | "answer";
  label: string;
  ref?: string;
};

export type Intern = {
  id: string;
  /** Short handle shown in the UI, e.g. `int-7f2`. */
  handle: string;
  task: string;
  status: InternStatus;
  mode: Mode;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Tools the intern has reached for, in order of first use. */
  tools: string[];
  toolCalls: number;
  artifacts: Artifact[];
  summary?: string;
  error?: string;
  sessionId: string;
};

// ---------------------------------------------------------------------------
// Outbox — what interns propose, and a human approves
// ---------------------------------------------------------------------------

export type ActionKind = "email" | "slack" | "calendar";

export type ActionStatus =
  | "pending"
  | "approved"
  | "sent"
  | "rejected"
  | "failed";

export type Draft = {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
};

/**
 * An outbound action an intern wants taken. Intern never sends — it proposes.
 * VoiceOS reads it aloud, the human says yes, VoiceOS sends with its own
 * credentials and reports back via `outbox_record_result`.
 */
export type ProposedAction = {
  id: string;
  internId: string | null;
  kind: ActionKind;
  status: ActionStatus;
  /** One line, written to be spoken. */
  title: string;
  draft: Draft;
  /** Why the intern thinks this should go out. */
  rationale: string;
  /** Graph node ids / urls the draft was built from. */
  sources: string[];
  createdAt: number;
  decidedAt?: number;
  settledAt?: number;
  decidedVia?: "voice" | "cockpit";
  /** What the executor reported back. */
  result?: string;
};

export type LogLevel = "sys" | "in" | "out" | "tool" | "ok" | "warn" | "err";

export type LogLine = {
  id: number;
  /** null for cockpit-level lines that aren't owned by an intern. */
  internId: string | null;
  ts: number;
  level: LogLevel;
  text: string;
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export type ContextStatus = {
  id: string;
  name: string;
  ok: boolean;
  detail?: string;
  tools: string[];
};

export type SystemState = {
  mode: Mode;
  scoutUrl: string;
  reachable: boolean;
  checkedAt: number;
  contexts: ContextStatus[];
  note?: string;
};

// ---------------------------------------------------------------------------
// Event stream (SSE)
// ---------------------------------------------------------------------------

export type CockpitEvent =
  | {
      type: "snapshot";
      interns: Intern[];
      log: LogLine[];
      system: SystemState;
      outbox: ProposedAction[];
    }
  | { type: "log"; line: LogLine }
  | { type: "intern"; intern: Intern }
  | { type: "graph"; graph: Graph }
  | { type: "system"; system: SystemState }
  | { type: "action"; action: ProposedAction };

/**
 * Server-side cockpit state: intern registry, log ring buffer, brain graph,
 * and the fan-out bus that feeds `/api/events`.
 *
 * Held in module scope and pinned to `globalThis` so dev hot-reload doesn't
 * orphan running interns.
 */

import type {
  CockpitEvent,
  ContextStatus,
  Graph,
  GraphEdge,
  GraphNode,
  Intern,
  LogLevel,
  LogLine,
  ActionKind,
  ActionStatus,
  Draft,
  Mode,
  ProposedAction,
  SystemState,
} from "./types";
import * as scout from "./scout";
import { planSim, seedGraph, simOutboundDraft, simSummary } from "./sim";

const LOG_CAP = 1200;
const MAX_CONCURRENT = 4;

type Subscriber = (e: CockpitEvent) => void;

type Store = {
  interns: Map<string, Intern>;
  controllers: Map<string, AbortController>;
  queue: string[];
  running: number;
  log: LogLine[];
  logSeq: number;
  graph: Graph;
  system: SystemState;
  outbox: Map<string, ProposedAction>;
  subs: Set<Subscriber>;
  probing: Promise<void> | null;
  lastProbe: number;
};

declare global {
  var __internCockpit: Partial<Store> | undefined;
}

function create(): Store {
  return {
    interns: new Map(),
    controllers: new Map(),
    queue: [],
    running: 0,
    log: [],
    logSeq: 0,
    graph: seedGraph(),
    system: {
      mode: "sim",
      scoutUrl: scout.SCOUT_URL,
      reachable: false,
      checkedAt: 0,
      contexts: [],
      note: "probing brain…",
    },
    outbox: new Map(),
    subs: new Set(),
    probing: null,
    lastProbe: 0,
  };
}

/**
 * Hot reload keeps the old object, so a store created before a field existed
 * would come back missing it. Backfill anything absent instead of trusting the
 * shape — the maps stay identical, so in-flight interns keep writing to the
 * same place.
 */
const store: Store = Object.assign(create(), globalThis.__internCockpit ?? {});
globalThis.__internCockpit = store;

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export function subscribe(fn: Subscriber): () => void {
  store.subs.add(fn);
  return () => store.subs.delete(fn);
}

function emit(e: CockpitEvent) {
  for (const fn of store.subs) {
    try {
      fn(e);
    } catch {
      /* a dead subscriber must not take down the run */
    }
  }
}

export function log(internId: string | null, level: LogLevel, text: string) {
  const line: LogLine = {
    id: ++store.logSeq,
    internId,
    ts: Date.now(),
    level,
    text,
  };
  store.log.push(line);
  if (store.log.length > LOG_CAP) store.log.splice(0, store.log.length - LOG_CAP);
  emit({ type: "log", line });
}

function touch(intern: Intern) {
  store.interns.set(intern.id, intern);
  emit({ type: "intern", intern });
}

// ---------------------------------------------------------------------------
// Snapshot accessors
// ---------------------------------------------------------------------------

export const snapshot = () => ({
  interns: [...store.interns.values()].sort((a, b) => b.createdAt - a.createdAt),
  log: store.log.slice(-400),
  system: store.system,
  graph: store.graph,
  outbox: listActions(),
});

export const getGraph = () => store.graph;
export const getSystem = () => store.system;

// ---------------------------------------------------------------------------
// Graph mutation
// ---------------------------------------------------------------------------

function setGraph(next: Graph) {
  store.graph = next;
  emit({ type: "graph", graph: next });
}

function graft(nodes: GraphNode[], edges: GraphEdge[]) {
  const byId = new Map(store.graph.nodes.map((n) => [n.id, n]));
  for (const n of nodes) byId.set(n.id, n);
  const seen = new Set(store.graph.edges.map((e) => `${e.source}->${e.target}`));
  const nextEdges = [...store.graph.edges];
  for (const e of edges) {
    const key = `${e.source}->${e.target}`;
    if (!seen.has(key) && byId.has(e.source) && byId.has(e.target)) {
      seen.add(key);
      nextEdges.push(e);
    }
  }
  setGraph({
    ...store.graph,
    nodes: [...byId.values()],
    edges: nextEdges,
    generatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Scout probe
// ---------------------------------------------------------------------------

export async function probe(force = false): Promise<SystemState> {
  const fresh = Date.now() - store.lastProbe < 15_000;
  if (!force && fresh) return store.system;
  if (store.probing) {
    await store.probing;
    return store.system;
  }

  store.probing = (async () => {
    const reachable = await scout.health();
    let contexts: ContextStatus[] = [];
    if (reachable) contexts = await scout.contexts();

    const mode: Mode = reachable ? "live" : "sim";
    const prev = store.system;
    store.system = {
      mode,
      scoutUrl: scout.SCOUT_URL,
      reachable,
      checkedAt: Date.now(),
      contexts,
      note: reachable
        ? undefined
        : `brain unreachable at ${scout.SCOUT_URL} — running simulated`,
    };
    store.lastProbe = Date.now();
    emit({ type: "system", system: store.system });

    if (reachable && prev.mode !== "live") {
      log(null, "ok", `brain online at ${scout.SCOUT_URL} · switching to LIVE`);
      await refreshGraph();
    } else if (!reachable && prev.mode === "live") {
      log(null, "warn", `lost brain at ${scout.SCOUT_URL} · falling back to SIM`);
      setGraph(seedGraph());
    }
  })();

  try {
    await store.probing;
  } finally {
    store.probing = null;
  }
  return store.system;
}

export async function refreshGraph(): Promise<Graph> {
  if (store.system.reachable) {
    const g = await scout.graph();
    if (g) {
      setGraph(g);
      return g;
    }
    log(null, "warn", "brain returned no graph — keeping what we have");
    return store.graph;
  }
  setGraph(seedGraph());
  return store.graph;
}

// ---------------------------------------------------------------------------
// Interns
// ---------------------------------------------------------------------------

let counter = 0;

export function spawn(task: string): Intern {
  const n = ++counter;
  const id = `int-${n.toString(36).padStart(2, "0")}${Math.random()
    .toString(36)
    .slice(2, 4)}`;
  const intern: Intern = {
    id,
    handle: id,
    task,
    status: "queued",
    mode: store.system.reachable ? "live" : "sim",
    createdAt: Date.now(),
    tools: [],
    toolCalls: 0,
    artifacts: [],
    sessionId: `cockpit-${id}`,
  };
  store.interns.set(id, intern);

  // The intern is a first-class node in the brain while it works.
  graft(
    [{ id, label: id, kind: "intern", weight: 5, detail: task.slice(0, 80) }],
    [{ source: "brain", target: id, rel: "dispatched" }],
  );

  emit({ type: "intern", intern });
  log(id, "sys", `spawned · ${task}`);

  store.queue.push(id);
  pump();
  return intern;
}

export function cancel(id: string): boolean {
  const intern = store.interns.get(id);
  if (!intern) return false;
  if (intern.status === "done" || intern.status === "failed") return false;

  store.controllers.get(id)?.abort();
  store.queue = store.queue.filter((q) => q !== id);
  if (intern.status === "queued") {
    intern.status = "cancelled";
    intern.endedAt = Date.now();
    touch(intern);
    log(id, "warn", "cancelled before start");
  }
  return true;
}

function pump() {
  while (store.running < MAX_CONCURRENT && store.queue.length) {
    const id = store.queue.shift()!;
    const intern = store.interns.get(id);
    if (!intern || intern.status !== "queued") continue;
    store.running++;
    void run(intern).finally(() => {
      store.running--;
      pump();
    });
  }
}

async function run(intern: Intern) {
  const ctl = new AbortController();
  store.controllers.set(intern.id, ctl);

  intern.status = "running";
  intern.startedAt = Date.now();
  intern.mode = store.system.reachable ? "live" : "sim";
  touch(intern);

  try {
    if (intern.mode === "live") {
      await runLive(intern, ctl.signal);
    } else {
      await runSim(intern, ctl.signal);
    }
    if (intern.status === "running") {
      intern.status = "done";
      intern.endedAt = Date.now();
      touch(intern);
      log(intern.id, "ok", `finished in ${elapsed(intern)}`);
    }
  } catch (err) {
    if (ctl.signal.aborted) {
      intern.status = "cancelled";
      intern.endedAt = Date.now();
      touch(intern);
      log(intern.id, "warn", "cancelled");
    } else {
      intern.status = "failed";
      intern.error = err instanceof Error ? err.message : String(err);
      intern.endedAt = Date.now();
      touch(intern);
      log(intern.id, "err", intern.error);
    }
  } finally {
    store.controllers.delete(intern.id);
  }
}

const elapsed = (i: Intern) =>
  `${(((i.endedAt ?? Date.now()) - (i.startedAt ?? i.createdAt)) / 1000).toFixed(1)}s`;

const BRIEF = (task: string) => `You are an intern working a long-running task for the team.

TASK: ${task}

Work it end to end. Navigate the sources you need — do not guess. When you have
something durable, file it: prose and decisions into the knowledge wiki via
update_knowledge, structured facts (people, projects, notes, follow-ups) into the
CRM via update_crm. Link what you write to what already exists. Finish with a
short report of what you found and what you filed.

If the task implies something should go OUT to a person — an email, a Slack
message, a meeting invite — do not send it and do not claim you sent it. You
have no send tool. Instead, draft it and end your report with exactly one
fenced block, using query_voice first so the draft is in the house style:

\`\`\`action
{"kind":"email","to":["someone@example.com"],"subject":"…","body":"…",
 "rationale":"why this should go out","sources":["what you based it on"]}
\`\`\`

A human approves it before anything is sent.`;

async function runLive(intern: Intern, signal: AbortSignal) {
  let buffer = "";
  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    if (text) log(intern.id, "out", text);
  };

  for await (const ev of scout.runStream(BRIEF(intern.task), {
    sessionId: intern.sessionId,
    signal,
  })) {
    const kind = String(ev.event ?? "");

    if (kind.includes("ToolCallStarted") || kind === "tool_call_started") {
      flush();
      const name =
        ev.tool?.tool_name ?? ev.tools?.[0]?.tool_name ?? "tool";
      intern.toolCalls++;
      if (!intern.tools.includes(name)) intern.tools.push(name);
      touch(intern);
      log(intern.id, "tool", `${name}(…)`);
      continue;
    }

    if (kind.includes("ToolCallCompleted") || kind === "tool_call_completed") {
      const name = ev.tool?.tool_name ?? "tool";
      const result = ev.tool?.result;
      const preview =
        typeof result === "string"
          ? result.replace(/\s+/g, " ").slice(0, 240)
          : "";
      log(intern.id, "ok", `${name} → ${preview || "ok"}`);
      if (name.startsWith("update_")) {
        const artifact = {
          kind: name.includes("knowledge") ? ("wiki" as const) : ("note" as const),
          label: preview.slice(0, 80) || name,
        };
        intern.artifacts.push(artifact);
        touch(intern);
      }
      continue;
    }

    if (typeof ev.content === "string" && ev.content) {
      buffer += ev.content;
      // Flush on sentence-ish boundaries so the terminal reads like a stream
      // of thoughts rather than one wall of text at the end.
      if (buffer.length > 160 || /[.\n]$/.test(buffer)) flush();
      continue;
    }

    if (kind.includes("RunCompleted") || kind === "run_completed") {
      flush();
      const content = typeof ev.content === "string" ? ev.content : undefined;
      if (content) intern.summary = content.slice(0, 600);
    }

    if (kind.includes("RunError") || kind.includes("Error")) {
      flush();
      throw new Error(String(ev.content ?? "scout run error"));
    }
  }

  flush();

  if (intern.summary) {
    const proposed = parseProposedAction(intern.summary, intern.id);
    if (proposed) {
      intern.artifacts.push({
        kind: "answer",
        label: `proposed ${proposed.kind}: ${proposed.draft.subject}`,
        ref: proposed.id,
      });
      touch(intern);
    }
  }
  if (intern.artifacts.length) await refreshGraph();
}

async function runSim(intern: Intern, signal: AbortSignal) {
  const steps = planSim(intern.task, intern.id);
  for (const step of steps) {
    await sleep(step.delay, signal);
    if (signal.aborted) throw new Error("aborted");

    if (step.tool) {
      intern.toolCalls++;
      if (!intern.tools.includes(step.tool)) intern.tools.push(step.tool);
      touch(intern);
    }
    log(intern.id, step.level, step.text);

    if (step.artifact) {
      intern.artifacts.push(step.artifact);
      touch(intern);
    }
    if (step.graft) graft(step.graft.nodes, step.graft.edges);
  }
  intern.summary = simSummary(intern.task);

  const outbound = simOutboundDraft(intern.task);
  if (outbound) {
    const proposed = proposeAction({ internId: intern.id, ...outbound });
    intern.artifacts.push({
      kind: "answer",
      label: `proposed email: ${proposed.draft.subject}`,
      ref: proposed.id,
    });
    touch(intern);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// One-shot ask (not an intern — a direct question to the brain)
// ---------------------------------------------------------------------------

export async function ask(question: string): Promise<void> {
  log(null, "in", `? ${question}`);
  await probe();

  if (!store.system.reachable) {
    const g = store.graph;
    const q = question.toLowerCase();
    const hits = g.nodes
      .filter(
        (n) =>
          n.label.toLowerCase().includes(q.split(/\s+/)[0] ?? "") ||
          q.includes(n.label.toLowerCase().split(/\s+/)[0] ?? " "),
      )
      .slice(0, 6);
    log(null, "warn", "SIM · answering from the local brain index only");
    if (hits.length) {
      for (const h of hits) log(null, "out", `${h.kind.padEnd(9)} ${h.label}`);
    } else {
      log(null, "out", "no matching nodes. spawn an intern to go find out.");
    }
    return;
  }

  let buffer = "";
  const flush = () => {
    const t = buffer.trim();
    buffer = "";
    if (t) log(null, "out", t);
  };

  try {
    for await (const ev of scout.runStream(question, {
      sessionId: "cockpit-ask",
    })) {
      const kind = String(ev.event ?? "");
      if (kind.includes("ToolCallStarted")) {
        flush();
        log(null, "tool", `${ev.tool?.tool_name ?? "tool"}(…)`);
      } else if (typeof ev.content === "string" && ev.content) {
        buffer += ev.content;
        if (buffer.length > 160 || /[.\n]$/.test(buffer)) flush();
      }
    }
    flush();
  } catch (err) {
    log(null, "err", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Outbox
//
// Interns never send anything. They propose, a human approves out loud, and
// whoever holds the credentials (VoiceOS) executes and reports back. The whole
// point of the split: the draft is written from web pages, Slack messages and
// documents the intern read — untrusted text — so nothing derived from it
// leaves the building without a person saying yes.
// ---------------------------------------------------------------------------

let actionCounter = 0;

export function listActions(status?: ActionStatus): ProposedAction[] {
  const all = [...store.outbox.values()].sort((a, b) => b.createdAt - a.createdAt);
  return status ? all.filter((a) => a.status === status) : all;
}

export const getAction = (id: string) => store.outbox.get(id) ?? null;

export function proposeAction(input: {
  internId: string | null;
  kind: ActionKind;
  title: string;
  draft: Draft;
  rationale: string;
  sources?: string[];
}): ProposedAction {
  const id = `act-${(++actionCounter).toString(36).padStart(2, "0")}${Math.random()
    .toString(36)
    .slice(2, 4)}`;
  const action: ProposedAction = {
    id,
    internId: input.internId,
    kind: input.kind,
    status: "pending",
    title: input.title,
    draft: input.draft,
    rationale: input.rationale,
    sources: input.sources ?? [],
    createdAt: Date.now(),
  };
  store.outbox.set(id, action);
  emit({ type: "action", action });
  log(
    input.internId,
    "warn",
    `proposed ${input.kind} · "${input.draft.subject}" → ${input.draft.to.join(", ")} · awaiting approval (${id})`,
  );

  const nodes: GraphNode[] = [
    {
      id,
      label: `✉ ${input.draft.subject}`.slice(0, 60),
      kind: "action",
      weight: 4,
      detail: `pending · to ${input.draft.to.join(", ")}`,
    },
  ];
  const edges: GraphEdge[] = [{ source: "brain", target: id, rel: "proposed" }];
  if (input.internId) {
    edges.push({ source: input.internId, target: id, rel: "drafted" });
  }
  graft(nodes, edges);
  return action;
}

function settle(action: ProposedAction, detail: string) {
  store.outbox.set(action.id, action);
  emit({ type: "action", action });
  graft(
    [
      {
        id: action.id,
        label: `✉ ${action.draft.subject}`.slice(0, 60),
        kind: "action",
        weight: 4,
        detail,
      },
    ],
    [],
  );
}

export function approveAction(
  id: string,
  via: "voice" | "cockpit",
): ProposedAction | null {
  const action = store.outbox.get(id);
  if (!action || action.status !== "pending") return null;
  action.status = "approved";
  action.decidedAt = Date.now();
  action.decidedVia = via;
  settle(action, `approved via ${via}`);
  log(action.internId, "ok", `${id} approved via ${via} · handed to the executor`);
  return action;
}

export function rejectAction(
  id: string,
  reason: string,
  via: "voice" | "cockpit",
): ProposedAction | null {
  const action = store.outbox.get(id);
  if (!action || (action.status !== "pending" && action.status !== "approved")) {
    return null;
  }
  action.status = "rejected";
  action.decidedAt = Date.now();
  action.decidedVia = via;
  action.result = reason;
  settle(action, `rejected · ${reason}`.slice(0, 60));
  log(action.internId, "warn", `${id} rejected via ${via}${reason ? ` · ${reason}` : ""}`);
  return action;
}

/** The executor (VoiceOS) tells us what actually happened. */
export function recordActionResult(
  id: string,
  status: "sent" | "failed",
  detail?: string,
): ProposedAction | null {
  const action = store.outbox.get(id);
  if (!action) return null;
  if (status === "sent" && action.status !== "approved") return null;
  action.status = status;
  action.settledAt = Date.now();
  action.result = detail;
  settle(action, status === "sent" ? "sent" : `failed · ${detail ?? ""}`.slice(0, 60));
  log(
    action.internId,
    status === "sent" ? "ok" : "err",
    `${id} ${status}${detail ? ` · ${detail}` : ""}`,
  );
  return action;
}

/**
 * Pull a proposed action out of an intern's final report.
 *
 * The brief asks for a fenced ```action block of JSON when the task implies
 * something outbound. Parsing one block is deterministic; asking the model to
 * "just say if you want to send an email" is not.
 */
export function parseProposedAction(
  report: string,
  internId: string,
): ProposedAction | null {
  const match = report.match(/```action\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1].trim()) as {
      kind?: string;
      to?: string[] | string;
      cc?: string[] | string;
      subject?: string;
      body?: string;
      rationale?: string;
      sources?: string[];
    };
    const to = Array.isArray(raw.to) ? raw.to : raw.to ? [raw.to] : [];
    if (!to.length || !raw.subject || !raw.body) return null;
    const kind: ActionKind =
      raw.kind === "slack" || raw.kind === "calendar" ? raw.kind : "email";
    return proposeAction({
      internId,
      kind,
      title: `${kind} to ${to.join(", ")} — ${raw.subject}`,
      draft: {
        to,
        cc: Array.isArray(raw.cc) ? raw.cc : raw.cc ? [raw.cc] : undefined,
        subject: raw.subject,
        body: raw.body,
      },
      rationale: raw.rationale ?? "proposed by the intern from its findings",
      sources: raw.sources ?? [],
    });
  } catch {
    log(internId, "warn", "final report had an action block that wasn't valid JSON");
    return null;
  }
}

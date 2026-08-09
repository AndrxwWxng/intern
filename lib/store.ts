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
  Fact,
  Mode,
  ProposedAction,
  Question,
  RoleId,
  SystemState,
} from "./types";
import { outgoing } from "./types";
import * as scout from "./scout";
import {
  planSim,
  seedGraph,
  simOutboundDraft,
  simQuestion,
  simSummary,
} from "./sim";
import {
  DRY_RUN,
  connectorFor,
  connectorStatus,
  execute,
} from "./connectors";
import * as brain from "./brain";
import { DEFAULT_ROLE, getRole, pickRole } from "./roster";
import * as trust from "./trust";

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
  questions: Map<string, Question>;
  /** The last graph read from Scout or seeded, before our facts are grafted on. */
  base: Graph;
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
    questions: new Map(),
    base: seedGraph(),
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
  questions: listQuestions(),
  trust: trust.all(),
  brain: brain.stats(),
});

export const getGraph = () => store.graph;
export const getSystem = () => store.system;

// ---------------------------------------------------------------------------
// Graph mutation
//
// Two things feed the picture: whatever Scout projects (or the seed, offline)
// and the facts we hold ourselves. The second must survive a re-read of the
// first, so `base` is kept aside and our projection is grafted back on top
// every time the base changes. Otherwise a `graph refresh` would quietly erase
// everything captured since the last one.
// ---------------------------------------------------------------------------

function setBase(next: Graph) {
  store.base = next;
  const facts = brain.projection();

  // The seed exists so the UI is never dead on arrival. The moment the brain
  // holds anything real that reason is gone, and showing invented people
  // beside real ones is worse than showing nothing — so real facts replace the
  // seed rather than joining it. LIVE is untouched: Scout's graph is real too,
  // so there both halves are kept.
  const seeded = next.mode === "sim" && facts.nodes.length > 0;
  const baseNodes = seeded ? [] : next.nodes;
  const baseEdges = seeded ? [] : next.edges;

  const byId = new Map(baseNodes.map((n) => [n.id, n]));
  for (const n of facts.nodes) byId.set(n.id, n);

  const seen = new Set(baseEdges.map((e) => `${e.source}->${e.target}`));
  const edges = [...baseEdges];
  for (const e of facts.edges) {
    const key = `${e.source}->${e.target}`;
    if (seen.has(key) || !byId.has(e.source) || !byId.has(e.target)) continue;
    seen.add(key);
    edges.push(e);
  }

  store.graph = {
    ...next,
    nodes: [...byId.values()],
    edges,
    generatedAt: Date.now(),
  };
  emit({ type: "graph", graph: store.graph });
  emit({ type: "brain", brain: brain.stats() });
}

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
  // Replaying the log is idempotent and only ever happens once, but every
  // entry point goes through here, so this is the one place it needs to be.
  await brain.ready();
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
      setBase(seedGraph());
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
      setBase(g);
      return store.graph;
    }
    log(null, "warn", "brain returned no graph — keeping what we have");
    return store.graph;
  }
  setBase(seedGraph());
  return store.graph;
}

// ---------------------------------------------------------------------------
// Interns
// ---------------------------------------------------------------------------

// Seeded from what is already there: hot reload replaces this module but keeps
// the store on `globalThis`, so a counter starting from zero would hand out ids
// that already belong to something.
let counter = store.interns.size;

export function spawn(
  task: string,
  opts: { role?: RoleId; resumes?: string } = {},
): Intern {
  const n = ++counter;
  const id = `int-${n.toString(36).padStart(2, "0")}${Math.random()
    .toString(36)
    .slice(2, 4)}`;
  const role = opts.role ?? pickRole(task);
  const intern: Intern = {
    id,
    handle: id,
    task,
    role,
    status: "queued",
    mode: store.system.reachable ? "live" : "sim",
    createdAt: Date.now(),
    resumes: opts.resumes,
    tools: [],
    toolCalls: 0,
    artifacts: [],
    sessionId: `cockpit-${id}`,
  };
  store.interns.set(id, intern);

  // The intern is a first-class node in the brain while it works.
  graft(
    [
      {
        id,
        label: id,
        kind: "intern",
        weight: 5,
        detail: `${role} · ${task.slice(0, 70)}`,
      },
    ],
    [{ source: "brain", target: id, rel: "dispatched" }],
  );

  emit({ type: "intern", intern });
  log(id, "sys", `spawned as ${role} · ${task}`);
  brain.note({
    kind: "spawn",
    actor: "you",
    internId: id,
    sourceId: null,
    ref: id,
    detail: `${role}: ${task.slice(0, 120)}`,
  });

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

/**
 * Everything the brain has learned about how this role should work, rendered
 * for the brief.
 *
 * This is the entire learning loop and it is deliberately this small: a person
 * corrects a draft, the correction becomes a fact, the next brief retrieves it,
 * behaviour changes. Nobody wrote a rule and there is no training job.
 */
function recalled(intern: Intern): { text: string; facts: Fact[] } {
  const preferences = brain.preferencesFor(intern.role, 5);
  const context = brain.recall(intern.task, { limit: 4 }).filter(
    (f) => !preferences.some((p) => p.id === f.id),
  );
  const facts = [...preferences, ...context];
  if (!facts.length) return { text: "", facts };

  const lines = facts.map(
    (f) => `- [${f.id}] ${f.title}${f.body ? `\n    ${f.body.replace(/\n+/g, " ").slice(0, 400)}` : ""}`,
  );
  return {
    text: `
WHAT THE BRAIN ALREADY KNOWS — earned from earlier work, follow it:
${lines.join("\n")}
`,
    facts,
  };
}

const BRIEF = (intern: Intern, learned: string) =>
  `You are an intern working a long-running task for the team.

${getRole(intern.role).charter}

TASK: ${intern.task}
${learned}
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

A human approves it before anything is sent.

If something the task left out cannot be resolved from the brain — who someone
reports to, which of two people was meant, a date nobody stated — do NOT pick
the likely one. Stop and ask, with exactly one fenced block:

\`\`\`question
{"question":"the one thing you need answered","context":"what you were doing and what you already tried"}
\`\`\`

A wrong guess quietly poisons everything downstream of it; a question costs
someone ten seconds. Ask at most one per run, and only when you are genuinely
blocked.`;

async function runLive(intern: Intern, signal: AbortSignal) {
  let buffer = "";
  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    if (text) log(intern.id, "out", text);
  };

  const learned = recalled(intern);
  if (learned.facts.length) {
    log(
      intern.id,
      "sys",
      `recalled ${learned.facts.length} fact${learned.facts.length === 1 ? "" : "s"} from the brain · ${learned.facts
        .map((f) => f.id)
        .join(" ")}`,
    );
  }

  for await (const ev of scout.runStream(BRIEF(intern, learned.text), {
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
    // A question outranks a proposal: an intern that asked and also drafted
    // built that draft on the assumption it just said it could not make.
    const asked = parseQuestion(intern.summary, intern);
    if (asked) {
      park(intern, asked);
      return;
    }
    const proposed = parseProposedAction(intern.summary, intern);
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
  const learned = recalled(intern);
  if (learned.facts.length) {
    log(
      intern.id,
      "sys",
      `recalled ${learned.facts.length} fact${learned.facts.length === 1 ? "" : "s"} from the brain · ${learned.facts
        .map((f) => f.id)
        .join(" ")}`,
    );
  }

  const question = simQuestion(intern.task, intern.role);
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

    // The simulated intern hits the thing it cannot resolve part-way through,
    // the same as a real one would, and stops there rather than at the end.
    if (question && step.level === "ok" && !intern.blockedBy) {
      park(intern, askQuestion(intern, question.question, question.context));
      return;
    }
  }
  intern.summary = simSummary(intern.task);

  const outbound = simOutboundDraft(intern.task);
  if (outbound) {
    const proposed = proposeAction({
      internId: intern.id,
      role: intern.role,
      ...outbound,
    });
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
// Questions — the other kind of handover
//
// An approval gate is a handover whose recipient happens to be a person. So is
// a question. The only difference is which way the information flows, which is
// why they share the parking, the graph node and the resume path.
//
// Parked means parked: there is no timeout that eventually guesses.
// ---------------------------------------------------------------------------

let questionCounter = store.questions.size;

export const listQuestions = (status?: Question["status"]): Question[] => {
  const all = [...store.questions.values()].sort((a, b) => b.askedAt - a.askedAt);
  return status ? all.filter((q) => q.status === status) : all;
};

export const getQuestion = (id: string) => store.questions.get(id) ?? null;

export function askQuestion(
  intern: Intern,
  question: string,
  context: string,
): Question {
  const id = `ask-${(++questionCounter).toString(36).padStart(2, "0")}${Math.random()
    .toString(36)
    .slice(2, 4)}`;
  const row: Question = {
    id,
    internId: intern.id,
    role: intern.role,
    question: question.slice(0, 500),
    context: context.slice(0, 1000),
    status: "open",
    askedAt: Date.now(),
  };
  store.questions.set(id, row);
  emit({ type: "question", question: row });
  log(intern.id, "warn", `asks: ${row.question}`);
  brain.note({
    kind: "question",
    actor: "system",
    internId: intern.id,
    sourceId: null,
    ref: id,
    detail: row.question,
  });

  graft(
    [
      {
        id,
        label: `? ${row.question}`.slice(0, 56),
        kind: "question",
        weight: 4,
        detail: "waiting on a person",
      },
    ],
    [{ source: intern.id, target: id, rel: "asks" }],
  );
  return row;
}

/** Stop the intern where it stands and hand the work to a person. */
function park(intern: Intern, question: Question) {
  intern.status = "waiting";
  intern.blockedBy = question.id;
  intern.endedAt = Date.now();
  touch(intern);
  log(intern.id, "sys", `parked · waiting on ${question.id}`);
}

/**
 * Answer a question. The answer becomes a fact first — so it is there for
 * every future task, not just this one — and only then is the parked work
 * picked back up.
 */
export function answerQuestion(
  id: string,
  answer: string,
  actor = "you",
): { question: Question; resumed: Intern | null } | null {
  const question = store.questions.get(id);
  if (!question || question.status !== "open") return null;

  question.status = "answered";
  question.answer = answer.slice(0, 2000);
  question.answeredAt = Date.now();

  const fact = brain.learn({
    kind: "answer",
    title: question.question,
    body: answer,
    actor,
    subject: question.role,
    tags: ["answered"],
    internId: question.internId,
  });
  log(question.internId, "ok", `${id} answered · filed as ${fact.id}`);
  brain.note({
    kind: "answer",
    actor,
    internId: question.internId,
    sourceId: null,
    ref: id,
    detail: answer.slice(0, 160),
  });

  // Re-project first so the new fact is a node the edge can actually attach to.
  setBase(store.base);
  graft(
    [
      {
        id,
        label: `? ${question.question}`.slice(0, 56),
        kind: "question",
        weight: 4,
        detail: `answered · ${answer.slice(0, 60)}`,
      },
    ],
    [{ source: id, target: fact.id, rel: "answered" }],
  );

  // Resume by dispatching a fresh intern that inherits the answer. A run that
  // has already ended cannot be rewound, and pretending otherwise would mean
  // replaying tool calls that already happened.
  let resumed: Intern | null = null;
  const parked = question.internId ? store.interns.get(question.internId) : null;
  if (parked && parked.status === "waiting") {
    parked.status = "done";
    parked.blockedBy = undefined;
    touch(parked);
    resumed = spawn(
      `${parked.task}\n\nYou asked: ${question.question}\nThe answer is: ${answer}\nCarry on from there.`,
      { role: parked.role, resumes: parked.id },
    );
    question.resumedBy = resumed.id;
    graft([], [{ source: id, target: resumed.id, rel: "resumed" }]);
  }

  emit({ type: "question", question });
  emit({ type: "brain", brain: brain.stats() });
  return { question, resumed };
}

/** The question doesn't need answering after all. The work stays stopped. */
export function dismissQuestion(id: string): Question | null {
  const question = store.questions.get(id);
  if (!question || question.status !== "open") return null;
  question.status = "dismissed";
  question.answeredAt = Date.now();
  const parked = question.internId ? store.interns.get(question.internId) : null;
  if (parked && parked.status === "waiting") {
    parked.status = "cancelled";
    parked.blockedBy = undefined;
    touch(parked);
  }
  emit({ type: "question", question });
  log(question.internId, "warn", `${id} dismissed`);
  return question;
}

/**
 * Pull a question out of an intern's final report — same fenced-block trick as
 * the action block, and for the same reason: one deterministic parse beats
 * asking a model to reliably signal intent in prose.
 */
export function parseQuestion(report: string, intern: Intern): Question | null {
  const match = report.match(/```question\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1].trim()) as {
      question?: string;
      context?: string;
    };
    if (!raw.question) return null;
    return askQuestion(intern, raw.question, raw.context ?? intern.task);
  } catch {
    log(intern.id, "warn", "final report had a question block that wasn't valid JSON");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capture — the pushed ingestion path
//
// Someone points at something and says "add this to the brain". The channel's
// own agent reads it and calls this; no OAuth of ours is involved, which is
// exactly why this path exists before any connector does.
//
// Idempotent by construction: the same thing captured twice is one observation
// with one fact, so a retry, a double-tap or two people forwarding the same
// message all land the same way.
// ---------------------------------------------------------------------------

export async function capture(input: {
  sourceId?: string;
  externalId?: string;
  actor?: string;
  title: string;
  body: string;
  url?: string;
  tags?: string[];
  kind?: Fact["kind"];
  /** Also put an archivist on writing it into the wiki properly. */
  file?: boolean;
}): Promise<{ fact: Fact; fresh: boolean; merged: boolean; intern: Intern | null }> {
  await brain.ready();

  const hint = { kind: input.kind ?? ("note" as const), tags: input.tags };
  const { observation, fresh } = brain.record({
    sourceId: input.sourceId ?? "capture",
    externalId: input.externalId,
    actor: input.actor ?? "you",
    title: input.title,
    body: input.body,
    url: input.url,
    hint,
  });
  const { fact, merged } = brain.promote(observation, hint);

  log(
    null,
    fresh ? "ok" : "sys",
    fresh
      ? `captured ${observation.id} → ${merged ? `corroborates ${fact.id}` : `new fact ${fact.id}`} · ${fact.title}`
      : `already had that one · ${observation.id} → ${fact.id}`,
  );

  setBase(store.base);

  let intern: Intern | null = null;
  if (input.file && fresh) {
    intern = spawn(
      `File this into the knowledge wiki and link it to what already exists.\n\nTITLE: ${input.title}\n\n${input.body}${
        input.url ? `\n\nSOURCE: ${input.url}` : ""
      }`,
      { role: "archivist" },
    );
  }

  return { fact, fresh, merged, intern };
}

// ---------------------------------------------------------------------------
// One-shot ask (not an intern — a direct question to the brain)
// ---------------------------------------------------------------------------

export async function ask(question: string): Promise<void> {
  log(null, "in", `? ${question}`);
  await probe();

  if (!store.system.reachable) {
    // Facts first: they are the citable layer, and unlike graph nodes they
    // carry provenance, so the answer can say where it came from.
    const facts = brain.recall(question, { limit: 5 });
    const first = question.toLowerCase().split(/\s+/)[0] ?? "";
    const hits = store.graph.nodes
      .filter(
        (n) =>
          n.kind !== "fact" &&
          first.length > 1 &&
          n.label.toLowerCase().includes(first),
      )
      .slice(0, 6);

    log(null, "warn", "SIM · answering from the local brain index only");
    for (const f of facts) {
      log(
        null,
        "out",
        `${f.kind.padEnd(11)} ${f.title}  [${f.id} · ${f.observations.length} obs · ${Math.round(f.confidence * 100)}%]`,
      );
    }
    for (const h of hits) log(null, "out", `${h.kind.padEnd(11)} ${h.label}`);
    if (!facts.length && !hits.length) {
      log(null, "out", "nothing on that yet. spawn an intern, or capture what you know.");
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

let actionCounter = store.outbox.size;

export function listActions(status?: ActionStatus): ProposedAction[] {
  const all = [...store.outbox.values()].sort((a, b) => b.createdAt - a.createdAt);
  return status ? all.filter((a) => a.status === status) : all;
}

export const getAction = (id: string) => store.outbox.get(id) ?? null;

export function proposeAction(input: {
  internId: string | null;
  role?: RoleId;
  kind: ActionKind;
  title: string;
  draft: Draft;
  rationale: string;
  sources?: string[];
}): ProposedAction {
  const id = `act-${(++actionCounter).toString(36).padStart(2, "0")}${Math.random()
    .toString(36)
    .slice(2, 4)}`;
  const role =
    input.role ??
    (input.internId ? store.interns.get(input.internId)?.role : undefined) ??
    DEFAULT_ROLE;
  const action: ProposedAction = {
    id,
    internId: input.internId,
    role,
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
  brain.note({
    kind: "handover",
    actor: "system",
    internId: input.internId,
    sourceId: null,
    ref: id,
    detail: `${role} proposed ${input.kind}: ${input.draft.subject}`,
  });

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

  // A graduated role has already been judged on this kind of work often enough
  // that a person said to stop reviewing it. Honouring that is the whole point
  // of graduation — but it happens loudly, in the same stream as everything
  // else, so nobody discovers it after the fact.
  if (trust.isGraduated(role)) {
    log(input.internId, "sys", `${role} is graduated · ${id} goes without review`);
    void approveAndSend(id, "graduated");
  }
  return action;
}

function settle(action: ProposedAction, detail: string) {
  store.outbox.set(action.id, action);
  emit({ type: "action", action });
  brain.note({
    kind: "decision",
    actor: action.decidedVia === "graduated" ? "system" : "you",
    internId: action.internId,
    sourceId: null,
    ref: action.id,
    detail,
  });
  graft(
    [
      {
        id: action.id,
        label: `✉ ${outgoing(action).subject}`.slice(0, 60),
        kind: "action",
        weight: 4,
        detail,
      },
    ],
    [],
  );
}

const FIELDS: (keyof Draft)[] = ["to", "cc", "subject", "body", "startsAt", "endsAt"];

const render = (v: Draft[keyof Draft]): string =>
  Array.isArray(v) ? v.join(", ") : (v ?? "");

/** Which fields the person actually rewrote. Whitespace-only changes don't count. */
function changedFields(proposed: Draft, accepted: Draft): (keyof Draft)[] {
  return FIELDS.filter(
    (f) => render(proposed[f]).trim() !== render(accepted[f]).trim(),
  );
}

export type Decision = "voice" | "cockpit" | "graduated";

/**
 * Approve a draft, optionally rewriting it first.
 *
 * The edited version is stored beside the original, never over it. That pair —
 * what the intern wrote, what the person was willing to send — is the only
 * honest signal the system gets about how good the work actually was, and it
 * is the reason the next draft is better. Collapsing them into one field would
 * make the outbox tidier and the product pointless.
 */
export function approveAction(
  id: string,
  via: Decision,
  edits?: Partial<Draft>,
): ProposedAction | null {
  const action = store.outbox.get(id);
  if (!action || action.status !== "pending") return null;

  const accepted: Draft = { ...action.draft, ...edits };
  const edited = edits ? changedFields(action.draft, accepted) : [];

  action.status = "approved";
  action.decidedAt = Date.now();
  action.decidedVia = via;
  if (edited.length) {
    action.accepted = accepted;
    action.editedFields = edited;
  }

  settle(action, edited.length ? `approved with edits via ${via}` : `approved via ${via}`);
  log(
    action.internId,
    "ok",
    edited.length
      ? `${id} approved via ${via} with edits to ${edited.join(", ")}`
      : `${id} approved via ${via} · handed to the executor`,
  );

  // Graduated work is not supervised, so it is not evidence about supervision.
  // Counting it would let a role's rate drift up on decisions nobody made.
  if (via !== "graduated") {
    recordDecision(action, edited.length ? "edited" : "unedited");
  }
  if (edited.length) learnFromEdit(action, accepted, edited);

  return action;
}

/**
 * "Not like this." The task halts and the reason is filed as a correction, so
 * the next intern on this kind of work reads it before it starts.
 */
export function rejectAction(
  id: string,
  reason: string,
  via: Decision,
): ProposedAction | null {
  const action = store.outbox.get(id);
  if (!action || (action.status !== "pending" && action.status !== "approved")) {
    return null;
  }
  // Rejecting work that went out unsupervised is the single most important
  // signal there is, and it never passes through `pending` — graduation
  // approves it on arrival. Counting only pending rejections would make
  // graduation permanent in practice, whatever the revocation rule said.
  const unreviewed =
    action.status === "pending" || action.decidedVia === "graduated";

  action.status = "rejected";
  action.decidedAt = Date.now();
  action.decidedVia = via;
  action.result = reason;
  settle(action, `rejected · ${reason}`.slice(0, 60));
  log(action.internId, "warn", `${id} rejected via ${via}${reason ? ` · ${reason}` : ""}`);

  if (unreviewed) recordDecision(action, "rejected");

  const fact = brain.learn({
    kind: "correction",
    title: `do not send: ${action.draft.subject}`,
    body: `A ${action.role} drafted a ${action.kind} to ${action.draft.to.join(", ")} and a person rejected it.\n\nReason given: ${reason}\n\nWhat was drafted:\n${action.draft.body}`,
    subject: action.role,
    tags: ["rejected", action.kind],
    internId: action.internId,
  });
  log(action.internId, "sys", `filed the reason as ${fact.id} · the next ${action.role} reads it first`);
  emit({ type: "brain", brain: brain.stats() });
  return action;
}

/** Fold the decision into the role's record, and say so if a line was crossed. */
function recordDecision(
  action: ProposedAction,
  outcome: "unedited" | "edited" | "rejected",
) {
  const { trust: record, proposed, revoked } = trust.record(
    action.role,
    action.id,
    outcome,
  );
  emit({ type: "trust", trust: trust.all() });

  if (revoked) {
    log(null, "warn", `${action.role} un-graduated · back to supervised on every draft`);
  }
  if (proposed) {
    log(
      null,
      "ok",
      `${action.role} is ready to graduate · ${Math.round(record.rate * 100)}% accepted unedited over ${record.decisions} · run "graduate ${action.role}" to confirm`,
    );
  }
}

/**
 * Turn one edit into a preference the next brief will carry.
 *
 * The before and after are both kept in full. A summary of what changed would
 * be smaller and would lose the thing that matters — how the person actually
 * writes, as opposed to how they'd describe the way they write.
 */
function learnFromEdit(
  action: ProposedAction,
  accepted: Draft,
  edited: (keyof Draft)[],
) {
  const fact = brain.learn({
    kind: "preference",
    title: `${action.role}: ${edited.join(" and ")} rewritten before sending`,
    body: [
      `A ${action.role} drafted a ${action.kind}; a person rewrote it before approving.`,
      "",
      ...edited.flatMap((field) => [
        `${String(field).toUpperCase()} — proposed:`,
        render(action.draft[field]),
        `${String(field).toUpperCase()} — accepted:`,
        render(accepted[field]),
        "",
      ]),
      "Write it the accepted way next time.",
    ].join("\n"),
    subject: action.role,
    tags: ["voice", action.kind],
    internId: action.internId,
  });
  log(
    action.internId,
    "sys",
    `learned ${fact.id} from your edit · every ${action.role} from now on starts with it`,
  );
  emit({ type: "brain", brain: brain.stats() });
}

// ---------------------------------------------------------------------------
// Graduation
// ---------------------------------------------------------------------------

export function graduateRole(role: RoleId, confirmed: boolean) {
  const record = trust.graduate(role, confirmed);
  emit({ type: "trust", trust: trust.all() });
  log(
    null,
    confirmed ? "ok" : "sys",
    confirmed
      ? `${role} graduated · its drafts now go without review, and one rejection takes it back`
      : `${role} stays supervised`,
  );
  return record;
}

export const trustRecords = () => trust.all();

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

  // What actually left the building is itself something the company now knows.
  // Without this the brain would have no record that the email exists, and the
  // next intern would happily draft it again.
  if (status === "sent") {
    const sent = outgoing(action);
    const { observation } = brain.record({
      sourceId: `sent:${action.kind}`,
      externalId: action.id,
      actor: "you",
      title: `${action.kind} sent to ${sent.to.join(", ")}: ${sent.subject}`,
      body: sent.body,
      hint: { kind: "note", tags: ["sent", action.kind] },
    });
    brain.promote(observation, { kind: "note", tags: ["sent", action.kind] });
    setBase(store.base);
  }
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
  intern: Intern,
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
      internId: intern.id,
      role: intern.role,
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
    log(intern.id, "warn", "final report had an action block that wasn't valid JSON");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Execution
//
// The only path from an approved draft to something actually leaving. Splitting
// approve from execute keeps the gate honest: approveAction records a human
// decision, executeAction acts on it, and neither can happen out of order.
// ---------------------------------------------------------------------------

export async function executeAction(id: string): Promise<ProposedAction | null> {
  const action = store.outbox.get(id);
  if (!action || action.status !== "approved") return null;

  const connector = connectorFor(action.kind);
  if (!connector) {
    log(
      action.internId,
      "warn",
      `${id} approved but no ${action.kind} connector is configured — waiting for an external sender`,
    );
    return action;
  }

  log(action.internId, "tool", `${connector.id}.send(${id})${DRY_RUN ? " · DRY RUN" : ""}`);
  const result = await execute(action);
  return recordActionResult(id, result.ok ? "sent" : "failed", result.detail);
}

/** Approve and, if we hold the credentials, send it ourselves. */
export async function approveAndSend(
  id: string,
  via: Decision,
  edits?: Partial<Draft>,
): Promise<{ action: ProposedAction | null; dispatched: boolean }> {
  const approved = approveAction(id, via, edits);
  if (!approved) return { action: null, dispatched: false };

  const connector = connectorFor(approved.kind);
  if (!connector) return { action: approved, dispatched: false };

  const settled = await executeAction(id);
  return { action: settled ?? approved, dispatched: true };
}

export { connectorStatus };

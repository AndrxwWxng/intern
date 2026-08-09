/**
 * Local simulation layer.
 *
 * When Scout isn't running, the cockpit still needs a brain to render and
 * interns that visibly do work. This module owns both: a seeded company graph
 * and a scripted-but-randomised execution trace per intern.
 *
 * Everything here is clearly labelled `SIM` in the UI. It is a stand-in, not a
 * fake of a live result.
 */

import type { Artifact, Graph, GraphEdge, GraphNode, RoleId } from "./types";

// ---------------------------------------------------------------------------
// Seed brain
// ---------------------------------------------------------------------------

const SOURCES: [string, string][] = [
  ["web", "parallel · web search + extract"],
  ["workspace", "scout repo · read-only"],
  ["crm", "postgres · scout schema"],
  ["knowledge", "wiki/knowledge · prose memory"],
  ["voice", "wiki/voice · style guide"],
  ["slack", "read-only · messages, threads"],
  ["gdrive", "read-only · files, folders"],
];

const CONTACTS: [string, string, string[]][] = [
  ["Josh Kim", "Anthropic · research", ["research", "partners"]],
  ["Mara Velez", "Ramp · platform lead", ["customer", "design-partner"]],
  ["Dan Okafor", "Sequoia · seed", ["investor"]],
  ["Priya Raghunathan", "Vercel · DX", ["partners", "infra"]],
  ["Tomas Lind", "internal · founding eng", ["team"]],
  ["Ana Sousa", "internal · gtm", ["team", "gtm"]],
];

const PROJECTS: [string, string, string[]][] = [
  ["context-providers", "active", ["core", "infra"]],
  ["slack-interface", "shipped", ["core", "gtm"]],
  ["wiki-git-backend", "active", ["core"]],
  ["seed-raise", "active", ["investor", "gtm"]],
  ["design-partner-pilot", "active", ["customer", "gtm"]],
];

const NOTES: [string, string, string[]][] = [
  ["RLM paper — recurrent latent memory", "Josh shared; relevant to wiki compaction", ["research"]],
  ["Ramp pilot kickoff", "Mara wants Slack-first, no new UI to learn", ["customer", "gtm"]],
  ["Navigation beats retrieval", "why we dropped the vector-db-everything plan", ["core", "research"]],
  ["Seed round — target list", "12 funds, 3 warm intros via Dan", ["investor"]],
  ["Coffee: flat white, extra shot", "schema-on-demand demo table", ["misc"]],
];

const WIKI: [string, string[]][] = [
  ["runbooks/incident-response", ["infra"]],
  ["decisions/why-postgres-not-vectors", ["core", "research"]],
  ["onboarding/first-week", ["team"]],
  ["voice/slack-message", ["gtm"]],
  ["research/rlm-summary", ["research"]],
];

const FOLLOWUPS: [string, string][] = [
  ["Send Mara the pilot scope", "customer"],
  ["Reply to Dan re: data room", "investor"],
  ["Ship git-backed wiki to prod", "core"],
];

function tagId(t: string) {
  return `tag:${t}`;
}

export function seedGraph(): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const tags = new Set<string>();

  const push = (n: GraphNode) => nodes.push(n);
  const link = (source: string, target: string, rel: string) =>
    edges.push({ source, target, rel });

  push({ id: "brain", label: "brain", kind: "intern", weight: 12, detail: "company brain" });

  for (const [id, detail] of SOURCES) {
    push({ id: `src:${id}`, label: id, kind: "source", weight: 7, detail });
    link("brain", `src:${id}`, "provides");
  }

  const bind = (nodeId: string, list: string[]) => {
    for (const t of list) {
      tags.add(t);
      link(nodeId, tagId(t), "tagged");
    }
  };

  CONTACTS.forEach(([name, detail, t], i) => {
    const id = `contact:${i}`;
    // People the seed invented, so NOT `contact` — that kind means "has an
    // account on the platform" and is derived from the accounts table in
    // `convex/brain.ts::graph`. The cockpit unions this graph with that one,
    // so calling these contacts put six fictional colleagues in the same list
    // as the real ones with nothing to tell them apart. Ids and edges are
    // unchanged; only the claim about what they are is.
    push({ id, label: name, kind: "fact", weight: 5, detail, meta: { table: "scout_contacts" } });
    link("src:crm", id, "row");
    bind(id, t);
  });

  PROJECTS.forEach(([name, status, t], i) => {
    const id = `project:${i}`;
    push({ id, label: name, kind: "project", weight: 6, detail: status, meta: { table: "scout_projects" } });
    link("src:crm", id, "row");
    bind(id, t);
  });

  NOTES.forEach(([title, detail, t], i) => {
    const id = `note:${i}`;
    push({ id, label: title, kind: "note", weight: 3, detail, meta: { table: "scout_notes" } });
    link("src:crm", id, "row");
    bind(id, t);
  });

  FOLLOWUPS.forEach(([title, t], i) => {
    const id = `followup:${i}`;
    push({ id, label: title, kind: "followup", weight: 3, detail: "pending", meta: { table: "scout_followups" } });
    link("src:crm", id, "row");
    bind(id, [t]);
  });

  WIKI.forEach(([path, t], i) => {
    const id = `wiki:${i}`;
    push({ id, label: path, kind: "wiki", weight: 4, detail: "wiki/knowledge", meta: { path } });
    link(path.startsWith("voice/") ? "src:voice" : "src:knowledge", id, "page");
    bind(id, t);
  });

  for (const t of tags) {
    push({ id: tagId(t), label: `#${t}`, kind: "tag", weight: 2 });
  }

  // A few cross links so the graph reads like a brain, not a star.
  link("contact:0", "note:0", "cites");
  link("contact:0", "wiki:4", "cites");
  link("contact:1", "note:1", "cites");
  link("contact:1", "project:4", "owns");
  link("contact:2", "note:3", "cites");
  link("contact:2", "project:3", "owns");
  link("contact:4", "project:0", "owns");
  link("contact:5", "project:1", "owns");
  link("project:2", "wiki:1", "documents");
  link("project:0", "wiki:1", "documents");
  link("followup:0", "contact:1", "about");
  link("followup:1", "contact:2", "about");
  link("followup:2", "project:2", "about");
  link("note:2", "wiki:1", "documents");

  return { nodes, edges, mode: "sim", generatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Scripted intern execution
// ---------------------------------------------------------------------------

export type SimStep = {
  /** ms to wait before emitting. */
  delay: number;
  level: "sys" | "out" | "tool" | "ok" | "warn";
  text: string;
  tool?: string;
  artifact?: Artifact;
  /** Nodes/edges to graft onto the brain when this step lands. */
  graft?: { nodes: GraphNode[]; edges: GraphEdge[] };
};

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const jitter = (base: number) => Math.round(base * (0.6 + Math.random() * 0.9));

function keywords(task: string): string[] {
  const stop = new Set([
    "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with",
    "about", "find", "get", "make", "write", "draft", "our", "my", "all",
    "that", "this", "from", "into", "then", "what", "how", "is", "are",
  ]);
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 4);
}

function slug(task: string): string {
  return (
    keywords(task).join("-").slice(0, 40) ||
    `task-${Math.random().toString(36).slice(2, 6)}`
  );
}

/**
 * Build a plausible trace for a task. The shape is fixed (plan → gather →
 * synthesise → file → report); the sources, phrasing and timings vary.
 */
export function planSim(task: string, internId: string): SimStep[] {
  const kw = keywords(task);
  const topic = kw.slice(0, 2).join(" ") || "the request";
  const pageSlug = slug(task);
  const steps: SimStep[] = [];

  steps.push({ delay: 200, level: "sys", text: `brief received · ${task}` });
  steps.push({
    delay: jitter(600),
    level: "out",
    text: `decomposing into ${2 + Math.floor(Math.random() * 3)} passes; long-running, will file results into the brain`,
  });

  const gatherers: [string, string[]][] = [
    ["query_workspace", [`grep -r "${kw[0] ?? "scout"}" — 14 hits across 6 files`, `reading scout/contexts.py, app/router.py`]],
    ["query_crm", [`SELECT * FROM scout.scout_notes WHERE tags && ARRAY['${kw[0] ?? "core"}']`, `4 rows · 2 contacts, 1 project`]],
    ["query_knowledge", [`ls wiki/knowledge/ → 5 pages; opening decisions/`, `existing page covers ~40% of ${topic}`]],
    ["query_web", [`parallel.web_search "${task.slice(0, 48)}"`, `8 results, extracting top 3`]],
    ["query_slack", [`conversations.history #eng · last 200 msgs`, `2 threads mention ${topic}`]],
    ["query_gdrive", [`files.list q="name contains '${kw[0] ?? "spec"}'"`, `1 doc, 1 sheet`]],
  ];

  const chosen = gatherers
    .sort(() => Math.random() - 0.5)
    .slice(0, 3 + Math.floor(Math.random() * 2));

  for (const [tool, lines] of chosen) {
    steps.push({ delay: jitter(900), level: "tool", tool, text: `${tool}(…)` });
    for (const line of lines) {
      steps.push({ delay: jitter(700), level: "out", text: line });
    }
  }

  steps.push({
    delay: jitter(1200),
    level: "out",
    text: `cross-referencing ${chosen.length} sources · resolving ${pick(["conflicts", "duplicates", "stale claims"])}`,
  });

  const noteId = `note:${internId}`;
  const wikiId = `wiki:${internId}`;

  steps.push({
    delay: jitter(1100),
    level: "tool",
    tool: "update_knowledge",
    text: `update_knowledge("file a page at knowledge/${pageSlug}")`,
  });
  steps.push({
    delay: jitter(800),
    level: "ok",
    text: `wrote wiki/knowledge/${pageSlug}.md`,
    artifact: { kind: "wiki", label: `knowledge/${pageSlug}`, ref: pageSlug },
    graft: {
      nodes: [
        { id: wikiId, label: `${pageSlug}`, kind: "wiki", weight: 4, detail: "filed by intern" },
      ],
      edges: [
        { source: "src:knowledge", target: wikiId, rel: "page" },
        { source: internId, target: wikiId, rel: "wrote" },
      ],
    },
  });

  steps.push({
    delay: jitter(900),
    level: "tool",
    tool: "update_crm",
    text: `update_crm("INSERT INTO scout.scout_notes …")`,
  });
  steps.push({
    delay: jitter(700),
    level: "ok",
    text: `scout_notes +1 · linked to ${chosen.length} sources`,
    artifact: { kind: "note", label: task.slice(0, 60) },
    graft: {
      nodes: [
        { id: noteId, label: task.slice(0, 48), kind: "note", weight: 3, detail: "filed by intern" },
      ],
      edges: [
        { source: "src:crm", target: noteId, rel: "row" },
        { source: noteId, target: wikiId, rel: "documents" },
        { source: internId, target: noteId, rel: "wrote" },
      ],
    },
  });

  if (Math.random() > 0.45) {
    const fuId = `followup:${internId}`;
    steps.push({
      delay: jitter(700),
      level: "ok",
      text: `scout_followups +1 · due in ${1 + Math.floor(Math.random() * 6)}d`,
      artifact: { kind: "followup", label: `follow up on ${topic}` },
      graft: {
        nodes: [
          { id: fuId, label: `follow up · ${topic}`, kind: "followup", weight: 3, detail: "pending" },
        ],
        edges: [
          { source: "src:crm", target: fuId, rel: "row" },
          { source: fuId, target: noteId, rel: "about" },
        ],
      },
    });
  }

  steps.push({
    delay: jitter(900),
    level: "sys",
    text: `done · ${chosen.length} sources read, 2 writes, brain updated`,
  });

  return steps;
}

export function simSummary(task: string): string {
  return `Filed ${slug(task)} into the knowledge wiki and linked it to the CRM. Re-run to refresh from live sources.`;
}

// ---------------------------------------------------------------------------
// Questions
//
// The simulated intern has to be able to get stuck, or the approval gate is
// the only handover anyone ever sees and half the design goes undemonstrated.
// It gets stuck on the same thing a real one would: something specific to this
// company that the brief did not say and the brain does not hold.
// ---------------------------------------------------------------------------

/** Words that name a person or a slot the brain would have to fill in. */
const AMBIGUOUS: [RegExp, (m: string) => { question: string; context: string }][] = [
  [
    /\bonboard(?:ing)?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    (name) => ({
      question: `Who does ${name} report to, and which team are they joining?`,
      context: `Onboarding ${name}. The CRM has no contact for them and no reporting line, and the first-week page needs both before it can say which channels and which manager 1:1 to set up.`,
    }),
  ],
  [
    /\b(?:set up|provision|grant)\b.*\baccess\b/,
    () => ({
      question: "Which systems should this access cover — the standard set, or something narrower?",
      context:
        "The brief says to grant access but not to what. wiki/knowledge has no page on a standard access bundle, so there is nothing to copy.",
    }),
  ],
  [
    /\b(?:schedule|book|invite)\b/,
    () => ({
      question: "What time should this be, and how long?",
      context:
        "Nothing in the brief or the calendar context gives a time. A guessed slot would send real invitations to real people.",
    }),
  ],
];

/**
 * Decide whether a simulated brief has a hole in it worth stopping for.
 *
 * Only the onboarder stops in SIM. Every role asking would be noise, and
 * onboarding is the case the design keeps using because it is the one where a
 * confident guess does the most damage.
 */
export function simQuestion(
  task: string,
  role: RoleId,
): { question: string; context: string } | null {
  if (role !== "onboarder") return null;
  for (const [pattern, build] of AMBIGUOUS) {
    const match = task.match(pattern);
    if (match) return build(match[1] ?? "them");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Outbound proposals
// ---------------------------------------------------------------------------

const OUTBOUND_HINTS = [
  "email", "send", "reply", "respond", "follow up", "followup", "reach out",
  "intro", "introduce", "draft", "message", "ping", "chase", "thank",
  "schedule", "invite", "update them", "let them know",
];

// People first, then their org — so "email ramp about the pilot" still greets
// Mara rather than opening with "Hi Ramp".
// example.com is reserved by RFC 2606 and routes nowhere. These are seeded
// demo contacts, and with DRY_RUN off an approved draft really sends — a
// plausible-looking address at a real company would put test mail in a
// stranger's inbox. Set OUTBOX_TEST_RECIPIENT to route drafts to yourself.
const FALLBACK_DOMAIN = "example.com";
const RECIPIENTS: [string, string, string][] = [
  ["mara", "Mara", `mara@${FALLBACK_DOMAIN}`],
  ["dan", "Dan", `dan@${FALLBACK_DOMAIN}`],
  ["josh", "Josh", `josh@${FALLBACK_DOMAIN}`],
  ["priya", "Priya", `priya@${FALLBACK_DOMAIN}`],
  ["ramp", "Mara", `mara@${FALLBACK_DOMAIN}`],
  ["sequoia", "Dan", `dan@${FALLBACK_DOMAIN}`],
  ["investor", "Dan", `dan@${FALLBACK_DOMAIN}`],
  ["anthropic", "Josh", `josh@${FALLBACK_DOMAIN}`],
  ["vercel", "Priya", `priya@${FALLBACK_DOMAIN}`],
];

/**
 * Decide whether a simulated brief implies something outbound, and draft it.
 * Returns null for the (common) case of a pure research task.
 */
export function simOutboundDraft(task: string): {
  kind: "email";
  title: string;
  draft: { to: string[]; subject: string; body: string };
  rationale: string;
  sources: string[];
} | null {
  const lower = task.toLowerCase();
  if (!OUTBOUND_HINTS.some((h) => lower.includes(h))) return null;

  const match = RECIPIENTS.find(([k]) => lower.includes(k));
  const who = match?.[1];
  // One env var to point every simulated draft at your own inbox, which is
  // how you test a real send without mailing a seeded contact.
  const to =
    process.env.OUTBOX_TEST_RECIPIENT ?? match?.[2] ?? `team@${FALLBACK_DOMAIN}`;
  const topic = keywords(task).slice(0, 3).join(" ") || "the update";
  const subject = topic.replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    kind: "email",
    title: `email to ${to} — ${subject}`,
    draft: {
      to: [to],
      subject,
      body: [
        `Hi${who ? ` ${who}` : " there"},`,
        "",
        `Following up on ${topic}. I pulled together what we have across the wiki,`,
        "the CRM and the threads on this, and filed the detail internally.",
        "",
        "Short version: the pieces are in place and I wanted to close the loop",
        "with you before we go further. Happy to walk through it whenever suits.",
        "",
        "Best,",
      ].join("\n"),
    },
    rationale: `the brief ("${task.slice(0, 60)}") asks for something to go out`,
    sources: ["wiki/knowledge", "scout.scout_notes"],
  };
}

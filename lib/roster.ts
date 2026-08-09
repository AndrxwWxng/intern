/**
 * The roster.
 *
 * An intern is not a generic runner: it has a job description, and that is
 * what makes trust meaningful. "This intern is right 90% of the time" is
 * useless across every kind of work at once; "the correspondent's drafts go out
 * unedited 9 times in 10" is a thing you can act on. So the role is the unit
 * trust is tracked against, and it is chosen before the work starts.
 *
 * Roles are picked from the brief. A wrong pick is cheap — it changes the
 * charter appended to the brief, not what the intern is allowed to touch — and
 * `spawn as <role>` overrides it.
 */

import type { Role, RoleId } from "./types";

export const ROLES: Role[] = [
  {
    id: "researcher",
    name: "researcher",
    blurb: "maps a topic across every source and files what it finds",
    charter: `You are a researcher. Go wide before you go deep: find every place
this topic is mentioned, reconcile what the sources disagree about, and file a
single coherent page rather than a pile of quotes. Say what you could not find.`,
    match: [
      "research", "map", "find", "investigate", "summarise", "summarize",
      "compare", "audit", "review", "analyse", "analyze", "what", "why",
      "where", "across", "mentions", "landscape",
    ],
  },
  {
    id: "correspondent",
    name: "correspondent",
    blurb: "drafts what needs to go out, and never sends it",
    charter: `You are a correspondent. Read the house voice before writing a
word — query_voice first, every time. Match the register of what we have sent
before. Be short. Draft the message and stop; you have no send tool and a
person approves every word before it leaves.`,
    match: [
      "email", "send", "reply", "respond", "draft", "message", "write",
      "follow up", "followup", "reach out", "intro", "introduce", "ping",
      "chase", "thank", "announce", "invite", "schedule",
    ],
  },
  {
    id: "archivist",
    name: "archivist",
    blurb: "turns what's scattered into something the brain can cite",
    charter: `You are an archivist. Your job is not to discover anything new: it
is to take what already exists and make it citable. Link every page you write
to what it supersedes or extends. Prefer editing an existing page over adding a
near-duplicate one.`,
    match: [
      "file", "capture", "organise", "organize", "tidy", "index", "archive",
      "document", "wiki", "write up", "record", "log", "note", "clean up",
      "consolidate", "dedupe",
    ],
  },
  {
    id: "onboarder",
    name: "onboarder",
    blurb: "sets a person up, and asks before it guesses",
    charter: `You are an onboarder. Everything about a person's setup is
specific to this company: who they report to, which channels, which email
convention, which equipment. You will not find most of it in the brief. Read
the brain for it, and where the brain does not say, ASK. A guessed reporting
line is worse than a question.`,
    match: [
      "onboard", "onboarding", "new hire", "starts", "starting", "joining",
      "joins", "set up", "setup", "provision", "access", "accounts", "laptop",
      "first week", "offboard",
    ],
  },
];

const BY_ID = new Map(ROLES.map((r) => [r.id, r]));

export const DEFAULT_ROLE: RoleId = "researcher";

export const getRole = (id: RoleId | string | undefined): Role =>
  BY_ID.get(id as RoleId) ?? BY_ID.get(DEFAULT_ROLE)!;

export const isRoleId = (v: unknown): v is RoleId =>
  typeof v === "string" && BY_ID.has(v as RoleId);

/**
 * Score the brief against each role's vocabulary.
 *
 * Multi-word matches count double: "follow up" landing on the correspondent is
 * a much stronger signal than the bare word "up" ever could be.
 */
export function pickRole(task: string): RoleId {
  const lower = ` ${task.toLowerCase()} `;
  let best: RoleId = DEFAULT_ROLE;
  let bestScore = 0;

  for (const role of ROLES) {
    let score = 0;
    for (const word of role.match) {
      if (!lower.includes(word.includes(" ") ? word : ` ${word}`)) continue;
      score += word.includes(" ") ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = role.id;
    }
  }
  return best;
}

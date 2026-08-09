/**
 * The intern's side of a Slack conversation.
 *
 * An intern that needs a person stops and asks — `askQuestion` in
 * `lib/store.ts` has always parked it. What was missing was any way for the
 * person to find out, which meant "parked" in practice meant "stalled until
 * somebody happened to look at the cockpit". This is the other half: the
 * question goes to them, and what they type back unparks the work.
 *
 * All of it lives in Convex because token material does. The Next process
 * never sees a Slack token; it hands over a user id and a question, and gets
 * back only whether the DM went.
 *
 * Default runtime: `fetch` and `crypto.subtle`, no Node built-ins.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const POST = "https://slack.com/api/chat.postMessage";
const OPEN = "https://slack.com/api/conversations.open";
const LOOKUP = "https://slack.com/api/users.lookupByEmail";

type SlackResponse = { ok?: boolean; error?: string; ts?: string; channel?: unknown };

async function slackCall(
  url: string,
  botToken: string,
  body: Record<string, unknown>,
): Promise<SlackResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  // Slack answers 200 with {ok:false} rather than an HTTP error.
  return (await res.json().catch(() => ({}))) as SlackResponse;
}

type Delivery = { botToken: string; providerUserId: string };

/**
 * How to reach one person on Slack.
 *
 * Preferred: their own connection, made by OAuth — that is the model the rest
 * of the app is built on, and it is the only one that works across workspaces.
 *
 * Fallback: a single workspace bot token on the deployment, resolving them by
 * the email they signed in with. This exists because per-user OAuth needs
 * SLACK_CLIENT_ID/SECRET set on the deployment, and a team that hasn't done
 * that yet would otherwise get no notifications at all — which is the one
 * outcome that makes a parked intern useless.
 */
async function deliveryFor(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<{ delivery: Delivery | null; detail: string }> {
  const connected: Delivery | null = await ctx.runQuery(
    internal.connections.slackDelivery,
    { userId },
  );
  if (connected) return { delivery: connected, detail: "connected account" };

  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    return {
      delivery: null,
      detail: "no slack connection, and SLACK_BOT_TOKEN is not set on the deployment",
    };
  }

  const email: string | null = await ctx.runQuery(internal.slack.emailFor, { userId });
  if (!email) return { delivery: null, detail: "no email on that account" };

  const found = (await (
    await fetch(`${LOOKUP}?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    })
  ).json().catch(() => ({}))) as { ok?: boolean; error?: string; user?: { id?: string } };

  if (!found.ok || !found.user?.id) {
    return {
      delivery: null,
      detail: `users.lookupByEmail(${email}): ${found.error ?? "not found"}`,
    };
  }
  return {
    delivery: { botToken, providerUserId: found.user.id },
    detail: "workspace bot",
  };
}

/** The email an account signed in with — how the bot finds them in Slack. */
export const emailFor = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.db.get("users", args.userId);
    return user?.email ?? null;
  },
});

// ---------------------------------------------------------------------------
// Thread ↔ question routing
// ---------------------------------------------------------------------------

export const recordThread = internalMutation({
  args: {
    ts: v.string(),
    channel: v.string(),
    userId: v.id("users"),
    questionId: v.string(),
    internId: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("slackThreads", { ...args, askedAt: Date.now() });
    return null;
  },
});

/**
 * Which question a reply is answering.
 *
 * A threaded reply names its question exactly, which is what makes this work
 * when someone has three interns stuck at once. A bare message in the DM has
 * to be guessed at, and the only safe guess is when exactly one question is
 * outstanding — otherwise answering the wrong one puts a wrong fact in the
 * brain, which is worse than asking the person to reply in the thread.
 */
export const routeReply = internalQuery({
  args: { userId: v.id("users"), threadTs: v.union(v.string(), v.null()) },
  returns: v.union(
    v.object({ questionId: v.string(), ambiguous: v.boolean() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    if (args.threadTs) {
      const row = await ctx.db
        .query("slackThreads")
        .withIndex("by_ts", (q) => q.eq("ts", args.threadTs!))
        .unique();
      if (!row || row.answeredAt !== undefined) return null;
      return { questionId: row.questionId, ambiguous: false };
    }

    const open = await ctx.db
      .query("slackThreads")
      .withIndex("by_userId_and_answeredAt", (q) =>
        q.eq("userId", args.userId).eq("answeredAt", undefined),
      )
      .take(5);

    if (open.length === 0) return null;
    if (open.length > 1) return { questionId: open[0].questionId, ambiguous: true };
    return { questionId: open[0].questionId, ambiguous: false };
  },
});

export const closeThread = internalMutation({
  args: { questionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Indexed, not a table scan: a thread that fell outside a scan window
    // would stay open and let the same question be answered twice.
    const rows = await ctx.db
      .query("slackThreads")
      .withIndex("by_questionId", (q) => q.eq("questionId", args.questionId))
      .take(10);
    for (const row of rows) {
      if (row.answeredAt === undefined) {
        await ctx.db.patch("slackThreads", row._id, { answeredAt: Date.now() });
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/**
 * DM the person whose intern is stuck.
 *
 * Returns a reason rather than throwing when there is no Slack: an intern that
 * asked a question has already stopped, and failing to *notify* about it must
 * not also lose the question.
 */
export const askOwner = internalAction({
  args: {
    userId: v.id("users"),
    questionId: v.string(),
    internId: v.union(v.string(), v.null()),
    role: v.string(),
    question: v.string(),
    context: v.string(),
  },
  returns: v.object({ delivered: v.boolean(), detail: v.string() }),
  handler: async (ctx, args): Promise<{ delivered: boolean; detail: string }> => {
    const { delivery, detail: how } = await deliveryFor(ctx, args.userId);
    if (!delivery) return { delivered: false, detail: how };

    // conversations.open is idempotent and returns the existing DM if there is
    // one, so this is also how the very first message gets somewhere to go.
    const opened = await slackCall(OPEN, delivery.botToken, {
      users: delivery.providerUserId,
    });
    const channel =
      opened.channel && typeof opened.channel === "object" && "id" in opened.channel
        ? String((opened.channel as { id?: unknown }).id ?? "")
        : "";
    if (!opened.ok || !channel) {
      return { delivered: false, detail: `conversations.open: ${opened.error ?? "no channel"}` };
    }

    const who = args.internId ? `${args.internId} · ${args.role}` : args.role;
    const sent = await slackCall(POST, delivery.botToken, {
      channel,
      text: `${who} is stuck: ${args.question}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${who}* stopped and needs you.\n\n>${args.question.replace(/\n/g, "\n>")}`,
          },
        },
        ...(args.context
          ? [
              {
                type: "context",
                elements: [{ type: "mrkdwn", text: args.context.slice(0, 300) }],
              },
            ]
          : []),
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "Reply in this thread and the intern picks the work back up.",
            },
          ],
        },
      ],
    });

    if (!sent.ok || !sent.ts) {
      return { delivered: false, detail: `chat.postMessage: ${sent.error ?? "no ts"}` };
    }

    await ctx.runMutation(internal.slack.recordThread, {
      ts: sent.ts,
      channel,
      userId: args.userId,
      questionId: args.questionId,
      internId: args.internId,
    });

    return { delivered: true, detail: `${how} · dm ${channel}@${sent.ts}` };
  },
});

/**
 * Say something back — "got it", or why the answer didn't land.
 *
 * `threadTs` null posts into the DM rather than a thread, which is the only
 * option when the thing being reported is that we couldn't tell which thread
 * the person meant.
 */
export const replyInThread = internalAction({
  args: {
    userId: v.id("users"),
    threadTs: v.union(v.string(), v.null()),
    text: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { delivery } = await deliveryFor(ctx, args.userId);
    if (!delivery) return null;

    const opened = await slackCall(OPEN, delivery.botToken, {
      users: delivery.providerUserId,
    });
    const channel =
      opened.channel && typeof opened.channel === "object" && "id" in opened.channel
        ? String((opened.channel as { id?: unknown }).id ?? "")
        : "";
    if (!channel) return null;

    await slackCall(POST, delivery.botToken, {
      channel,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
      text: args.text,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/**
 * Hand a Slack reply to the Next process, which is where questions live.
 *
 * The two halves authenticate to each other with a shared secret rather than a
 * user token: this call is made on somebody's behalf, not by them, and there
 * is no session to borrow at the moment a DM arrives.
 */
export const deliverAnswer = internalAction({
  args: {
    userId: v.id("users"),
    questionId: v.string(),
    answer: v.string(),
  },
  returns: v.object({ ok: v.boolean(), detail: v.string() }),
  handler: async (_ctx, args): Promise<{ ok: boolean; detail: string }> => {
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const secret = process.env.INTERN_SERVICE_SECRET;
    if (!secret) return { ok: false, detail: "INTERN_SERVICE_SECRET not set" };

    try {
      const res = await fetch(`${appUrl}/api/slack/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId: args.userId,
          questionId: args.questionId,
          answer: args.answer,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        resumed?: string | null;
        error?: string;
      };
      if (!res.ok) return { ok: false, detail: data.error ?? `HTTP ${res.status}` };
      return {
        ok: true,
        detail: data.resumed ? `resumed as ${data.resumed}` : "answered",
      };
    } catch (err) {
      // The cockpit process being down is the common case in development, and
      // it must not turn into a Slack retry storm — the event is acknowledged
      // either way, and the question is still parked in the cockpit.
      return { ok: false, detail: err instanceof Error ? err.message : "unreachable" };
    }
  },
});

/** The whole inbound path, from a verified event to a resumed intern. */
export const handleReply = internalAction({
  args: {
    slackUserId: v.string(),
    threadTs: v.union(v.string(), v.null()),
    text: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const answer = args.text.trim();
    if (!answer) return null;

    const account: { userId: Id<"users">; botToken: string | null } | null =
      await ctx.runQuery(internal.connections.bySlackUser, {
        providerUserId: args.slackUserId,
      });
    // A DM from a Slack account nobody has connected is not ours to act on.
    if (!account) return null;

    const route: { questionId: string; ambiguous: boolean } | null =
      await ctx.runQuery(internal.slack.routeReply, {
        userId: account.userId,
        threadTs: args.threadTs,
      });

    if (!route) return null;

    // Guessing here would put a wrong answer in the brain and dispatch an
    // intern to act on it, which is worse than asking them to be specific.
    if (route.ambiguous) {
      await ctx.runAction(internal.slack.replyInThread, {
        userId: account.userId,
        threadTs: null,
        text: "More than one intern is waiting — reply in the thread of the one you mean and I'll pass it on.",
      });
      return null;
    }

    const result: { ok: boolean; detail: string } = await ctx.runAction(
      internal.slack.deliverAnswer,
      { userId: account.userId, questionId: route.questionId, answer },
    );

    if (result.ok) {
      await ctx.runMutation(internal.slack.closeThread, {
        questionId: route.questionId,
      });
    }

    if (args.threadTs) {
      await ctx.runAction(internal.slack.replyInThread, {
        userId: account.userId,
        threadTs: args.threadTs,
        text: result.ok
          ? `Got it — ${result.detail}.`
          : `Couldn't pass that on: ${result.detail}. It's still waiting in the cockpit.`,
      });
    }
    return null;
  },
});

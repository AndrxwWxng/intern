/**
 * Telling somebody their intern is stuck.
 *
 * The delivery itself lives in Convex, because that is where token material
 * lives and it stays there — this side hands over a user id and a question and
 * learns only whether it went. The two halves authenticate with a shared
 * secret rather than a user token: by the time an intern gets stuck, the
 * request that dispatched it is long over and there is no session to borrow.
 *
 * Every failure here is soft. An intern that asked a question has already
 * stopped safely; failing to *notify* about it must never also lose it.
 */

const SITE_URL = () =>
  process.env.CONVEX_SITE_URL ??
  process.env.NEXT_PUBLIC_CONVEX_URL?.replace(".convex.cloud", ".convex.site");

export const notifyConfigured = () =>
  Boolean(process.env.INTERN_SERVICE_SECRET && SITE_URL());

/** Why questions aren't reaching anyone, in one line an operator can act on. */
export const notifyNote = () =>
  !process.env.INTERN_SERVICE_SECRET
    ? "INTERN_SERVICE_SECRET unset — parked interns won't DM anyone"
    : !SITE_URL()
      ? "CONVEX_SITE_URL unset — parked interns won't DM anyone"
      : "questions go out over slack";

export type NotifyResult = { delivered: boolean; detail: string };

export async function notifyQuestion(input: {
  userId: string;
  questionId: string;
  internId: string | null;
  question: string;
  context: string;
}): Promise<NotifyResult> {
  const site = SITE_URL();
  const secret = process.env.INTERN_SERVICE_SECRET;
  if (!site || !secret) {
    return { delivered: false, detail: "notify not configured" };
  }

  try {
    const res = await fetch(`${site}/notify/question`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as Partial<NotifyResult> & {
      error?: string;
    };
    if (!res.ok) {
      return { delivered: false, detail: data.error ?? `HTTP ${res.status}` };
    }
    return {
      delivered: data.delivered === true,
      detail: data.detail ?? "sent",
    };
  } catch (err) {
    return {
      delivered: false,
      detail: err instanceof Error ? err.message : "unreachable",
    };
  }
}

/**
 * Tell someone their intern finished.
 *
 * Soft like `notifyQuestion`, and for a stronger reason: the work is already
 * done and filed by the time this runs. Failing to announce it must never look
 * like the run itself failed, so the caller only logs what came back.
 */
export async function notifyDone(input: {
  userId: string;
  internId: string;
  task: string;
  status: string;
  summary?: string;
  artifacts?: string[];
  took?: string;
}): Promise<NotifyResult> {
  const site = SITE_URL();
  const secret = process.env.INTERN_SERVICE_SECRET;
  if (!site || !secret) {
    return { delivered: false, detail: "notify not configured" };
  }

  try {
    const res = await fetch(`${site}/notify/done`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as Partial<NotifyResult> & {
      error?: string;
    };
    if (!res.ok) {
      return { delivered: false, detail: data.error ?? `HTTP ${res.status}` };
    }
    return { delivered: data.delivered === true, detail: data.detail ?? "sent" };
  } catch (err) {
    return {
      delivered: false,
      detail: err instanceof Error ? err.message : "unreachable",
    };
  }
}

/**
 * Connector registry.
 *
 * Resolution per action kind: the native connector if it's configured,
 * otherwise the generic webhook, otherwise nothing — in which case the outbox
 * hands the draft back to whoever asked and waits to be told what happened.
 */

import { calendar } from "./calendar";
import { gmail } from "./gmail";
import { slack } from "./slack";
import { DRY_RUN, type Connector, type SendResult } from "./types";
import { webhookFor } from "./webhook";
import type { ActionKind, ConnectorStatus, ConnectorsState, ProposedAction } from "../types";

const NATIVE: Record<ActionKind, Connector> = {
  email: gmail,
  slack,
  calendar,
};

export function connectorFor(kind: ActionKind): Connector | null {
  const native = NATIVE[kind];
  if (native?.configured()) return native;
  const fallback = webhookFor(kind);
  return fallback.configured() ? fallback : null;
}

/** One row of `connections.mine`, narrowed to what the panel needs. */
export type UserConnection = {
  provider: "google" | "slack";
  accountLabel?: string;
  broken: boolean;
  brokenReason?: string;
};

/** Which OAuth grant each surface actually goes out on. */
const PROVIDER_FOR: Record<ActionKind, "google" | "slack"> = {
  email: "google",
  calendar: "google",
  slack: "slack",
};

/**
 * What this deployment can do, and what *you* can do — deliberately two
 * different answers on the same row.
 *
 * `connections` is the viewer's own grants. Passing none says "nobody is
 * asking", not "nothing is connected", so callers that have no viewer get
 * `connected: false` everywhere rather than a cheerful default.
 */
export function connectorStatus(connections: UserConnection[] = []): ConnectorsState {
  const kinds: ActionKind[] = ["email", "slack", "calendar"];
  return {
    dryRun: DRY_RUN,
    connectors: kinds.map<ConnectorStatus>((kind) => {
      const active = connectorFor(kind);
      const native = NATIVE[kind];
      const link = connections.find((c) => c.provider === PROVIDER_FOR[kind]);
      return {
        kind,
        id: active?.id ?? null,
        label: active?.label ?? `${native.id} · not configured`,
        configured: Boolean(active),
        connected: Boolean(link && !link.broken),
        account: link?.accountLabel,
        broken: link?.broken || undefined,
        brokenReason: link?.brokenReason,
        requires: native.requires,
        missing: native.requires.filter((v) => !process.env[v]),
      };
    }),
  };
}

/** Perform an approved action. Never called before a human has approved it. */
export async function execute(action: ProposedAction): Promise<SendResult> {
  const connector = connectorFor(action.kind);
  if (!connector) {
    return {
      ok: false,
      detail: `no connector configured for ${action.kind}`,
    };
  }
  try {
    return await connector.send(action);
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export { DRY_RUN };

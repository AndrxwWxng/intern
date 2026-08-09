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

export function connectorStatus(): ConnectorsState {
  const kinds: ActionKind[] = ["email", "slack", "calendar"];
  return {
    dryRun: DRY_RUN,
    connectors: kinds.map<ConnectorStatus>((kind) => {
      const active = connectorFor(kind);
      const native = NATIVE[kind];
      return {
        kind,
        id: active?.id ?? null,
        label: active?.label ?? `${native.id} · not configured`,
        configured: Boolean(active),
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

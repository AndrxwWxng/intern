"use client";

import { useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import BrainGraph from "./BrainGraph";
import BrainRail from "./BrainRail";
import CommandBar, { HELP } from "./CommandBar";
import InternRail from "./InternRail";
import Outbox from "./Outbox";
import Terminal from "./Terminal";
import type {
  CockpitEvent,
  Graph,
  GraphNode,
  Intern,
  LogLevel,
  LogLine,
  NodeKind,
  ProposedAction,
  SystemState,
} from "@/lib/types";

const EMPTY_GRAPH: Graph = {
  nodes: [],
  edges: [],
  mode: "sim",
  generatedAt: 0,
};

const EMPTY_SYSTEM: SystemState = {
  mode: "sim",
  scoutUrl: "",
  reachable: false,
  checkedAt: 0,
  contexts: [],
  note: "connecting…",
};

export default function Cockpit() {
  const [interns, setInterns] = useState<Intern[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  // Scout/SIM feed these over SSE; Convex is merged on top below.
  const [streamGraph, setStreamGraph] = useState<Graph>(EMPTY_GRAPH);
  const [system, setSystem] = useState<SystemState>(EMPTY_SYSTEM);
  const [streamOutbox, setStreamOutbox] = useState<ProposedAction[]>([]);
  const [connected, setConnected] = useState(false);

  // Live from Convex. Undefined until the first result lands.
  const convexGraph = useQuery(api.brain.graph, {});
  const convexOutbox = useQuery(api.outbox.list, {});

  const [filter, setFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<NodeKind>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [termHeight, setTermHeight] = useState(280);

  const localSeq = useRef(0);
  const echo = useCallback((level: LogLevel, text: string) => {
    setLog((prev) => [
      ...prev,
      {
        id: -++localSeq.current,
        internId: null,
        ts: Date.now(),
        level,
        text,
      },
    ]);
  }, []);

  // --- event stream -------------------------------------------------------
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      let e: CockpitEvent | { type: "ping" };
      try {
        e = JSON.parse(msg.data);
      } catch {
        return;
      }
      switch (e.type) {
        case "snapshot":
          setInterns(e.interns);
          setLog(e.log);
          setSystem(e.system);
          setStreamOutbox(e.outbox);
          setConnected(true);
          break;
        case "action":
          setStreamOutbox((prev) => {
            const rest = prev.filter((a) => a.id !== e.action.id);
            return [e.action, ...rest].sort((a, b) => b.createdAt - a.createdAt);
          });
          break;
        case "log":
          setLog((prev) => {
            const next = [...prev, e.line];
            return next.length > 1500 ? next.slice(-1200) : next;
          });
          break;
        case "intern":
          setInterns((prev) => {
            const rest = prev.filter((i) => i.id !== e.intern.id);
            return [e.intern, ...rest].sort((a, b) => b.createdAt - a.createdAt);
          });
          break;
        case "graph":
          setStreamGraph(e.graph);
          break;
        case "system":
          setSystem(e.system);
          break;
      }
    };
    return () => es.close();
  }, []);

  // --- Convex merged over the stream --------------------------------------
  // Scout (or SIM) supplies the bulk of the graph; Convex supplies whatever
  // has been filed durably. Convex wins on collision, because it is the thing
  // that survives a restart and the thing every other browser is also seeing.
  const graph = useMemo<Graph>(() => {
    if (!convexGraph?.nodes.length) return streamGraph;

    const nodes = new Map(streamGraph.nodes.map((n) => [n.id, n]));
    for (const n of convexGraph.nodes) {
      nodes.set(n.id, {
        id: n.id,
        label: n.label,
        kind: n.kind,
        weight: n.weight ?? undefined,
        detail: n.detail ?? undefined,
        meta: n.meta ?? undefined,
      });
    }

    const seen = new Set(streamGraph.edges.map((e) => `${e.source}|${e.target}|${e.rel ?? ""}`));
    const edges = [...streamGraph.edges];
    for (const e of convexGraph.edges) {
      const key = `${e.source}|${e.target}|${e.rel ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: e.source, target: e.target, rel: e.rel ?? undefined });
    }

    return { ...streamGraph, nodes: [...nodes.values()], edges, generatedAt: Date.now() };
  }, [streamGraph, convexGraph]);

  const outbox = useMemo<ProposedAction[]>(() => {
    if (!convexOutbox?.length) return streamOutbox;

    const byId = new Map(streamOutbox.map((a) => [a.id, a]));
    for (const row of convexOutbox) {
      byId.set(row.handle, {
        id: row.handle,
        internId: row.internHandle,
        kind: row.kind,
        status: row.status,
        title: row.title,
        draft: row.draft,
        rationale: row.rationale,
        sources: row.sources,
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        settledAt: row.settledAt,
        decidedVia: row.decidedVia,
        result: row.result,
      });
    }
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [streamOutbox, convexOutbox]);

  // Derived, not stored — the brain mutates under the inspector constantly.
  const selected = useMemo(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );
  const select = useCallback(
    (node: GraphNode | null) => setSelectedId(node?.id ?? null),
    [],
  );

  // --- actions ------------------------------------------------------------
  const spawn = useCallback(
    async (task: string) => {
      const res = await fetch("/api/interns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      if (!res.ok) echo("err", `spawn failed: ${res.status}`);
    },
    [echo],
  );

  const kill = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/interns/${id}`, { method: "DELETE" });
      if (!res.ok) echo("err", `no such intern: ${id}`);
    },
    [echo],
  );

  const decide = useCallback(
    async (id: string, decision: "approve" | "reject") => {
      const res = await fetch(`/api/outbox/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) echo("err", `could not ${decision} ${id}`);
    },
    [echo],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    echo("sys", "re-reading brain…");
    try {
      const res = await fetch("/api/brain?refresh=1");
      const data = (await res.json()) as { graph: Graph };
      setStreamGraph(data.graph);
      echo(
        "ok",
        `brain: ${data.graph.nodes.length} nodes, ${data.graph.edges.length} edges (${data.graph.mode})`,
      );
    } catch {
      echo("err", "brain refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, [echo]);

  const run = useCallback(
    (raw: string) => {
      const [verb, ...rest] = raw.split(/\s+/);
      const arg = rest.join(" ").trim();
      echo("in", raw);

      switch (verb.toLowerCase()) {
        case "help":
          for (const l of HELP) echo("out", l);
          return;
        case "clear":
          setLog([]);
          return;
        case "focus":
          if (!arg || arg === "all") {
            setFilter(null);
            echo("sys", "stream: all");
          } else {
            setFilter(arg);
            echo("sys", `stream: ${arg}`);
          }
          return;
        case "kill":
          if (!arg) return echo("err", "usage: kill <id>");
          void kill(arg);
          return;
        case "graph":
          if (arg === "refresh" || arg === "") return void refresh();
          echo("err", "usage: graph refresh");
          return;
        case "ask": {
          if (!arg) return echo("err", "usage: ask <question>");
          void fetch("/api/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: arg }),
          });
          return;
        }
        case "outbox": {
          const pending = outbox.filter((a) => a.status === "pending");
          if (!pending.length) return echo("out", "outbox empty");
          for (const a of pending) {
            echo("out", `${a.id}  ${a.kind} → ${a.draft.to.join(", ")}  ${a.draft.subject}`);
          }
          return;
        }
        case "approve":
          if (!arg) return echo("err", "usage: approve <action-id>");
          void decide(arg, "approve");
          return;
        case "reject":
          if (!arg) return echo("err", "usage: reject <action-id>");
          void decide(arg, "reject");
          return;
        case "spawn":
          if (!arg) return echo("err", "usage: spawn <task>");
          void spawn(arg);
          return;
        default:
          void spawn(raw);
      }
    },
    [decide, echo, kill, outbox, refresh, spawn],
  );

  const toggleKind = (k: NodeKind) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const activeIds = useMemo(
    () =>
      interns
        .filter((i) => i.status === "running" || i.status === "queued")
        .map((i) => i.id),
    [interns],
  );

  // --- terminal resize ----------------------------------------------------
  const dragging = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const h = window.innerHeight - e.clientY - 40;
      setTermHeight(Math.max(90, Math.min(window.innerHeight - 220, h)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header system={system} connected={connected} interns={interns} />

      <div className="flex min-h-0 flex-1">
        <BrainRail
          system={system}
          graph={graph}
          hidden={hidden}
          onToggleKind={toggleKind}
          selected={selected}
          onSelect={select}
          onRefresh={refresh}
          refreshing={refreshing}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <BrainGraph
              graph={graph}
              selectedId={selectedId}
              onSelect={select}
              query={query}
              hidden={hidden}
              activeIds={activeIds}
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
              <div className="pointer-events-auto flex items-center gap-2 border border-line bg-panel/90 px-2 py-1 backdrop-blur">
                <span className="text-faint">⌕</span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="filter nodes"
                  spellCheck={false}
                  className="w-44 bg-transparent placeholder:text-faint/70"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="text-faint hover:text-fg"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              <div className="border border-line bg-panel/90 px-2 py-1 text-faint backdrop-blur">
                {graph.nodes.length} nodes · {graph.edges.length} edges
              </div>
            </div>
          </div>

          <div
            onMouseDown={() => {
              dragging.current = true;
              document.body.style.userSelect = "none";
            }}
            className="h-[5px] shrink-0 cursor-row-resize border-t border-line bg-panel transition-colors hover:bg-line-2"
          />

          <div style={{ height: termHeight }} className="flex min-h-0 shrink-0">
            <div className="flex min-h-0 flex-1 flex-col">
              <Terminal
                log={log}
                interns={interns}
                filter={filter}
                onFilter={setFilter}
              />
            </div>
          </div>

          <CommandBar
            onSubmit={run}
            mode={system.reachable ? "live" : "sim"}
            busy={activeIds.length}
          />
        </main>

        <aside className="flex min-h-0 w-[268px] shrink-0 flex-col border-l border-line">
          <Outbox actions={outbox} onDecide={decide} />
          <InternRail
            interns={interns}
            filter={filter}
            onFilter={setFilter}
            onKill={kill}
          />
        </aside>
      </div>
    </div>
  );
}

function Header({
  system,
  connected,
  interns,
}: {
  system: SystemState;
  connected: boolean;
  interns: Intern[];
}) {
  const [clock, setClock] = useState("");
  useEffect(() => {
    const t = setInterval(
      () =>
        setClock(new Date().toLocaleTimeString("en-GB", { hour12: false })),
      1000,
    );
    return () => clearInterval(t);
  }, []);

  const done = interns.filter((i) => i.status === "done").length;

  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
      <span className="tracking-[0.28em] text-fg">INTERN</span>
      <span className="text-line-2">|</span>
      <span className="text-faint">company brain</span>

      <div className="ml-auto flex items-center gap-4 text-faint">
        <span>{done} filed</span>
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected ? "bg-ok" : "bg-err"
            }`}
          />
          {connected ? "stream" : "reconnecting"}
        </span>
        <span
          className={`border px-1.5 ${
            system.reachable
              ? "border-ok/40 text-ok"
              : "border-warn/40 text-warn"
          }`}
          title={
            system.reachable
              ? `brain online at ${system.scoutUrl}`
              : `brain unreachable at ${system.scoutUrl} — running simulated`
          }
        >
          {system.reachable ? "LIVE" : "SIM"}
        </span>
        <span className="tabular-nums">{clock}</span>
      </div>
    </header>
  );
}

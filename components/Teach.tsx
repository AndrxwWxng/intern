"use client";

import { useEffect, useRef, useState } from "react";
import { KIND_COLOR } from "./BrainGraph";
import type { FactKind, GraphNode } from "@/lib/types";

/**
 * Put something into the brain by hand.
 *
 * The rest of the cockpit fills the graph by asking: an intern parks on a
 * question and waits for someone to answer it. That only ever covers what an
 * intern happened to get stuck on, so everything a person already knows and was
 * never asked about stays outside the brain. This is the other direction —
 * unprompted, and the same landing path as `POST /api/capture`, so a fact typed
 * here is indistinguishable from one an answer produced.
 *
 * Collapsed to a single line at rest. The panel below it is where interns are
 * stopped, and that has to stay the loudest thing in the column.
 */

const KINDS: FactKind[] = [
  "note",
  "decision",
  "preference",
  "correction",
  "answer",
  "person",
  "project",
];

/** What a kind is for, one line, shown under the picker. */
const ABOUT: Record<FactKind, string> = {
  note: "something true worth citing later",
  decision: "what was settled, and by whom",
  preference: "how the work should be done — binds to a role",
  correction: "what an intern got wrong",
  answer: "the answer to something nobody asked yet",
  person: "who someone is and what they own",
  project: "what a piece of work is",
};

/** Kinds that bind to a role rather than to a thing in the graph. */
const ROLES = ["researcher", "correspondent", "archivist", "onboarder"];

export type TeachInput = {
  text: string;
  kind: FactKind;
  tags: string[];
  subject?: string;
  links: string[];
};

export default function Teach({
  selected,
  onTeach,
}: {
  selected: GraphNode | null;
  onTeach: (input: TeachInput) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<FactKind>("note");
  const [tags, setTags] = useState("");
  const [subject, setSubject] = useState("");
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // The node it would attach to is whatever is selected *now*, and the
  // selection changes under this panel as the graph is explored. Pinning it at
  // submit rather than on open is what makes "attach to" honest.
  const target = attach ? selected : null;
  const binds = kind === "preference" || kind === "correction";

  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);

  // A confirmation nobody dismissed is noise ten seconds later.
  useEffect(() => {
    if (!filed) return;
    const t = setTimeout(() => setFiled(null), 6000);
    return () => clearTimeout(t);
  }, [filed]);

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    const ok = await onTeach({
      text: body,
      kind,
      tags: tags
        .split(/[,\s]+/)
        .map((t) => t.replace(/^#/, "").trim())
        .filter(Boolean)
        .slice(0, 8),
      subject: binds ? subject.trim() || undefined : undefined,
      links: target ? [target.id] : [],
    });
    setBusy(false);
    if (!ok) return;
    setText("");
    setTags("");
    setFiled(
      target ? `filed · linked to ${target.label}` : "filed into the brain",
    );
    box.current?.focus();
  };

  if (!open) {
    return (
      <section className="shrink-0 border-b border-line bg-panel">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-8 w-full items-center gap-2 px-3 text-left text-faint transition-colors hover:text-fg"
        >
          <span className="text-k-fact">+</span>
          <span className="label">tell it something</span>
          <span className="ml-auto text-faint">no intern needed</span>
        </button>
      </section>
    );
  }

  return (
    <section className="shrink-0 border-b border-line bg-panel">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="label">tell it something</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-faint hover:text-fg"
          title="collapse"
        >
          ✕
        </button>
      </header>

      <div className="px-3 py-2">
        <textarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape") setOpen(false);
          }}
          rows={3}
          spellCheck={false}
          placeholder="the ramp pilot ships behind a flag — first line becomes the title"
          className="w-full resize-y border border-line bg-bg px-1.5 py-1 text-fg placeholder:text-faint/70 focus:border-k-fact/50"
        />

        <div className="mt-1.5 flex flex-wrap gap-px">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`border px-1.5 py-0.5 transition-colors ${
                kind === k
                  ? "border-k-fact/50 text-k-fact"
                  : "border-line text-faint hover:border-line-2 hover:text-dim"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <p className="mt-1 text-faint">{ABOUT[kind]}</p>

        {binds ? (
          <select
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="mt-1.5 w-full border border-line bg-bg px-1.5 py-0.5 text-dim"
          >
            <option value="">every role</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : null}

        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          spellCheck={false}
          placeholder="tags, space separated — they join it to what's already there"
          className="mt-1.5 w-full border border-line bg-bg px-1.5 py-0.5 text-fg placeholder:text-faint/70 focus:border-line-2"
        />

        {selected ? (
          <button
            type="button"
            onClick={() => setAttach((a) => !a)}
            className={`mt-1.5 flex w-full items-center gap-2 border px-1.5 py-0.5 text-left transition-colors ${
              attach ? "border-line-2" : "border-line opacity-50"
            }`}
            title="hang the new fact off the selected node"
          >
            <span className={attach ? "text-k-fact" : "text-faint"}>
              {attach ? "▣" : "▢"}
            </span>
            <span className="text-faint">about</span>
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: KIND_COLOR[selected.kind] }}
            />
            <span className="truncate text-dim">{selected.label}</span>
          </button>
        ) : (
          <p className="mt-1.5 text-faint">
            select a node first to hang it off something
          </p>
        )}

        <button
          type="button"
          disabled={!text.trim() || busy}
          onClick={() => void submit()}
          className="mt-1.5 w-full border border-k-fact/40 py-0.5 text-k-fact transition-colors hover:bg-k-fact/10 disabled:opacity-40"
        >
          {busy ? "filing…" : "file it  ⌘⏎"}
        </button>

        {filed ? <p className="mt-1 text-ok">{filed}</p> : null}
      </div>
    </section>
  );
}

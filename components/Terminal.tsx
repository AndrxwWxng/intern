"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Intern, LogLine, LogLevel } from "@/lib/types";

const LEVEL: Record<LogLevel, { glyph: string; className: string }> = {
  sys: { glyph: "·", className: "text-faint" },
  in: { glyph: ">", className: "text-fg" },
  out: { glyph: " ", className: "text-dim" },
  tool: { glyph: "→", className: "text-k-project" },
  ok: { glyph: "✓", className: "text-ok" },
  warn: { glyph: "!", className: "text-warn" },
  err: { glyph: "✗", className: "text-err" },
};

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString("en-GB", { hour12: false });

export default function Terminal({
  log,
  interns,
  filter,
  onFilter,
}: {
  log: LogLine[];
  interns: Intern[];
  filter: string | null;
  onFilter: (id: string | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  const lines = filter ? log.filter((l) => l.internId === filter) : log;

  useLayoutEffect(() => {
    if (!follow) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, follow]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      setFollow(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const active = interns.filter(
    (i) => i.status === "running" || i.status === "queued",
  );

  return (
    <section className="flex min-h-0 flex-col bg-panel">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="label mr-2">stream</span>
        <Tab active={filter === null} onClick={() => onFilter(null)}>
          all
        </Tab>
        {interns.slice(0, 8).map((i) => (
          <Tab
            key={i.id}
            active={filter === i.id}
            onClick={() => onFilter(i.id)}
            dot={
              i.status === "running"
                ? "bg-ok pulse-slow"
                : i.status === "failed"
                  ? "bg-err"
                  : i.status === "cancelled"
                    ? "bg-faint"
                    : i.status === "queued"
                      ? "bg-warn"
                      : "bg-line-2"
            }
          >
            {i.handle}
          </Tab>
        ))}
        <div className="ml-auto flex items-center gap-3 text-faint">
          <span>
            {active.length} active · {lines.length} lines
          </span>
          <button
            type="button"
            onClick={() => {
              setFollow(true);
              const el = scroller.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className={`transition-colors hover:text-fg ${
              follow ? "text-ok" : "text-faint"
            }`}
            title="follow tail"
          >
            {follow ? "◉ follow" : "○ paused"}
          </button>
        </div>
      </header>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5"
      >
        {lines.length === 0 ? (
          <p className="px-1 py-2 text-faint">
            no output yet. dispatch an intern below.
          </p>
        ) : null}
        {lines.map((line) => {
          const meta = LEVEL[line.level];
          return (
            <div
              key={line.id}
              className="enter flex items-start gap-2 whitespace-pre-wrap break-words px-1 leading-[1.55]"
            >
              <span className="shrink-0 whitespace-nowrap text-faint tabular-nums">
                {clock(line.ts)}
              </span>
              <button
                type="button"
                onClick={() => onFilter(line.internId)}
                className="w-[64px] shrink-0 truncate whitespace-nowrap text-left text-faint transition-colors hover:text-dim"
              >
                {line.internId ?? "cockpit"}
              </button>
              <span className={`shrink-0 ${meta.className}`}>{meta.glyph}</span>
              <span className={`min-w-0 flex-1 ${meta.className}`}>
                {line.text}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Tab({
  children,
  active,
  onClick,
  dot,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  dot?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2 py-0.5 transition-colors ${
        active
          ? "bg-raised text-fg"
          : "text-faint hover:bg-raised/60 hover:text-dim"
      }`}
    >
      {dot ? <span className={`h-1 w-1 rounded-full ${dot}`} /> : null}
      {children}
    </button>
  );
}

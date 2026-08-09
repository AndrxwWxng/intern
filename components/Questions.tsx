"use client";

import { useState } from "react";
import type { Question } from "@/lib/types";

/**
 * What the interns are stuck on.
 *
 * This sits above the outbox because an unanswered question is a stopped
 * intern, where an unapproved draft is only a delayed one. When there is
 * nothing open the whole panel disappears rather than sitting there empty —
 * at rest the cockpit should be quiet.
 */
export default function Questions({
  questions,
  onAnswer,
  onDismiss,
}: {
  questions: Question[];
  onAnswer: (id: string, answer: string) => void;
  onDismiss: (id: string) => void;
}) {
  const open = questions.filter((q) => q.status === "open");
  if (!open.length) return null;

  return (
    <section className="flex max-h-[46%] min-h-0 shrink-0 flex-col border-b border-line bg-panel">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="label">asks</h2>
        <span className="tabular-nums text-k-question">
          {open.length} intern{open.length === 1 ? "" : "s"} parked
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {open.map((q) => (
          <Ask key={q.id} question={q} onAnswer={onAnswer} onDismiss={onDismiss} />
        ))}
      </div>
    </section>
  );
}

function Ask({
  question,
  onAnswer,
  onDismiss,
}: {
  question: Question;
  onAnswer: (id: string, answer: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [answer, setAnswer] = useState("");

  const submit = () => {
    if (answer.trim()) onAnswer(question.id, answer.trim());
  };

  return (
    <article className="enter border-b border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-k-question pulse-slow" />
        <span className="text-fg">{question.internId ?? question.id}</span>
        <span className="text-faint">{question.role}</span>
        <span className="ml-auto text-faint">{question.id}</span>
      </div>

      <p className="mt-1.5 text-fg leading-relaxed">{question.question}</p>
      <p className="mt-1 text-faint leading-relaxed">{question.context}</p>

      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        spellCheck={false}
        placeholder="answer it — this becomes a fact everyone inherits"
        className="mt-2 w-full resize-y border border-line bg-bg px-1.5 py-1 text-fg outline-none placeholder:text-faint/70 focus:border-k-question/50"
      />

      <div className="mt-1.5 flex gap-px">
        <button
          type="button"
          disabled={!answer.trim()}
          onClick={submit}
          className="flex-1 border border-k-question/40 py-0.5 text-k-question transition-colors hover:bg-k-question/10 disabled:opacity-40"
        >
          answer &amp; resume
        </button>
        <button
          type="button"
          onClick={() => onDismiss(question.id)}
          className="flex-1 border border-line py-0.5 text-faint transition-colors hover:border-err/40 hover:text-err"
          title="drop the question and stop the work"
        >
          drop it
        </button>
      </div>
    </article>
  );
}

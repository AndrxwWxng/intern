/**
 * `npm test`
 *
 * One thing worth checking here: Scout streams its context sub-agents down the
 * same response as the top-level run, so anything accumulating `content` has to
 * key on `run_id`. When it didn't, two agents' sentences spliced together.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// Explicit extension: node's ESM loader does not resolve it for us.
import { lanes, type ScoutEvent } from "./scout.ts";

/** Two runs talking at once, alternating every chunk — the real failure shape. */
const INTERLEAVED: ScoutEvent[] = [
  { event: "RunContent", run_id: "top", agent_id: "scout", content: "Status" },
  {
    event: "RunContent",
    run_id: "sub",
    parent_run_id: "top",
    agent_id: "knowledge-read",
    content: "The wiki contains: ",
  },
  { event: "RunContent", run_id: "top", agent_id: "scout", content: ": only one " },
  {
    event: "RunContent",
    run_id: "sub",
    parent_run_id: "top",
    agent_id: "knowledge-read",
    content: "unknown/not ",
  },
  { event: "RunContent", run_id: "top", agent_id: "scout", content: "source found." },
  {
    event: "RunContent",
    run_id: "sub",
    parent_run_id: "top",
    agent_id: "knowledge-read",
    content: "found.",
  },
];

function collect(events: ScoutEvent[]): string[] {
  const lines: string[] = [];
  const out = lanes((text) => lines.push(text));
  for (const ev of events) {
    if (typeof ev.content !== "string") continue;
    out.lane(ev).text += ev.content;
  }
  out.flushAll();
  return lines;
}

test("concurrent runs do not splice into each other", () => {
  assert.deepEqual(collect(INTERLEAVED), [
    "Status: only one source found.",
    "knowledge-read · The wiki contains: unknown/not found.",
  ]);
});

test("only the top-level run is the answer", () => {
  const out = lanes(() => {});
  assert.equal(out.lane(INTERLEAVED[0]).main, true);
  assert.equal(out.lane(INTERLEAVED[1]).main, false);
});

test("flushing one run leaves the others mid-sentence", () => {
  const lines: string[] = [];
  const out = lanes((text) => lines.push(text));
  out.lane(INTERLEAVED[0]).text += "half a ";
  out.lane(INTERLEAVED[1]).text += "other agent";
  out.flush(INTERLEAVED[0]);
  assert.deepEqual(lines, ["half a"]);
  // Re-opening a drained lane puts it at the back — flushAll drains in the
  // order lanes are currently open, which at end of stream is good enough.
  out.lane(INTERLEAVED[0]).text += "sentence";
  out.flushAll();
  assert.deepEqual(lines, ["half a", "knowledge-read · other agent", "sentence"]);
});

test("an event with no run_id still gets a lane", () => {
  assert.deepEqual(collect([{ event: "RunContent", content: "bare" }]), ["bare"]);
});

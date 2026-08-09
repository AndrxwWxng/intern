/**
 * `npm test`
 *
 * The first case is verbatim from a real run on 9 Aug 2026 that researched for
 * three minutes, wrote a correct Slack draft, and posted nothing: it said
 * `channel` where the parser demanded `to`, and had no `subject` because a
 * Slack post does not have one. The block was dropped without a word.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseActionBlock } from "./action-block.ts";

const REAL_RUN = `Research found no verified viable prospects.

\`\`\`action
{"kind":"slack","channel":"#demo","body":"**Finding:** No new viable prospects were verified today.\\n• **Next:** Rerun when web access is available.","rationale":"Report the outcome without inventing prospects.","sources":["Knowledge: prospecting/viable-prospects.md"]}
\`\`\``;

test("a slack block using `channel` and no `subject` still becomes a draft", () => {
  const parsed = parseActionBlock(REAL_RUN);
  assert.ok(parsed && !("error" in parsed), "should not be dropped");
  assert.equal(parsed.kind, "slack");
  assert.deepEqual(parsed.draft.to, ["#demo"]);
  // No invented heading — the connector bolds `subject` above the body.
  assert.equal(parsed.draft.subject, "");
  assert.match(parsed.title, /^slack to #demo — Finding:/);
  assert.deepEqual(parsed.sources, ["Knowledge: prospecting/viable-prospects.md"]);
});

test("an email keeps its subject and defaults to the first line without one", () => {
  const withSubject = parseActionBlock(
    '```action\n{"kind":"email","to":"a@b.co","subject":"Pilot","body":"Hi there"}\n```',
  );
  assert.ok(withSubject && !("error" in withSubject));
  assert.equal(withSubject.draft.subject, "Pilot");

  const without = parseActionBlock(
    '```action\n{"kind":"email","to":["a@b.co"],"body":"Pilot update\\nsecond line"}\n```',
  );
  assert.ok(without && !("error" in without));
  assert.equal(without.draft.subject, "Pilot update");
});

test("no block at all is not an error — most runs send nothing", () => {
  assert.equal(parseActionBlock("Filed it into the wiki. Nothing to send."), null);
});

test("an unusable block reports why instead of vanishing", () => {
  const noRecipient = parseActionBlock('```action\n{"kind":"slack","body":"hello"}\n```');
  assert.ok(noRecipient && "error" in noRecipient);
  assert.match(noRecipient.error, /recipient/);

  const noBody = parseActionBlock('```action\n{"kind":"slack","channel":"#demo"}\n```');
  assert.ok(noBody && "error" in noBody);
  assert.match(noBody.error, /body/);

  const notJson = parseActionBlock("```action\n{kind: slack,}\n```");
  assert.ok(notJson && "error" in notJson);
  assert.match(notJson.error, /valid JSON/);
});

test("an unknown kind falls back to email rather than being dropped", () => {
  const parsed = parseActionBlock(
    '```action\n{"kind":"carrier-pigeon","to":"a@b.co","body":"hi"}\n```',
  );
  assert.ok(parsed && !("error" in parsed));
  assert.equal(parsed.kind, "email");
});

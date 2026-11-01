import { test } from "node:test";
import assert from "node:assert/strict";
import { initial, reduce, sanitize, statusLine, isStale, type Ev } from "./reducer.ts";

const run = (...evs: Ev[]) => evs.reduce(reduce, initial());

test("starts idle", () => assert.equal(initial().state, "idle"));
test("working then done with turn count", () => {
  const m = run({ type: "agent_start" }, { type: "assistant_text", text: "a\nAll done." }, { type: "agent_settled" });
  assert.equal(m.state, "done"); assert.equal(m.turn, 1); assert.equal(m.msg, "All done.");
  assert.equal(run({ type: "agent_start" }).state, "working");
});
test("input clears done to idle", () => {
  const m = run({ type: "agent_start" }, { type: "agent_settled" }, { type: "input" });
  assert.equal(m.state, "idle"); assert.equal(m.msg, "");
});
test("aborted run is idle", () => assert.equal(run({ type: "agent_start" }, { type: "agent_settled", aborted: true }).state, "idle"));
test("blocked overrides working, restores after", () => {
  let m = run({ type: "agent_start" }, { type: "block", id: "x", kind: "permission", msg: "Allow?" });
  assert.equal(m.state, "blocked"); assert.equal(m.kind, "permission");
  m = reduce(m, { type: "unblock", id: "x" });
  assert.equal(m.state, "working"); assert.equal(m.kind, null);
});
test("nested blockers: last wins, all must clear", () => {
  let m = run({ type: "block", id: "a", kind: "question" }, { type: "block", id: "b", kind: "permission" });
  assert.equal(m.kind, "permission");
  m = reduce(m, { type: "unblock", id: "b" }); assert.equal(m.kind, "question");
  m = reduce(m, { type: "unblock", id: "a" }); assert.equal(m.state, "idle");
});
test("settled while blocked stays blocked", () => {
  const m = run({ type: "agent_start" }, { type: "block", id: "a", kind: "question" }, { type: "agent_settled" });
  assert.equal(m.state, "blocked");
  assert.equal(reduce(m, { type: "unblock", id: "a" }).state, "done");
});
test("sanitize truncates and redacts", () => {
  assert.equal([...sanitize("word ".repeat(60))].length, 120);
  assert.ok(!sanitize("key sk-abcdefghijklmnop1234").includes("abcdefghij"));
  assert.ok(!sanitize("password=hunter2").includes("hunter2"));
  assert.ok(!sanitize("Authorization: Bearer abcdefgh12345678").includes("abcdefgh1"));
  assert.equal(sanitize("a\x1b[31mb\nc"), "a [31mb c");
});
test("statusLine takes last line", () => assert.equal(statusLine("- one\n\n- two\n"), "two"));
test("stale rule", () => {
  const r = { updated_ms: 0, pid: 1 };
  assert.equal(isStale(r, 31_000, () => false), true);
  assert.equal(isStale(r, 31_000, () => true), false);
  assert.equal(isStale(r, 10_000, () => false), false);
});

import { view } from "./reducer.ts";
test("M4: blocker msg not persisted after unblock", () => {
  let m = run({ type: "agent_start" }, { type: "assistant_text", text: "Working on it" }, { type: "block", id: "x", kind: "permission", msg: "Waiting: Allow?" });
  assert.equal(view(m).msg, "Waiting: Allow?");
  m = reduce(m, { type: "unblock", id: "x" });
  assert.equal(view(m).msg, "Working on it"); assert.equal(view(m).state, "working");
});
test("M5: agent_settled drops leaked tool blockers, keeps ui prompts", () => {
  let m = run({ type: "agent_start" }, { type: "block", id: "tool-1", kind: "question" }, { type: "agent_settled" });
  assert.equal(m.state, "done");
  m = run({ type: "agent_start" }, { type: "block", id: "ui-prompt", kind: "question" }, { type: "agent_settled" });
  assert.equal(m.state, "blocked");
});
test("M3: blocker without msg falls back to earlier blocker text", () => {
  const m = run({ type: "block", id: "tool-1", kind: "question", msg: "Waiting: Pick?" }, { type: "block", id: "ui-prompt", kind: "question", msg: "" });
  assert.equal(view(m).msg, "Waiting: Pick?");
  assert.equal(view(run({ type: "block", id: "ui-prompt", kind: "question" })).msg, "Waiting for input");
});
test("M6: redaction forms", () => {
  for (const x of ["DB_PASSWORD=hunter2xx", "client_secret=abc123", "GITHUB_TOKEN=zzz999", '{"password": "hunter2"}', "github_pat_11ABCDEFG0123456789", "glpat-abcdefghij1234567890", "npm_abcdefghij1234567890", "xapp-1-abcdefghijk", "SK" + "0123456789abcdef0123456789abcdef", "https://bob:s3cret@host/x", "Authorization: Basic dXNlcjpwYXNzd29yZA=="]) {
    const out = sanitize(`run ${x} now`);
    assert.ok(out.includes("[redacted]"), `${x} -> ${out}`);
    assert.ok(!/hunter2|abc123|zzz999|s3cret|dXNlcjpw|ABCDEFG0123|abcdefghij|0123456789abcdef/.test(out), `${x} -> ${out}`);
  }
});

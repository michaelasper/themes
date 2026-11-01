import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, { sweep } from "./index.ts";

const OWNER = Symbol.for("tern-pi-status.owner");
let dir: string;
const saved = { ...process.env };
const mk = () => {
  const h = new Map<string, Function>();
  factory({ on: (n: string, f: Function) => void h.set(n, f) } as any);
  return { h, emit: (n: string, e: any = {}, ctx: any = {}) => h.get(n)?.(e, ctx) };
};
const tui = { mode: "tui", cwd: "/tmp", sessionManager: { getSessionFile: () => "/s.jsonl" } };
const rec = () => JSON.parse(readFileSync(join(dir, "7.json"), "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pistatus-"));
  process.env.TERN_STATUS_DIR = dir; process.env.TERN_PANE = "7"; delete process.env.PI_SUBAGENT_CHILD;
  delete (globalThis as any)[OWNER];
});
afterEach(() => { process.env = { ...saved }; delete (globalThis as any)[OWNER]; rmSync(dir, { recursive: true, force: true }); });

test("C2: factory registers nothing process-wide", () => {
  const before = process.listenerCount("exit");
  const a = mk();
  assert.equal(process.listenerCount("exit"), before);
  assert.deepEqual(readdirSync(dir), []);
  a.emit("session_shutdown");
});
test("C2: session_start adds exit/signal hooks, shutdown removes them, file deleted", async () => {
  const e0 = process.listenerCount("exit"), s0 = process.listenerCount("SIGHUP");
  const a = mk();
  await a.emit("session_start", {}, tui);
  assert.equal(process.listenerCount("exit"), e0 + 1); assert.equal(process.listenerCount("SIGHUP"), s0 + 1);
  assert.equal(rec().state, "idle"); assert.equal(rec().pid, process.pid); assert.ok(rec().instance);
  assert.equal(rec().v, 1); assert.equal(statSync(join(dir, "7.json")).mode & 0o777, 0o600);
  await a.emit("session_shutdown");
  assert.equal(process.listenerCount("exit"), e0); assert.equal(process.listenerCount("SIGHUP"), s0);
  assert.equal(existsSync(join(dir, "7.json")), false);
  assert.equal((globalThis as any)[OWNER], undefined);
});
test("C1: non-tui sessions never write", async () => {
  for (const mode of ["print", "rpc", undefined]) { const a = mk(); await a.emit("session_start", {}, { ...tui, mode }); await a.emit("agent_start"); await a.emit("session_shutdown"); }
  assert.deepEqual(readdirSync(dir), []);
});
test("C1: PI_SUBAGENT_CHILD=1 registers nothing", () => {
  process.env.PI_SUBAGENT_CHILD = "1";
  assert.equal(mk().h.size, 0);
});
test("C1: second instance in same process cannot clobber or delete parent file", async () => {
  const parent = mk(); await parent.emit("session_start", {}, tui); await parent.emit("agent_start");
  await parent.emit("ui_prompt_start", { kind: "confirm", title: "Allow?" });
  const child = mk(); await child.emit("session_start", {}, tui); // even if (wrongly) tui
  await child.emit("agent_settled"); await child.emit("session_shutdown");
  assert.equal(rec().state, "blocked");
  await parent.emit("session_shutdown");
  assert.equal(existsSync(join(dir, "7.json")), false);
});
test("C1: remove() only deletes when pid and instance match", async () => {
  const a = mk(); await a.emit("session_start", {}, tui);
  const r = rec(); writeFileSync(join(dir, "7.json"), JSON.stringify({ ...r, instance: "other" }));
  await a.emit("session_shutdown");
  assert.equal(rec().instance, "other");
  writeFileSync(join(dir, "7.json"), JSON.stringify({ ...r, pid: process.pid + 1 }));
  const b = mk(); await b.emit("session_start", {}, tui);
  writeFileSync(join(dir, "7.json"), JSON.stringify({ ...r, pid: process.pid + 1 })); await b.emit("session_shutdown");
  assert.equal(rec().pid, process.pid + 1);
});
test("L5/L7/L6: no-op without numeric TERN_PANE", () => {
  delete process.env.TERN_PANE; assert.equal(mk().h.size, 0);
  process.env.TERN_PANE = "../x"; assert.equal(mk().h.size, 0);
});
test("M1/M2/M4: ui_prompt events block; permission when tool in flight; msg restored", async () => {
  const a = mk(); await a.emit("session_start", {}, tui); await a.emit("agent_start");
  await a.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Doing it" }] } });
  await a.emit("ui_prompt_start", { kind: "select", title: "Pick one\nsecond line" });
  assert.equal(rec().kind, "question"); assert.equal(rec().msg, "Waiting: Pick one");
  await a.emit("ui_prompt_end");
  assert.equal(rec().state, "working"); assert.equal(rec().msg, "Doing it"); assert.equal(rec().kind, null);
  await a.emit("tool_execution_start", { toolName: "bash", toolCallId: "t1", args: {} });
  await a.emit("ui_prompt_start", { kind: "select", title: "Allow rm -rf?" });
  assert.equal(rec().kind, "permission");
  await a.emit("ui_prompt_end"); await a.emit("tool_execution_end", { toolCallId: "t1" });
  await a.emit("ui_prompt_start", { kind: "confirm", title: "Sure?" });
  assert.equal(rec().kind, "permission");
  await a.emit("session_shutdown");
});
test("M6: prompt title is first line, ≤60 chars, redacted", async () => {
  const a = mk(); await a.emit("session_start", {}, tui);
  await a.emit("ui_prompt_start", { kind: "confirm", title: "run GITHUB_TOKEN=abc123 " + "x".repeat(200) });
  assert.ok(!rec().msg.includes("abc123")); assert.ok([...rec().msg].length <= 70);
  await a.emit("session_shutdown");
});
test("M3: ask_user_question text read from questions[0]; nested custom prompt keeps it", async () => {
  const a = mk(); await a.emit("session_start", {}, tui); await a.emit("agent_start");
  await a.emit("tool_execution_start", { toolName: "ask_user_question", toolCallId: "q1", args: { questions: [{ id: "a", question: "Which DB?" }] } });
  assert.equal(rec().msg, "Waiting: Which DB?");
  await a.emit("ui_prompt_start", { kind: "custom" });
  assert.equal(rec().msg, "Waiting: Which DB?"); assert.equal(rec().kind, "question");
  await a.emit("ui_prompt_end"); await a.emit("tool_execution_end", { toolCallId: "q1" });
  assert.equal(rec().state, "working");
  await a.emit("session_shutdown");
});
test("M5: agent_settled clears leaked tool blocker", async () => {
  const a = mk(); await a.emit("session_start", {}, tui); await a.emit("agent_start");
  await a.emit("tool_execution_start", { toolName: "ask_user_question", toolCallId: "q1", args: {} });
  assert.equal(rec().state, "blocked");
  await a.emit("agent_settled", { aborted: false });
  assert.equal(rec().state, "done");
  await a.emit("session_shutdown");
});
test("L4: extension-sourced input does not clear done", async () => {
  const a = mk(); await a.emit("session_start", {}, tui); await a.emit("agent_start"); await a.emit("agent_settled", {});
  await a.emit("input", { source: "extension" }); assert.equal(rec().state, "done");
  await a.emit("input", { source: "interactive" }); assert.equal(rec().state, "idle");
  await a.emit("session_shutdown");
});
test("H1: sweep removes dead-pid stale files and orphan tmp, keeps live/fresh", () => {
  const now = 1_000_000;
  const w = (n: string, o: any) => writeFileSync(join(dir, n), JSON.stringify(o));
  w("1.json", { pid: 111, updated_ms: now - 60_000 });
  w("2.json", { pid: 222, updated_ms: now - 60_000 });
  w("3.json", { pid: 111, updated_ms: now - 1000 });
  w("4.json", { garbage: true });
  writeFileSync(join(dir, "5.json.111.tmp"), "x"); writeFileSync(join(dir, "5.json.222.tmp"), "x");
  sweep(dir, now, (p) => p === 222);
  assert.deepEqual(readdirSync(dir).sort(), ["2.json", "3.json", "4.json", "5.json.222.tmp"]);
});
test("H1: session_start sweeps stale file of another dead pane", async () => {
  writeFileSync(join(dir, "9.json"), JSON.stringify({ pid: 2 ** 22 + 12345, updated_ms: 1 }));
  const a = mk(); await a.emit("session_start", {}, tui);
  assert.equal(existsSync(join(dir, "9.json")), false);
  await a.emit("session_shutdown");
});
test("schema: consumer fields intact", async () => {
  const a = mk(); await a.emit("session_start", {}, tui);
  for (const k of ["v", "pane", "session_file", "cwd", "state", "msg", "kind", "turn", "updated_ms", "pid"]) assert.ok(k in rec(), k);
  assert.equal(rec().pane, "7"); assert.equal(rec().session_file, "/s.jsonl");
  await a.emit("session_shutdown");
});

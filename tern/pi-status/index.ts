import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initial, isStale, reduce, sanitize, view, type Ev, type Kind, type Model } from "./reducer.ts";

const HEARTBEAT_MS = 10_000;
const OWNER = Symbol.for("tern-pi-status.owner");
const QUESTION_TOOL = /ask_user|question/i;
const SIGNALS = ["SIGHUP", "SIGTERM"] as const;

export const defaultDir = () => process.env.TERN_STATUS_DIR || join(homedir(), ".local", "state", "conductor", "tern-status");

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** Delete status files (and orphaned tmp files) left behind by dead processes. */
export function sweep(dir: string, now = Date.now(), alive: (pid: number) => boolean = pidAlive): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = join(dir, name);
    try {
      if (name.endsWith(".json")) {
        const rec = JSON.parse(readFileSync(p, "utf8"));
        if (typeof rec?.pid === "number" && typeof rec?.updated_ms === "number" && isStale(rec, now, alive)) unlinkSync(p);
      } else {
        const m = /\.(\d+)\.tmp$/.exec(name);
        if (m && !alive(Number(m[1]))) unlinkSync(p);
      }
    } catch { /* best-effort */ }
  }
}

const firstLine = (t: unknown) => (typeof t === "string" ? sanitize(t.split(/\r?\n/)[0] ?? "", 60) : "");

export default function (pi: ExtensionAPI) {
  const pane = process.env.TERN_PANE?.trim();
  if (!pane || !/^\d+$/.test(pane)) return; // not in Tern (consumer only reads numeric pane ids)
  if (process.env.PI_SUBAGENT_CHILD === "1") return; // async subagent child: parent owns the pane

  const instance = randomBytes(8).toString("hex");
  const g = globalThis as any;
  let owned = false;
  let dir = defaultDir();
  let file = join(dir, `${pane}.json`);
  let model: Model = initial();
  let sessionFile: string | null = null;
  let cwd = process.cwd();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastKey = "";
  const toolsInFlight = new Set<string>();
  const sigHandlers = new Map<string, () => void>();

  const write = () => {
    if (!owned) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const v = view(model);
      // `turn` counts agent runs (agent_start fires for retries/continuations), not user turns
      const rec = { v: 1, pane, session_file: sessionFile, cwd, state: v.state, msg: v.msg, kind: v.kind, turn: model.turn, updated_ms: Date.now(), pid: process.pid, instance };
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
      renameSync(tmp, file);
    } catch { /* status is best-effort */ }
  };
  const keyOf = () => { const v = view(model); return `${v.state}|${v.kind}|${v.msg}|${model.turn}`; };
  const dispatch = (e: Ev) => {
    if (!owned) return;
    model = reduce(model, e);
    const k = keyOf();
    if (k !== lastKey) { lastKey = k; write(); }
  };
  /** Unlink only a file this very process+instance wrote. */
  const remove = () => {
    try {
      const rec = JSON.parse(readFileSync(file, "utf8"));
      if (rec?.pid === process.pid && rec?.instance === instance) unlinkSync(file);
    } catch { /* missing or unreadable */ }
  };
  const onExit = () => { if (owned) remove(); };

  const release = () => {
    clearInterval(timer); timer = undefined;
    if (!owned) return;
    remove();
    process.removeListener("exit", onExit);
    for (const [sig, h] of sigHandlers) process.removeListener(sig as NodeJS.Signals, h);
    sigHandlers.clear();
    if (g[OWNER] === instance) delete g[OWNER];
    owned = false;
  };

  pi.on("session_start", async (_e: any, ctx: any) => {
    if (ctx?.mode !== "tui") return; // print/rpc/subagent sessions never own the pane
    if (owned) release(); // new session in same instance (e.g. /new): reclaim cleanly
    if (g[OWNER] && g[OWNER] !== instance) return; // another instance in this process owns it
    g[OWNER] = instance;
    owned = true;
    dir = defaultDir();
    file = join(dir, `${pane}.json`);
    cwd = ctx.cwd ?? process.cwd();
    try { sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null; } catch { sessionFile = null; }
    model = initial();
    toolsInFlight.clear();
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); } catch { /* ignore */ }
    sweep(dir);
    process.once("exit", onExit);
    for (const sig of SIGNALS) {
      const h = () => {
        remove();
        process.removeListener(sig, h);
        sigHandlers.delete(sig);
        // restore default termination unless someone else handles the signal
        if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
      };
      sigHandlers.set(sig, h);
      process.on(sig, h);
    }
    lastKey = keyOf();
    write();
    timer = setInterval(write, HEARTBEAT_MS);
    timer.unref?.();
  });
  pi.on("input", async (e: any) => { if (e?.source !== "extension") dispatch({ type: "input" }); });
  pi.on("agent_start", async () => { dispatch({ type: "agent_start" }); });
  pi.on("message_end", async (e: any) => {
    const m = e.message;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return;
    const text = m.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
    dispatch({ type: "assistant_text", text });
  });
  pi.on("tool_execution_start", async (e: any) => {
    if (QUESTION_TOOL.test(String(e.toolName))) {
      const q = e.args?.questions?.[0]?.question ?? e.args?.question ?? e.args?.prompt ?? e.args?.title;
      const t = firstLine(q);
      dispatch({ type: "block", id: `tool-${e.toolCallId}`, kind: "question", msg: t ? `Waiting: ${t}` : "Waiting for answer" });
    } else {
      toolsInFlight.add(String(e.toolCallId));
    }
  });
  pi.on("tool_execution_end", async (e: any) => {
    toolsInFlight.delete(String(e.toolCallId));
    dispatch({ type: "unblock", id: `tool-${e.toolCallId}` });
  });
  // pi emits these once per outermost blocking dialog (nesting handled by pi)
  (pi as any).on("ui_prompt_start", async (e: any) => {
    // a dialog while a non-question tool runs is a permission gate, whatever widget it uses
    const kind: Kind = toolsInFlight.size > 0 || e.kind === "confirm" ? "permission" : "question";
    const t = firstLine(e.title);
    dispatch({ type: "block", id: "ui-prompt", kind, msg: t ? `Waiting: ${t}` : "" });
  });
  (pi as any).on("ui_prompt_end", async () => { dispatch({ type: "unblock", id: "ui-prompt" }); });
  pi.on("agent_settled", async (e: any) => { toolsInFlight.clear(); dispatch({ type: "agent_settled", aborted: !!e?.aborted }); });
  pi.on("session_shutdown", async () => { release(); });
}

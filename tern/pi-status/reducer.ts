export type State = "working" | "blocked" | "idle" | "done";
export type Kind = "question" | "permission" | "auth" | null;

export interface Model {
  state: State;
  kind: Kind;
  msg: string;
  turn: number;
  running: boolean;
  /** open blockers by id, insertion-ordered; last one is reported */
  blockers: Map<string, { kind: Kind; msg: string }>;
  unseen: boolean;
}

export type Ev =
  | { type: "agent_start" }
  | { type: "assistant_text"; text: string }
  | { type: "agent_settled"; aborted?: boolean }
  | { type: "input" }
  | { type: "block"; id: string; kind: Kind; msg?: string }
  | { type: "unblock"; id: string }
  | { type: "reset" };

export const MAX_MSG = 120;

const SECRET = [
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs]|AKIA|ASIA|AIza)[-_A-Za-z0-9]{12,}/g,
  /\b(?:github_pat_|glpat-|npm_|xapp-|xoxe[.-])[A-Za-z0-9_.-]{10,}/g,
  /\b(?:SK|AC)[0-9a-fA-F]{32}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+\/=]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /([A-Za-z0-9_]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|authorization)["']?)(\s*[:=]\s*["']?)[^\s"',}]+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+\/_-]{40,}={0,2}/g,
];

export function sanitize(text: string, max = MAX_MSG): string {
  let s = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  s = s.replace(/:\/\/[^\/\s:@]+:[^\/\s@]+@/g, "://[redacted]@");
  for (const re of SECRET) s = s.replace(re, (m, k, sep) => (typeof k === "string" && typeof sep === "string" ? `${k}${sep}[redacted]` : "[redacted]"));
  s = s.replace(/\s+/g, " ").trim();
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s;
}

/** Last non-empty line of assistant text (the "status line"), sanitized. */
export function statusLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^[\s>*#\-•]+/, "").trim()).filter(Boolean);
  return sanitize(lines[lines.length - 1] ?? "");
}

export function initial(): Model {
  return { state: "idle", kind: null, msg: "", turn: 0, running: false, blockers: new Map(), unseen: false };
}

function derive(m: Model): Model {
  const last = [...m.blockers.values()].pop();
  if (last) return { ...m, state: "blocked", kind: last.kind ?? "question" };
  if (m.running) return { ...m, state: "working", kind: null };
  return { ...m, state: m.unseen ? "done" : "idle", kind: null };
}

export function reduce(m: Model, e: Ev): Model {
  switch (e.type) {
    case "agent_start":
      return derive({ ...m, running: true, unseen: false, turn: m.turn + 1 });
    case "assistant_text": {
      const msg = statusLine(e.text);
      return msg ? { ...m, msg } : m;
    }
    case "agent_settled": {
      // tool blockers can leak if a tool_execution_end is missed; UI prompts close themselves
      const blockers = new Map([...m.blockers].filter(([id]) => !id.startsWith("tool-")));
      return derive({ ...m, blockers, running: false, unseen: !e.aborted && m.turn > 0 });
    }
    case "input":
      // user acted: output seen
      return derive({ ...m, unseen: false, msg: m.running ? m.msg : "" });
    case "block": {
      const blockers = new Map(m.blockers);
      blockers.delete(e.id);
      blockers.set(e.id, { kind: e.kind, msg: sanitize(e.msg ?? "") });
      return derive({ ...m, blockers });
    }
    case "unblock": {
      const blockers = new Map(m.blockers);
      blockers.delete(e.id);
      return derive({ ...m, blockers });
    }
    case "reset":
      return initial();
  }
}

/** What gets written: while blocked, the newest blocker's text; assistant msg is left untouched. */
export function view(m: Model): { state: State; kind: Kind; msg: string } {
  if (m.state !== "blocked") return { state: m.state, kind: null, msg: m.msg };
  const withMsg = [...m.blockers.values()].reverse().find((b) => b.msg);
  return { state: "blocked", kind: m.kind ?? "question", msg: withMsg?.msg ?? "Waiting for input" };
}

export function isStale(rec: { updated_ms: number; pid: number }, now: number, alive: (pid: number) => boolean): boolean {
  return now - rec.updated_ms > 30_000 && !alive(rec.pid);
}

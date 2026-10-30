// Pure, dependency-free helpers for the conductor board. Nothing here touches the app, a terminal,
// a timer or the file system: callers inject time, sleep and the work to run, so test/harness.mjs
// can exercise every safeguard in plain node.

export const VOICE_STATES = ["idle", "listening", "speaking", "transcribing"];
export const STALE_ACTIVE_MS = 3000; // active states are rewritten several times a second by the writer
export const STALE_IDLE_MS = 15000; // idle is a slow heartbeat
export const MAX_VOICE_BYTES = 4096; // the real file is ~80 bytes; anything bigger is not ours
export const LEVEL_STEPS = 8; // bar heights are quantised so a redraw only happens on a visible change

// Strict parse of the optional voice state file {v:1, state, level, updated_ms}. Only these fields are read.
export function parseVoice(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_VOICE_BYTES) return null;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || j.v !== 1 || !VOICE_STATES.includes(j.state) || !Number.isFinite(j.updated_ms)) return null;
    const level = Number.isFinite(j.level) ? Math.min(1, Math.max(0, j.level)) : 0;
    return { state: j.state, level, at: j.updated_ms };
  } catch {
    return null;
  }
}

// What to show now: the file's state, or "offline" when missing, malformed, stale or from the future.
export function effVoice(v, now) {
  if (!v) return { state: "offline", level: 0 };
  const age = now - v.at;
  if (age > (v.state === "idle" ? STALE_IDLE_MS : STALE_ACTIVE_MS) || age < -STALE_ACTIVE_MS) return { state: "offline", level: 0 };
  return v;
}

export const quantize = (level) => Math.round(Math.min(1, Math.max(0, level)) * LEVEL_STEPS) / LEVEL_STEPS;

// Poll interval for the voice file: gentle when nothing is happening, never faster than MIN_POLL_MS.
export const MIN_POLL_MS = 250;
export const ACTIVE_POLL_MS = 250;
export const IDLE_POLL_MS = 1000;
export const INACTIVE_POLL_MS = 3000; // layout not shown
export function voicePollMs(eff, layoutActive) {
  if (!layoutActive) return INACTIVE_POLL_MS;
  const ms = eff.state === "offline" || eff.state === "idle" ? IDLE_POLL_MS : ACTIVE_POLL_MS;
  return Math.max(MIN_POLL_MS, ms);
}

// Rolling history for the bars. A sample is added only for a new writer timestamp.
export class VoiceTrack {
  constructor(bars = 24) {
    this.bars = bars;
    this.hist = new Array(bars).fill(0);
    this.last = null; // last valid parse
    this.lastAt = null;
    this.shown = ""; // "state:quantised level" last drawn
  }
  apply(text) {
    const v = parseVoice(text);
    this.last = v;
    if (v && v.state !== "idle" && v.at !== this.lastAt) {
      this.hist.push(quantize(v.level));
      this.hist.shift();
    }
    if (v) this.lastAt = v.at;
    return v;
  }
  // True when what the user would see changed since the last call that returned true (so: notify).
  changed(now) {
    const e = effVoice(this.last, now);
    const key = `${e.state}:${quantize(e.level)}`;
    if (key === this.shown) return false;
    this.shown = key;
    return true;
  }
}

// At most `max` takes per rolling `windowMs`.
export class Limiter {
  constructor(max, windowMs, now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.stamps = [];
  }
  tryTake() {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(t);
    return true;
  }
}

// Collapses a burst of changes into one: fires only after `ms` of calm.
export class Debounce {
  constructor(ms) {
    this.ms = ms;
    this.at = null;
  }
  touch(now) {
    this.at = now;
  }
  due(now) {
    return this.at != null && now - this.at >= this.ms;
  }
  clear() {
    this.at = null;
  }
  pending() {
    return this.at != null;
  }
}

// Runs fn with a hard timeout. The timer is the injected sleep (the app has no timer globals).
export function withTimeout(fn, ms, sleep) {
  let t = true;
  return Promise.race([
    Promise.resolve().then(fn).finally(() => { t = false; }),
    sleep(ms).then(() => { if (t) throw new Error(`timed out after ${ms} ms`); return new Promise(() => {}); }),
  ]);
}

// The only way the board runs a command: never during render, one at a time, rate limited, with a timeout,
// and each key refreshed no more often than its own minimum interval. `cost` counts toward the minute cap.
export class SafeRunner {
  constructor({ now, sleep, timeoutMs = 5000, maxPerMinute = 12, backoffMs = 15000 }) {
    this.now = now;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
    this.limiter = new Limiter(maxPerMinute, 60000, now);
    this.backoffMs = backoffMs;
    this.inflight = false;
    this.last = new Map(); // key -> start time of last attempt
    this.failedAt = new Map(); // key -> time of last failure
    this.skipped = { busy: 0, rate: 0, interval: 0, backoff: 0 };
  }
  // Returns {ran:false, why} when it declines, else {ran:true, ok, value|error}. Never throws.
  async run(key, minIntervalMs, fn) {
    const t = this.now();
    if (this.inflight) { this.skipped.busy++; return { ran: false, why: "busy" }; }
    if (this.last.has(key) && t - this.last.get(key) < minIntervalMs) { this.skipped.interval++; return { ran: false, why: "interval" }; }
    if (this.failedAt.has(key) && t - this.failedAt.get(key) < this.backoffMs) { this.skipped.backoff++; return { ran: false, why: "backoff" }; }
    if (!this.limiter.tryTake()) { this.skipped.rate++; return { ran: false, why: "rate" }; }
    this.inflight = true;
    this.last.set(key, t);
    try {
      const value = await withTimeout(fn, this.timeoutMs, this.sleep);
      this.failedAt.delete(key);
      return { ran: true, ok: true, value };
    } catch (e) {
      this.failedAt.set(key, this.now());
      return { ran: true, ok: false, error: String(e?.message ?? e) };
    } finally {
      this.inflight = false;
    }
  }
}

// How often the review banner's git info may refresh while that session stays selected.
export const REFRESH_MS = { done: 30000 };
export const SELECT_DEBOUNCE_MS = 400;

// ---- conductor session resolution: optional generic file contract, see README "Conductor session file" ----
export const MAX_MANAGER_BYTES = 4096;
export const MANAGER_STALE_MS = 24 * 3600 * 1000;
export const MANAGER_POLL_MS = 3000; // while the layout is shown (never below 2 s)
export const MANAGER_IDLE_POLL_MS = 10000; // layout hidden: no file reads, just a slow loop
export const NO_MANAGER_NOTE = "No conductor session. Run /conductor on in a pi session, or start one here";
export const notFoundNote = (t) => `conductor terminal ${t} not found; set with install.sh --manager tN. No conductor session: run /conductor on in a pi session, or start one here`;
const ADDR = /^[\w.:@-]{1,64}$/;

// Strict parse of {v:1, terminal, updated_ms, pid?}. Returns null for anything else.
export function parseManager(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_MANAGER_BYTES) return null;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || j.v !== 1 || typeof j.terminal !== "string" || !ADDR.test(j.terminal) || !Number.isFinite(j.updated_ms)) return null;
    return { terminal: j.terminal, at: j.updated_ms, pid: Number.isInteger(j.pid) ? j.pid : null };
  } catch {
    return null;
  }
}

// Precedence: file (valid, terminal exists, fresh or still alive) > install-time terminal (if it exists) > none.
// `terms` = every known terminal address, `live` = addresses currently reporting an agent status.
export function resolveManager({ fileText, terms, live, installed, now }) {
  const f = parseManager(fileText);
  let why = "";
  if (f) {
    const age = now - f.at;
    if (!terms.has(f.terminal)) why = `file names ${f.terminal}, which does not exist`;
    else if (age < -MANAGER_STALE_MS) why = "file timestamp is far in the future";
    else if (age > MANAGER_STALE_MS && !live.has(f.terminal)) why = `file for ${f.terminal} is stale and the terminal is not live`;
    else return { terminal: f.terminal, source: "file", note: "" };
  }
  if (installed && terms.has(installed)) return { terminal: installed, source: "install", note: "" };
  return { terminal: null, source: "none", note: installed ? notFoundNote(installed) : NO_MANAGER_NOTE, why };
}

// ---- effective status: subagents ----
// Generic, optional contract (README "Subagents and effective status"): the core records the starter of a terminal
// as `parent` (Herdr AGENTS.md: sub-agents are terminals an agent started with `hc run`). A live descendant terminal
// whose own status is "working" counts toward every ancestor. No pi code is imported or assumed.
export const MAX_ANCESTOR_DEPTH = 8;
const parentOf = (t) => {
  const p = t?.parent;
  const a = typeof p === "string" ? p : p && typeof p === "object" && typeof p.address === "string" ? p.address : null;
  return a && a !== t.address ? a : null;
};
const statusWord = (t) => (typeof t?.status === "string" ? t.status : typeof t?.status?.status === "string" ? t.status.status : typeof t?.report?.status === "string" ? t.report.status : "");
// Map ancestor address -> number of distinct live descendant terminals that report "working".
// Walks `parent` links with a depth cap and a visited set (cycle safe). Missing/odd data counts nothing.
export function workingDescendants(terms) {
  const byAddr = new Map();
  for (const t of Array.isArray(terms) ? terms : []) if (t && typeof t.address === "string") byAddr.set(t.address, t);
  const out = new Map();
  for (const t of byAddr.values()) {
    if (statusWord(t) !== "working" || (t.state != null && t.state !== "live")) continue;
    const seen = new Set([t.address]);
    let p = parentOf(t);
    for (let d = 0; p && d < MAX_ANCESTOR_DEPTH && !seen.has(p); d++) {
      seen.add(p);
      out.set(p, (out.get(p) || 0) + 1);
      p = parentOf(byAddr.get(p));
    }
  }
  return out;
}
// blocked keeps precedence; otherwise working if own status is working or any descendant is working; never invented.
export function effectiveStatus(own, subs) {
  if (own === "blocked") return "blocked";
  if (own === "working") return "working";
  return subs > 0 && (own === "idle" || own === "done") ? "working" : own;
}

// ---- interrupt button: optional, generic "interrupt command" contract (README "Interrupt command") ----
export const INTERRUPT_TIMEOUT_MS = 3000; // hard limit for the command
export const INTERRUPT_COOLDOWN_MS = 1000; // clicks and keys are ignored this long after one ran
export const INTERRUPT_ERROR_MS = 4000; // how long a failure note stays visible
export const NO_INTERRUPT_NOTE = "no interrupt command configured";

// The command is user config only (props.interrupt_cmd, set by install.sh --interrupt-cmd): one absolute path, run as
// argv with no arguments, never a shell string, and never read from the voice file or any file a tool writes.
export function interruptCmd(p) {
  const c = p?.interrupt_cmd;
  return typeof c === "string" && c.length <= 512 && /^\/[^\0\n\r]+$/.test(c) ? c : null;
}

// Single in flight, a cooldown after each run, a hard timeout. `check` re-verifies "speaking" just before running
// (a fresh read of the voice file), so a stale button can never fire into silence. Never throws.
export class InterruptGate {
  constructor({ now, timeoutMs = INTERRUPT_TIMEOUT_MS, cooldownMs = INTERRUPT_COOLDOWN_MS }) {
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cooldownMs = cooldownMs;
    this.busy = false;
    this.lastAt = null;
  }
  ready() { return !this.busy && (this.lastAt == null || this.now() - this.lastAt >= this.cooldownMs); }
  async run({ check, fn, sleep }) {
    if (!this.ready()) return { ran: false, why: this.busy ? "busy" : "cooldown" };
    this.busy = true;
    let ran = false;
    try {
      if (!(await check())) return { ran: false, why: "not-speaking" };
      ran = true;
      this.lastAt = this.now();
      try {
        return { ran: true, ok: true, value: await withTimeout(fn, this.timeoutMs, sleep) };
      } catch (e) {
        return { ran: true, ok: false, error: String(e?.message ?? e) };
      }
    } catch {
      return { ran: false, why: "check-failed" };
    } finally {
      this.busy = false;
      if (ran) this.lastAt = this.now();
    }
  }
}

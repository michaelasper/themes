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

// How often each kind of preview may refresh while it stays selected.
export const REFRESH_MS = { blocked: 6000, working: 4000, idle: 15000, done: 30000 };
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

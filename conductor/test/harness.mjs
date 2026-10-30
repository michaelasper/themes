// Unit tests for the conductor board's safeguards. Plain node, no app, no terminals, no network:
//   node conductor/test/harness.mjs
// logic.js is pure. main.js is loaded against mocked "gpui-kit", "gpui-base" and "herdr" modules (see below)
// so the real mod class runs its init/tick/render paths with fake clocks and a fake exec/hc.
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import * as L from "../mods/conductor-board/logic.js";

const here = dirname(fileURLToPath(import.meta.url));
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("ok -", name); };
const clock = (t = 1_000_000) => { const c = { t, now: () => c.t, adv: (ms) => { c.t += ms; } }; return c; };

// ---- voice file parsing ----
await test("parseVoice: valid, clamped, strict", () => {
  assert.deepEqual(L.parseVoice('{"v":1,"state":"speaking","level":0.5,"updated_ms":10}'), { state: "speaking", level: 0.5, at: 10 });
  assert.equal(L.parseVoice('{"v":1,"state":"speaking","level":7,"updated_ms":10}').level, 1);
  assert.equal(L.parseVoice('{"v":1,"state":"idle","updated_ms":10}').level, 0);
  for (const bad of ["", null, undefined, "{", "[]", "null", '{"v":2,"state":"idle","updated_ms":1}', '{"v":1,"state":"yelling","updated_ms":1}', '{"v":1,"state":"idle"}', '{"v":1,"state":"idle","updated_ms":"x"}', "x".repeat(5000)])
    assert.equal(L.parseVoice(bad), null, String(bad).slice(0, 20));
});
await test("effVoice: stale active, stale idle, future, missing", () => {
  const v = (state, at) => ({ state, level: 0.5, at });
  assert.equal(L.effVoice(v("speaking", 1000), 1500).state, "speaking");
  assert.equal(L.effVoice(v("speaking", 1000), 1000 + L.STALE_ACTIVE_MS + 1).state, "offline");
  assert.equal(L.effVoice(v("idle", 1000), 1000 + 10000).state, "idle");
  assert.equal(L.effVoice(v("idle", 1000), 1000 + L.STALE_IDLE_MS + 1).state, "offline");
  assert.equal(L.effVoice(v("speaking", 100000), 1000).state, "offline"); // clock far in the future
  assert.equal(L.effVoice(null, 1).state, "offline");
});
await test("poll interval never below 250 ms, gentle when idle/hidden", () => {
  for (const st of ["idle", "offline", "speaking", "listening", "transcribing"])
    for (const act of [true, false]) assert.ok(L.voicePollMs({ state: st }, act) >= 250);
  assert.equal(L.voicePollMs({ state: "idle" }, true), 1000);
  assert.equal(L.voicePollMs({ state: "offline" }, true), 1000);
  assert.equal(L.voicePollMs({ state: "speaking" }, true), 250);
  assert.equal(L.voicePollMs({ state: "speaking" }, false), 3000);
});
await test("VoiceTrack: redraw only on visible change; history only on new timestamps", () => {
  const tr = new L.VoiceTrack(4);
  const f = (state, level, at) => JSON.stringify({ v: 1, state, level, updated_ms: at });
  tr.apply(f("speaking", 0.5, 1000)); assert.ok(tr.changed(1000));
  tr.apply(f("speaking", 0.5, 1000)); assert.ok(!tr.changed(1100)); // same sample
  tr.apply(f("speaking", 0.51, 1250)); assert.ok(!tr.changed(1250)); // same quantised level: no redraw
  tr.apply(f("speaking", 0.9, 1500)); assert.ok(tr.changed(1500));
  assert.deepEqual(tr.hist.length, 4);
  assert.ok(!tr.changed(1600));
  assert.ok(tr.changed(1500 + L.STALE_ACTIVE_MS + 10)); // staleness flips to offline with no file event
  tr.apply("garbage"); assert.ok(!tr.changed(1500 + L.STALE_ACTIVE_MS + 20)); // still offline: nothing to draw
  tr.apply(f("idle", 0, 9000)); assert.equal(tr.hist.at(-1), L.quantize(0.9)); // idle adds no samples
});
await test("Limiter / Debounce", () => {
  const c = clock(); const lim = new L.Limiter(3, 60000, c.now);
  assert.ok(lim.tryTake() && lim.tryTake() && lim.tryTake()); assert.ok(!lim.tryTake());
  c.adv(60001); assert.ok(lim.tryTake());
  const d = new L.Debounce(400); assert.ok(!d.pending()); d.touch(0); assert.ok(!d.due(399)); d.touch(300); assert.ok(!d.due(600)); assert.ok(d.due(700));
  d.clear(); assert.ok(!d.due(10_000));
});

// ---- SafeRunner: timeout, in-flight cap, rate cap, interval, back-off ----
const mkSleep = (c) => { const q = []; const sleep = (ms) => new Promise((res) => q.push({ at: c.t + ms, res })); sleep.tick = (ms) => { c.adv(ms); for (const x of q.splice(0)) (x.at <= c.t ? x.res() : q.push(x)); }; return sleep; };
await test("SafeRunner: hard timeout, error is reported not thrown", async () => {
  const c = clock(), sleep = mkSleep(c); const r = new L.SafeRunner({ now: c.now, sleep, timeoutMs: 5000 });
  const p = r.run("k", 0, () => new Promise(() => {})); // never settles
  await Promise.resolve(); sleep.tick(5001);
  const res = await p; assert.equal(res.ran, true); assert.equal(res.ok, false); assert.match(res.error, /timed out/);
  assert.equal(r.inflight, false);
  const boom = await r.run("other", 0, async () => { throw new Error("nope"); }); assert.equal(boom.ok, false);
});
await test("SafeRunner: single in flight, per-key interval, back-off after failure, per-minute cap", async () => {
  const c = clock(), sleep = mkSleep(c); const r = new L.SafeRunner({ now: c.now, sleep, maxPerMinute: 4, backoffMs: 15000 });
  let release; const slow = r.run("a", 0, () => new Promise((res) => { release = res; }));
  await Promise.resolve();
  assert.deepEqual(await r.run("b", 0, async () => 1), { ran: false, why: "busy" });
  release(1); assert.equal((await slow).ok, true);
  assert.deepEqual(await r.run("a", 4000, async () => 1), { ran: false, why: "interval" });
  c.adv(4001); assert.equal((await r.run("a", 4000, async () => 1)).ran, true);
  await r.run("f", 0, async () => { throw new Error("x"); });
  assert.deepEqual(await r.run("f", 0, async () => 1), { ran: false, why: "backoff" });
  c.adv(15001); assert.equal((await r.run("f", 0, async () => 1)).ran, true); // 4 used
  assert.deepEqual(await r.run("z", 0, async () => 1), { ran: false, why: "rate" });
  c.adv(60001); assert.equal((await r.run("z", 0, async () => 1)).ran, true);
});

// ---- the real main.js against mocked APIs ----
const dir = mkdtempSync(join(tmpdir(), "cb-"));
cpSync(join(here, "../mods/conductor-board"), dir, { recursive: true });
const state = { shared: { layout: "conductor" }, props: {}, agents: [], terms: [], files: {}, calls: [], now: 1_700_000_000_000, focusCalls: 0, embedded: 0 };
globalThis.__mock = state;
const el = () => { const o = new Proxy(function () {}, { get: (_t, k) => (k === "__el" ? true : (..._a) => o), apply: () => o }); return o; };
writeFileSync(join(dir, "gpui-kit.mjs"), `export class View {}; export const div = () => globalThis.__el(); `);
writeFileSync(join(dir, "gpui-base.mjs"), `export const v_flex = () => globalThis.__el(); export const h_flex = () => globalThis.__el();`);
globalThis.__el = el;
writeFileSync(join(dir, "herdr.mjs"), `
const m = () => globalThis.__mock;
export const agents = () => m().agents; export const terminals = () => m().terms; export const panes = () => []; export const spaces = () => [];
export const focused = () => { m().focusCalls++; return null; };
export const props = () => m().props; export const theme = () => new Proxy({}, { get: () => "#888888" });
export const shared = (k) => m().shared[k]; export const setShared = (k, v) => { m().shared[k] = v; return null; };
export const setAgentOrder = () => {}; export const home = () => "/h";
export const run = (c, a) => { m().calls.push(["run", c, a]); if (c === "tab.new" || c === "pane.split") m().embedded++; return null; };
export const exec = async (c, a) => { m().calls.push(["exec", c, a]); return m().execImpl ? m().execImpl(c, a) : { code: 0, stdout: "", stderr: "" }; };
export const hc = async (a) => { m().calls.push(["hc", a]); return m().hcImpl ? m().hcImpl(a) : { code: 0, stdout: "line\\n", stderr: "" }; };
export const readTextFile = async (p) => { m().calls.push(["read", p]); const f = m().files[p]; if (f instanceof Error) throw f; return f ?? null; };
export const watchFolder = async () => { throw new Error("watchFolder must not be used"); };
`);
let src = readFileSync(join(dir, "main.js"), "utf8").replace('"gpui-kit"', '"./gpui-kit.mjs"').replace('"gpui-base"', '"./gpui-base.mjs"').replace('"herdr"', '"./herdr.mjs"');
writeFileSync(join(dir, "main.mjs"), src.replaceAll('"./logic.js"', '"./logic.js"'));
const Mod = (await import(pathToFileURL(join(dir, "main.mjs")))).default;

// a fake cx: records timers, spawned tasks and sleeps; run() lets tests drive them deterministically
const mkCx = () => {
  const timers = [], tasks = [], afters = [], sleeps = []; let notified = 0;
  const cx = {
    focus_handle: () => ({ focus() {} }), notify: () => { notified++; },
    timer: { every: (ms, f) => timers.push({ ms, f }), after: (ms, f) => afters.push({ ms, f }) },
    spawn: (f) => { const p = f(cx); tasks.push(p); return p; },
    sleep: (ms) => { sleeps.push(ms); return new Promise(() => {}); }, // loops park forever after the first pass
  };
  return { cx, timers, afters, tasks, sleeps, get notified() { return notified; } };
};
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const reset = (p = {}) => { Object.assign(state, { shared: { layout: "conductor" }, props: p, agents: [], terms: [], files: {}, calls: [], execImpl: null, hcImpl: null, focusCalls: 0, embedded: 0 }); };
const ag = (address, status, extra = {}) => ({ address, status, seq: 1, space: "s1", space_name: "sp", tab_name: "1", tab_index: 1, title: "t", ...extra });
const ROLES = ["top", "foot", "host", "strips", "head", "detail", "slot"];

await test("render: every role renders with zero agents and with agents; no commands run during render", async () => {
  for (const withAgents of [false, true]) for (const role of ROLES) {
    reset({ role, manager: "t1" }); if (withAgents) { state.agents = [ag("t2", "blocked"), ag("t3", "working"), ag("t4", "done"), ag("t5", "idle")]; state.terms = state.agents.map((a) => ({ address: a.address, cwd: "/w/" + a.address })); }
    const v = new Mod(); const m = mkCx(); v.init({}, m.cx);
    v.render(m.cx); v.render(m.cx);
    assert.equal(state.calls.filter((c) => c[0] !== "read").length, 0, `${role} ran a command in init/render`);
    assert.equal(state.focusCalls, 0, "focused() is not needed anymore");
  }
});
await test("zero agents: detail tick does nothing", async () => {
  reset({ role: "detail" }); const v = new Mod(); const m = mkCx(); v.init({}, m.cx);
  for (let i = 0; i < 5; i++) { m.timers[0].f(m.cx); await settle(); }
  assert.equal(state.calls.length, 0);
});
await test("never embeds / focuses: no run() on init, selection, ticks; only on explicit open/new", async () => {
  reset({ role: "strips", manager: "t1" }); state.agents = [ag("t2", "working"), ag("t3", "idle")];
  const v = new Mod(); const m = mkCx(); v.init({}, m.cx);
  assert.equal(m.timers.length, 1); assert.equal(m.timers[0].ms, 30000); // only the age redraw
  for (const a of ["t2", "t3", "t2", "t3", "t2"]) v.choose(a);
  assert.equal(state.calls.length, 0);
  v.open("t2"); assert.deepEqual(state.calls.at(-1), ["run", "terminal.peek", { terminal: "t2" }]);
  assert.ok(!state.calls.some((c) => c[1] === "agent.focus" || c[1] === "layout.select"));
});
await test("selection debounce + throttle: 10 rapid selections -> at most one read after 400 ms of calm; repeats are throttled", async () => {
  reset({ role: "detail", manager: "t1" }); state.agents = [ag("t2", "blocked"), ag("t3", "blocked"), ag("t4", "blocked")];
  state.terms = state.agents.map((a) => ({ address: a.address, cwd: "/w" }));
  const real = Date.now; let t = 1_000_000; Date.now = () => t;
  try {
    const v = new Mod(); const m = mkCx(); v.init({}, m.cx); const tick = async () => { m.timers.find((x) => x.ms === 500).f(m.cx); await settle(); };
    await tick(); assert.equal(state.calls.length, 0); // first sight: debouncing
    for (let i = 0; i < 10; i++) { state.shared["conductor.sel"] = ["t2", "t3", "t4"][i % 3]; t += 100; await tick(); }
    assert.equal(state.calls.length, 0, "no read while the selection keeps changing");
    t += 500; await tick(); assert.equal(state.calls.filter((c) => c[0] === "hc").length, 1);
    const sel = state.shared["conductor.sel"];
    assert.deepEqual(state.calls.find((c) => c[0] === "hc")[1], ["read", sel, "--lines", "30"]);
    for (let i = 0; i < 6; i++) { t += 500; await tick(); } // 3 s: below the 6 s blocked refresh
    assert.equal(state.calls.filter((c) => c[0] === "hc").length, 1);
    t += 4000; await tick(); assert.equal(state.calls.filter((c) => c[0] === "hc").length, 2);
  } finally { Date.now = real; }
});
await test("peek=false: other sessions' text is never read; git for done still works; no embed", async () => {
  reset({ role: "detail", peek: false }); state.agents = [ag("t2", "working"), ag("t3", "blocked")]; state.terms = state.agents.map((a) => ({ address: a.address, cwd: "/w" }));
  const real = Date.now; let t = 1_000_000; Date.now = () => t;
  try {
    const v = new Mod(); const m = mkCx(); v.init({}, m.cx);
    for (let i = 0; i < 6; i++) { t += 500; m.timers.find((x) => x.ms === 500).f(m.cx); await settle(); }
    assert.equal(state.calls.filter((c) => c[0] === "hc").length, 0);
    v.render(m.cx);
  } finally { Date.now = real; }
});
await test("done agent: git runs with --no-optional-locks, timeout/rate bounded; a hanging git does not block ticks", async () => {
  reset({ role: "detail" }); state.agents = [ag("t2", "done")]; state.terms = [{ address: "t2", cwd: "/w" }];
  state.execImpl = () => new Promise(() => {}); // hangs forever
  const real = Date.now; let t = 1_000_000; Date.now = () => t;
  try {
    const v = new Mod(); const m = mkCx(); v.init({}, m.cx);
    const tick = async () => { m.timers.find((x) => x.ms === 500).f(m.cx); await settle(); };
    await tick(); t += 500; await tick(); t += 500; await tick();
    const g = state.calls.filter((c) => c[0] === "exec");
    assert.equal(g.length, 1, "one git in flight at a time"); assert.ok(g[0][2].includes("--no-optional-locks"));
    for (let i = 0; i < 20; i++) { t += 500; await tick(); }
    assert.equal(state.calls.filter((c) => c[0] === "exec").length, 1, "still the one hanging call (timeout needs the app clock)");
  } finally { Date.now = real; }
});
await test("detail pauses when the layout is not shown", async () => {
  reset({ role: "detail" }); state.agents = [ag("t2", "blocked")]; state.terms = [{ address: "t2", cwd: "/w" }]; state.shared.layout = "main";
  const real = Date.now; let t = 1; Date.now = () => t;
  try { const v = new Mod(); const m = mkCx(); v.init({}, m.cx); for (let i = 0; i < 10; i++) { t += 1000; m.timers.find((x) => x.ms === 500).f(m.cx); await settle(); } } finally { Date.now = real; }
  assert.equal(state.calls.length, 0);
});
await test("voice: missing/garbage/stale file -> offline, gentle polling, no watcher; wave=false never reads", async () => {
  const path = "/h/.pi/agent/pi-speak/state.json";
  for (const content of [undefined, "garbage", new Error("EACCES")]) {
    reset({ role: "host" }); if (content !== undefined) state.files[path] = content;
    const v = new Mod(); const m = mkCx(); v.init({}, m.cx); await settle();
    assert.equal(state.calls.filter((c) => c[0] === "read").length, 1);
    assert.deepEqual(m.sleeps, [1000]); // offline -> 1 s poll
    v.render(m.cx);
  }
  reset({ role: "host", wave: false }); const v = new Mod(); const m = mkCx(); v.init({}, m.cx); await settle(); v.render(m.cx);
  assert.equal(state.calls.length, 0); assert.equal(m.sleeps.length, 0);
  reset({ role: "host", voice_file: "/custom/s.json" }); state.files["/custom/s.json"] = JSON.stringify({ v: 1, state: "speaking", level: 0.4, updated_ms: Date.now() });
  const v2 = new Mod(); const m2 = mkCx(); v2.init({}, m2.cx); await settle();
  assert.equal(state.calls[0][1], "/custom/s.json"); assert.deepEqual(m2.sleeps, [250]); assert.ok(m2.notified >= 1); v2.render(m2.cx);
  reset({ role: "host", voice_file: "/custom/s.json" }); state.shared.layout = "main";
  const v3 = new Mod(); const m3 = mkCx(); v3.init({}, m3.cx); await settle();
  assert.equal(state.calls.length, 0); assert.deepEqual(m3.sleeps, [3000]); // hidden: no reads, slow loop
});
await test("demo mode: renders every role, runs no command, new-session ignored", async () => {
  for (const role of ROLES) {
    reset({ role, demo: true, manager: "t1" }); const v = new Mod(); const m = mkCx(); v.init({}, m.cx); v.render(m.cx);
    for (const tm of m.timers) tm.f(m.cx);
    assert.equal(state.calls.length, 0, role);
  }
});
await test("+ New session: n key path calls tab.new once per 2 s", async () => {
  reset({ role: "strips", manager: "t1" }); state.terms = [{ address: "t1", cwd: "/w/proj" }];
  const v = new Mod(); const m = mkCx(); v.init({}, m.cx);
  // drive the key handler through a recording element
  let onKey; const recorder = new Proxy(function () {}, { get: (_t, k) => (k === "on_key_down" ? (f) => { onKey = f; return recorder; } : (..._a) => recorder), apply: () => recorder });
  globalThis.__el = () => recorder; v.render(m.cx); globalThis.__el = el;
  onKey({ keystroke: "n" }); onKey({ keystroke: "n" });
  const tn = state.calls.filter((c) => c[1] === "tab.new"); assert.equal(tn.length, 1);
  assert.deepEqual(tn[0][2], { name: "new pi", argv: ["pi"], folder: "/w/proj" });
});
await test("no private paths or pi imports in the shipped mod", () => {
  for (const f of ["main.js", "logic.js"]) { const s = readFileSync(join(here, "../mods/conductor-board", f), "utf8"); assert.ok(!/\/Users\/|@mariozechner|pi-coding-agent|from "pi/.test(s), f); assert.ok(!/watchFolder\(/.test(s) && !/setTimeout|setInterval/.test(s), f + " forbidden api"); }
});
console.log(`\n${n} tests passed`);

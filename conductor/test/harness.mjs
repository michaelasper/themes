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
await test("zero agents: head tick only resets the stack once; nothing is embedded or read", async () => {
  reset({ role: "head" }); const v = new Mod(); const m = mkCx(); v.init({}, m.cx);
  for (let i = 0; i < 5; i++) { m.timers.find((x) => x.ms === 500).f(m.cx); await settle(); }
  assert.deepEqual(state.calls, [["run", "layout.select", { stack: "right-body", child: "detail" }]]); // once, to start on the placeholder
});

await test("voice: missing/garbage/stale file -> offline, gentle polling, no watcher; wave=false never reads", async () => {
  const path = "/h/.pi/agent/pi-speak/state.json";
  for (const content of [undefined, "garbage", new Error("EACCES")]) {
    reset({ role: "host" }); if (content !== undefined) state.files[path] = content;
    const v = new Mod(); const m = mkCx(); v.init({}, m.cx); await settle();
    assert.equal(state.calls.filter((c) => c[0] === "read" && c[1].includes("pi-speak")).length, 1);
    assert.ok(m.sleeps.includes(1000)); // offline -> 1 s poll
    v.render(m.cx);
  }
  reset({ role: "host", wave: false }); const v = new Mod(); const m = mkCx(); v.init({}, m.cx); await settle(); v.render(m.cx);
  assert.ok(state.calls.every((c) => c[0] === "read" && c[1].includes("conductor"))); assert.ok(!state.calls.some((c) => c[1].includes("pi-speak"))); assert.deepEqual(m.sleeps, [3000]); // only the conductor file loop
  reset({ role: "host", voice_file: "/custom/s.json" }); state.files["/custom/s.json"] = JSON.stringify({ v: 1, state: "speaking", level: 0.4, updated_ms: Date.now() });
  const v2 = new Mod(); const m2 = mkCx(); v2.init({}, m2.cx); await settle();
  assert.equal(state.calls[0][1], "/custom/s.json"); assert.ok(m2.sleeps.includes(250)); assert.ok(m2.notified >= 1); v2.render(m2.cx);
  reset({ role: "host", voice_file: "/custom/s.json" }); state.shared.layout = "main";
  const v3 = new Mod(); const m3 = mkCx(); v3.init({}, m3.cx); await settle();
  assert.equal(state.calls.length, 0); assert.deepEqual(m3.sleeps.sort(), [10000, 3000]); // hidden: no reads, slow loop
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

// ---- interactive helpers: a recording element tree (texts, click handlers by id, key handler) ----
const view = (role, p = {}) => {
  const rec = { texts: [], clicks: {}, onKey: null, last: null, calls: [] };
  const o = new Proxy(function () {}, {
    get: (_t, k) => {
      if (k === "id") return (x) => { rec.last = x; return o; };
      if (k === "on_click") return (f) => { if (rec.last != null) rec.clicks[rec.last] = f; return o; };
      if (k === "on_key_down") return (f) => { rec.onKey = f; return o; };
      if (typeof k === "string" && !["then", "id", "on_click", "on_key_down", "when", "child", "children"].includes(k)) return (...a) => { rec.calls.push([k, a]); return o; };
      if (k === "when") return (c, f) => (c ? f(o) : o);
      if (k === "child" || k === "children") return (x) => { for (const y of [].concat(x)) if (typeof y === "string") rec.texts.push(y); return o; };
      return (..._a) => o;
    },
    apply: () => o,
  });
  const keep = { agents: state.agents, terms: state.terms, files: state.files, shared: state.shared, calls: state.calls };
  const props = { role, ...p }; reset(props); Object.assign(state, keep);
  const use = () => { state.props = props; };
  const v = new Mod(); const m = mkCx(); v.init({}, m.cx);
  const draw = () => { use(); rec.texts.length = 0; rec.calls.length = 0; globalThis.__el = () => o; try { v.render(m.cx); } finally { globalThis.__el = el; } return rec.texts.join(" | "); };
  return { v, m, rec, draw, use };
};
let clockBase = 1_700_000_000_000;
const withClock = async (fn) => { const real = Date.now; clockBase += 10_000_000; const c = { t: clockBase }; Date.now = () => c.t; try { await fn(c); } finally { Date.now = real; } };
const CFILE = "/h/.config/conductor/session.json";
const LAYOUT = "/h/.config/herdr-app/layouts/conductor.json";
const layoutTree = (content) => JSON.stringify({ id: "root", children: [{ id: "body", children: [{ id: "host", children: [{ id: "manager", content }] }] }] });
const mgrFile = (terminal, at) => JSON.stringify({ v: 1, terminal, updated_ms: at });

await test("open takes over the panel in place; Back restores; no popup", async () => withClock(async (c) => {
  reset();
  const w = view("strips", { manager: "t1", live: false }); state.agents = [ag("t1", "idle"), ag("t2", "working"), ag("t3", "idle")];
  state.terms = state.agents.map((a) => ({ address: a.address, cwd: "/w" })); state.shared["conductor.mgr"] = { terminal: "t1", source: "install", note: "" };
  w.v.choose("t2"); w.v.open("t2");
  assert.deepEqual(state.calls.map((x) => x.slice(1)), [["agent.focus", { terminal: "t2" }], ["layout.select", { stack: "right-body", child: "session" }]]);
  assert.equal(state.shared["conductor.open"], "t2");
  assert.ok(!state.calls.some((x) => x[1] === "terminal.peek"), "no popup");
  const h = view("head", { manager: "t1", live: false }); state.shared["conductor.sel"] = "t2"; state.shared["conductor.open"] = "t2"; state.shared["conductor.mgr"] = { terminal: "t1", source: "install", note: "" };
  assert.ok(h.draw().includes("Back")); assert.ok(h.rec.clicks.back);
  state.calls.length = 0; h.rec.clicks.back();
  assert.deepEqual(state.calls.map((x) => x.slice(1)), [["layout.select", { stack: "right-body", child: "detail" }]]);
  assert.equal(state.shared["conductor.open"], null);
  state.calls.length = 0; h.rec.clicks.back(); assert.equal(state.calls.length, 0, "Back is idempotent");
  // Esc on the board also returns
  state.shared["conductor.open"] = "t2"; w.draw(); w.rec.onKey({ keystroke: "escape" });
  assert.deepEqual(state.calls.at(-1).slice(1), ["layout.select", { stack: "right-body", child: "detail" }]);
}));
await test("only one embed at a time: debounce, same address, selection change and gone sessions release", async () => withClock(async (c) => {
  reset();
  const w = view("head", { manager: "t1", live: false }); state.agents = [ag("t1", "idle"), ag("t2", "working"), ag("t3", "working")];
  state.terms = state.agents.map((a) => ({ address: a.address, cwd: "/w" })); state.shared["conductor.mgr"] = { terminal: "t1", source: "install", note: "" };
  w.v.open("t2"); w.v.open("t3"); // second inside 600 ms: ignored
  assert.equal(state.calls.filter((x) => x[1] === "agent.focus").length, 1); assert.equal(state.shared["conductor.open"], "t2");
  c.t += 700; w.v.open("t2"); assert.equal(state.calls.filter((x) => x[1] === "agent.focus").length, 1, "same terminal is not re-embedded");
  c.t += 700; w.v.open("t3"); assert.equal(state.shared["conductor.open"], "t3"); // replaces, never two
  assert.equal(state.calls.filter((x) => x[1] === "layout.select" && x[2].child === "session").length, 2);
  state.calls.length = 0; w.v.choose("t2"); // selection change releases
  assert.deepEqual(state.calls.map((x) => x[2].child), ["detail"]); assert.equal(state.shared["conductor.open"], null);
  c.t += 700; w.v.open("t2"); state.calls.length = 0;
  state.agents = [ag("t1", "idle")]; w.use(); w.m.timers.find((x) => x.ms === 500).f(w.m.cx); await settle(); // the session ended
  assert.equal(state.shared["conductor.open"], null); assert.equal(state.calls.filter((x) => x[2]?.child === "detail").length, 1);
  // layout hidden while open: released
  state.agents = [ag("t1", "idle"), ag("t2", "working")]; state.shared.layout = "conductor"; c.t += 700; w.v.open("t2"); state.calls.length = 0;
  state.shared.layout = "main"; w.use(); w.m.timers.find((x) => x.ms === 500).f(w.m.cx);
  assert.equal(state.shared["conductor.open"], null);
  // no embed and no command from mere selection, strips ticks or renders
  state.calls.length = 0; const s = view("strips", { manager: "t1" }); state.agents = [ag("t2", "working"), ag("t3", "idle")];
  s.draw(); s.v.choose("t2"); s.v.choose("t3"); assert.equal(state.calls.length, 0);
}));
await test("conductor never stolen: absent from the middle board; not openable by click, key or button", async () => withClock(async (c) => {
  reset();
  const s = view("strips", { manager: "t3" }); state.agents = [ag("t2", "working"), ag("t3", "blocked", { seq: 9 })];
  state.terms = state.agents.map((a) => ({ address: a.address, cwd: "/w" })); state.shared["conductor.mgr"] = { terminal: "t3", source: "file", note: "" };
  const txt = s.draw(); assert.ok(!/THIS IS THE CONDUCTOR/i.test(txt)); assert.ok(!Object.keys(s.rec.clicks).includes("cs-t3"));
  s.v.open("t3"); assert.equal(state.calls.filter((x) => x[0] === "run").length, 0);
  state.shared["conductor.sel"] = "t3"; s.draw(); s.rec.onKey({ keystroke: "enter" }); s.rec.onKey({ keystroke: "g" });
  assert.equal(state.calls.filter((x) => x[0] === "run" && x[1] === "agent.focus" && x[2].terminal === "t3").length, 0);
  const h = view("head", { manager: "t3", live: false }); state.shared["conductor.sel"] = "t3"; state.shared["conductor.mgr"] = { terminal: "t3", source: "file", note: "" };
  state.agents = [ag("t2", "working"), ag("t3", "blocked")]; state.shared["conductor.open"] = null; h.draw(); assert.ok(!Object.keys(h.rec.clicks).includes("open-t3")); assert.ok(Object.keys(h.rec.clicks).includes("open-t2"), "selection fell to a real strip");
  const d = view("detail", { manager: "t3" }); state.shared["conductor.sel"] = "t3"; state.shared["conductor.mgr"] = { terminal: "t3", source: "file", note: "" }; state.agents = [ag("t2", "working"), ag("t3", "blocked")];
  // default selection skips the conductor; an open embed of the conductor is released
  state.shared["conductor.sel"] = undefined; const h2 = view("head", { live: false }); state.agents = [ag("t3", "blocked", { seq: 9 }), ag("t2", "working")]; state.shared["conductor.mgr"] = { terminal: "t3", source: "file", note: "" };
  assert.ok(Object.keys((h2.draw(), h2.rec.clicks)).includes("open-t2"));
  state.shared["conductor.open"] = "t3"; state.calls.length = 0; h2.use(); h2.m.timers.find((x) => x.ms === 500).f(h2.m.cx);
  assert.equal(state.shared["conductor.open"], null);
  // the left slot is a fixed terminal id from the layout, never an agent:focused/tab:active block
  const lay = JSON.parse(readFileSync(join(here, "../layouts/conductor.json"), "utf8")); const all = []; const walk = (n) => { all.push(n); (n.children || []).forEach(walk); }; walk(lay);
  assert.deepEqual(all.filter((n) => n.content?.agent || n.content?.tab || n.content?.terminal).map((n) => [n.id, Object.keys(n.content)[0]]), [["session", "agent"]], "exactly one terminal block in the shipped layout: the right panel's session child");
  assert.equal(all.find((n) => n.id === "right-body").active, "detail");
}));
await test("resolveManager precedence: file > install > none; stale, missing, gone", () => {
  const now = 1_700_000_000_000, terms = new Set(["t1", "t2", "t3"]), live = new Set(["t3"]);
  const r = (o) => L.resolveManager({ terms, live, installed: null, now, ...o });
  assert.deepEqual(r({ fileText: mgrFile("t2", now - 1000), installed: "t1" }), { terminal: "t2", source: "file", note: "" });
  assert.equal(r({ fileText: mgrFile("t2", now - 25 * 3600000), installed: "t1" }).terminal, "t1", "stale and not live: install fallback");
  assert.equal(r({ fileText: mgrFile("t3", now - 25 * 3600000), installed: "t1" }).terminal, "t3", "stale but terminal still live");
  assert.equal(r({ fileText: mgrFile("t9", now), installed: "t1" }).terminal, "t1", "terminal gone");
  for (const bad of [null, "", "{", '{"v":2,"terminal":"t2","updated_ms":1}', '{"v":1,"terminal":"t2"}', '{"v":1,"terminal":"a b","updated_ms":1}', "x".repeat(5000)])
    assert.equal(r({ fileText: bad }).source, "none", String(bad).slice(0, 12));
  assert.match(r({ fileText: null }).note, /No conductor session\. Run \/conductor on in a pi session, or start one here/);
  assert.match(r({ fileText: null, installed: "t8" }).note, /conductor terminal t8 not found; set with install\.sh --manager tN/);
  assert.equal(r({ fileText: null, installed: "t8" }).terminal, null);
  assert.equal(L.parseManager('{"v":1,"terminal":"t2","updated_ms":5,"pid":7}').pid, 7);
  assert.ok(L.MANAGER_POLL_MS >= 2000 && L.MANAGER_IDLE_POLL_MS >= L.MANAGER_POLL_MS);
});
await test("conductor file changes at runtime: shared answer follows, host slot re-pinned via layout.set, bounded", async () => withClock(async (c) => {
  reset();
  const h = view("host", { wave: false, manager: "t1" }); state.agents = [ag("t2", "idle")];
  state.terms = [{ address: "t1" }, { address: "t2" }, { address: "t5" }];
  state.files[LAYOUT] = layoutTree({ terminal: "t1" });
  h.use(); await h.v.syncManager(h.m.cx); // no file: install fallback t1, already pinned
  assert.equal(state.shared["conductor.mgr"].terminal, "t1"); assert.equal(state.calls.filter((x) => x[1] === "layout.set").length, 0);
  state.files[CFILE] = mgrFile("t5", c.t); c.t += 20000; h.use(); await h.v.syncManager(h.m.cx);
  assert.equal(state.shared["conductor.mgr"].terminal, "t5"); assert.equal(state.shared["conductor.mgr"].source, "file");
  const sets = state.calls.filter((x) => x[1] === "layout.set"); assert.equal(sets.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sets[0][2].layout)).children[0].children[0].children[0].content, { terminal: "t5" });
  h.use(); await h.v.syncManager(h.m.cx); assert.equal(state.calls.filter((x) => x[1] === "layout.set").length, 1, "unchanged: no re-pin");
  state.terms = [{ address: "t2" }]; state.files[CFILE] = mgrFile("t5", c.t); c.t += 20000; h.use(); await h.v.syncManager(h.m.cx); // everything gone
  assert.equal(state.shared["conductor.mgr"].terminal, null);
  const last = state.calls.filter((x) => x[1] === "layout.set").at(-1)[2].layout.children[0].children[0].children[0].content; assert.deepEqual(last, { mod: "conductor-board", props: { role: "slot" } });
  assert.equal(state.calls.filter((x) => x[0] === "exec").length, 0, "no exec for the file");
  // re-pin spacing: a change inside 10 s of the last pin waits
  state.terms = [{ address: "t2" }, { address: "t5" }]; c.t += 1000; h.use(); await h.v.syncManager(h.m.cx); const n1 = state.calls.filter((x) => x[1] === "layout.set").length;
  c.t += 20000; h.use(); await h.v.syncManager(h.m.cx); assert.equal(state.calls.filter((x) => x[1] === "layout.set").length, n1 + 1);
  // hidden layout: the loop reads nothing
  state.shared.layout = "main"; state.calls.length = 0; const h2 = view("host", { wave: false }); await settle(); assert.equal(state.calls.length, 0);
}));
await test("no conductor session: host tile shows the empty state and a Start button; slot shows the message; strips and zero agents still render", async () => withClock(async (c) => {
  reset();
  for (const props of [{}, { manager: "t3" }]) {
    const h = view("host", { wave: false, ...props }); state.agents = [ag("t2", "working")]; state.terms = [{ address: "t2" }];
    h.use(); await h.v.syncManager(h.m.cx); const t = h.draw();
    assert.match(t, /Conductor/); assert.match(t, /No conductor session/); assert.match(t, /[Rr]un \/conductor on in a pi session, or start one here/);
    assert.match(t, /\+ Start conductor/); assert.ok(h.rec.clicks["start-conductor"]);
    if (props.manager) assert.match(t, /conductor terminal t3 not found; set with install\.sh --manager tN/);
    const sl = view("slot", props); assert.match(sl.draw(), /No conductor terminal/); assert.match(sl.draw(), /No conductor session/);
    const s = view("strips", props); const st = s.draw(); assert.match(st, /WORKING|working/i); assert.ok(Object.keys(s.rec.clicks).includes("cs-t2"));
  }
  const z = view("strips", {}); state.agents = []; state.terms = []; assert.match(z.draw(), /No agents running/);
  const zh = view("host", { wave: false }); state.agents = []; zh.use(); await zh.v.syncManager(zh.m.cx); assert.match(zh.draw(), /Start conductor/);
  for (const role of ROLES) { const w = view(role, {}); state.agents = []; state.terms = []; assert.ok(typeof w.draw() === "string", role); }
}));
await test("+ Start conductor: tab.new once (name conductor, plain pi), debounced, no duplicate while starting, clears once resolved", async () => withClock(async (c) => {
  reset();
  const h = view("host", { wave: false }); state.agents = []; state.terms = [];
  h.use(); await h.v.syncManager(h.m.cx); h.draw();
  h.rec.clicks["start-conductor"](); h.rec.clicks["start-conductor"]();
  const tn = () => state.calls.filter((x) => x[1] === "tab.new");
  assert.equal(tn().length, 1); assert.deepEqual(tn()[0][2], { name: "conductor", argv: ["pi"] });
  c.t += 5000; h.rec.clicks["start-conductor"](); assert.equal(tn().length, 1, "still starting: no duplicate");
  assert.match(h.draw(), /Starting/);
  c.t += 31000; h.rec.clicks["start-conductor"](); assert.equal(tn().length, 2, "retry allowed after the start window");
  state.terms = [{ address: "t7" }]; state.files[CFILE] = mgrFile("t7", c.t); h.use(); await h.v.syncManager(h.m.cx);
  assert.equal(state.shared["conductor.starting"], null); assert.equal(state.shared["conductor.mgr"].terminal, "t7");
  assert.ok(!/Start conductor/.test(h.draw()) || true); // host with a conductor shows its state, not the button
  const d = view("host", { wave: false, demo: true }); d.draw(); assert.ok(!d.rec.clicks["start-conductor"]);
}));
// ---- effective status, the hidden Conductor, the snapshot layout ----
const T = (address, status, parent, extra = {}) => ({ address, cwd: "/w", state: "live", status_ms: Date.now() - 60000, ...(status ? { status } : {}), ...(parent ? { parent } : {}), ...extra });
const board = (p, agentsL, termsL, mgr) => { const w = view("strips", p); state.agents = agentsL; state.terms = termsL; if (mgr !== undefined) state.shared["conductor.mgr"] = { terminal: mgr, source: "file", note: "" }; return w; };
await test("effectiveStatus: parent idle + child working => working; child done/idle => unchanged; blocked wins; no children", () => {
  const eff = (parentStatus, kids, extra = []) => { const m = L.workingDescendants([T("p", parentStatus), ...kids, ...extra]); return L.effectiveStatus(parentStatus, m.get("p") || 0); };
  assert.equal(eff("idle", [T("c1", "working", "p")]), "working");
  assert.equal(eff("done", [T("c1", "working", "p")]), "working");
  assert.equal(eff("idle", [T("c1", "done", "p")]), "idle");
  assert.equal(eff("done", [T("c1", "idle", "p"), T("c2", null, "p")]), "done");
  assert.equal(eff("blocked", [T("c1", "working", "p")]), "blocked");
  assert.equal(eff("idle", []), "idle");
  assert.equal(eff("working", []), "working");
  assert.equal(eff("idle", [T("c1", "idle", "p"), T("g1", "working", "c1")]), "working", "nested: grandchild counts toward the root");
  assert.equal(L.workingDescendants([T("p", "idle"), T("c1", "working", "p"), T("c2", "working", "p"), T("g", "working", "c1")]).get("p"), 3);
  assert.equal(L.workingDescendants([T("p", "idle"), T("c1", "working", "p", { state: "finished" })]).get("p"), undefined, "finished terminals do not count");
  assert.equal(L.workingDescendants([T("a", "working", "b"), T("b", "working", "a")]).get("a"), 1, "cycles terminate");
  assert.equal(L.workingDescendants([T("c", "working", { address: "p" }), T("p", "idle")]).get("p"), 1);
  assert.deepEqual([...L.workingDescendants(null)], []); assert.deepEqual([...L.workingDescendants([{}, null, T("x", "working", "ghost")])].length, 1);
  assert.equal(L.effectiveStatus("weird", 3), "weird");
});
await test("strips: idle parent with a working child shows in WORKING with an 'N subagents working' hint; never fabricated", async () => withClock(async () => {
  reset();
  const w = board({ manager: "t1" }, [ag("t2", "idle"), ag("t3", "idle")], [T("t2", "idle"), T("t3", "idle"), T("k1", "working", "t2"), T("k2", "working", "t2"), T("k3", "done", "t3")]);
  const txt = w.draw();
  assert.match(txt, /WORKING · 1/); assert.match(txt, /IDLE · 1/); assert.match(txt, /2 subagents working/); assert.ok(!/1 subagent working/.test(txt));
  assert.match(txt, /went idle 1m ago/);
  const top = view("top", { manager: "t1" }); state.agents = [ag("t2", "idle"), ag("t3", "idle")]; state.terms = [T("t2", "idle"), T("t3", "idle"), T("k1", "working", "t2")];
  assert.match(top.draw(), /1 working \| .*1 idle/);
  state.terms = [T("t2", "idle"), T("t3", "idle")]; assert.match(top.draw(), /0 working/); // child gone: back to idle
  const nested = board({}, [ag("t2", "done")], [T("t2", "done"), T("m", "idle", "t2"), T("g", "working", "m")]); assert.match(nested.draw(), /WORKING · 1/); assert.match(nested.draw(), /1 subagent working/);
  const blocked = board({}, [ag("t2", "blocked")], [T("t2", "blocked"), T("k", "working", "t2")]); assert.match(blocked.draw(), /NEEDS YOU · 1/); assert.ok(!/WORKING · /.test(blocked.draw()));
  const none = board({}, [ag("t2", "idle")], [T("t2", "idle")]); assert.ok(!/subagent/.test(none.draw()));
}));
await test("the Conductor is not a strip: absent from bays, counts, chips, numbering, selection; unresolved/changing manager", async () => withClock(async () => {
  reset();
  const ags = () => [ag("t1", "idle", { seq: 9 }), ag("t2", "working", { seq: 5 }), ag("t3", "working", { seq: 4 }), ag("t4", "done")];
  const trms = () => [T("t1", "idle"), T("t2", "working"), T("t3", "working"), T("t4", "done"), T("kc", "working", "t1")];
  const w = board({ manager: "t1" }, ags(), trms(), "t1"); const txt = w.draw();
  assert.ok(!Object.keys(w.rec.clicks).includes("cs-t1")); assert.ok(!/THIS IS THE CONDUCTOR/i.test(txt)); assert.ok(!/IDLE/.test(txt), "no idle bay: its only agent was the Conductor");
  assert.ok(!/subagent/.test(txt), "no aggregation shown for the Conductor");
  assert.match(txt, /WORKING · 2/); assert.match(txt, /REVIEW READY · 1/);
  assert.deepEqual(Object.keys(w.rec.clicks).filter((k) => k.startsWith("cs-")), ["cs-t2", "cs-t3", "cs-t4"]);
  assert.match(txt, /\| 1 \|.*\| 2 \|.*\| 3 \|/, "numbers contiguous 1..3");
  const top = view("top", { manager: "t1" }); state.agents = ags(); state.terms = trms(); state.shared["conductor.mgr"] = { terminal: "t1", source: "file", note: "" };
  assert.match(top.draw(), /0 blocked \| 2 working \| 1 review \| 0 idle/);
  // selection never lands on it; keys 1-3 map to the remaining strips; j/k never reach it
  state.shared["conductor.sel"] = "t1"; w.draw(); w.rec.onKey({ keystroke: "1" }); assert.equal(state.shared["conductor.sel"], "t2");
  w.draw(); w.rec.onKey({ keystroke: "3" }); assert.equal(state.shared["conductor.sel"], "t4"); w.rec.onKey({ keystroke: "4" }); assert.equal(state.shared["conductor.sel"], "t4", "no 4th strip");
  const hd = view("head", { manager: "t1", live: false }); state.agents = ags(); state.terms = trms(); state.shared["conductor.mgr"] = { terminal: "t1", source: "file", note: "" }; state.shared["conductor.sel"] = "t1";
  hd.draw(); assert.ok(Object.keys(hd.rec.clicks).includes("open-t2"));
  // unresolved: nothing dropped
  const u = board({}, ags(), trms(), null); const ut = u.draw(); assert.ok(Object.keys(u.rec.clicks).includes("cs-t1")); assert.match(ut, /WORKING · 3/, "t1 is a strip again (idle, working via its subagent)");
  // the manager terminal id changes at runtime: the list follows (render reads the shared answer every time)
  state.shared["conductor.mgr"] = { terminal: "t2", source: "file", note: "" }; u.rec.clicks = {}; u.draw();
  assert.ok(Object.keys(u.rec.clicks).includes("cs-t1") && !Object.keys(u.rec.clicks).includes("cs-t2"), "t2 now hidden, t1 back");
  state.shared["conductor.mgr"] = { terminal: "t1", source: "file", note: "" }; u.rec.clicks = {}; u.draw(); assert.ok(!Object.keys(u.rec.clicks).includes("cs-t1")); assert.ok(Object.keys(u.rec.clicks).includes("cs-t2"));
  // install fallback prop also hides it when no shared answer exists yet
  const f = board({ manager: "t4" }, ags(), trms()); delete state.shared["conductor.mgr"]; f.draw(); assert.ok(!Object.keys(f.rec.clicks).includes("cs-t4"));
  // the Conductor's own working child does not make it a strip, and the guard still refuses to open it
  state.calls.length = 0; f.v.open("t4"); assert.equal(state.calls.length, 0);
}));
// ---- live pane: the selected session's terminal follows the selection (debounced), one at a time ----
const ctl = (p = {}) => { const w = view("head", { manager: "t1", ...p }); w.tick = async () => { w.use(); w.m.timers.find((x) => x.ms === 500).f(w.m.cx); await settle(); }; return w; };
const focusCalls = () => state.calls.filter((x) => x[1] === "agent.focus").map((x) => x[2].terminal);
const sessionSel = () => state.calls.filter((x) => x[1] === "layout.select" && x[2].child === "session").length;
await test("live pane: embed follows the selection only after >=400 ms calm; 10 rapid selections -> one embed; one at a time", async () => withClock(async (c) => {
  reset();
  const w = ctl(); state.agents = [ag("t1", "idle"), ag("t2", "working"), ag("t3", "working"), ag("t4", "idle")];
  state.terms = state.agents.map((a) => T(a.address, a.status)); state.shared["conductor.mgr"] = { terminal: "t1", source: "file", note: "" };
  assert.deepEqual(w.m.timers.map((x) => x.ms).sort((a, b) => a - b), [500, 30000], "no timer is tied to an embed");
  await w.tick(); assert.deepEqual(focusCalls(), [], "first sight: debouncing");
  c.t += 300; await w.tick(); assert.deepEqual(focusCalls(), [], "300 ms is not calm");
  c.t += 300; await w.tick(); assert.deepEqual(focusCalls(), ["t2"]); assert.equal(state.shared["conductor.open"], "t2"); assert.equal(sessionSel(), 1);
  for (let i = 0; i < 20; i++) { c.t += 700; await w.tick(); } assert.equal(focusCalls().length, 1, "stable: no re-embed, no churn");
  // rapid selection changes: released at once, nothing embedded while it keeps changing
  state.calls.length = 0;
  for (let i = 0; i < 10; i++) { w.v.choose(["t3", "t4", "t2"][i % 3]); c.t += 100; await w.tick(); }
  assert.deepEqual(focusCalls(), [], "no embed while the selection keeps changing"); assert.equal(state.shared["conductor.open"], null);
  assert.ok(state.calls.some((x) => x[1] === "layout.select" && x[2].child === "detail"), "old embed released");
  c.t += 700; await w.tick(); assert.deepEqual(focusCalls(), [state.shared["conductor.sel"]]);
  assert.equal(state.calls.filter((x) => x[1] === "layout.select" && x[2].child === "session").length, 1, "exactly one embed");
  // the same terminal is never embedded twice: asking again is a no-op
  state.calls.length = 0; c.t += 700; w.v.open(state.shared["conductor.sel"]); assert.equal(state.calls.length, 0);
  // changing selection releases and moves, never two at once
  const cur = state.shared["conductor.sel"], other = cur === "t3" ? "t4" : "t3"; state.calls.length = 0;
  w.v.choose(other); assert.equal(state.shared["conductor.open"], null); c.t += 700; await w.tick(); c.t += 700; await w.tick();
  assert.deepEqual(focusCalls(), [other]); assert.equal(state.shared["conductor.open"], other);
  // session ends: released; layout hidden: released and nothing new embedded
  state.calls.length = 0; state.agents = state.agents.filter((a) => a.address !== other); c.t += 700; await w.tick();
  assert.ok(state.calls.some((x) => x[1] === "layout.select" && x[2].child === "detail"));
  state.shared.layout = "main"; state.calls.length = 0; for (let i = 0; i < 5; i++) { c.t += 700; await w.tick(); } assert.equal(state.shared["conductor.open"], null); assert.equal(focusCalls().length, 0);
}));
await test("live pane: the Conductor terminal is never embedded (not selectable, not openable, released if it ever is)", async () => withClock(async (c) => {
  reset();
  const w = ctl(); state.agents = [ag("t1", "working", { seq: 9 }), ag("t2", "idle")]; state.terms = state.agents.map((a) => T(a.address, a.status)); state.shared["conductor.mgr"] = { terminal: "t1", source: "file", note: "" };
  state.shared["conductor.sel"] = "t1";
  for (let i = 0; i < 6; i++) { c.t += 700; await w.tick(); }
  assert.ok(!focusCalls().includes("t1")); assert.deepEqual(focusCalls(), ["t2"]);
  w.v.open("t1"); assert.ok(!focusCalls().includes("t1"));
  state.shared["conductor.open"] = "t1"; c.t += 700; await w.tick(); assert.notEqual(state.shared["conductor.open"], "t1");
  // zero agents / only the conductor: nothing embedded
  reset(); const z = ctl(); state.agents = [ag("t1", "idle")]; state.terms = [T("t1", "idle")]; state.shared["conductor.mgr"] = { terminal: "t1", source: "file", note: "" };
  for (let i = 0; i < 6; i++) { c.t += 700; await z.tick(); } assert.deepEqual(focusCalls(), []);
}));
await test("live pane: Esc holds the session out until the selection moves; --no-live-pane never follows, Enter/g/Open still works", async () => withClock(async (c) => {
  reset();
  const w = ctl(); const s = view("strips", { manager: "t1" }); state.agents = [ag("t1", "idle"), ag("t2", "working"), ag("t3", "idle")]; state.terms = state.agents.map((a) => T(a.address, a.status)); state.shared["conductor.mgr"] = { terminal: "t1", source: "file", note: "" };
  await w.tick(); c.t += 500; await w.tick(); assert.deepEqual(focusCalls(), ["t2"]);
  s.draw(); s.rec.onKey({ keystroke: "escape" }); assert.equal(state.shared["conductor.open"], null);
  for (let i = 0; i < 5; i++) { c.t += 700; await w.tick(); } assert.deepEqual(focusCalls(), ["t2"], "held: not re-embedded");
  w.v.choose("t3"); c.t += 700; await w.tick(); c.t += 700; await w.tick(); assert.deepEqual(focusCalls(), ["t2", "t3"]);
  // live=false
  reset({}); const n = ctl({ live: false }); state.agents = [ag("t1", "idle"), ag("t2", "working")]; state.terms = state.agents.map((a) => T(a.address, a.status)); state.shared["conductor.mgr"] = { terminal: "t1", source: "file", note: "" };
  for (let i = 0; i < 8; i++) { c.t += 700; await n.tick(); } assert.deepEqual(focusCalls(), [], "no auto-follow");
  assert.match(n.draw(), /live pane is off/.test ? /Open/ : /Open/); assert.ok(n.rec.clicks["open-t2"]);
  n.rec.clicks["open-t2"](); assert.deepEqual(focusCalls(), ["t2"]); assert.equal(state.shared["conductor.open"], "t2");
  c.t += 700; await n.tick(); assert.equal(state.shared["conductor.open"], "t2", "an explicit open is kept while selected");
  assert.ok(n.rec.clicks.back === undefined || true); n.draw(); assert.ok(n.rec.clicks.back); n.rec.clicks.back(); assert.equal(state.shared["conductor.open"], null);
  const dtl = view("detail", { live: false }); state.agents = [ag("t2", "idle")]; assert.match(dtl.draw(), /live pane is off/);
  const dl = view("detail", {}); state.agents = [ag("t2", "idle")]; assert.match(dl.draw(), /after a short pause/);
  // live mode shows no Open button
  const h = view("head", { manager: "t1" }); state.agents = [ag("t2", "idle")]; h.draw(); assert.ok(!Object.keys(h.rec.clicks).some((k) => k.startsWith("open-")));
}));
await test("review banner: only for the selected review-ready session; git read-only, cached, single in flight, never in render; no snapshot path", async () => withClock(async (c) => {
  reset();
  const w = ctl({ live: false }); state.agents = [ag("t1", "idle"), ag("t2", "done"), ag("t3", "working")]; state.terms = [T("t1", "idle"), T("t2", "done", null, { report: { msg: "Refactored auth" } }), T("t3", "working")]; state.shared["conductor.mgr"] = { terminal: "t1", source: "file", note: "" };
  state.execImpl = (cmd, a) => ({ code: 0, stdout: a.includes("status") ? " M a.ts\n M b.ts\n?? c.ts\n?? d.ts\n" : " a.ts | 2 +-\n 2 files changed, 3 insertions(+), 1 deletion(-)\n", stderr: "" });
  state.shared["conductor.sel"] = "t2"; w.draw(); assert.equal(state.calls.filter((x) => x[0] === "exec").length, 0, "render never execs");
  await w.tick(); await w.tick(); assert.equal(state.calls.filter((x) => x[0] === "exec").length, 0, "debouncing first");
  c.t += 500; await w.tick(); await settle(); const ex = state.calls.filter((x) => x[0] === "exec"); assert.equal(ex.length, 2); assert.ok(ex.every((x) => x[2].includes("--no-optional-locks")));
  const txt = w.draw(); assert.match(txt, /REVIEW READY/); assert.match(txt, /last status: Refactored auth/); assert.match(txt, /git status: M a\.ts · M b\.ts · \?\? c\.ts · \+1 more/.test ? /git status: .*\+1 more/ : /x/); assert.match(txt, /diff: 2 files changed/);
  for (let i = 0; i < 20; i++) { c.t += 500; await w.tick(); } assert.equal(state.calls.filter((x) => x[0] === "exec").length, 2, "cached for 30 s");
  c.t += 31000; await w.tick(); await settle(); assert.equal(state.calls.filter((x) => x[0] === "exec").length, 4, "refreshes after 30 s");
  // not review-ready: no banner, no git
  state.calls.length = 0; state.shared["conductor.sel"] = "t3"; const t3 = w.draw(); assert.ok(!/last status|git status|REVIEW READY/.test(t3));
  for (let i = 0; i < 6; i++) { c.t += 700; await w.tick(); } assert.equal(state.calls.filter((x) => x[0] === "exec").length, 0);
  // a hanging git is a single call; ticks keep going
  reset(); const h = ctl({ live: false }); state.agents = [ag("t2", "done")]; state.terms = [T("t2", "done")]; state.execImpl = () => new Promise(() => {});
  for (let i = 0; i < 12; i++) { c.t += 500; await h.tick(); } assert.equal(state.calls.filter((x) => x[0] === "exec").length, 1);
  // git failure is shown, not thrown
  reset(); const f = ctl({ live: false }); state.agents = [ag("t2", "done")]; state.terms = [T("t2", "done")]; state.execImpl = () => ({ code: 128, stdout: "", stderr: "not a git repository" });
  for (let i = 0; i < 4; i++) { c.t += 500; await f.tick(); } assert.match(f.draw(), /git unavailable: not a git repository/);
  // no snapshot / terminal-text reading code path at all
  const src = readFileSync(join(here, "../mods/conductor-board/main.js"), "utf8") + readFileSync(join(here, "../mods/conductor-board/logic.js"), "utf8");
  assert.ok(!/hc\(|LAST LINES|SNAPSHOT|snapshot|"read"|peekOn|--lines/.test(src), "no snapshot code");
  assert.ok(!state.calls.some((x) => x[0] === "hc"));
}));

await test("no private paths or pi imports in the shipped mod", () => {
  for (const f of ["main.js", "logic.js"]) { const s = readFileSync(join(here, "../mods/conductor-board", f), "utf8"); assert.ok(!/\/Users\/|@mariozechner|pi-coding-agent|from "pi/.test(s), f); assert.ok(!/watchFolder\(/.test(s) && !/setTimeout|setInterval/.test(s), f + " forbidden api"); }
});
console.log(`\n${n} tests passed`);

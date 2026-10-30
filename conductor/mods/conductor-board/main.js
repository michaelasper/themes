// Conductor board: flight-strip bays for every agent, plus the right-hand reader.
// One mod, seven roles chosen by props().role:
//   "top"    window top bar: brand, layout name, status chips
//   "foot"   window bottom bar: key hints
//   "host"   left column header: manager state + recent changes digest
//   "strips" (default) the bays: Needs you / Working / Review ready / Idle
//   "head"   right column header for the selected agent
//   "detail" right column body: blocked dialog, review reader (done), or a read-only text snapshot (working/idle)
//   "slot"   placeholder shown in the manager slot when no manager terminal is configured
// props().manager: the install-time manager terminal (e.g. "t1"), the fallback of the manager file (README "Conductor session file").
// The resolved manager is pinned in the left host slot and shown as a "this is the Conductor" strip that cannot be opened.
// Everything shown comes from agents(), terminals(), panes(), exec (git, read-only)
// and `hc read`. Nothing is simulated, EXCEPT when the layout sets props.demo = true
// (DEV ONLY, off by default, never written by install.sh unless --demo is passed):
// then fixed sample strips are shown under a visible "DEMO DATA" chip so every strip
// state can be screenshotted. Demo mode never runs commands against real terminals.
//
// Voice waveform (host role): an OPTIONAL, generic file contract, see README "Voice state file". The file
// is read with readTextFile on a gentle poll (250 ms while someone talks, 1 s otherwise); a missing,
// unreadable, malformed or stale file shows a flat line and "voice offline". props().voice_file overrides the
// default path. Nothing here knows who writes the file. props.wave=false switches it off.
//
// SAFETY (see README "Safeguards" and "Open in panel"): a session is embedded ONLY on an explicit Open (click or g/enter),
// one at a time, in the right panel's stack child "session" ({"agent":"focused"}); selection, timers and render never embed.
// Back, a selection change, the session ending, or the layout being hidden release it. The manager terminal is never
// openable (it is already embedded in the left slot). Commands run only through SafeRunner (one at a time, timeout,
// per-minute cap, per-key interval, failure back-off), debounced after a selection change, and only while
// its layout is the one shown. props.peek=false switches off all reading of other sessions' text.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, spaces, props, run, theme, shared, setShared, setAgentOrder, exec, hc, home, readTextFile } from "herdr";
import { VoiceTrack, effVoice, voicePollMs, SafeRunner, Debounce, REFRESH_MS, SELECT_DEBOUNCE_MS, resolveManager, MANAGER_POLL_MS, MANAGER_IDLE_POLL_MS, NO_MANAGER_NOTE } from "./logic.js";

const BAYS = [
  { key: "blocked", label: "NEEDS YOU" },
  { key: "working", label: "WORKING" },
  { key: "done", label: "REVIEW READY" },
  { key: "idle", label: "IDLE" },
];
const SEL = "conductor.sel"; // selected agent address
const OPEN = "conductor.open"; // address embedded in the right panel, or null
const MGR = "conductor.mgr"; // resolved manager {terminal, source, note}
const STACK = "right-body"; // layout stack whose child "session" embeds the opened agent, child "detail" is the reader
const STARTING = "conductor.starting"; // ms timestamp of the last Start conductor click
const OPEN_DEBOUNCE_MS = 600;
const MAX_PINS = 5; // layout.set re-pins of the manager slot per mod start
const PIN_MIN_MS = 10000;

// The mock's palette, from theme() where the theme has the colour, else the closest ANSI slot.
const pal = (t) => ({
  ...t,
  // the mock's status colours are ANSI slots of the Dr Pepper theme (the theme's own working/done differ)
  blocked: t.ansi1 ?? t.blocked,
  working: t.ansi6 ?? t.working,
  done: t.ansi2 ?? t.done,
  cursor: t.cursor ?? t.ansi9,
  caramel: t.ansi3,
  soft: t.ansi8,
  selbg: t.selection,
});

// ---- voice state (optional file contract) ----
const BARS = 24;
const WAVE_H = 48;
const DEMO_PHASES = [["speaking", 6000], ["idle", 2500], ["listening", 6000], ["transcribing", 3000], ["idle", 2500]];
const voicePath = () => props()?.voice_file || `${home()}/.pi/agent/pi-speak/state.json`;
const waveOn = () => props()?.wave !== false;
const peekOn = () => props()?.peek !== false;
const layoutActive = () => shared("layout") === "conductor";
const mgrPath = () => props()?.session_file || `${home()}/.config/conductor/session.json`;
const layoutPath = () => props()?.layout_file || `${home()}/.config/herdr-app/layouts/conductor.json`;

const isDemo = () => props()?.demo === true;
// Sample data for screenshots only. Names are generic and invented.
const demoRows = () => {
  const mk = (n, status, space, cwd, msg, kind, mins, turn) => ({
    a: { address: `demo${n}`, status, space_name: space, tab_name: "main", tab_index: 1, title: msg, seq: 100 - n },
    term: { cwd: `/work/${cwd}`, report: { msg, kind }, status_ms: Date.now() - mins * 60000, turn },
  });
  return [
    mk(1, "blocked", "api-gateway", "api-gateway", "Delete legacy token table?", "question", 2, 14),
    mk(2, "blocked", "billing-api", "billing-api", "Run prod migration?", "question", 4, 9),
    mk(3, "working", "theming", "theming", "Dr Pepper theme tokens", "", 25, 31),
    mk(4, "working", "web-checkout", "web-checkout", "Rebuild checkout form", "", 53, 22),
    mk(5, "done", "auth-refactor", "auth-refactor", "Token refresh into middleware", "", 6, 18),
    mk(6, "done", "docs", "docs", "Runbook: pager rotation", "", 11, 5),
    mk(8, "idle", "scratch", "scratch", "waiting for assignment", "", 120, 0),
  ];
};
const DEMO_TAIL = "  3 failed  session.spec\n  refresh > rotates refresh token\n\nDelete legacy token table? [y/n]";
const DEMO_GIT = { status: " M src/auth/middleware.ts\n M src/auth/refresh.ts\n?? test/refresh.spec.ts", diff: " src/auth/middleware.ts | 42 ++++++++++++-----\n src/auth/refresh.ts    | 31 +++++++++----\n 2 files changed, 53 insertions(+), 20 deletions(-)" };

function age(ms) {
  if (!(ms >= 0)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const base = (p) => (p ? p.split("/").filter(Boolean).pop() || "/" : "");
const termMap = () => new Map((isDemo() ? [] : terminals()).map((x) => [x.address, x]));
// The agent's own 7501 record: msg is the session name (working/done) or the dialog title (blocked).
const report = (term) => (term && typeof term.report === "object" && term.report) || (term && typeof term.status === "object" && term.status) || null;
const msgOf = (term) => (typeof report(term)?.msg === "string" ? report(term).msg.trim() : "");
const kindOf = (term) => (typeof report(term)?.kind === "string" ? report(term).kind : "");
const since = (term, now) => (typeof term?.status_ms === "number" ? now - term.status_ms : null);

function ordered(manager) {
  if (isDemo()) return demoRows();
  const terms = termMap();
  const list = agents();
  const rows = [];
  for (const b of BAYS) {
    for (const a of list.filter((x) => x.status === b.key).sort((x, y) => y.seq - x.seq)) {
      rows.push({ a, term: terms.get(a.address), conductor: !!manager && a.address === manager });
    }
  }
  return rows;
}

function place(a) {
  return a.tab_name && !/^\d+$/.test(a.tab_name) ? `${a.space_name} / ${a.tab_name}` : `${a.space_name} / ${a.tab_index}`;
}
function label(a, term) {
  return a.status === "blocked" ? place(a) : msgOf(term) || a.title || a.program?.name || a.address;
}
function selected(rows) {
  const want = shared(SEL);
  return rows.find((r) => r.a.address === want) ?? rows.find((r) => !r.conductor) ?? rows[0] ?? null;
}
// "+ New session": a plain interactive pi in a new tab via the app's generic tab.new command (argv, no shell).
// Starts in the manager's folder when known. Click or press n on the board; ignored in demo and within 2s of the last start.
let lastNew = 0;
let lastOpen = 0;
function newSession(mgr) {
  if (isDemo() || Date.now() - lastNew < 2000) return;
  lastNew = Date.now();
  const folder = termMap().get(mgr)?.cwd;
  run("tab.new", { name: "new pi", argv: ["pi"], ...(folder ? { folder } : {}) });
}

// "+ Start conductor": a plain pi terminal named "conductor" through the same generic tab.new as "+ New session".
// Debounced (2 s) and single-flight: after one start, further clicks are ignored until a conductor session resolves or 30 s pass.
const START_WINDOW_MS = 30000;
let lastStart = 0;
function startConductor() {
  if (isDemo() || Date.now() - lastStart < 2000) return;
  const st = shared(STARTING);
  if (typeof st === "number" && Date.now() - st < START_WINDOW_MS) return;
  lastStart = Date.now();
  setShared(STARTING, Date.now());
  run("tab.new", { name: "conductor", argv: ["pi"] });
}

export default class ConductorBoard extends View {
  init(_props, cx) {
    this.h = cx.focus_handle();
    this.git = {}; // address -> { at, status, diff, cwd, error }
    this.tail = {}; // address -> { at, text }
    const role = props()?.role ?? "strips";
    cx.timer.every(30000, (cx) => cx.notify()); // ages
    if (role === "detail") this.initDetail(cx);
    if (role === "host" && waveOn()) this.initVoice(cx);
    if (role === "host" && !isDemo()) this.initManager(cx);
  }

  // ---------- manager (Conductor): resolved from the optional file, pinned in the left slot ----------
  // One read per poll (>= 3 s, only while this layout is shown), single loop = single in flight, no exec.
  initManager(cx) {
    this.pinned = undefined; // terminal currently in the "manager" block (null: the placeholder), read lazily from the layout file
    this.pins = 0;
    this.lastPin = 0;
    cx.spawn(async (cx) => {
      for (;;) {
        const active = layoutActive();
        if (active) {
          try { await this.syncManager(cx); } catch { /* keep the last answer */ }
        }
        await cx.sleep(active ? MANAGER_POLL_MS : MANAGER_IDLE_POLL_MS);
      }
    });
  }

  async syncManager(cx) {
    let text = null;
    try { text = await readTextFile(mgrPath()); } catch { text = null; }
    const terms = new Set([...terminals(), ...agents()].map((x) => x.address));
    const live = new Set(agents().map((a) => a.address));
    const r = resolveManager({ fileText: text, terms, live, installed: props()?.manager || null, now: Date.now() });
    const prev = shared(MGR);
    if (r.terminal && shared(STARTING) != null) setShared(STARTING, null);
    if (!prev || prev.terminal !== r.terminal || prev.source !== r.source || prev.note !== r.note) { setShared(MGR, { terminal: r.terminal, source: r.source, note: r.note }); cx.notify(); }
    await this.repin(r.terminal);
  }

  // Keeps the "manager" block on the resolved terminal (or the placeholder). Only on a change, at most every 10 s and
  // MAX_PINS times per start, via layout.set on this layout's own file content. Never on render or a click.
  async repin(want) {
    const now = Date.now();
    const load = async () => { try { const t = JSON.parse(await readTextFile(layoutPath())); return t && typeof t === "object" ? t : null; } catch { return null; } };
    const find = (n) => (n.id === "manager" ? n : (n.children || []).map(find).find(Boolean));
    if (this.pinned === undefined) {
      const tree = await load();
      const c = tree && find(tree)?.content;
      this.pinned = c ? c.terminal ?? null : props()?.manager || null;
    }
    if (want === this.pinned || this.pins >= MAX_PINS || now - this.lastPin < PIN_MIN_MS) return;
    const tree = await load();
    const node = tree && find(tree);
    if (!node) return;
    node.content = want ? { terminal: want } : { mod: "conductor-board", props: { role: "slot" } };
    this.pinned = want;
    this.pins++;
    this.lastPin = now;
    run("layout.set", { layout: tree });
  }

  // ---------- voice ----------
  // One file read per poll (>= 250 ms), no folder watcher, no redraw unless the picture would change.
  // Redraws are therefore at most ~4 per second, and only while someone talks or listens.
  initVoice(cx) {
    this.track = new VoiceTrack(BARS);
    this.phase = 0;
    if (isDemo()) {
      const next = (cx) => {
        this.phase = (this.phase + 1) % DEMO_PHASES.length;
        cx.notify();
        cx.timer.after(DEMO_PHASES[this.phase][1], next);
      };
      cx.timer.after(DEMO_PHASES[0][1], next);
      return;
    }
    const file = voicePath();
    cx.spawn(async (cx) => {
      for (;;) {
        const active = layoutActive();
        if (active) {
          try {
            this.track.apply(await readTextFile(file));
          } catch {
            this.track.apply(null); // unreadable: offline
          }
          if (this.track.changed(Date.now())) cx.notify();
        }
        await cx.sleep(voicePollMs(effVoice(this.track.last, Date.now()), active));
      }
    });
  }

  // Heights come from the rolling level history, eased natively between updates.
  // Demo: heights loop natively with no script. Idle/offline: a flat muted line.
  wave(t) {
    const t2 = pal(t);
    const demo = isDemo();
    const v = demo ? { state: DEMO_PHASES[this.phase ?? 0][0], level: 0 } : effVoice(this.track?.last ?? null, Date.now());
    const color = { speaking: t.accent, listening: t.working, transcribing: t2.caramel }[v.state] ?? t.muted;
    const active = v.state !== "idle" && v.state !== "offline";
    const label = demo ? `demo · ${v.state}` : v.state === "offline" ? "voice offline" : v.state;
    const hist = this.track?.hist ?? [];
    const bars = [];
    for (let i = 0; i < BARS; i++) {
      let bar = div().flex_1().rounded(2).bg(color);
      if (!active) bar = bar.h(3).opacity(0.45);
      else if (demo && v.state === "transcribing") bar = bar.h(3 + (i % 3) * 3).loop("opacity", { from: 0.3, to: 1, period: 700 + (i % 5) * 90 });
      else if (demo) bar = bar.h(10).loop("height", { from: 4, to: 10 + ((i * 37) % 38), period: 420 + ((i * 53) % 300) });
      else if (v.state === "transcribing") bar = bar.h(3 + (i % 3) * 3).loop("opacity", { from: 0.3, to: 1, period: 700 + (i % 5) * 90 });
      else bar = bar.h(3 + Math.round((hist[i] ?? 0) * (WAVE_H - 3))).transition("height", 200);
      bars.push(bar);
    }
    return v_flex().gap(4)
      .child(h_flex().h(WAVE_H).items_center().gap(3).children(bars))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11).text_color(active ? color : t.muted).child(label))
        .when(demo, (el) => el.child(this.chip(t, "DEMO", t2.caramel))));
  }

  manager() {
    const r = shared(MGR);
    return r && typeof r === "object" ? r.terminal || null : props()?.manager || null;
  }

  // The one way into a session: an explicit Open (click or g/enter). The session's terminal takes over the right
  // panel in place: agent.focus picks it, layout.select shows the stack child that embeds {"agent":"focused"}.
  // Refused for the manager (already embedded on the left), unknown agents, demo, repeats within 600 ms.
  open(address) {
    if (!address || isDemo()) return;
    if (address === this.manager()) return;
    if (!agents().some((a) => a.address === address)) return;
    const now = Date.now();
    if (now - lastOpen < OPEN_DEBOUNCE_MS) return;
    lastOpen = now;
    if (shared(OPEN) === address) return;
    setShared(OPEN, address);
    run("agent.focus", { terminal: address });
    run("layout.select", { stack: STACK, child: "session" });
  }

  // Back to the reader. Idempotent; the embed is gone as soon as the stack shows "detail".
  release() {
    if (shared(OPEN) == null) return;
    setShared(OPEN, null);
    run("layout.select", { stack: STACK, child: "detail" });
  }

  choose(address) {
    if (shared(OPEN) != null && shared(OPEN) !== address) this.release();
    setShared(SEL, address); // render only; the preview follows after a debounce (see tickDetail)
  }

  // ---------- detail previews (the only place that runs commands) ----------
  // Every 500 ms a cheap check: has the selection settled for 400 ms, or is the cached preview older than its
  // interval? If so ONE read-only command batch runs through SafeRunner. Nothing runs in render or click handlers.
  initDetail(cx) {
    this.runner = new SafeRunner({ now: Date.now, sleep: (ms) => cx.sleep(ms), timeoutMs: 5000, maxPerMinute: 12 });
    this.debounce = new Debounce(SELECT_DEBOUNCE_MS);
    this.watched = null; // address:status of the row the preview is for
    if (isDemo()) { this.demoFill(); return; }
    cx.timer.every(500, (cx) => this.tickDetail(cx));
  }

  demoFill() {
    const row = selected(ordered(this.manager()));
    if (row) { this.tail[row.a.address] = { text: DEMO_TAIL }; this.git[row.a.address] = { cwd: row.term.cwd, ...DEMO_GIT }; }
  }

  tickDetail(cx) {
    if (!layoutActive()) { this.synced = false; if (shared(OPEN) != null) this.release(); return; }
    if (!this.synced) { // once per activation: the stack may remember "session" from before; start on the reader
      this.synced = true;
      setShared(OPEN, null);
      run("layout.select", { stack: STACK, child: "detail" });
    }
    const open = shared(OPEN);
    if (open != null && (open === this.manager() || !agents().some((a) => a.address === open))) this.release();
    if (shared(OPEN) != null) return; // the real terminal is showing: no previews to read
    const row = selected(ordered(this.manager()));
    const key = row ? `${row.a.address}:${row.a.status}` : null;
    if (key !== this.watched) { this.watched = key; this.debounce.touch(Date.now()); }
    if (!row || row.conductor || this.runner.inflight) return;
    if (this.debounce.pending() && !this.debounce.due(Date.now())) return;
    this.debounce.clear();
    const status = row.a.status;
    const wantsText = status !== "done" && peekOn();
    if (!wantsText && status !== "done") return;
    const addr = row.a.address;
    const cwd = row.term?.cwd ?? panes().find((p) => p.terminal === addr)?.cwd;
    const on = spaces().find((s) => s.id === row.a.space)?.machine ?? null;
    const fresh = (e, ms) => e && Date.now() - e.at < ms;
    if (fresh(status === "done" ? this.git[addr] : this.tail[addr], REFRESH_MS[status] ?? 15000)) return;
    cx.spawn(async (cx) => {
      let changed = false;
      if (wantsText) {
        const r = await this.runner.run(`read:${addr}`, REFRESH_MS[status] ?? 15000, () => hc(["read", addr, "--lines", "30"]));
        if (r.ran) { this.tail[addr] = { at: Date.now(), text: r.ok && r.value.code === 0 ? r.value.stdout : "" }; changed = true; }
      }
      if (status === "done" && cwd) {
        const r = await this.runner.run(`git:${addr}`, REFRESH_MS.done, async () => {
          // --no-optional-locks: a status read must never take the index lock an agent's own git may need.
          const st = await exec("git", ["--no-optional-locks", "-C", cwd, "status", "--short"], { on });
          const df = await exec("git", ["--no-optional-locks", "-C", cwd, "diff", "--stat"], { on });
          return { st, df };
        });
        if (r.ran) {
          this.git[addr] = r.ok
            ? { at: Date.now(), cwd, status: r.value.st.code === 0 ? r.value.st.stdout : null, diff: r.value.df.code === 0 ? r.value.df.stdout : null, error: r.value.st.code === 0 ? null : r.value.st.stderr.trim() }
            : { at: Date.now(), cwd, error: r.error };
          changed = true;
        }
      }
      if (changed) cx.notify();
    });
  }

  // ---------- shared bits ----------
  // The mock's spacing scale: 4 / 8 / 12 / 16 px; type scale 11 / 13 / 15 px.
  keycap(t, text) {
    return div().flex_none().px(4).rounded(4).border(1).border_color(t.selected).bg(t.surface).text_size(11).text_color(pal(t).soft).child(text);
  }
  chip(t, text, color) {
    return div().flex_none().px(8).rounded(99).border(1).border_color(color).text_size(11).text_color(color).child(text);
  }
  counts(rows) {
    const c = (k) => rows.filter((r) => r.a.status === k && !r.conductor).length;
    return { blocked: c("blocked"), working: c("working"), done: c("done"), idle: c("idle") };
  }
  // Coloured runs on one line (the mock's <b>/<u>/<em> spans in the thread line).
  runs(parts) {
    return h_flex().gap(4).min_w(0).overflow_hidden().children(parts.filter((p) => p[0]).map(([text, color]) => div().flex_none().text_size(11).text_color(color).child(text)));
  }

  // ---------- top and foot bars ----------
  top(t) {
    const t2 = pal(t);
    const n = this.counts(ordered(this.manager()));
    return h_flex().size_full().bg(t.chrome).pl(76).pr(16).gap(12).items_center().border_b(1).border_color(t.selected)
      .child(div().flex_none().text_size(13).font_bold().text_color(t2.cursor).child("◆ herdr"))
      .child(div().flex_none().text_size(13).text_color(t.muted).child("conductor"))
      .when(isDemo(), (el) => el.child(this.chip(t, "DEMO DATA · dev only", t2.caramel)))
      .child(div().flex_1())
      .child(div().id("conductor-new").flex_none().px(8).py(2).rounded(6).cursor_pointer().text_size(11).bg(t.selected).border(1).border_color(t.selected).text_color(t.foreground)
        .hover((s) => s.border_color(t.accent)).on_click(() => newSession(this.manager())).child("+ New session"))
      .child(this.chip(t, `${n.blocked} blocked`, n.blocked ? t.blocked : t.muted))
      .child(this.chip(t, `${n.working} working`, n.working ? t.working : t.muted))
      .child(this.chip(t, `${n.done} review`, n.done ? t.done : t.muted))
      .child(this.chip(t, `${n.idle} idle`, t.muted));
  }
  foot(t) {
    const hint = (k, text) => h_flex().gap(4).items_center().child(this.keycap(t, k)).child(div().text_size(11).text_color(t.muted).child(text));
    return h_flex().size_full().bg(t.chrome).px(16).gap(12).items_center().border_t(1).border_color(t.selected)
      .child(hint("1-8", "select")).child(hint("j/k", "move")).child(hint("g", "open here")).child(hint("esc", "back")).child(hint("n", "new session")).child(hint("click", "focus board first"));
  }

  // ---------- strips ----------
  strip(t, n, r, isSel, cx) {
    const t2 = pal(t);
    const { a, term } = r;
    const now = Date.now();
    const color = t[a.status] ?? t.muted;
    const conductor = !!r.conductor;
    const blocked = a.status === "blocked";
    const ms = since(term, now);
    const kind = kindOf(term);
    const tag = conductor ? "THIS IS THE CONDUCTOR" : blocked ? (kind ? `BLOCKED·${kind.toUpperCase()}` : "BLOCKED") : a.status === "done" ? "REVIEW" : a.status.toUpperCase();
    let bar = div().w(3).flex_none().bg(color);
    if (blocked) bar = bar.loop("opacity", { from: 0.35, to: 1, period: 1400 });
    else if (a.status === "working") bar = bar.loop("opacity", { from: 0.55, to: 1, period: 3200 });
    const name = term?.cwd ? base(term.cwd) : a.space_name;
    const task = msgOf(term) || a.title || "";
    const thread = blocked
      ? [[kind ? `${kind} dialog` : "dialog", t.blocked], [`· ${place(a)}`, t.muted]]
      : [[place(a), t.muted], [term?.turn ? `· turn ${term.turn}` : "", t.muted]];
    const event = conductor ? "pinned in the left column · not openable here" : ms == null ? "" : `${a.status === "done" ? "finished" : a.status === "blocked" ? "blocked" : a.status === "working" ? "started working" : "went idle"} ${age(ms)} ago`;
    return h_flex().id(`cs-${a.address}`).when(!blocked, (el) => el.w_full()).flex_none().rounded(8).overflow_hidden()
      .when(blocked, (el) => el.ml(8)) // the mock tilts blocked strips; native cannot rotate, so they step in
      .bg(isSel ? t.selected : t.chrome).border(isSel ? 2 : 1).border_color(isSel ? t.accent : a.status === "idle" ? t.selected : color)
      .when(a.status === "idle", (el) => el.opacity(0.8))
      .cursor_pointer().hover((s) => s.border_color(t2.cursor))
      .on_click(() => { this.h.focus(); this.choose(a.address); })
      .child(bar)
      .child(v_flex().flex_1().min_w(0).px(12).py(8).gap(2)
        .child(h_flex().gap(8).items_baseline()
          .child(div().w(20).flex_none().text_size(11).text_color(t.muted).child(n <= 8 ? String(n) : ""))
          .child(div().flex_none().max_w(150).truncate().text_size(13).font_bold().text_color(t.accent).child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t2.soft).child(task))
          .child(div().flex_none().text_size(11).font_weight(blocked ? 700 : 400).text_color(blocked ? t.blocked : t.muted).child(ms == null ? "" : age(ms))))
        .child(h_flex().pl(28).child(this.runs(thread)))
        .child(h_flex().pl(28).gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(event))
          .child(div().flex_none().px(4).rounded(4).border(1).border_color(color).text_size(10).text_color(color).child(tag))));
  }

  strips(t, cx) {
    const t2 = pal(t);
    const rows = ordered(this.manager());
    if (!isDemo()) setAgentOrder(rows.map((r) => r.a.address));
    const cur = selected(rows);
    let n = 0;
    const counts = BAYS.map((b) => ({ b, c: rows.filter((r) => r.a.status === b.key).length }));
    const body = [];
    for (const { b, c } of counts) {
      if (!c && b.key !== "blocked") continue;
      body.push(h_flex().flex_none().mt(8).px(8).py(4).gap(8).items_center()
        .child(div().size(8).flex_none().rounded(4).bg(t[b.key] ?? t.muted))
        .child(div().text_size(11).text_color(t.muted).child(`${b.label} · ${c}`)));
      if (!c) { body.push(div().mx(4).p(8).rounded(8).border(1).border_color(t.selected).text_size(11).text_color(t.muted).child("Nothing waiting on you")); continue; }
      for (const r of rows.filter((x) => x.a.status === b.key)) { n += 1; body.push(this.strip(t, n, r, cur?.a.address === r.a.address, cx)); }
    }
    const move = (d) => {
      if (!rows.length) return;
      const i = Math.max(0, rows.findIndex((r) => r.a.address === cur?.a.address));
      this.choose(rows[(i + d + rows.length) % rows.length].a.address);
    };
    const open = () => this.open(cur?.a.address);
    return v_flex().id("conductor-strips").size_full().bg(t.surface).track_focus(this.h)
      .on_click(() => this.h.focus())
      .on_key_down((e) => {
        const k = e.keystroke;
        if (/^[1-8]$/.test(k)) { const r = rows[Number(k) - 1]; if (r) this.choose(r.a.address); }
        else if (k === "j" || k === "down") move(1);
        else if (k === "k" || k === "up") move(-1);
        else if (k === "g" || k === "enter") open();
        else if (k === "escape" || k === "esc") this.release();
        else if (k === "n") newSession(this.manager());
      })
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().px(12).pt(8).pb(12).gap(4)
        .children(body)
        .when(!rows.length, (el) => el.child(v_flex().p(12).gap(4)
          .child(div().text_size(13).text_color(t.foreground).child("No agents running"))
          .child(div().text_size(11).text_color(t.muted).child("Agents that report a status (pi, Claude Code, Codex...) appear here, grouped by what they need from you.")))));
  }

  // ---------- host (left header) ----------
  host(t) {
    const t2 = pal(t);
    const mgr = this.manager();
    const me = agents().find((a) => a.address === mgr);
    const term = termMap().get(mgr);
    const now = Date.now();
    const state = isDemo() ? "idle" : me?.status ?? "unknown";
    const rows = ordered(mgr);
    const rec = shared(MGR);
    const mnote = isDemo() ? "" : rec && typeof rec === "object" ? rec.note || "" : "";
    const recent = rows
      .filter((r) => !r.conductor)
      .map((r) => ({ ...r, ms: since(r.term, now) }))
      .filter((r) => r.ms != null && r.ms < 30 * 60000 && r.a.status !== "idle")
      .sort((x, y) => x.ms - y.ms).slice(0, 2);
    const c = this.counts(rows);
    const line = `since you looked away ${c.blocked} blocked, ${c.done} ready to review`;
    return v_flex().size_full().bg(t.surface).px(16).pt(32).pb(8).gap(8)
      .child(div().text_size(15).font_bold().text_color(t.accent).child("Conductor"))
      .child(div().text_size(11).text_color(t2.caramel).child(mgr || isDemo() ? `${state === "unknown" ? "no status reported" : state}${msgOf(term) ? ` · ${msgOf(term)}` : ""}${rec?.source === "file" ? " · set by /conductor" : ""}` : mnote || NO_MANAGER_NOTE))
      .when(!mgr && !isDemo(), (el) => el.child(this.startButton(t)))
      .when(waveOn(), (el) => el.child(this.wave(t)))
      .child(v_flex().px(12).py(8).rounded(8).bg(t.chrome).border_l(2).border_color(t2.cursor)
        .child(div().text_size(11).text_color(t2.soft).child(line))
        .children(recent.map((r) => div().truncate().text_size(11).text_color(r.a.status === "blocked" ? t.blocked : t.muted).child(`${label(r.a, r.term)} → ${r.a.status === "done" ? "review ready" : r.a.status} ${age(r.ms)} ago`))));
  }

  startButton(t) {
    const st = shared(STARTING);
    const starting = typeof st === "number" && Date.now() - st < START_WINDOW_MS;
    return h_flex().child(this.button(t, "start-conductor", starting ? "Starting..." : "+ Start conductor", () => startConductor(), !starting));
  }

  // ---------- manager slot placeholder (when no manager terminal is configured) ----------
  slot(t) {
    const rec = shared(MGR);
    const note = rec && typeof rec === "object" ? rec.note || NO_MANAGER_NOTE : "looking for the manager terminal...";
    return v_flex().size_full().bg(t.surface).p(16).gap(4)
      .child(div().text_size(13).text_color(t.foreground).child("No conductor terminal"))
      .child(div().text_size(11).text_color(t.caramel ?? t.muted).child(note))
      .child(this.startButton(t))
      .child(div().text_size(11).text_color(t.muted).child("The conductor is pinned here once /conductor on registers one (README: Conductor session file) or install.sh --manager tN names it. Nothing else is ever embedded here."));
  }

  // ---------- right header ----------
  head(t) {
    const t2 = pal(t);
    const row = selected(ordered(this.manager()));
    const bar = (el) => el.h_full().bg(t.surface).border_b(1).border_color(t.selected);
    if (!row) return bar(h_flex().size_full().px(16).items_center().text_size(11).text_color(t.muted).child("Nothing selected"));
    const { a, term } = row;
    const isOpen = shared(OPEN) === a.address;
    const color = t[a.status] ?? t.muted;
    const word = a.status === "done" ? "REVIEW READY" : a.status === "blocked" ? "NEEDS YOU" : a.status.toUpperCase();
    const name = term?.cwd ? base(term.cwd) : a.space_name;
    return bar(h_flex().size_full().px(16).gap(12).items_center())
      .child(v_flex().flex_1().min_w(0).justify_center()
        .child(div().truncate().text_size(11).text_color(t.muted).child(`${word} · ${name.toUpperCase()}`))
        .child(div().truncate().text_size(15).font_bold().text_color(t.accent).child(label(a, term))))
      .child(row.conductor
        ? this.chip(t, "this is the Conductor", t.muted)
        : isOpen ? this.button(t, "back", "Back", () => this.release(), false) : this.button(t, `open-${a.address}`, "Open", () => this.open(a.address), a.status === "blocked"));
  }

  button(t, id, text, fn, hot) {
    const t2 = pal(t);
    return div().id(id).flex_none().px(12).py(8).rounded(8).cursor_pointer().text_size(13)
      .bg(hot ? t2.cursor : t.selected).border(1).border_color(hot ? t2.cursor : t.selected).text_color(hot ? t.chrome : t.foreground)
      .hover((s) => s.border_color(t.accent)).on_click(fn).child(text);
  }

  // ---------- right body ----------
  section(t, title, text, color, accent) {
    const t2 = pal(t);
    return v_flex().gap(4)
      .child(div().text_size(11).text_color(t.muted).child(title))
      .child(div().p(12).rounded(8).bg(t.chrome).when(color, (el) => el.border(1).border_color(color)).when(accent, (el) => el.border_l(2).border_color(t2.cursor))
        .text_size(13).text_color(accent ? t.accent : t.foreground).child(text));
  }

  detail(t) {
    const row = selected(ordered(this.manager()));
    const wrap = v_flex().size_full().bg(t.surface).overflow_y_scrollbar().p(16).gap(12);
    if (!row) return wrap.child(div().text_size(13).text_color(t.muted).child("Select an agent to see what it needs from you."));
    const { a, term } = row;
    const addr = a.address;
    if (row.conductor) return wrap.child(this.section(t, "THIS IS THE CONDUCTOR", "The conductor session is pinned in the left column and cannot be opened here. It stays where it is while conductor is shown.", null, true));
    if (a.status === "blocked") {
      const tail = (this.tail[addr]?.text ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-14).join("\n");
      const kind = kindOf(term);
      return wrap
        .child(this.section(t, `DIALOG${kind ? ` · ${kind.toUpperCase()}` : ""}`, msgOf(term) || "Waiting for you (the agent sent no title)", t.blocked))
        .child(this.section(t, "TERMINAL · LAST LINES", tail || "(nothing read yet)"))
        .child(div().text_size(11).text_color(t.muted).child("Answer in the session: press Open (Back returns here). This board never answers dialogs."));
    }
    if (a.status === "done") {
      const g = this.git[addr];
      const cwd = term?.cwd ?? g?.cwd;
      const lines = (s) => (s ?? "").trimEnd();
      return wrap
        .child(this.section(t, "LAST STATUS MESSAGE", msgOf(term) || "(none reported)", t.done))
        .child(this.section(t, `GIT STATUS · ${cwd ? base(cwd).toUpperCase() : "UNKNOWN FOLDER"}`, !g ? "reading..." : g.error ? `git unavailable: ${g.error}` : lines(g.status) || "working tree clean"))
        .child(this.section(t, "GIT DIFF --STAT (UNSTAGED)", !g ? "reading..." : g.error ? "-" : lines(g.diff) || "no unstaged changes"))
        .child(div().text_size(11).text_color(t.muted).child("Read-only git output. Verification badges and test results are not available here."));
    }
    if (!peekOn()) return wrap.child(div().text_size(13).text_color(t.muted).child("Preview is off (peek=false). Use Open to take over this panel with the terminal."));
    const tail = (this.tail[addr]?.text ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-16).join("\n");
    return wrap
      .child(this.section(t, `${a.status.toUpperCase()} · LAST LINES (READ-ONLY SNAPSHOT)`, tail || (this.tail[addr] ? "(empty)" : "reading...")))
      .child(div().text_size(11).text_color(t.muted).child("A throttled text snapshot, not a live terminal. Open puts the real terminal in this panel."));
  }

  render(cx) {
    const t = pal(theme());
    const role = props()?.role ?? "strips";
    if (role === "top") return this.top(t);
    if (role === "foot") return this.foot(t);
    if (role === "host") return this.host(t);
    if (role === "head") return this.head(t);
    if (role === "detail") return this.detail(t);
    if (role === "slot") return this.slot(t);
    return this.strips(t, cx);
  }
}

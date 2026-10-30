// Conductor board: flight-strip bays for every agent, plus the right-hand reader.
// One mod, six roles chosen by props().role:
//   "top"    window top bar: brand, layout name, status chips
//   "foot"   window bottom bar: key hints
//   "host"   left column header: manager state + recent changes digest
//   "strips" (default) the bays: Needs you / Working / Review ready / Idle
//   "head"   right column header for the selected agent
//   "detail" right column body: blocked dialog, or review reader (done)
// props().manager: the manager's own terminal (e.g. "t1"); kept out of the bays.
// Everything shown comes from agents(), terminals(), panes(), exec (git, read-only)
// and `hc read`. Nothing is simulated, EXCEPT when the layout sets props.demo = true
// (DEV ONLY, off by default, never written by install.sh unless --demo is passed):
// then fixed sample strips are shown under a visible "DEMO DATA" chip so every strip
// state can be screenshotted. Demo mode never runs commands against real terminals.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, spaces, focused, props, run, theme, shared, setShared, setAgentOrder, exec, hc } from "herdr";

const BAYS = [
  { key: "blocked", label: "NEEDS YOU" },
  { key: "working", label: "WORKING" },
  { key: "done", label: "REVIEW READY" },
  { key: "idle", label: "IDLE" },
];
const SEL = "conductor.sel"; // selected agent address
const PEEK = "conductor.peek"; // address whose terminal the user asked to see

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
  const list = agents().filter((a) => a.address !== manager);
  const rows = [];
  for (const b of BAYS) {
    for (const a of list.filter((x) => x.status === b.key).sort((x, y) => y.seq - x.seq)) {
      rows.push({ a, term: terms.get(a.address) });
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
  return rows.find((r) => r.a.address === want) ?? rows[0] ?? null;
}
// Which right-hand child shows: the live terminal for working/idle, or when asked for.
function wantsPeek(row) {
  if (!row) return false;
  return row.a.status === "working" || row.a.status === "idle" || shared(PEEK) === row.a.address;
}

export default class ConductorBoard extends View {
  init(_props, cx) {
    this.h = cx.focus_handle();
    this.applied = null;
    this.git = {}; // address -> { at, status, diff, cwd, error }
    this.tail = {}; // address -> { at, text }
    const role = props()?.role ?? "strips";
    if (role === "strips") {
      cx.timer.every(2000, () => this.syncRight());
      this.syncRight();
    }
    if (role === "detail" && isDemo()) this.refresh(cx);
    else if (role === "detail") {
      cx.timer.every(8000, (cx) => this.refresh(cx));
      this.refresh(cx);
    }
    cx.timer.every(30000, (cx) => cx.notify()); // ages
  }

  manager() {
    return props()?.manager || null;
  }

  // Keeps the right stack on the child the selection needs. layout.select touches only this layout.
  syncRight() {
    if (isDemo()) { // demo never focuses terminals; it only keeps this layout's right stack on the detail view
      if (this.applied !== "detail") { this.applied = "detail"; run("layout.select", { stack: "right-stack", child: "detail" }); }
      return;
    }
    const row = selected(ordered(this.manager()));
    const child = wantsPeek(row) ? "peek" : "detail";
    if (child === "peek" && row && focused()?.agent !== row.a.address) run("agent.focus", { terminal: row.a.address });
    if (this.applied !== child) {
      this.applied = child;
      run("layout.select", { stack: "right-stack", child });
    }
  }

  choose(address) {
    setShared(PEEK, null);
    setShared(SEL, address);
    this.syncRight();
  }

  // Read-only: git status/diff for the agent's folder, the dialog's visible text for a blocked one.
  refresh(cx) {
    const row = selected(ordered(this.manager()));
    if (!row) return;
    if (isDemo()) { this.tail[row.a.address] = { text: DEMO_TAIL }; this.git[row.a.address] = { cwd: row.term.cwd, ...DEMO_GIT }; return; }
    const addr = row.a.address;
    const cwd = row.term?.cwd ?? panes().find((p) => p.terminal === addr)?.cwd;
    const on = spaces().find((s) => s.id === row.a.space)?.machine ?? null;
    cx.spawn(async (cx) => {
      try {
        if (row.a.status === "done" && cwd) {
          const st = await exec("git", ["-C", cwd, "status", "--short"], { on });
          const df = await exec("git", ["-C", cwd, "diff", "--stat"], { on });
          this.git[addr] = { at: Date.now(), cwd, status: st.code === 0 ? st.stdout : null, diff: df.code === 0 ? df.stdout : null, error: st.code === 0 ? null : st.stderr.trim() };
        }
        if (row.a.status === "blocked") {
          const r = await hc(["read", addr, "--lines", "20"]);
          this.tail[addr] = { at: Date.now(), text: r.code === 0 ? r.stdout : "" };
        }
      } catch (e) {
        this.git[addr] = { at: Date.now(), cwd, error: String(e?.message ?? e) };
      }
      cx.notify();
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
    const c = (k) => rows.filter((r) => r.a.status === k).length;
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
      .child(this.chip(t, `${n.blocked} blocked`, n.blocked ? t.blocked : t.muted))
      .child(this.chip(t, `${n.working} working`, n.working ? t.working : t.muted))
      .child(this.chip(t, `${n.done} review`, n.done ? t.done : t.muted))
      .child(this.chip(t, `${n.idle} idle`, t.muted));
  }
  foot(t) {
    const hint = (k, text) => h_flex().gap(4).items_center().child(this.keycap(t, k)).child(div().text_size(11).text_color(t.muted).child(text));
    return h_flex().size_full().bg(t.chrome).px(16).gap(12).items_center().border_t(1).border_color(t.selected)
      .child(hint("1-8", "select")).child(hint("j/k", "move")).child(hint("g", "open session")).child(hint("click", "focus board first"));
  }

  // ---------- strips ----------
  strip(t, n, r, isSel, cx) {
    const t2 = pal(t);
    const { a, term } = r;
    const now = Date.now();
    const color = t[a.status] ?? t.muted;
    const blocked = a.status === "blocked";
    const ms = since(term, now);
    const kind = kindOf(term);
    const tag = blocked ? (kind ? `BLOCKED·${kind.toUpperCase()}` : "BLOCKED") : a.status === "done" ? "REVIEW" : a.status.toUpperCase();
    let bar = div().w(3).flex_none().bg(color);
    if (blocked) bar = bar.loop("opacity", { from: 0.35, to: 1, period: 1400 });
    else if (a.status === "working") bar = bar.loop("opacity", { from: 0.55, to: 1, period: 3200 });
    const name = term?.cwd ? base(term.cwd) : a.space_name;
    const task = msgOf(term) || a.title || "";
    const thread = blocked
      ? [[kind ? `${kind} dialog` : "dialog", t.blocked], [`· ${place(a)}`, t.muted]]
      : [[place(a), t.muted], [term?.turn ? `· turn ${term.turn}` : "", t.muted]];
    const event = ms == null ? "" : `${a.status === "done" ? "finished" : a.status === "blocked" ? "blocked" : a.status === "working" ? "started working" : "went idle"} ${age(ms)} ago`;
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
    const open = () => {
      if (!cur || isDemo()) return;
      setShared(PEEK, cur.a.address);
      run("agent.focus", { terminal: cur.a.address });
      this.syncRight();
    };
    return v_flex().id("conductor-strips").size_full().bg(t.surface).track_focus(this.h)
      .on_click(() => this.h.focus())
      .on_key_down((e) => {
        const k = e.keystroke;
        if (/^[1-8]$/.test(k)) { const r = rows[Number(k) - 1]; if (r) this.choose(r.a.address); }
        else if (k === "j" || k === "down") move(1);
        else if (k === "k" || k === "up") move(-1);
        else if (k === "g" || k === "enter") open();
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
    const recent = rows
      .map((r) => ({ ...r, ms: since(r.term, now) }))
      .filter((r) => r.ms != null && r.ms < 30 * 60000 && r.a.status !== "idle")
      .sort((x, y) => x.ms - y.ms).slice(0, 2);
    const c = this.counts(rows);
    const line = `since you looked away ${c.blocked} blocked, ${c.done} ready to review`;
    return v_flex().size_full().bg(t.surface).px(16).pt(32).pb(8).gap(8)
      .child(div().text_size(15).font_bold().text_color(t.accent).child("Jarvis"))
      .child(div().truncate().text_size(11).text_color(t2.caramel).child(mgr || isDemo() ? `${state === "unknown" ? "no status reported" : state}${msgOf(term) ? ` · ${msgOf(term)}` : ""}` : "no manager terminal set"))
      .child(v_flex().px(12).py(8).rounded(8).bg(t.chrome).border_l(2).border_color(t2.cursor)
        .child(div().text_size(11).text_color(t2.soft).child(line))
        .children(recent.map((r) => div().truncate().text_size(11).text_color(r.a.status === "blocked" ? t.blocked : t.muted).child(`${label(r.a, r.term)} → ${r.a.status === "done" ? "review ready" : r.a.status} ${age(r.ms)} ago`))));
  }

  // ---------- right header ----------
  head(t) {
    const t2 = pal(t);
    const row = selected(ordered(this.manager()));
    const bar = (el) => el.h_full().bg(t.surface).border_b(1).border_color(t.selected);
    if (!row) return bar(h_flex().size_full().px(16).items_center().text_size(11).text_color(t.muted).child("Nothing selected"));
    const { a, term } = row;
    const color = t[a.status] ?? t.muted;
    const peek = wantsPeek(row);
    const word = a.status === "done" ? "REVIEW READY" : a.status === "blocked" ? "NEEDS YOU" : a.status.toUpperCase();
    const name = term?.cwd ? base(term.cwd) : a.space_name;
    return bar(h_flex().size_full().px(16).gap(12).items_center())
      .child(v_flex().flex_1().min_w(0).justify_center()
        .child(div().truncate().text_size(11).text_color(t.muted).child(`${word} · ${name.toUpperCase()}`))
        .child(div().truncate().text_size(15).font_bold().text_color(t.accent).child(label(a, term))))
      .when(peek && (a.status === "blocked" || a.status === "done"), (el) => el.child(this.button(t, `back-${a.address}`, "Back", () => { setShared(PEEK, null); this.syncRight(); })))
      .when(!peek, (el) => el.child(this.button(t, `go-${a.address}`, "Go to session", () => { if (isDemo()) return; setShared(PEEK, a.address); run("agent.focus", { terminal: a.address }); this.syncRight(); }, a.status === "blocked")));
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
    if (a.status === "blocked") {
      const tail = (this.tail[addr]?.text ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-14).join("\n");
      const kind = kindOf(term);
      return wrap
        .child(this.section(t, `DIALOG${kind ? ` · ${kind.toUpperCase()}` : ""}`, msgOf(term) || "Waiting for you (the agent sent no title)", t.blocked))
        .child(this.section(t, "TERMINAL · LAST LINES", tail || "(nothing read yet)"))
        .child(div().text_size(11).text_color(t.muted).child("Answer in the session: use Go to session. This board never answers dialogs."));
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
    return wrap.child(div().text_size(13).text_color(t.muted).child("Live terminal is shown here."));
  }

  render(cx) {
    const t = pal(theme());
    const role = props()?.role ?? "strips";
    if (role === "top") return this.top(t);
    if (role === "foot") return this.foot(t);
    if (role === "host") return this.host(t);
    if (role === "head") return this.head(t);
    if (role === "detail") return this.detail(t);
    return this.strips(t, cx);
  }
}

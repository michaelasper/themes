// Conductor board: flight-strip bays for every agent, plus the right-hand reader.
// One mod, three roles chosen by props().role:
//   "host"   left column header: manager state + recent changes digest
//   "strips" (default) the bays: Needs you / Working / Review ready / Idle
//   "head"   right column header for the selected agent
//   "detail" right column body: blocked dialog, or review reader (done)
// props().manager: the manager's own terminal (e.g. "t1"); kept out of the bays.
// Everything shown comes from agents(), terminals(), panes(), exec (git, read-only)
// and `hc read`. Nothing is simulated.

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
const termMap = () => new Map(terminals().map((x) => [x.address, x]));
// The agent's own 7501 record: msg is the session name (working/done) or the dialog title (blocked).
const report = (term) => (term && typeof term.report === "object" && term.report) || (term && typeof term.status === "object" && term.status) || null;
const msgOf = (term) => (typeof report(term)?.msg === "string" ? report(term).msg.trim() : "");
const kindOf = (term) => (typeof report(term)?.kind === "string" ? report(term).kind : "");
const since = (term, now) => (typeof term?.status_ms === "number" ? now - term.status_ms : null);

function ordered(manager) {
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
    if (role === "detail") {
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

  // ---------- strips ----------
  strip(t, n, r, isSel, cx) {
    const { a, term } = r;
    const now = Date.now();
    const color = t[a.status] ?? t.dim;
    const blocked = a.status === "blocked";
    const ms = since(term, now);
    const kind = kindOf(term);
    const tag = blocked ? (kind ? `BLOCKED · ${kind}` : "BLOCKED") : a.status === "done" ? "REVIEW" : a.status.toUpperCase();
    let bar = div().w(4).flex_none().bg(color);
    if (blocked) bar = bar.loop("opacity", { from: 0.35, to: 1, period: 1400 });
    else if (a.status === "working") bar = bar.loop("opacity", { from: 0.55, to: 1, period: 3200 });
    const line2 = blocked ? msgOf(term) || "Waiting for you" : `${place(a)}${term?.cwd ? ` · ${base(term.cwd)}` : ""}`;
    const event = ms == null ? "" : `${a.status === "done" ? "finished" : a.status === "blocked" ? "blocked" : a.status === "working" ? "started working" : "went idle"} ${age(ms)} ago${term?.turn ? ` · turn ${term.turn}` : ""}`;
    return h_flex().id(`cs-${a.address}`).w_full().flex_none().rounded(8).overflow_hidden()
      .when(blocked, (el) => el.ml(14))
      .bg(isSel ? t.selected : t.surface).border(1).border_color(isSel ? color : t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => { this.h.focus(); this.choose(a.address); })
      .child(bar)
      .child(v_flex().flex_1().min_w(0).px(10).py(7).gap(3)
        .child(h_flex().gap(8).items_center()
          .child(div().w(14).flex_none().text_size(11).text_color(t.dim).child(n <= 8 ? String(n) : ""))
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(label(a, term)))
          .child(div().flex_none().text_size(11).text_color(blocked ? t.blocked : t.dim).child(ms == null ? "" : age(ms))))
        .child(div().pl(22).truncate().text_size(11.5).text_color(blocked ? t.blocked : t.muted).child(line2))
        .child(h_flex().pl(22).gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(event))
          .child(div().flex_none().px(6).rounded(4).border(1).border_color(color).text_size(9.5).text_color(color).child(tag))));
  }

  strips(t, cx) {
    const rows = ordered(this.manager());
    setAgentOrder(rows.map((r) => r.a.address));
    const cur = selected(rows);
    let n = 0;
    const counts = BAYS.map((b) => ({ b, c: rows.filter((r) => r.a.status === b.key).length }));
    const body = [];
    for (const { b, c } of counts) {
      if (!c && b.key !== "blocked") continue;
      body.push(h_flex().h(22).flex_none().mt(6).gap(7).items_center()
        .child(div().size(7).rounded(4).bg(t[b.key] ?? t.dim))
        .child(div().text_size(10.5).font_semibold().text_color(c && b.key === "blocked" ? t.blocked : t.muted).child(b.label))
        .child(div().text_size(10.5).text_color(t.dim).child(String(c))));
      if (!c) { body.push(div().px(4).text_size(11).text_color(t.dim).child("Nothing waiting on you")); continue; }
      for (const r of rows.filter((x) => x.a.status === b.key)) { n += 1; body.push(this.strip(t, n, r, cur?.a.address === r.a.address, cx)); }
    }
    const move = (d) => {
      if (!rows.length) return;
      const i = Math.max(0, rows.findIndex((r) => r.a.address === cur?.a.address));
      this.choose(rows[(i + d + rows.length) % rows.length].a.address);
    };
    const open = () => {
      if (!cur) return;
      setShared(PEEK, cur.a.address);
      run("agent.focus", { terminal: cur.a.address });
      this.syncRight();
    };
    return v_flex().id("conductor-strips").size_full().bg(t.chrome).track_focus(this.h)
      .on_click(() => this.h.focus())
      .on_key_down((e) => {
        const k = e.keystroke;
        if (/^[1-8]$/.test(k)) { const r = rows[Number(k) - 1]; if (r) this.choose(r.a.address); }
        else if (k === "j" || k === "down") move(1);
        else if (k === "k" || k === "up") move(-1);
        else if (k === "g" || k === "enter") open();
      })
      .child(h_flex().h(30).flex_none().px(14).gap(14).items_center().border_b(1).border_color(t.border)
        .children(counts.map(({ b, c }) => h_flex().gap(5).items_center()
          .child(div().size(6).rounded(3).bg(c ? t[b.key] : t.dim))
          .child(div().text_size(11).text_color(c && b.key === "blocked" ? t.blocked : t.muted).child(`${c} ${b.key === "done" ? "review" : b.key === "blocked" ? "need you" : b.key}`)))))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(6)
        .children(body)
        .when(!rows.length, (el) => el.child(v_flex().p(10).gap(6)
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child("No agents running"))
          .child(div().text_size(11.5).text_color(t.muted).child("Agents that report a status (pi, Claude Code, Codex...) appear here, grouped by what they need from you.")))))
      .child(h_flex().h(26).flex_none().px(14).gap(14).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child("click here, then").child("1-8 select").child("j/k move").child("g/enter open terminal"));
  }

  // ---------- host (left header) ----------
  host(t) {
    const mgr = this.manager();
    const all = agents();
    const me = all.find((a) => a.address === mgr);
    const term = termMap().get(mgr);
    const now = Date.now();
    const state = me?.status ?? "unknown";
    const recent = ordered(mgr)
      .map((r) => ({ ...r, ms: since(r.term, now) }))
      .filter((r) => r.ms != null && r.ms < 30 * 60000 && r.a.status !== "idle")
      .sort((x, y) => x.ms - y.ms).slice(0, 4);
    const by = (k) => ordered(mgr).filter((r) => r.a.status === k).length;
    return v_flex().size_full().bg(t.chrome).px(12).pt(32).pb(10).gap(6)
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).rounded(4).bg(t[state] ?? t.dim))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Jarvis"))
        .child(div().flex_1().truncate().text_size(11).text_color(t.muted).child(mgr ? `${state === "unknown" ? "no status reported" : state} · ${mgr}${msgOf(term) ? ` · ${msgOf(term)}` : ""}` : "no manager terminal set")))
      .child(v_flex().p(8).gap(3).rounded(6).bg(t.surface).border(1).border_color(t.border)
        .child(div().text_size(10.5).font_semibold().text_color(t.muted).child("RECENT CHANGES · LAST 30 MIN"))
        .child(div().text_size(11).text_color(t.foreground).child(`${by("blocked")} blocked · ${by("done")} ready to review · ${by("working")} working`))
        .children(recent.map((r) => div().truncate().text_size(10.5).text_color(r.a.status === "blocked" ? t.blocked : t.muted).child(`${label(r.a, r.term)} → ${r.a.status === "done" ? "review ready" : r.a.status} ${age(r.ms)} ago`)))
        .when(!recent.length, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("Nothing changed recently"))));
  }

  // ---------- right header ----------
  head(t) {
    const row = selected(ordered(this.manager()));
    if (!row) return h_flex().size_full().px(14).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(11).text_color(t.dim).child("Nothing selected");
    const { a, term } = row;
    const color = t[a.status] ?? t.dim;
    const peek = wantsPeek(row);
    return h_flex().size_full().px(14).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().size(8).rounded(4).bg(color))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(label(a, term)))
      .child(div().flex_none().text_size(10.5).text_color(color).child(a.status === "done" ? "REVIEW READY" : a.status.toUpperCase()))
      .when(peek && (a.status === "blocked" || a.status === "done"), (el) => el.child(this.button(t, `back-${a.address}`, "Back", () => { setShared(PEEK, null); this.syncRight(); })))
      .when(!peek, (el) => el.child(this.button(t, `go-${a.address}`, "Go to session", () => { setShared(PEEK, a.address); run("agent.focus", { terminal: a.address }); this.syncRight(); }, a.status === "blocked")));
  }

  button(t, id, text, fn, hot) {
    return div().id(id).flex_none().px(10).py(3).rounded(6).cursor_pointer().text_size(11.5)
      .bg(hot ? t.accent : t.raised).text_color(hot ? t.accent_foreground : t.foreground)
      .hover((s) => s.bg(hot ? t.accent : t.hover)).on_click(fn).child(text);
  }

  // ---------- right body ----------
  section(t, title, text, color) {
    return v_flex().gap(4).child(div().text_size(10.5).font_semibold().text_color(t.muted).child(title))
      .child(div().p(8).rounded(6).bg(t.surface).border(1).border_color(color ?? t.border).text_size(11.5).text_color(t.foreground).child(text));
  }

  detail(t) {
    const row = selected(ordered(this.manager()));
    const wrap = v_flex().size_full().bg(t.chrome).overflow_y_scrollbar().p(12).gap(10);
    if (!row) return wrap.child(div().text_size(12).text_color(t.dim).child("Select an agent to see what it needs from you."));
    const { a, term } = row;
    const addr = a.address;
    if (a.status === "blocked") {
      const tail = (this.tail[addr]?.text ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-14).join("\n");
      const kind = kindOf(term);
      return wrap
        .child(this.section(t, `DIALOG${kind ? ` · ${kind.toUpperCase()}` : ""}`, msgOf(term) || "Waiting for you (the agent sent no title)", t.blocked))
        .child(this.section(t, "TERMINAL, LAST LINES", tail || "(nothing read yet)"))
        .child(div().text_size(10.5).text_color(t.dim).child("Answer in the session: use Go to session. This board never answers dialogs."));
    }
    if (a.status === "done") {
      const g = this.git[addr];
      const cwd = term?.cwd ?? g?.cwd;
      const lines = (s) => (s ?? "").trimEnd();
      return wrap
        .child(this.section(t, "LAST STATUS MESSAGE", msgOf(term) || "(none reported)", t.done))
        .child(this.section(t, `GIT STATUS · ${cwd ? base(cwd) : "unknown folder"}`, !g ? "reading..." : g.error ? `git unavailable: ${g.error}` : lines(g.status) || "working tree clean"))
        .child(this.section(t, "GIT DIFF --STAT (UNSTAGED)", !g ? "reading..." : g.error ? "-" : lines(g.diff) || "no unstaged changes"))
        .child(div().text_size(10.5).text_color(t.dim).child("Read-only git output. Verification badges and test results are not available here."));
    }
    return wrap.child(div().text_size(12).text_color(t.dim).child("Live terminal is shown here."));
  }

  render(cx) {
    const t = theme();
    const role = props()?.role ?? "strips";
    if (role === "host") return this.host(t);
    if (role === "head") return this.head(t);
    if (role === "detail") return this.detail(t);
    return this.strips(t, cx);
  }
}

# Conductor

A Herdr app layout for running many agents from one "manager" session (for example a pi session with voice). Left: a header (Conductor state, optional voice waveform) over an optional manager terminal. Centre: flight-strip bays (Needs you, Working, Review ready, Idle). Right: the selected session's real terminal (live pane), with a review banner on top when it is ready for review.

![Conductor](preview.png)

*The preview is a real `herdr-app shot` taken with the dev-only demo mode (invented sample strips, flagged "DEMO DATA" in the top bar). The manager terminal was painted over. Demo mode is off unless installed with `./install.sh --demo` (props.demo); never use it for real work.*

It is meant to be switched to and from, not lived in: `ctrl-shift-l` cycles layouts, and with zero agents it shows an empty state.

## Install

Needs the Herdr app and `python3`. The Dr Pepper look comes from the theme file `~/.config/herdr-app/themes/dr-pepper.json`; a copy is in [`../themes/dr-pepper.json`](../themes/dr-pepper.json) (also in [michaelasper/theme](https://github.com/michaelasper/theme)).

```sh
git clone https://github.com/michaelasper/themes.git
cd themes/conductor
./install.sh                       # no conductor terminal pinned until /conductor on registers one; wave and previews on
./install.sh --manager t1          # fallback: pin terminal t1 in the left slot if no conductor session file names one
./install.sh --interrupt-cmd /abs/path/to/stop-speech   # command behind the Interrupt button (see below)
./install.sh --no-wave --no-live-pane   # waveform off / the right pane does not follow the selection (Enter, g or Open embeds)
```

Flags can also be set by env (`CONDUCTOR_NO_WAVE=1`, `CONDUCTOR_NO_LIVE_PANE=1`) or later by editing `props` (`"wave": false`, `"live": false`) on the `conductor-board` blocks of the installed layout. `--no-wave` also shortens the left header. `--demo` is dev-only (sample strips) and is never the default.

`install.sh` copies only new files (`layouts/conductor.json`, `layouts/conductor.svg`, `mods/conductor-board/`) and refuses to overwrite. It never touches `keys.json` or other layouts. Then switch with `ctrl-shift-l` or `herdr-app do layout.switch --name conductor`; `ctrl-shift-l` goes on to the next layout, or `layout.switch --name main` returns. `./uninstall.sh` removes it.

**Switch to the `main` layout before uninstall or install** (`ctrl-shift-l`, or `herdr-app do layout.switch --name main`): the files of the layout on screen must not be replaced under it. To reinstall: switch to main, `./uninstall.sh`, `./install.sh`, switch back.

To use another theme, edit `"theme"` on the root of `~/.config/herdr-app/layouts/conductor.json`.

## What each part shows (real data only)

| Part | Source |
|---|---|
| Strips: name, status message, time since status change, latest event, tag | `agents()`, `terminals()` (`report.msg`, `report.kind`, `status_ms`, `turn`) |
| Blocked strip | dialog title (`report.msg`) and kind (`question`, `auth`, `permission`) when the agent reports one; offset right, pulsing bar |
| Review banner (selected session is `done`) | top of the right pane, above the terminal: last status message; `git --no-optional-locks -C <cwd> status --short` and `diff --stat`, read-only, one read at a time, at most every 30 s, only for the selected review-ready session |
| Right pane | the selected session's real terminal (live pane, see "Live pane"); the header shows its status line (blocked: the dialog title and kind it reported; age; turn; subagents working) |
| Session cost (strip, dimmed, right of the event line) and the total in the top bar | optional per-terminal files, see "Session cost files"; nothing is shown for a session without a fresh one |
| Strip status | **effective status** (see "Subagents and effective status"); the Conductor's own session is not a strip (it is pinned in the left column) |
| Left header | the Conductor's reported state (or the empty state and "+ Start conductor") and "recent changes in the last 30 min" computed from `status_ms` |

Keys work after clicking the centre column: `1`-`8` select, `j`/`k` or arrows move, `g`/`enter` (or the **Open** button) put the session's terminal in the right panel, `esc` (or **Back**) returns, `n` starts a new session, `x` interrupts speech (see "Interrupt button"). Working strips have a quiet native opacity glow; blocked ones pulse; done and idle are still.

## Not implemented (deliberately not faked)

- Verification badges, test counts, "verified" marks and spoken summaries. The review banner shows git output and the last status message only.
- "Hold space to talk". The waveform only displays an optional voice-state file (below); it never records or sends audio.
- An authority tag (ASK/AUTO): nothing reports it. The tag shows the status (and blocked kind).
- Approve/Hold buttons: the board never answers dialogs or sends input; **Open** shows the real terminal in the panel; answering happens there.
- Command palette on `cmd-k`: use Herdr's own (`app.palette`).
- Reading other sessions' terminal text. There is no text snapshot any more: the pane embeds the real terminal instead, so nothing calls `hc read`.


## Safeguards (why this layout will not squish or freeze your sessions)

An earlier build reportedly made sessions "get really squished" and the app freeze. It was never run under a profiler, so the causes below are hypotheses from reading the code and Herdr's `AGENTS.md`; each has a fix that removes the mechanism whether or not it was the main cause.

| Hypothesis (evidence) | Safeguard |
|---|---|
| A terminal block resizes the real PTY to its tile. The old right pane embedded `{"agent":"focused"}` and a 2 s timer called `agent.focus` on every selected working/idle agent, so one PTY after another was re-embedded at tile size; the left slot was `{"tab":"active"}`, which follows the focused agent's tab, so the same terminal could be embedded twice and fought over its size. | Originally only an explicit Open embeds a session, in one place (the right panel), one at a time; selection, timers and render never embed. The left slot is a fixed terminal id (never `{"tab":"active"}`/`agent:focused`) and the Conductor's own terminal can never be opened on the right, so one terminal is never embedded twice. See "Open in panel". |
| `AGENTS.md`: "Every redraw of a mod redraws the whole window". The 50 ms voice loop redrew the window up to 20 times a second, with live terminals in it. | Voice file polled at most every 250 ms while someone talks, every 1 s otherwise, every 3 s when the layout is not shown; redraw only when the state or the level (8 steps) changes; bars ease natively (`transition`). No `watchFolder`. |
| `AGENTS.md`: timers keep running while a mod is hidden. | Every poll checks `shared("layout") === "conductor"` first and does nothing otherwise. |
| `hc read` / `git status` every 2-8 s with no timeout, no single-flight, and re-run on selection change. | All commands go through `SafeRunner` (`mods/conductor-board/logic.js`): never during render or in click handlers; one in flight; 5 s hard timeout (the app allows 30 s); at most 12 per minute; per-key minimum interval (30 s for the banner git read); 15 s back-off after a failure; a selection must be stable for 400 ms first. |
| `git status` takes the index lock and can race an agent's own git. | `git --no-optional-locks`. |
| Fixed-width clamps: host 440 px + strips min 380 + right min 320 = a 1188 px minimum. Narrower windows squeeze the columns. | Host is a weight (4/5/5) with a 300 px min; mins sum to 900 px. |
| Test layouts left in the app. | None shipped. |

Still true and unavoidable: the Conductor terminal's PTY is resized to its slot while this layout is shown (and back when you switch away), and an opened session's PTY is resized to the right panel until Back.

Switches: `--no-live-pane` (the pane embeds only on Enter/g/Open), `--no-wave` (no voice-file reads), no conductor session and no `--manager` (no left terminal).

## Tests

`node test/harness.mjs` runs the real `main.js` against mocked `gpui-kit`/`herdr` modules: voice file parsing and staleness, poll intervals, redraw-only-on-change, selection debounce, throttling, single in flight, timeout, rate cap, back-off, zero agents, hidden layout, `wave=false`/`peek=false`, demo mode, `n` key, that nothing runs during render, Open taking over the panel and Back restoring, one embed at a time, the Conductor never being openable, the conductor session file (valid, stale, missing, terminal gone, changing at runtime, re-pin), the empty state and the Start button. Session cost: strict parse, footer format and `(sub)`, known/unknown/stale/malformed/future, partial vs complete total, the Conductor excluded, unsafe addresses never become paths, opt-out, hidden layout, no redraw when unchanged. It does not draw anything (a recording stand-in for the UI kit collects the texts and click handlers). Interrupt: visible/enabled only while speaking and fresh, one command run per click burst, 1 s cooldown, missing command, failure/timeout note, the `x` key, no shell string. Added: effective status (parent idle + child working, child done, nested, blocked precedence, no children), the Conductor hidden from strips/counts/numbering/selection and following a changed manager id, the live pane (debounced follow, one at a time, never the Conductor, Esc hold, `--no-live-pane`), and the review banner (review-ready only, cached, single in flight, no snapshot code path).

## Safe first run (visual verification is yours)

Nothing here has been seen in the running app since the changes below; `herdr-app check` and the harness pass. Do this once:

1. Save your work. Install: `./install.sh` (add `--no-wave --no-live-pane` for the quietest start).
2. `herdr-app status` shows no errors.
3. Switch: `ctrl-shift-l` (or `herdr-app do layout.switch --name conductor`).
3a. Open one session (Enter or Open), then Back. Open another. Watch for squished terminals.
4. If anything is squished, slow or frozen: **`ctrl-alt-shift-escape`** puts you back on the default layout (nothing is deleted). Report which step.
5. Back: `ctrl-shift-l`, or `layout.switch --name main`. Remove: switch to main first, then `./uninstall.sh`.

Not verified in the app: that the layout looks right, the waveform and its update rate, previews, the click and `n` key, Open/Back in the panel, `layout.set` re-pinning the left slot, the Start button, and the CPU cost of ~4 Hz redraws. The `preview.png` is the earlier demo-mode capture and does not show the waveform or the final layout.

## New session

**+ New session** (top bar button, or `n` with the board focused) opens a plain interactive `pi` in a new tab through the app's generic `tab.new` command (argv `["pi"]`, in the Conductor's folder when known). It does nothing in demo mode and ignores repeat clicks within 2 seconds.

## Voice waveform and the optional voice-state file

The left header shows a 24-bar waveform (rolling history of recent levels) with a state label: speaking = accent, listening = working colour, transcribing = caramel (pulsing), idle = muted flat line. This is an **optional, generic contract**: the layout imports no code from any voice tool and works without it (it then shows a flat line and `voice offline`).

Default path `~/.pi/agent/pi-speak/state.json`; override with the host block's `props.voice_file`. Any program may write it:

```json
{"v":1,"state":"idle|listening|speaking|transcribing","level":0.0,"updated_ms":1760000000000}
```

- `level` is 0..1 (loudness right now); `updated_ms` is epoch milliseconds. No text, names or other fields are read; files over 4 KB are ignored.
- Write atomically (temp file in the same folder, then rename). While not idle write at least 4 times a second (the reader samples every 250 ms); write once when going idle and then a heartbeat about every 5 s.
- Missing, unreadable, malformed or stale (active state older than 3 s, idle older than 15 s) means `voice offline`.
- Cost: one small file read per 250 ms while active (1 s idle); a redraw only when the shown state or level step changes.
- `--demo` shows a synthetic waveform driven by native loops, labelled `demo`.

pi-speak is one known writer (speaking level: RMS envelope of the clip being played; listening: mic RMS). The mod does not depend on it.

## Session cost files (optional, generic)

Each strip can show that session's cost, small and dimmed on the metadata line, in the footer's own style (`$29.790`, with ` (sub)` when it is a subscription). The top bar shows the total over the strips, `partial k/n` when some strips have no known cost. **If a session's cost is unknown, nothing is shown for it**, never a guess.

Where it comes from: nothing in Herdr's status carries cost (`agents()`/`terminals()` report status, message, turn only), and the footer is only drawn inside the terminal. The one truthful source is the session itself. The [pi-herdr-manager](https://github.com/michaelasper/pi-herdr-manager) extension, loaded in a pi session running in a Herdr terminal, writes the cost pi's footer computes (the sum of `usage.cost.total` over the session's entries, plus the `(sub)` rule) to a file. This mod reads files only; it imports no pi code and never reads terminal text. Any tool may write them:

```
~/.config/conductor/costs/<terminal address>.json   (override: props.cost_dir)
{"v":1,"usd":29.79,"sub":true,"updated_ms":1760000000000}
```

- One file per terminal (so many writers never race on one file), written atomically (temp file, then rename). `sub` is optional: `true`/`false` only when the writer knew it. Numbers only: no names, paths or content; files over 1 KB, other versions, negative or non-numeric values are ignored.
- Ignored (shows nothing) when older than 1 hour or dated in the future; the pi extension refreshes every 10 minutes while the session lives and deletes the file on shutdown. A session that crashed can show its last figure for up to an hour. Entries whose terminal is gone are dropped at the next poll.
- Like the footer, a session with $0 that is not a subscription shows nothing; a subscription with $0 shows `$0.000 (sub)`.
- The Conductor's own session is **excluded** (it is not a strip, its file is never read, and it is not in the total).
- Cost: one sequential `readTextFile` per live non-Conductor session (at most 64) every 15 s while this layout is shown, none while hidden; no `exec`, no `hc read`, nothing during render; shared state is written (and the window redrawn) only when the answer changes. `props.costs = false` turns it all off (no reads, nothing shown). Off in demo mode.
- The total sums the strips' known figures only; subscription figures count at their API-equivalent value, as in the footer.

Not verified in the app: how the dimmed text looks at the strip's width (the harness cannot draw). Sessions started before the extension update show nothing until reloaded (`/reload`).

## Interrupt button and the interrupt command (optional, generic)

Next to the waveform, an **■ Interrupt · x** button appears **only while the voice file says `speaking` and is fresh** (state `speaking`, `updated_ms` within 3 s). It is hidden when idle, listening, transcribing or offline. The `x` key on the board does the same. Both read the voice file again right before acting, so a stale button never fires into silence.

It runs the **interrupt command**: *any executable that stops speech*. The contract:

- one absolute path, configured by you: `./install.sh --interrupt-cmd /abs/path` (or `CONDUCTOR_INTERRUPT_CMD`), stored as `props.interrupt_cmd` on the layout blocks. If omitted, `install.sh` uses `$HOME/source/pi-speak/daemon/bin/pi-speak-interrupt` when that executable exists. The path is user config only: it is never read from the voice file or any file a tool writes.
- run through the app's `exec` as argv with **no arguments** (never a shell string), 3 s hard timeout, exit code 0 = success. It must find its own credentials; the layout never reads a token or puts one in a command line.
- single in flight; further clicks/keys are ignored while it runs and for 1 s after. A non-zero exit, a start failure or a timeout shows a short `interrupt failed` / `interrupt timed out` note for 4 s (no output of the command is shown).
- no command configured: the button is not offered; the header shows the quiet note `no interrupt command configured`. Nothing errors. Needs the waveform (`--no-wave` removes the voice reads and with them the button; the key then also does nothing). Not available in demo mode.

The layout imports nothing from any voice tool. pi-speak ships `daemon/bin/pi-speak-interrupt`, which stops all speech and clears its queue (README there).

## Live pane

By default the right pane shows the **selected session's real terminal**, so there is no Open click. Selecting a strip (click, `1`-`8`, `j`/`k`) releases the old embed at once; once the selection has been stable for 400 ms the new session is embedded. A review-ready (`done`) session shows a compact banner at the top of the same pane (last status message, `git status --short`, `git diff --stat`, all real and read-only) above its terminal.

**Tradeoff (PTY resize):** a terminal block resizes the real PTY to its tile, so the selected session's terminal is resized to the pane while it is selected (it re-wraps and any program that redraws on resize redraws) and returns to its own size when released. The Conductor's terminal is likewise sized to the left slot while this layout is shown. If that bothers you, install with `./install.sh --no-live-pane` (or set `"live": false` on the layout's `conductor-board` blocks): the pane then embeds only on an explicit **Open** (button, `g` or `enter`), and **Back** (or `esc`) releases it. In live mode `esc` releases the session and holds it out until you select another strip.

How it is mounted (from Herdr's `AGENTS.md`): the right column has the `head` block (title, status line, banner) and a `stack` (`right-body`) with two children, `detail` (this mod, a one-line placeholder) and `session`, a `{"agent":"focused"}` block ("one agent's terminal, full size"). Embedding runs `agent.focus {terminal}` then `layout.select {stack: "right-body", child: "session"}`; releasing runs `layout.select ... "detail"`. The controller (one 500 ms check) lives in the `head` block because it is always mounted.

Squish/freeze rules, all enforced in code and tests (the older "embed only on explicit Open" rule is deliberately replaced by the debounced follow, at the user's request):

- Follow only after >= 400 ms of stable selection, and Open's own 600 ms debounce, and at most 12 embeds a minute. Render and click handlers never embed (a click only changes the selection).
- Exactly one session embedded at a time besides the Conductor slot; opening another replaces it. Never the Conductor's terminal (it is not a strip, `open()` refuses it, and an embed of it is released), never the same terminal twice.
- No timer or loop is tied to the embed. Release happens on selection change, Back/esc, when the session ends or becomes the Conductor, and when the layout is no longer shown. On each activation the stack is reset to the placeholder once.
- Banner git info: only for the selected review-ready session, one command batch in flight (`SafeRunner`: 5 s timeout, 12/min, 30 s per key, back-off), never during render, `git --no-optional-locks`.
- Clicking into the embedded terminal gives it keyboard focus, so board keys then go to that terminal; click the board first.
- Nothing reads other sessions' terminal text (no `hc read`, no snapshot).

Unverified (not seen in the app): that `agent.focus` only moves Herdr's "focused agent" and does not change which tab is shown, that a hidden stack child is not mounted, and how the banner looks at the 112 px header height.

## Subagents and effective status

A strip's status is its **effective status**: `blocked` if the agent itself is blocked (blocked always wins); `working` if its own status is `working` OR any live descendant terminal reports `working`; otherwise its own (`idle`/`done`). A parent that is idle or done with a working child therefore sits in WORKING and shows `N subagents working`; a finished or idle child changes nothing; descendants count through nesting (a child's child counts toward the root).

Signal used (generic, optional contract, no pi code imported): the core records the starter of a terminal as `parent` (Herdr's `AGENTS.md`: sub-agents are terminals an agent started with `hc run`, `terminals()[i].parent`). A live descendant terminal whose own reported status is `working` counts toward every ancestor (depth cap 8, cycle safe). Any tool that wants its helpers counted can start them as child terminals that report `working` over OSC 7501.

Limit: helpers that are not terminals are invisible to a generic mod. pi-subagents' async runs live in `$TMPDIR/pi-subagents-uid-*/async-subagent-runs/<id>/status.json` (`state: "running"`, pid, `sessionId`), but those are in-process runs with no terminal and no link to the parent terminal address, so the mod does not read them. For those to count, a pi-side change is needed (see the report): the pi extension that owns the run should publish a working state for the parent session (for example keep the session's OSC 7501 status `working` while any subagent, monitor or loop is active, or run each subagent as a child terminal that reports `working`).

## Conductor session file (optional, generic)

The left tile pins the **Conductor** (the manager session) terminal. Which terminal is resolved dynamically from an optional file, so a tool such as `/conductor on` can register itself. The layout imports no code from any tool.

Default path `~/.config/conductor/session.json`; override with `CONDUCTOR_SESSION_FILE` at install (`--session-file PATH`, stored as `props.session_file`):

```json
{"v":1,"terminal":"t3","updated_ms":1760000000000,"pid":12345}
```

Precedence: the file (valid, the terminal exists, and `updated_ms` within 24 h, or the terminal still reports a live agent status) > the install-time `--manager tN` (if that terminal exists) > the empty state. The file is read at most every 3 s while the layout is shown (never while hidden; one read at a time, no commands) and the left slot is re-pinned when the answer changes (`layout.set` on this layout's own tree, at most every 10 s and 5 times per start). The Conductor's strip is marked "this is the Conductor" and cannot be opened.

Empty state: the host tile says "No conductor session. Run /conductor on in a pi session, or start one here" with a **+ Start conductor** button (plain `pi` in a new tab named `conductor`, through the same `tab.new` as + New session; debounced, and ignored for 30 s after a start until a session resolves). If `--manager tN` names a missing terminal it says "conductor terminal tN not found; set with install.sh --manager tN". The board's strips work without a Conductor.

Unverified: the exact argument form `layout.set {layout: <tree>}` accepts. If it is refused the left slot keeps its old terminal until a reinstall, while the host tile still shows the resolved state.

🤖 Generated by Claude Sonnet 5.5 running on [anthropic](https://www.anthropic.com)

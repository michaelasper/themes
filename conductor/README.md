# Conductor

A Herdr app layout for running many agents from one "manager" session (for example a pi session with voice). Left: a header (Conductor state, optional voice waveform) over an optional manager terminal. Centre: flight-strip bays (Needs you, Working, Review ready, Idle). Right: a reader that follows the selected strip.

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
./install.sh --no-wave --no-peek   # switch the waveform / the right-pane text previews off
```

Flags can also be set by env (`CONDUCTOR_NO_WAVE=1`, `CONDUCTOR_NO_PEEK=1`) or later by editing `props` (`"wave": false`, `"peek": false`) on the `conductor-board` blocks of the installed layout. `--no-wave` also shortens the left header. `--demo` is dev-only (sample strips) and is never the default.

`install.sh` copies only new files (`layouts/conductor.json`, `layouts/conductor.svg`, `mods/conductor-board/`) and refuses to overwrite. It never touches `keys.json` or other layouts. Then switch with `ctrl-shift-l` or `herdr-app do layout.switch --name conductor`; `ctrl-shift-l` goes on to the next layout, or `layout.switch --name main` returns. `./uninstall.sh` removes it.

**Switch to the `main` layout before uninstall or install** (`ctrl-shift-l`, or `herdr-app do layout.switch --name main`): the files of the layout on screen must not be replaced under it. To reinstall: switch to main, `./uninstall.sh`, `./install.sh`, switch back.

To use another theme, edit `"theme"` on the root of `~/.config/herdr-app/layouts/conductor.json`.

## What each part shows (real data only)

| Part | Source |
|---|---|
| Strips: name, status message, time since status change, latest event, tag | `agents()`, `terminals()` (`report.msg`, `report.kind`, `status_ms`, `turn`) |
| Blocked strip | dialog title (`report.msg`) and kind (`question`, `auth`, `permission`) when the agent reports one; offset right, pulsing bar |
| Review ready (status `done`) reader | last status message; `git --no-optional-locks -C <cwd> status --short` and `diff --stat`, read-only, at most every 30 s |
| Blocked reader | dialog title and the last lines of the terminal via `hc read` (throttled, see Safeguards) |
| Working / idle | a read-only text snapshot (`hc read`, throttled) until you press Open, which puts the real terminal in the panel (see "Open in panel") |
| Left header | the Conductor's reported state (or the empty state and "+ Start conductor") and "recent changes in the last 30 min" computed from `status_ms` |

Keys work after clicking the centre column: `1`-`8` select, `j`/`k` or arrows move, `g`/`enter` (or the **Open** button) put the session's terminal in the right panel, `esc` (or **Back**) returns, `n` starts a new session. Working strips have a quiet native opacity glow; blocked ones pulse; done and idle are still.

## Not implemented (deliberately not faked)

- Verification badges, test counts, "verified" marks and spoken summaries. The review reader shows git output and the last status message only.
- "Hold space to talk". The waveform only displays an optional voice-state file (below); it never records or sends audio.
- An authority tag (ASK/AUTO): nothing reports it. The tag shows the status (and blocked kind).
- Approve/Hold buttons: the board never answers dialogs or sends input; **Open** shows the real terminal in the panel; answering happens there.
- Command palette on `cmd-k`: use Herdr's own (`app.palette`).
- A live terminal that follows the selection. The right panel embeds a terminal only on an explicit Open (see "Open in panel").


## Safeguards (why this layout will not squish or freeze your sessions)

An earlier build reportedly made sessions "get really squished" and the app freeze. It was never run under a profiler, so the causes below are hypotheses from reading the code and Herdr's `AGENTS.md`; each has a fix that removes the mechanism whether or not it was the main cause.

| Hypothesis (evidence) | Safeguard |
|---|---|
| A terminal block resizes the real PTY to its tile. The old right pane embedded `{"agent":"focused"}` and a 2 s timer called `agent.focus` on every selected working/idle agent, so one PTY after another was re-embedded at tile size; the left slot was `{"tab":"active"}`, which follows the focused agent's tab, so the same terminal could be embedded twice and fought over its size. | Only an explicit Open embeds a session, in one place (the right panel), one at a time; selection, timers and render never embed. The left slot is a fixed terminal id (never `{"tab":"active"}`/`agent:focused`) and the Conductor's own terminal can never be opened on the right, so one terminal is never embedded twice. See "Open in panel". |
| `AGENTS.md`: "Every redraw of a mod redraws the whole window". The 50 ms voice loop redrew the window up to 20 times a second, with live terminals in it. | Voice file polled at most every 250 ms while someone talks, every 1 s otherwise, every 3 s when the layout is not shown; redraw only when the state or the level (8 steps) changes; bars ease natively (`transition`). No `watchFolder`. |
| `AGENTS.md`: timers keep running while a mod is hidden. | Every poll checks `shared("layout") === "conductor"` first and does nothing otherwise. |
| `hc read` / `git status` every 2-8 s with no timeout, no single-flight, and re-run on selection change. | All commands go through `SafeRunner` (`mods/conductor-board/logic.js`): never during render or in click handlers; one in flight; 5 s hard timeout (the app allows 30 s); at most 12 per minute; per-key minimum interval (blocked 6 s, working 4 s, idle 15 s, done 30 s); 15 s back-off after a failure; a selection must be stable for 400 ms first. |
| `git status` takes the index lock and can race an agent's own git. | `git --no-optional-locks`. |
| Fixed-width clamps: host 440 px + strips min 380 + right min 320 = a 1188 px minimum. Narrower windows squeeze the columns. | Host is a weight (4/5/5) with a 300 px min; mins sum to 900 px. |
| Test layouts left in the app. | None shipped. |

Still true and unavoidable: the Conductor terminal's PTY is resized to its slot while this layout is shown (and back when you switch away), and an opened session's PTY is resized to the right panel until Back.

Switches: `--no-peek` (no reading of other sessions' text at all), `--no-wave` (no voice-file reads), no conductor session and no `--manager` (no left terminal).

## Tests

`node test/harness.mjs` runs the real `main.js` against mocked `gpui-kit`/`herdr` modules: voice file parsing and staleness, poll intervals, redraw-only-on-change, selection debounce, throttling, single in flight, timeout, rate cap, back-off, zero agents, hidden layout, `wave=false`/`peek=false`, demo mode, `n` key, that nothing runs during render, Open taking over the panel and Back restoring, one embed at a time, the Conductor never being openable, the conductor session file (valid, stale, missing, terminal gone, changing at runtime, re-pin), the empty state and the Start button. It does not draw anything (a recording stand-in for the UI kit collects the texts and click handlers).

## Safe first run (visual verification is yours)

Nothing here has been seen in the running app since the changes below; `herdr-app check` and the harness pass. Do this once:

1. Save your work. Install: `./install.sh` (add `--no-wave --no-peek` for the quietest start).
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

## Open in panel

**Open** (button, `g` or `enter`) makes the session's terminal take over the right panel in place, with no popup. `esc` (board focused) or **Back** returns to the reader.

How it is mounted (from Herdr's `AGENTS.md`): the right column body is a `stack` (`right-body`) with two children, `detail` (this mod) and `session`, a `{"agent":"focused"}` block ("one agent's terminal, full size"). Open runs `agent.focus {terminal}` and then `layout.select {stack: "right-body", child: "session"}`; Back runs `layout.select ... "detail"`. A terminal block resizes the real PTY to its tile, so the tradeoff is: the opened session is re-wrapped to the panel's size while open (and the Conductor's terminal to the left slot) and returns to its own size when released. Any program in it that redraws on resize will redraw.

Squish/freeze rules that follow from that, all enforced in code and tests:

- Embed only on an explicit Open, never on selection, a timer or render. Open is debounced (600 ms) and ignores a repeat of the open terminal.
- At most one opened session at a time; opening another replaces it. The Conductor's terminal is the only other embedded one and is never openable (the strip says "this is the Conductor"; the Open button is absent), so no terminal is embedded twice.
- No timer is tied to the embed. Release (`layout.select ... detail`) happens on Back, on selecting another strip, when the session ends or becomes the Conductor, and when the layout is no longer shown. On each activation the stack is also reset to the reader once.
- Clicking into the embedded terminal gives it keyboard focus, so `esc` then goes to that terminal: use the Back button.

Unverified: that `agent.focus` only moves Herdr's "focused agent" and does not change which tab is shown, and that a hidden stack child is not mounted (the docs say a stack shows one child).

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

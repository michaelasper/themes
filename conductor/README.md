# Conductor

A Herdr app layout for running many agents from one "manager" session (for example a pi session with voice). Left: the manager's own terminal with a slim header. Centre: flight-strip bays (Needs you, Working, Review ready, Idle). Right: a reader that follows the selected strip.

![Conductor](preview.png)

*The preview is a real `herdr-app shot` taken with the dev-only demo mode (invented sample strips, flagged "DEMO DATA" in the top bar). The manager terminal was painted over. Demo mode is off unless installed with `./install.sh --demo` (props.demo); never use it for real work.*

It is meant to be switched to and from, not lived in: `ctrl-shift-l` cycles layouts, and with zero agents it shows an empty state.

## Install

Needs the Herdr app and `python3`. The Dr Pepper look comes from the theme file `~/.config/herdr-app/themes/dr-pepper.json`; a copy is in [`../themes/dr-pepper.json`](../themes/dr-pepper.json) (also in [michaelasper/theme](https://github.com/michaelasper/theme)).

```sh
git clone https://github.com/michaelasper/themes.git
cd themes/conductor
./install.sh --manager t1        # t1: the terminal to show on the left; default $HC_TERMINAL_ID
```

`install.sh` copies only new files (`layouts/conductor.json`, `layouts/conductor.svg`, `mods/conductor-board/`) and refuses to overwrite. It never touches `keys.json` or other layouts. Then switch with `ctrl-shift-l` or `herdr-app do layout.switch --name conductor`; `ctrl-shift-l` goes on to the next layout, or `layout.switch --name main` returns. `./uninstall.sh` removes it (switch away first).

To use another theme, edit `"theme"` on the root of `~/.config/herdr-app/layouts/conductor.json`.

## What each part shows (real data only)

| Part | Source |
|---|---|
| Strips: name, status message, time since status change, latest event, tag | `agents()`, `terminals()` (`report.msg`, `report.kind`, `status_ms`, `turn`) |
| Blocked strip | dialog title (`report.msg`) and kind (`question`, `auth`, `permission`) when the agent reports one; offset right, pulsing bar |
| Review ready (status `done`) reader | last status message; `git -C <cwd> status --short` and `git diff --stat`, run with `exec`, read-only, every 8 s |
| Blocked reader | dialog title and the last 14 lines of the terminal via `hc read` |
| Working / idle | the agent's live terminal (`{"agent": "focused"}` block), chosen with `agent.focus` |
| Left header | the manager's reported state and "recent changes in the last 30 min" computed from `status_ms` |

Keys work after clicking the centre column: `1`-`8` select, `j`/`k` or arrows move, `g`/`enter` open the agent's terminal (`agent.focus`). Working strips have a quiet native opacity glow; blocked ones pulse; done and idle are still.

## Not implemented (deliberately not faked)

- Verification badges, test counts, "verified" marks and spoken summaries. The review reader shows git output and the last status message only.
- A voice waveform or "hold space to talk": there is no signal here. The left header shows the manager terminal's own reported state.
- An authority tag (ASK/AUTO): nothing reports it. The tag shows the status (and blocked kind).
- Approve/Hold buttons: the board never answers dialogs or sends input; "Go to session" focuses the agent.
- Command palette on `cmd-k`: use Herdr's own (`app.palette`).
- Selecting a working or idle strip calls `agent.focus`, which also changes which agent Herdr treats as focused in other layouts.

## Verified and not

**+ New session** (top bar button, or `n` with the board focused) opens a plain interactive `pi` in a new tab through the app's generic `tab.new` command (argv `["pi"]`, in the manager's folder when known). It does nothing in demo mode and ignores repeat clicks within 2 seconds. The click and the `n` key are unverified: `herdr-app check` passes, but the command was never run.

Verified: `herdr-app check` passes; installed with no entries in `herdr-app status` errors; the layout renders and switches back; the empty-bay and idle-strip states rendered in a real screenshot. Not verified: clicks, key handling, blocked and review-ready strips (no such agents were available), the review reader's git output, `layout.select` switching of the right pane, and the pulse animations in motion.

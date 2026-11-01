# Conductor for Tern

Tern port of the Herdr Conductor (`~/source/themes/conductor`), window half only. For working mostly by voice: a tab you switch to, not a daily default. One tab, three columns (the layout of `11-command`): left a **host** panel (title/state line, 24-bar voice strip, "since you looked away" digest) above the manager `pi` pane; centre the board (top bar with brand and blocked/working/review/idle chips, bays, key-hint bar at the bottom); right the detail.

Open with `Open Conductor` from the palette or `tern ctl plugins run plugin.conductor.open`. Install: `tern plugin link "$PWD"`.

## Board

Bays, in key order: **NEEDS YOU**, **WORKING**, **REVIEW READY**, **IDLE**, each always shown (a dashed `none` when empty). A strip: key hint 1-8, bold name, task/message, age on the right, folder and cwd, an event line (`turn N`, `no status file`, or `stale`), and a tag (the blocked `kind` for needs-you). Colours are Dr Pepper CSS vars only; the font is CommitMono.

Age counts from when this plugin first saw the session in its current bay (once per collection); a stale session shows the age of its file.

**Since you looked away**: when the Conductor tab goes off screen the plugin stores `{pane: bay}` in `tern.kv` (`baseline`). Coming back, the host panel counts sessions that are now blocked or ready to review and were not in that bay then. No baseline yet: "no earlier visit recorded".

## State sources (in order)

1. **Status file** `~/.local/state/conductor/tern-status/<TERN_PANE>.json`, written by the pi extension (contract: `../pi-status/CONTRACT.md`): `working|blocked|idle|done`, `msg`, `kind`. `blocked` is NEEDS YOU, `done` is REVIEW READY. Only the files of live panes are read. Luau cannot `kill(pid, 0)` and has no epoch clock, so the plugin samples `date +%s` (at most once a minute while shown) and treats a file with `now - updated_ms > 30 s` as **stale whatever its pid**: it is never trusted, the session sits in IDLE with a `stale` tag and the file's age. Until the clock sample lands no file is trusted.
2. **Fallback** when there is no status file: `tern inspect --json` `working` flag gives WORKING; an unseen pane alert gives REVIEW READY; else IDLE. Without the file nothing can be NEEDS YOU.

Sessions are terminal panes that have a status file, run `pi`, or whose title starts with `π`.

## Reader

Detail panel: state and folder, the **DIALOG** box (the blocked message, never answerable here), **Go to session** (the only button; it never approves or sends), git, and **LAST OUTPUT**. For the selected REVIEW READY or NEEDS YOU session for the selected REVIEW READY or NEEDS YOU session `git --no-optional-locks -C <cwd> status --short` and `diff --stat` (read-only; one git job in flight process-wide, the latest-selected cwd waits its turn, at most one refresh per cwd every 8 s, 5 s timeout), and recent terminal lines via `cx.session:read`. The cwd is the pane's cwd.

## Keys

`1`-`8` select, `j`/`k` (or arrows) move, `enter`/`g` go, `n` new pi tab (in the selected session's cwd). They are `tern.command` chords whose `available` is true only while the board or reader has focus, so the keys stay normal keystrokes in terminals, including the manager. They also appear in the palette while the board is focused.

There is no interrupt: use Go to session and press Esc yourself.

## Voice

Display only. Reads `~/.pi/agent/pi-speak/state.json` (`PI_SPEAK_STATE_FILE` overrides) `{v:1,state,level,updated_ms}`: `idle|listening|speaking|transcribing`, else `offline` (missing, malformed, or unchanged for 3 s active / 15 s idle). It never records, sends audio, or reads text.

## Manager

The left pane is a new `pi` tab. If `~/.config/conductor/session.json` (or `CONDUCTOR_SESSION_FILE`) names a live pane, `{"v":1,"pane":"<TERN_PANE>"}` (Herdr's numeric-string `terminal` is also accepted), that pane is moved into the Conductor tab on open instead. The manager is never a strip.

## Cost when idle

While the Conductor tab is not on screen the loop only checks which tab is focused every 20 s (a focus event wakes it sooner): no file reads, no processes, no renders. Shown: files every 1 s (0.4 s while voice is active), one `tern inspect` per 2 s, git only for the selected review/needs-you session. The timer stops when the board canvas is gone. Views are re-sent only when they change and cached only after a successful update; a render error shows one toast per distinct message.

## Layout of the code

`window.luau` is the Tern glue. `logic.luau` is pure (parsing, bays, ordering, voice, staleness, digest) and is `require`d.

## Not done

- No Luau tests: `luau` is not installed here, and `logic.luau` was not run outside Tern.
- Carly integration, approving dialogs (it never answers a prompt).

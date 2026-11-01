# Dr Pepper + Conductor for Tern

Port of the Dr Pepper theme and the Herdr Conductor layout to [Tern](https://docs.stencil.so/tern/). The Conductor is a layout for working **mostly by voice**: a tab you switch to, not a daily default.

| Piece | Where | What |
|---|---|---|
| Theme | `build.py` → `dr-pepper.css` | Palette from `../themes/dr-pepper.json`, chat tokens from `~/source/theme` |
| Plugin | `conductor/` | Tab with host panel, manager `pi`, board, reader |
| Status extension | `pi-status/` | pi package: writes working/blocked/idle/done per Tern pane |
| Manager backend | `~/source/pi-herdr-manager` (`src/tern/`) | Lets the manager `pi` see and prompt sessions in Tern |

## Setup

```sh
./install.sh --check      # what is missing, changes nothing
./install.sh --font       # theme, plugin link, pi-status package; --font also sets CommitMono 14
./install.sh --uninstall
```

It is idempotent and never touches running panes. Afterwards **restart running `pi` sessions** (pi-status loads at start), then run `Open Conductor` from the palette or `tern ctl plugins run plugin.conductor.open`.

## Using it by voice

Bays: NEEDS YOU, WORKING, REVIEW READY, IDLE. The voice strip reads `~/.pi/agent/pi-speak/state.json`. Keys work only while the board, reader or host panel has focus (not in the manager pane): `ctrl+alt+1-8` select, `ctrl+alt+j/k` move, `ctrl+alt+enter` or `ctrl+alt+g` go to the session, `ctrl+alt+n` new pi. (Plain keys and `ctrl+alt+arrows` are bound by Tern's preset and cannot be used.) Nothing here answers a dialog or interrupts a session; **Go to session** is the only action on an existing session (`ctrl+alt+n` opens a new pi tab).

## Manager

In the Conductor tab's left `pi`, run `/conductor on`. It registers as the manager (`~/.config/conductor/session.json`), lists every pi session that runs pi-status, and can prompt idle ones (`[from manager] ` prefix, single line, audited in `~/.pi/agent/conductor/audit.jsonl`). It refuses a pane you are looking at. Verified live: list, prompt, worker reply, completion event back to the manager.

## Limits

- Needs-you only exists for sessions that run pi-status. Others fall back to Tern's working flag (working / review / idle).
- Status files older than 30 s are shown stale and never trusted.
- Only interactive (TUI) pi sessions report. Subagent children write nothing.
- The manager's `create` is confirm-gated and takes focus (Tern has no no-focus flag); prompts are single-line.
- Several pi TUIs inside one Tern pane (tmux inside a pane) share one status file.
- Plugin logic is untested outside Tern (no `luau` binary here).

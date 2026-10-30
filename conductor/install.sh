#!/bin/sh
# Installs the Conductor layout into the Herdr app. Copies NEW files only; refuses to overwrite.
#   ./install.sh [--manager tN] [--no-wave] [--no-live-pane] [--demo]
# SWITCH TO THE main LAYOUT BEFORE uninstall.sh / install.sh (ctrl-shift-l, or ctrl-alt-shift-escape): never replace
# files of the layout that is on screen.
# --manager tN  fallback manager terminal, pinned in the left column when ~/.config/conductor/session.json names none
#               (that file, written by /conductor, wins when valid). Embedding a live terminal resizes its PTY to the slot.
#               The manager's strip is marked "this is the Conductor" and cannot be opened. Default: a placeholder message.
# --session-file PATH  read the manager contract from PATH instead (CONDUCTOR_SESSION_FILE does the same).
# --no-wave     no voice waveform and no voice-file reads (CONDUCTOR_NO_WAVE=1 does the same).
# --no-live-pane  the right pane does not follow the selection: a session is embedded only on Enter/g/Open
#               (CONDUCTOR_NO_LIVE_PANE=1 does the same). Default: the selected session's terminal is shown (its PTY is
#               resized to the pane while selected). --no-peek is accepted and ignored (nothing reads terminal text any more).
# --interrupt-cmd PATH  absolute path of an executable that stops speech (CONDUCTOR_INTERRUPT_CMD does the same); run as argv
#               with no arguments by the Interrupt button / x key while the voice file says "speaking". If omitted, the
#               first existing, executable of $HOME/source/pi-speak/daemon/bin/pi-speak-interrupt is used. None found:
#               the button shows "no interrupt command configured". Stored as props.interrupt_cmd (user config only).
# --demo        DEV ONLY: installs with props.demo=true, so the board shows invented sample strips
#               under a "DEMO DATA" chip (for screenshots). Never use for real work.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
HOME_DIR=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
MANAGER=""
SESSION_FILE=${CONDUCTOR_SESSION_FILE:-}
DEMO=""
INTERRUPT=${CONDUCTOR_INTERRUPT_CMD:-}
NOWAVE=${CONDUCTOR_NO_WAVE:-}
NOLIVE=${CONDUCTOR_NO_LIVE_PANE:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --manager) MANAGER=${2:?--manager needs a terminal address}; shift 2 ;;
    --session-file) SESSION_FILE=${2:?--session-file needs a path}; shift 2 ;;
    --no-manager) MANAGER=""; shift ;;
    --no-wave) NOWAVE=1; shift ;;
    --no-live-pane) NOLIVE=1; shift ;;
    --no-peek) shift ;;
    --interrupt-cmd) INTERRUPT=${2:?--interrupt-cmd needs an absolute path}; shift 2 ;;
    --demo) DEMO=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$INTERRUPT" ] && [ -x "$HOME/source/pi-speak/daemon/bin/pi-speak-interrupt" ]; then
  INTERRUPT="$HOME/source/pi-speak/daemon/bin/pi-speak-interrupt"
fi
case "$INTERRUPT" in
  "") ;;
  /*) if [ ! -x "$INTERRUPT" ]; then echo "note: $INTERRUPT is not an executable file; the Interrupt button will fail until it is." >&2; fi ;;
  *) echo "--interrupt-cmd must be an absolute path" >&2; exit 2 ;;
esac
for f in layouts/conductor.json layouts/conductor.svg mods/conductor-board; do
  if [ -e "$HOME_DIR/$f" ]; then echo "refusing to overwrite $HOME_DIR/$f (run uninstall.sh first)" >&2; exit 1; fi
done
if [ ! -e "$HOME_DIR/themes/dr-pepper.json" ]; then
  echo "note: themes/dr-pepper.json not found; the layout falls back to a built-in look." >&2
  echo "      Get the theme: https://github.com/michaelasper/theme (or copy $HERE/../themes/dr-pepper.json)" >&2
fi
mkdir -p "$HOME_DIR/layouts" "$HOME_DIR/mods/conductor-board"
cp "$HERE/mods/conductor-board/main.js" "$HERE/mods/conductor-board/logic.js" "$HERE/mods/conductor-board/mod.json" "$HOME_DIR/mods/conductor-board/"
cp "$HERE/layouts/conductor.svg" "$HOME_DIR/layouts/conductor.svg"
python3 - "$HERE/layouts/conductor.json" "$HOME_DIR/layouts/conductor.json" "$MANAGER" "$DEMO" "$NOWAVE" "$NOLIVE" "$SESSION_FILE" "$INTERRUPT" <<'PY'
import json, sys
src, dst, manager, demo, nowave, nolive, mfile, interrupt = sys.argv[1:9]
layout = json.load(open(src))
def walk(n):
    yield n
    for c in n.get("children", []): yield from walk(c)
for n in walk(layout):
    c = n.get("content") or {}
    if manager and n["id"] == "manager": n["content"] = {"terminal": manager}
    if manager and c.get("mod") == "conductor-board": c.setdefault("props", {})["manager"] = manager
    if mfile and c.get("mod") == "conductor-board": c.setdefault("props", {})["session_file"] = mfile
    if interrupt and c.get("mod") == "conductor-board": c.setdefault("props", {})["interrupt_cmd"] = interrupt
    if demo and c.get("mod") == "conductor-board": c.setdefault("props", {})["demo"] = True
    if nowave and c.get("mod") == "conductor-board": c.setdefault("props", {})["wave"] = False
    if nolive and c.get("mod") == "conductor-board": c.setdefault("props", {})["live"] = False
    if nowave and n["id"] == "host-head": n["size"] = {"px": 234}
with open(dst, "x") as f: json.dump(layout, f, indent=2); f.write("\n")
PY
echo "Installed conductor (manager slot: ${MANAGER:-none}; wave: $([ -n "$NOWAVE" ] && echo off || echo on); live pane: $([ -n "$NOLIVE" ] && echo off || echo on); interrupt command: ${INTERRUPT:-none})."
cat <<'EOF'

Nothing has been switched yet. (To reinstall later: switch to main first, then ./uninstall.sh, then ./install.sh.) Safe first run:
  1. Save your work. The layout only DISPLAYS: it never starts, kills, resizes or focuses your sessions by itself.
  2. herdr-app status                 (errors should be empty)
  3. Switch:  ctrl-shift-l (cycles layouts)  or  herdr-app do layout.switch --name conductor
  4. Look at it for a minute. If anything is squished, slow or frozen:
       ctrl-alt-shift-escape   (always works: back to the default "main" layout, nothing is deleted)
  5. Back:    ctrl-shift-l again, or herdr-app do layout.switch --name main
  6. Remove:  switch to main first, then ./uninstall.sh
Not happy with the voice bars or the live right pane? Reinstall with --no-wave and/or --no-live-pane.
EOF

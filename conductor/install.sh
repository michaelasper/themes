#!/bin/sh
# Installs the Conductor layout into the Herdr app. Copies NEW files only; refuses to overwrite.
#   ./install.sh [--manager tN] [--no-wave] [--no-peek] [--demo]
# SWITCH TO THE main LAYOUT BEFORE uninstall.sh / install.sh (ctrl-shift-l, or ctrl-alt-shift-escape): never replace
# files of the layout that is on screen.
# --manager tN  fallback manager terminal, pinned in the left column when ~/.config/conductor/session.json names none
#               (that file, written by /conductor, wins when valid). Embedding a live terminal resizes its PTY to the slot.
#               The manager's strip is marked "this is the Conductor" and cannot be opened. Default: a placeholder message.
# --session-file PATH  read the manager contract from PATH instead (CONDUCTOR_SESSION_FILE does the same).
# --no-wave     no voice waveform and no voice-file reads (CONDUCTOR_NO_WAVE=1 does the same).
# --no-peek     the right pane never reads other sessions' terminal text (CONDUCTOR_NO_PEEK=1 does the same).
# --demo        DEV ONLY: installs with props.demo=true, so the board shows invented sample strips
#               under a "DEMO DATA" chip (for screenshots). Never use for real work.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
HOME_DIR=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
MANAGER=""
SESSION_FILE=${CONDUCTOR_SESSION_FILE:-}
DEMO=""
NOWAVE=${CONDUCTOR_NO_WAVE:-}
NOPEEK=${CONDUCTOR_NO_PEEK:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --manager) MANAGER=${2:?--manager needs a terminal address}; shift 2 ;;
    --session-file) SESSION_FILE=${2:?--session-file needs a path}; shift 2 ;;
    --no-manager) MANAGER=""; shift ;;
    --no-wave) NOWAVE=1; shift ;;
    --no-peek) NOPEEK=1; shift ;;
    --demo) DEMO=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
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
python3 - "$HERE/layouts/conductor.json" "$HOME_DIR/layouts/conductor.json" "$MANAGER" "$DEMO" "$NOWAVE" "$NOPEEK" "$SESSION_FILE" <<'PY'
import json, sys
src, dst, manager, demo, nowave, nopeek, mfile = sys.argv[1:8]
layout = json.load(open(src))
def walk(n):
    yield n
    for c in n.get("children", []): yield from walk(c)
for n in walk(layout):
    c = n.get("content") or {}
    if manager and n["id"] == "manager": n["content"] = {"terminal": manager}
    if manager and c.get("mod") == "conductor-board": c.setdefault("props", {})["manager"] = manager
    if mfile and c.get("mod") == "conductor-board": c.setdefault("props", {})["session_file"] = mfile
    if demo and c.get("mod") == "conductor-board": c.setdefault("props", {})["demo"] = True
    if nowave and c.get("mod") == "conductor-board": c.setdefault("props", {})["wave"] = False
    if nopeek and c.get("mod") == "conductor-board": c.setdefault("props", {})["peek"] = False
    if nowave and n["id"] == "host-head": n["size"] = {"px": 234}
with open(dst, "x") as f: json.dump(layout, f, indent=2); f.write("\n")
PY
echo "Installed conductor (manager slot: ${MANAGER:-none}; wave: $([ -n "$NOWAVE" ] && echo off || echo on); peek: $([ -n "$NOPEEK" ] && echo off || echo on))."
cat <<'EOF'

Nothing has been switched yet. (To reinstall later: switch to main first, then ./uninstall.sh, then ./install.sh.) Safe first run:
  1. Save your work. The layout only DISPLAYS: it never starts, kills, resizes or focuses your sessions by itself.
  2. herdr-app status                 (errors should be empty)
  3. Switch:  ctrl-shift-l (cycles layouts)  or  herdr-app do layout.switch --name conductor
  4. Look at it for a minute. If anything is squished, slow or frozen:
       ctrl-alt-shift-escape   (always works: back to the default "main" layout, nothing is deleted)
  5. Back:    ctrl-shift-l again, or herdr-app do layout.switch --name main
  6. Remove:  switch to main first, then ./uninstall.sh
Not happy with the voice bars or the previews? Reinstall with --no-wave and/or --no-peek.
EOF

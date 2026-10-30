#!/bin/sh
# Installs the Conductor layout into the Herdr app. Copies NEW files only; refuses to overwrite.
#   ./install.sh [--manager tN | --no-manager]
# --manager tN  the terminal shown in the left column and kept off the board
#               (default: $HC_TERMINAL_ID, the session running this script).
# --no-manager  the left column shows the active tab instead.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
HOME_DIR=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
MANAGER=${HC_TERMINAL_ID:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --manager) MANAGER=${2:?--manager needs a terminal address}; shift 2 ;;
    --no-manager) MANAGER=""; shift ;;
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
cp "$HERE/mods/conductor-board/main.js" "$HERE/mods/conductor-board/mod.json" "$HOME_DIR/mods/conductor-board/"
cp "$HERE/layouts/conductor.svg" "$HOME_DIR/layouts/conductor.svg"
python3 - "$HERE/layouts/conductor.json" "$HOME_DIR/layouts/conductor.json" "$MANAGER" <<'PY'
import json, sys
src, dst, manager = sys.argv[1:4]
layout = json.load(open(src))
def walk(n):
    yield n
    for c in n.get("children", []): yield from walk(c)
for n in walk(layout):
    c = n.get("content") or {}
    if manager and n["id"] == "manager": n["content"] = {"terminal": manager}
    if manager and c.get("mod") == "conductor-board": c.setdefault("props", {})["manager"] = manager
with open(dst, "x") as f: json.dump(layout, f, indent=2); f.write("\n")
PY
echo "Installed conductor (manager: ${MANAGER:-active tab})."
echo "Switch:  ctrl-shift-l (cycles layouts)  or  herdr-app do layout.switch --name conductor"
echo "Back:    ctrl-shift-l again, or herdr-app do layout.switch --name main"
echo "Check:   herdr-app status   (errors should be empty)"

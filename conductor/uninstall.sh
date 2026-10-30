#!/bin/sh
# Removes only what install.sh added. SWITCH TO THE main LAYOUT FIRST (ctrl-shift-l); never remove the layout that is on screen.
set -eu
HOME_DIR=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
rm -f "$HOME_DIR/layouts/conductor.json" "$HOME_DIR/layouts/conductor.svg" "$HOME_DIR/layouts/.state/conductor.json"
# The app also writes jsconfig.json / .d.ts into the mod folder.
rm -rf "$HOME_DIR/mods/conductor-board"
echo "Removed conductor layout and conductor-board mod."

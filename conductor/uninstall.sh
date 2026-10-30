#!/bin/sh
# Removes only what install.sh added. Switch to another layout first (ctrl-shift-l).
set -eu
HOME_DIR=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
rm -f "$HOME_DIR/layouts/conductor.json" "$HOME_DIR/layouts/conductor.svg" "$HOME_DIR/layouts/.state/conductor.json"
# The app also writes jsconfig.json / .d.ts into the mod folder.
rm -rf "$HOME_DIR/mods/conductor-board"
echo "Removed conductor layout and conductor-board mod."

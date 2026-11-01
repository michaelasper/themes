#!/bin/sh
# Sets up Dr Pepper + the Conductor on Tern. Idempotent. Never touches running panes.
#   ./install.sh [--check] [--font] [--no-theme] [--uninstall]
#   --check      report what is installed and what is missing; change nothing (not combinable with --uninstall)
#   --font       also set CommitMono 14 (the Herdr/Ghostty font)
#   --no-theme   skip the theme (plugin + pi extensions only)
#   --uninstall  unlink the plugin, remove the theme file if this installer wrote it, remove the pi-status entry
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
CFG=${TERN_CONFIG_DIR:-$HOME/Library/Application Support/Tern}
TERN=${TERN_EXE:-$(command -v tern || true)}
CHECK=""; FONT=""; THEME=1; UN=""
for a in "$@"; do case "$a" in
  --check) CHECK=1;; --font) FONT=1;; --no-theme) THEME="";; --uninstall) UN=1;;
  *) echo "unknown argument: $a" >&2; exit 2;; esac; done
[ -n "$CHECK" ] && [ -n "$UN" ] && { echo "--check cannot be combined with --uninstall" >&2; exit 2; }
ok()   { printf '  ok       %s\n' "$1"; }
miss() { printf '  MISSING  %s\n' "$1"; BAD=1; }
do_()  { if [ -n "$CHECK" ]; then miss "$1"; else printf '  doing    %s\n' "$1"; fi; }
tmo()  { if command -v timeout >/dev/null 2>&1; then timeout 20 "$@"; else "$@"; fi; }
BAD=""
PKG="$HERE/pi-status"
THEME_SRC="$HERE/dr-pepper.css"; THEME_DST="$CFG/themes/dr-pepper.css"
MARK="$CFG/themes/.dr-pepper.installed"
in_pi() { pi list 2>/dev/null | grep -qxF "    $PKG"; }
plugin_here() { "$TERN" plugin list 2>/dev/null | grep -q '^conductor ' && [ "$(cat "$("$TERN" plugin dir 2>/dev/null)/conductor.path" 2>/dev/null || true)" = "$HERE/conductor" ]; }
FAIL=""
step() { "$@" || { echo "  FAILED   $*" >&2; FAIL=1; }; }

if [ -n "$UN" ]; then
  echo "uninstall"
  [ -n "$TERN" ] && step "$TERN" plugin unlink conductor
  if [ -f "$MARK" ] && cmp -s "$THEME_SRC" "$THEME_DST"; then rm -f "$THEME_DST" "$MARK"; ok "theme file removed"
  else echo "  note     theme file not removed (not installed by this script or modified)"; fi
  echo "  note     the active theme setting in settings.json is unchanged; pick another with: tern ctl theme NAME"
  command -v pi >/dev/null && in_pi && step pi remove "$PKG"
  [ -z "$FAIL" ] && echo "done. restart pi sessions to unload pi-status." || { echo "uninstall incomplete" >&2; exit 1; }
  exit 0
fi

[ -n "$TERN" ] || { echo "tern not found on PATH (set TERN_EXE)" >&2; exit 1; }
command -v pi >/dev/null || { echo "pi not found on PATH" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found on PATH" >&2; exit 1; }

echo "theme"
if [ -n "$THEME" ]; then
  if [ -e "$THEME_DST" ] && cmp -s "$THEME_SRC" "$THEME_DST"; then ok "dr-pepper.css installed"
  else
    do_ "install dr-pepper.css"
    if [ -z "$CHECK" ]; then
      mkdir -p "$CFG/themes"
      if [ -e "$THEME_DST" ] || [ -L "$THEME_DST" ]; then cp -p "$THEME_DST" "$THEME_DST.bak" && echo "  note     existing file saved as dr-pepper.css.bak"; rm -f "$THEME_DST"; fi
      cp "$THEME_SRC" "$THEME_DST" && : > "$MARK"
    fi
  fi
  cur=$(python3 -c "import sys,json;print(json.load(open(sys.argv[1])).get('theme_dark',''))" "$CFG/settings.json" 2>/dev/null || true)
  if [ "$cur" = "dr-pepper" ]; then ok "theme active"
  else do_ "activate theme (tern ctl theme dr-pepper)"; [ -n "$CHECK" ] || step tmo "$TERN" ctl theme dr-pepper >/dev/null; fi
fi
if [ -n "$FONT" ]; then
  fam=$(python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(d.get('font_family',''),d.get('font_size',''))" "$CFG/settings.json" 2>/dev/null || true)
  if [ "$fam" = "CommitMono 14" ]; then ok "font CommitMono 14"
  else do_ "set font CommitMono 14"; [ -n "$CHECK" ] || { step tmo "$TERN" ctl font-family CommitMono >/dev/null; step tmo "$TERN" ctl font 14 >/dev/null; }; fi
fi

echo "conductor plugin"
if plugin_here; then ok "plugin linked to this checkout"
else do_ "tern plugin link $HERE/conductor"; [ -n "$CHECK" ] || { "$TERN" plugin unlink conductor >/dev/null 2>&1 || true; step "$TERN" plugin link "$HERE/conductor" >/dev/null; }; fi

echo "pi extensions"
if in_pi; then ok "pi-status registered"; else do_ "pi install $PKG"; [ -n "$CHECK" ] || step pi install "$PKG" >/dev/null; fi
if pi list 2>/dev/null | grep -q "pi-herdr-manager"; then ok "pi-herdr-manager (manager backend)"
else miss "pi-herdr-manager not installed (needed for the manager pane): pi install ~/source/pi-herdr-manager"; fi
[ -d "$HOME/source/pi-speak" ] && ok "pi-speak found (voice strip)" || echo "  note     pi-speak not found: the voice strip will read offline"

echo "setup"
[ -z "$FAIL" ] || { echo "a step failed" >&2; exit 1; }
if [ -n "$CHECK" ]; then [ -z "$BAD" ] && echo "all good" || { echo "incomplete"; exit 1; }
elif [ -n "$BAD" ]; then echo "incomplete: install the missing piece above, then re-run" >&2; exit 1
else echo "done. Restart running pi sessions so pi-status loads, then run: tern ctl plugins run plugin.conductor.open"; fi

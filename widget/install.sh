#!/bin/sh
# Install Hanging Spidey for the current user: app-menu launcher + start at login.
#   widget/install.sh            install
#   widget/install.sh --remove   remove launcher and autostart entry
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
NAME="hanging-spidey.desktop"

if [ "$1" = "--remove" ]; then
  rm -f "$APPS/$NAME" "$AUTOSTART/$NAME"
  echo "Removed launcher and autostart entry. Settings remain in ~/.config/hanging-spidey."
  exit 0
fi

missing=""
python3 -c "import gi; gi.require_version('Gtk','3.0')" 2>/dev/null || missing="$missing python3-gi gir1.2-gtk-3.0"
python3 -c "import gi
try:
    gi.require_version('WebKit2','4.1')
except ValueError:
    gi.require_version('WebKit2','4.0')" 2>/dev/null || missing="$missing gir1.2-webkit2-4.1"
python3 -c "import cairo" 2>/dev/null || missing="$missing python3-gi-cairo"
if [ -n "$missing" ]; then
  echo "Missing packages. Install them with:"
  echo "  sudo apt install$missing"
  exit 1
fi
python3 -c "import gi; gi.require_version('AyatanaAppIndicator3','0.1')" 2>/dev/null ||
  echo "Note: no tray icon support (gir1.2-ayatanaappindicator3-0.1); right-click Miles for the menu."

if [ ! -f "$ROOT/node_modules/three/build/three.module.js" ]; then
  echo "Installing three.js…"
  (cd "$ROOT" && npm install --omit=dev)
fi

chmod +x "$ROOT/widget/run.sh"
mkdir -p "$APPS" "$AUTOSTART"

entry() {
  cat <<EOF
[Desktop Entry]
Type=Application
Name=Hanging Spidey
Comment=Miles Morales desktop mascot
Exec=$ROOT/widget/run.sh
Icon=$ROOT/widget/icon.svg
Terminal=false
Categories=Utility;
EOF
}

entry > "$APPS/$NAME"
{ entry; echo "X-GNOME-Autostart-enabled=true"; echo "X-GNOME-Autostart-Delay=5"; } > "$AUTOSTART/$NAME"

echo "Installed. Launch “Hanging Spidey” from the app menu, or run: $ROOT/widget/run.sh"
echo "He starts automatically at login; toggle that from his menu (“Start at login”)."

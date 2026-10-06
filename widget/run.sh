#!/bin/sh
# Launch the Hanging Spidey desktop widget. XWayland (x11 backend) is what
# lets the overlay stay on top, place itself and pass clicks through.
cd "$(dirname "$0")/.." || exit 1
export GDK_BACKEND=x11
exec python3 widget/spidey_host.py "$@"

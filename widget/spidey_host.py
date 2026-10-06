#!/usr/bin/env python3
"""Hanging Spidey desktop host.

A transparent, always-on-top overlay that runs the web widget
(widget/app.html) in WebKitGTK. Only Miles himself receives clicks: the page
reports his body outline and the window's X11 input shape is set to it, so
everything else passes through to the desktop. While he rests the window
shrinks around him; during moves it covers the whole monitor layout.

Needs an X11 session ("Ubuntu on Xorg"): on GNOME Wayland, Xwayland before
23.1 doesn't forward the input shape, so the overlay would swallow clicks.
"""

import functools
import json
import os
import signal
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("GDK_BACKEND", "x11")

import gi  # noqa: E402

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
for _webkit in ("4.1", "4.0"):
    try:
        gi.require_version("WebKit2", _webkit)
        break
    except ValueError:
        continue
import cairo  # noqa: E402
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2  # noqa: E402

try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator  # noqa: E402
except (ValueError, ImportError):
    AppIndicator = None

APP_ID = "io.github.hangingspidey"
ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = Path(GLib.get_user_config_dir()) / "hanging-spidey"
SETTINGS_FILE = CONFIG_DIR / "settings.json"
STATE_FILE = CONFIG_DIR / "state.json"
AUTOSTART_FILE = Path(GLib.get_user_config_dir()) / "autostart" / "hanging-spidey.desktop"
LAUNCHER = ROOT / "widget" / "run.sh"
ICON = ROOT / "widget" / "icon.svg"
DEFAULT_SETTINGS = {"activity": "calm", "size": "medium", "roam": False, "paused": False}
DEBUG = "--debug" in sys.argv


def log(*args):
    if DEBUG:
        print("[spidey]", *args, flush=True)


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


class QuietHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".glb": "model/gltf-binary",
    }

    def log_message(self, *args):
        pass


def start_server():
    """Serve the project read-only on a random localhost port (ES modules
    and the GLB need http:, not file:)."""
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def autostart_enabled():
    return AUTOSTART_FILE.exists()


def set_autostart(enabled):
    if enabled:
        AUTOSTART_FILE.parent.mkdir(parents=True, exist_ok=True)
        AUTOSTART_FILE.write_text(
            "[Desktop Entry]\n"
            "Type=Application\n"
            "Name=Hanging Spidey\n"
            "Comment=Miles Morales desktop mascot\n"
            f"Exec={LAUNCHER}\n"
            f"Icon={ICON}\n"
            "X-GNOME-Autostart-enabled=true\n"
            "X-GNOME-Autostart-Delay=5\n"
        )
    elif AUTOSTART_FILE.exists():
        AUTOSTART_FILE.unlink()


class SpideyHost:
    def __init__(self, app):
        self.app = app
        self.settings = {**DEFAULT_SETTINGS, **load_json(SETTINGS_FILE, {})}
        self.state = load_json(STATE_FILE, None)
        self.hidden = False
        self.ready = False
        self.dragging = False
        self.server = start_server()

        self.window = Gtk.Window(type=Gtk.WindowType.POPUP)  # override-redirect: no WM frame, no taskbar, on top
        self.window.set_title("Hanging Spidey")
        visual = self.window.get_screen().get_rgba_visual()
        if visual is None:
            raise SystemExit("Hanging Spidey needs a compositing desktop (no RGBA visual).")
        self.window.set_visual(visual)
        self.window.set_app_paintable(True)
        self.window.connect("draw", self.on_draw)

        manager = WebKit2.UserContentManager()
        manager.register_script_message_handler("spidey")
        manager.connect("script-message-received::spidey", self.on_message)
        self.view = WebKit2.WebView.new_with_user_content_manager(manager)
        web = self.view.get_settings()
        web.set_enable_webgl(True)
        web.set_enable_developer_extras(DEBUG)
        if DEBUG and hasattr(web, "set_enable_write_console_messages_to_stdout"):
            web.set_enable_write_console_messages_to_stdout(True)
        if hasattr(web, "set_hardware_acceleration_policy"):
            web.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
        self.view.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        self.view.connect("context-menu", lambda *_: True)
        self.view.connect("load-changed", self.on_load_changed)
        self.view.connect("load-failed", lambda _v, _e, uri, err: log("load failed", uri, err.message))
        self.view.connect("web-process-terminated", lambda _v, reason: log("web process terminated", reason))
        self.window.add(self.view)

        display = Gdk.Display.get_default()
        display.connect("monitor-added", lambda *_: GLib.idle_add(self.fit_monitors))
        display.connect("monitor-removed", lambda *_: GLib.idle_add(self.fit_monitors))
        self.origin = (0, 0)
        self.fit_monitors()

        self.window.show_all()
        # Click-through everywhere until the page reports where he is.
        self.set_hit([])
        port = self.server.server_address[1]
        query = "?debug" if DEBUG else ""
        self.view.load_uri(f"http://127.0.0.1:{port}/widget/app.html{query}")

        self.indicator = self.build_indicator()
        self.watch_power()

    # ——— Window & monitors ———
    def on_draw(self, _widget, cr):
        cr.set_source_rgba(0, 0, 0, 0)
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.paint()
        return False

    def monitors(self):
        display = Gdk.Display.get_default()
        out = []
        for i in range(display.get_n_monitors()):
            m = display.get_monitor(i)
            g = m.get_geometry()
            w = m.get_workarea()
            out.append({"geom": (g.x, g.y, g.width, g.height), "work": (w.x, w.y, w.width, w.height), "primary": m.is_primary()})
        return out

    def fit_monitors(self):
        mons = self.monitors()
        x0 = min(m["geom"][0] for m in mons)
        y0 = min(m["geom"][1] for m in mons)
        x1 = max(m["geom"][0] + m["geom"][2] for m in mons)
        y1 = max(m["geom"][1] + m["geom"][3] for m in mons)
        self.origin = (x0, y0)
        self.size = (x1 - x0, y1 - y0)
        # Start full-size; the page then shrinks it to a strip around Miles.
        self.window.move(x0, y0)
        self.window.resize(*self.size)
        self.layout = [
            {
                "x": m["geom"][0] - x0, "y": m["geom"][1] - y0, "w": m["geom"][2], "h": m["geom"][3],
                "primary": m["primary"],
                "work": {"x": m["work"][0] - x0, "y": m["work"][1] - y0, "w": m["work"][2], "h": m["work"][3]},
            }
            for m in mons
        ]
        log("monitors", self.layout)
        if self.ready:
            self.call("configure", self.page_config())
        return False

    def page_config(self):
        return {
            "monitors": self.layout,
            "size": {"w": self.size[0], "h": self.size[1]},
            "settings": self.settings,
            "state": self.state,
        }

    def set_hit(self, rects):
        """Only these rectangles (his body) take clicks; the rest of the
        overlay, web included, passes them through to the desktop.

        Needs an X11 session ("Ubuntu on Xorg"): on GNOME Wayland, Xwayland
        before 23.1 doesn't forward the input shape and the whole overlay
        swallows clicks."""
        region = cairo.Region([cairo.RectangleInt(*map(int, r)) for r in rects])
        self.window.input_shape_combine_region(region)

    # ——— Page bridge ———
    def call(self, method, *args):
        payload = ",".join(json.dumps(a) for a in args)
        script = f"window.spidey && window.spidey.{method}({payload});"
        if hasattr(self.view, "evaluate_javascript"):
            self.view.evaluate_javascript(script, -1, None, None, None, None, None)
        else:
            self.view.run_javascript(script, None, None, None)

    def on_load_changed(self, _view, event):
        log("load", event.value_nick)

    def on_message(self, _manager, result):
        value = result.get_js_value() if hasattr(result, "get_js_value") else result
        try:
            msg = json.loads(value.to_string())
        except ValueError:
            return
        kind = msg.get("type")
        if kind == "hello":
            # The page's module has run and window.spidey exists.
            self.ready = True
            self.call("configure", self.page_config())
        elif kind == "hit":
            # During a drag the pointer grab keeps events coming even when
            # the cursor leaves the shape, so it can keep tracking him.
            if not self.hidden:
                self.set_hit(msg["rects"])
        elif kind == "viewport":
            self.window.move(self.origin[0] + int(msg["x"]), self.origin[1] + int(msg["y"]))
            self.window.resize(int(msg["w"]), int(msg["h"]))
            self.call("viewport", {k: msg[k] for k in ("x", "y", "w", "h")})
        elif kind == "menu":
            self.popup_menu()
        elif kind == "state":
            self.state = msg["state"]
            save_json(STATE_FILE, self.state)
        elif kind == "drag":
            self.dragging = msg["active"]
        elif kind in ("log", "stats", "ready"):
            log(kind, {k: v for k, v in msg.items() if k != "type"})

    # ——— Settings ———
    def set_setting(self, name, value):
        self.settings[name] = value
        save_json(SETTINGS_FILE, self.settings)
        self.call("set", name, value)

    def toggle_hidden(self, *_):
        self.hidden = not self.hidden
        if self.hidden:
            self.call("suspend", True)
            self.set_hit([])
            self.window.hide()
        else:
            self.window.show_all()
            self.call("suspend", False)
        self.refresh_indicator()

    # ——— Menus (tray + right-click on Miles) ———
    def build_menu(self):
        menu = Gtk.Menu()

        def item(label, cb):
            mi = Gtk.MenuItem(label=label)
            mi.connect("activate", cb)
            menu.append(mi)
            return mi

        def check(label, active, cb):
            mi = Gtk.CheckMenuItem(label=label)
            mi.set_active(active)
            mi.connect("toggled", lambda w: cb(w.get_active()))
            menu.append(mi)
            return mi

        def radio_submenu(label, name, options):
            sub = Gtk.Menu()
            group = None
            for value, text in options:
                mi = Gtk.RadioMenuItem.new_with_label_from_widget(group, text)
                group = mi
                mi.set_active(self.settings[name] == value)
                mi.connect("toggled", lambda w, v=value: w.get_active() and self.set_setting(name, v))
                sub.append(mi)
            parent = Gtk.MenuItem(label=label)
            parent.set_submenu(sub)
            menu.append(parent)

        item("Show Miles" if self.hidden else "Hide Miles", self.toggle_hidden)
        check("Pause moves", self.settings["paused"], lambda on: self.set_setting("paused", on))
        menu.append(Gtk.SeparatorMenuItem())
        if len(self.layout) > 1:
            item("Send to other monitor", lambda *_: self.call("command", "cross"))
            check("Roam both monitors", self.settings["roam"], lambda on: self.set_setting("roam", on))
        radio_submenu("Activity", "activity", [("calm", "Calm"), ("normal", "Normal"), ("playful", "Playful")])
        radio_submenu("Size", "size", [("small", "Small"), ("medium", "Medium"), ("large", "Large")])
        item("Reset position", lambda *_: self.call("command", "reset"))
        menu.append(Gtk.SeparatorMenuItem())
        check("Start at login", autostart_enabled(), set_autostart)
        item("Quit", lambda *_: self.quit())
        menu.show_all()
        return menu

    def build_indicator(self):
        if AppIndicator is None:
            log("no AppIndicator; right-click Miles for the menu")
            return None
        ind = AppIndicator.Indicator.new("hanging-spidey", str(ICON), AppIndicator.IndicatorCategory.APPLICATION_STATUS)
        ind.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        ind.set_title("Hanging Spidey")
        ind.set_menu(self.build_menu())
        return ind

    def refresh_indicator(self):
        if self.indicator:
            self.indicator.set_menu(self.build_menu())

    def popup_menu(self):
        # The right-click happened inside WebKit, so there is no GdkEvent to
        # anchor to: place the menu at the pointer on the overlay instead.
        self._popup = self.build_menu()
        self._popup.attach_to_widget(self.window, None)
        gdk_window = self.window.get_window()
        pointer = Gdk.Display.get_default().get_default_seat().get_pointer()
        _, x, y, _ = gdk_window.get_device_position(pointer)
        anchor = Gdk.Rectangle()
        anchor.x, anchor.y, anchor.width, anchor.height = x, y, 1, 1
        self._popup.popup_at_rect(gdk_window, anchor, Gdk.Gravity.NORTH_WEST, Gdk.Gravity.NORTH_WEST, None)

    # ——— Sleep / lock ———
    def watch_power(self):
        try:
            system = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
            system.signal_subscribe(
                "org.freedesktop.login1", "org.freedesktop.login1.Manager", "PrepareForSleep",
                "/org/freedesktop/login1", None, Gio.DBusSignalFlags.NONE, self.on_sleep,
            )
        except GLib.Error as err:
            log("no logind:", err.message)
        try:
            session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            session.signal_subscribe(
                None, "org.gnome.ScreenSaver", "ActiveChanged", "/org/gnome/ScreenSaver",
                None, Gio.DBusSignalFlags.NONE, self.on_lock,
            )
        except GLib.Error as err:
            log("no screensaver bus:", err.message)

    def on_sleep(self, _conn, _sender, _path, _iface, _signal, params):
        sleeping = params.unpack()[0]
        log("sleep" if sleeping else "wake")
        if not self.hidden:
            self.call("suspend", sleeping)

    def on_lock(self, _conn, _sender, _path, _iface, _signal, params):
        locked = params.unpack()[0]
        log("locked" if locked else "unlocked")
        if not self.hidden:
            self.call("suspend", locked)

    def quit(self):
        if self.state:
            save_json(STATE_FILE, self.state)
        self.server.shutdown()
        self.app.quit()


class SpideyApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.host = None

    def do_activate(self):
        if self.host:
            # Launched again while running: just make sure he's visible.
            if self.host.hidden:
                self.host.toggle_hidden()
            return
        self.hold()
        self.host = SpideyHost(self)
        for sig in (signal.SIGINT, signal.SIGTERM):
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, self.on_signal)

    def on_signal(self):
        self.host.quit()
        return GLib.SOURCE_REMOVE


def main():
    if os.environ.get("XDG_SESSION_TYPE") == "wayland":
        print(
            "Hanging Spidey: on a Wayland session his whole window may block clicks. "
            "Log in with \"Ubuntu on Xorg\" for proper click-through.",
            file=sys.stderr,
        )
    app = SpideyApp()
    return app.run([a for a in sys.argv if a != "--debug"])


if __name__ == "__main__":
    sys.exit(main())

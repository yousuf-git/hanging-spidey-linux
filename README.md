<div align="center">

  <img src="widget/icon.svg" alt="Hanging Spidey icon" width="110" />

  <h1>Hanging Spidey</h1>

  <p><strong>A 3D Miles Morales that lives on your Linux desktop: hanging from a web, climbing the screen edges, and swinging between monitors while you work.</strong></p>

  ![License](https://img.shields.io/github/license/yousuf-git/hanging-spidey-linux?style=flat-square)
  ![Last commit](https://img.shields.io/github/last-commit/yousuf-git/hanging-spidey-linux?style=flat-square)

  <br/>

  ![Three.js](https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=threedotjs&logoColor=white)
  ![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
  ![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
  ![GTK](https://img.shields.io/badge/GTK_3-4A86CF?style=for-the-badge&logo=gtk&logoColor=white)
  ![Linux](https://img.shields.io/badge/Linux_X11-FCC624?style=for-the-badge&logo=linux&logoColor=black)

  <p>
    <a href="#getting-started">Getting Started</a> &middot;
    <a href="#poses-and-moves">Poses</a> &middot;
    <a href="https://github.com/yousuf-git/hanging-spidey-linux/issues">Report a Bug</a>
  </p>

  <img src="docs/screens/poses.png" alt="Miles in his poses: upside-down hang, tuck hang, one-hand swing, wall climb, ceiling crawl, walking, standing" width="820" />

</div>

---

> Hanging Spidey is a desktop mascot for Linux. A rigged 3D Miles Morales (Spider-Verse suit) hangs from an orb web glued to the top of your screen, climbs the walls, crawls along the ceiling, walks the bottom edge and swings across monitors. He moves on his own every minute or two and otherwise just idles. Clicks pass straight through everything except his body.

## <img src="https://api.iconify.design/lucide/info.svg?color=%236e7681&width=22" /> About

The widget is a transparent, always-on-top overlay window that renders a real rigged glTF model with Three.js inside WebKitGTK. Miles is posed procedurally every frame: a behaviour planner decides where he is and what he's doing, and two-bone IK places his arms and legs. Nothing is pre-animated.

Each monitor's usable area becomes four surfaces: the **ceiling** (below the top bar), the **ground**, and the **left and right walls** (the dock edge counts as a wall). He sticks to whichever one he is on, moves between them, and between big moves he only breathes, blinks, glances around and sways on his line. He starts with your session, pauses during sleep and screen lock, and remembers where he was.

## <img src="https://api.iconify.design/lucide/sparkles.svg?color=%236e7681&width=22" /> Features

- **Real 3D character.** The Across the Spider-Verse Miles model with glossy suit shading, cyan and magenta rim lights, and a lens "blink" built in code (the model's own expression controls were lost in its export).
- **Procedural posing.** Two-bone IK for every limb. Clinging limbs are planned in his own body space, so hands and feet stay planted on the surface plane without tangling.
- **Simulated silk.** An orb web glued to the screen edge (radial threads, capture spiral with glue beads, a dense hub) and a twisted cord with fibres and a drop shadow.
- **Behaviour planner.** 17 moves across five states (hanging, ceiling, walls, ground, airborne). One big move happens after a random wait set by the activity level; otherwise he just idles.
- **Fully draggable.** Grab him and he dangles from your cursor on a short web. Drop him near a wall or the ceiling and he sticks; drop him in open space and he falls and lands.
- **Click-through.** Only his body outline takes clicks. The web, the net and everything around him pass clicks to the apps underneath.
- **Multi-monitor.** He stays on one monitor, or roams all of them. "Send to other monitor" makes him web-swing across.
- **Desktop citizen.** Tray icon and right-click menu, start at login, pauses on sleep and screen lock, and position saved across restarts. While he rests, the overlay window shrinks to fit him to keep CPU use down.

## <img src="https://api.iconify.design/lucide/image.svg?color=%236e7681&width=22" /> Poses and Moves

| | | |
|:---:|:---:|:---:|
| <img src="docs/screens/hang-feet.png" width="230" alt="Upside-down hang" /><br/><sub>**Upside-down hang**: feet on the line, knees in a wide diamond, both fists on the line below</sub> | <img src="docs/screens/hang-tuck.png" width="230" alt="Tuck hang" /><br/><sub>**Tuck hang**: both fists on the line, legs in a wide V</sub> | <img src="docs/screens/swing.png" width="230" alt="One-hand swing" /><br/><sub>**One-hand swing**: pumping, swinging and web travel</sub> |
| <img src="docs/screens/wall-climb.png" width="200" alt="Wall climb" /><br/><sub>**Wall climb**: ladder-style, one arm high, one knee up</sub> | <img src="docs/screens/ceiling-crawl.png" width="300" alt="Ceiling crawl" /><br/><sub>**Ceiling crawl**: hand over hand, palms and soles flat</sub> | <img src="docs/screens/walk.png" width="200" alt="Walking" /><br/><sub>**Walking**: about 0.9 m/s, full stride, arms swinging</sub> |

<details>
<summary>All moves the planner can choose from</summary>

| From | Moves |
|---|---|
| Hanging on a line | climb to ceiling, lower to ground, big swing, swing to wall, flip grip (feet / hand), tuck hang, go to other monitor |
| Ceiling | crawl, drop on a line, ceiling to wall, go to other monitor |
| Walls | crawl, wall to ceiling, wall to ground, web-zip up |
| Ground | walk, crouch, leap onto wall, web-zip up, go to other monitor |
| Anywhere | drag with the mouse, then stick, or fall and land |

</details>

## <img src="https://api.iconify.design/lucide/layers.svg?color=%236e7681&width=22" /> Tech Stack

- **Rendering:** Three.js (r186) with WebGL, plus Canvas 2D for the web silk
- **Character:** rigged glTF (GLB) model; procedural two-bone IK, blink morph built at load time
- **Behaviour:** plain JavaScript planner using generator-based moves (`widget/brain.js`)
- **Desktop host:** Python 3, GTK 3, WebKitGTK (WebKit2 4.1 / 4.0), Ayatana AppIndicator (optional), D-Bus (logind, GNOME ScreenSaver)
- **Platform:** Linux on an X11 session (override-redirect window with an X11 input shape)

## <img src="https://api.iconify.design/lucide/network.svg?color=%236e7681&width=22" /> How It Works

```mermaid
flowchart LR
  subgraph Host["spidey_host.py (GTK 3)"]
    W["Transparent overlay window"]
    T["Tray + right-click menu"]
    P["Sleep / lock watcher"]
    S["Local HTTP server"]
  end
  subgraph Page["widget/app.html (WebKitGTK)"]
    B["brain.js: behaviour planner, 2D rig"]
    M["miles3d.js: GLB model, IK, blink"]
    L["web.js: orb net + silk cord"]
  end
  S -->|"serves page, Three.js, GLB"| Page
  B -->|"pose + surface data"| M
  B -->|"line, anchor"| L
  Page -->|"body outline, drag, menu"| W
  W -->|"X11 input shape"| X["Desktop: clicks pass through"]
  T -->|"settings, commands"| Page
  P -->|"suspend / resume"| Page
```

1. **Planner** (`brain.js`) keeps Miles' state in screen pixels: which surface he's on, his position, his web line (a pendulum), and the current move. Moves are generators that advance once per frame. Between moves, a random timer (Calm: 1–3 min, Normal: 30–90 s, Playful: 10–40 s) picks the next one.
2. **3D rig** (`miles3d.js`) receives a 2D screen-space rig each frame and turns it into a 3D pose. Body facing depends on the surface (side-on against walls and the ceiling, turned toward his walking direction on the ground). Limbs are solved with two-bone IK, and clinging limbs are planned in body space and pinned to the surface plane.
3. **Web** (`web.js`) draws the orb net (cached once per anchor), the twisted cord, and the shot web.
4. **Host** (`spidey_host.py`) runs the page in an override-redirect GTK window. The page reports Miles' body outline, and the host sets it as the window's X11 input shape, so only he takes clicks. While he rests the window shrinks around him; during moves it covers the whole monitor layout so it never shifts mid-motion.

## <img src="https://api.iconify.design/lucide/folder-tree.svg?color=%236e7681&width=22" /> Project Structure

```
hanging-spidey/
├── widget/
│   ├── spidey_host.py   # GTK/WebKit overlay host: window, input shape, tray, sleep/lock, state
│   ├── app.html         # page loaded by the host (import map for Three.js)
│   ├── app.js           # render loop, layers, drag input, window fitting, blink
│   ├── brain.js         # behaviour planner: surfaces, moves, gait, 2D rig
│   ├── miles3d.js       # GLB loading, IK posing, cling gait, lens blink, outline
│   ├── web.js           # orb net, silk cord, wraps
│   ├── run.sh           # launcher (forces the X11 GDK backend)
│   ├── install.sh       # app-menu launcher + start at login (--remove to undo)
│   └── icon.svg
├── model/               # rigged Miles GLB (CC BY 4.0, see Credits)
├── preview/
│   └── movements.html   # standalone 2D mock-up of the behaviour (open in a browser)
└── docs/                # concept sketch, screenshots, reference images
```

## <img src="https://api.iconify.design/lucide/download.svg?color=%236e7681&width=22" /> Getting Started

### Prerequisites

- Linux with an **X11 session**. On Ubuntu, pick **"Ubuntu on Xorg"** from the gear icon on the login screen. On GNOME Wayland with Xwayland older than 23.1, the X11 input shape isn't forwarded, so the overlay would block clicks.
- A compositing desktop (GNOME, KDE and so on), so the window can be transparent.
- Python 3 with GTK 3 and WebKitGTK bindings, plus Node.js/npm to fetch Three.js:

```bash
sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1
# optional, for the tray icon:
sudo apt install gir1.2-ayatanaappindicator3-0.1
```

### Installation

```bash
git clone https://github.com/yousuf-git/hanging-spidey-linux.git
cd hanging-spidey-linux
npm install
widget/install.sh
```

`install.sh` checks the dependencies, adds a **Hanging Spidey** entry to your app menu, and enables start at login. To undo it:

```bash
widget/install.sh --remove
```

### Running

```bash
widget/run.sh            # start the widget
widget/run.sh --debug    # with a log of moves, frame rate and page errors
```

Launching it again while it's running just shows him if he was hidden (single instance).

## <img src="https://api.iconify.design/lucide/terminal.svg?color=%236e7681&width=22" /> Usage

- **Drag** Miles anywhere with the left mouse button. Drop him near a wall or the ceiling and he sticks; drop him in open space and he falls and lands. Dragging across a monitor edge moves him to that monitor.
- **Right-click** him, or use the tray icon, for the menu:

| Menu item | What it does |
|---|---|
| Hide / Show Miles | Hides the overlay and pauses rendering |
| Pause moves | Keeps idle motion but stops big moves |
| Send to other monitor | Web-swings him across (with more than one monitor) |
| Roam both monitors | Lets him wander across monitors on his own |
| Activity | Calm (1–3 min), Normal (30–90 s) or Playful (10–40 s) between big moves |
| Size | Small, Medium or Large (95 / 120 / 150 px per meter) |
| Reset position | Hangs him back from the ceiling of the primary monitor |
| Start at login | Toggles the autostart entry |
| Quit | Saves his state and exits |

### Previews in a browser

```bash
npm run dev    # serves the project on http://127.0.0.1:8765
```

- `http://127.0.0.1:8765/widget/app.html?debug` runs the widget page in a normal browser (single monitor = the window), showing his clickable outline.
- `preview/movements.html` is a standalone 2D mock-up of the behaviour on a two-monitor layout. It opens directly as a file.

## <img src="https://api.iconify.design/lucide/settings.svg?color=%236e7681&width=22" /> Configuration

Settings change from the menu and are stored per user:

| File | Contents |
|---|---|
| `~/.config/hanging-spidey/settings.json` | `activity`, `size`, `roam`, `paused` |
| `~/.config/hanging-spidey/state.json` | Where he was (surface, monitor, position, line length, grip), restored on the next start |
| `~/.config/autostart/hanging-spidey.desktop` | Start-at-login entry (created by `install.sh` or the menu) |

## <img src="https://api.iconify.design/lucide/palette.svg?color=%236e7681&width=22" /> Design References

The look and the poses were matched against film stills and reference art. The concept started as a sketch of Spidey hanging over the desktop:

<p align="center"><img src="docs/concept-sketch.jpg" alt="Original concept sketch" width="560" /></p>

<details>
<summary>Suit references (Spider-Verse Miles, suit and hoodie)</summary>

<p>
<img src="docs/refs/suit/suit-swing.jpg" height="230" />
<img src="docs/refs/suit/suit-upside-down-fall.jpg" height="230" />
<img src="docs/refs/suit/hoodie-fall.jpg" height="230" />
<img src="docs/refs/suit/hoodie-thwip.jpg" height="230" />
<img src="docs/refs/suit/hoodie-leap.jpg" height="230" />
<img src="docs/refs/suit/hoodie-stand.jpg" height="230" />
</p>

</details>

<details>
<summary>Hanging and crawling references (used for the hang, tuck, wall and ceiling poses)</summary>

<p>
<img src="docs/refs/crawl/hang-feet-diamond.jpg" height="230" />
<img src="docs/refs/crawl/hang-tuck.jpg" height="230" />
<img src="docs/refs/crawl/wall-side-photo.jpg" height="230" />
<img src="docs/refs/crawl/wall-back-view.jpg" height="230" />
<img src="docs/refs/crawl/wall-side-climb.jpg" height="230" />
<img src="docs/refs/crawl/ceiling-glass-crawl.jpg" height="230" />
<img src="docs/refs/crawl/wall-sideways-sketch.jpg" height="230" />
<img src="docs/refs/crawl/wall-crouch-sketch.jpg" height="230" />
</p>

</details>

<details>
<summary>Development previews</summary>

<p>
<img src="docs/screens/movement-preview.jpg" width="48%" alt="2D behaviour preview on a two-monitor layout" />
<img src="docs/screens/pose-lab.jpg" width="48%" alt="Early 3D pose lab" />
</p>

</details>

## <img src="https://api.iconify.design/lucide/map.svg?color=%236e7681&width=22" /> Roadmap

- **Hoodie fit.** Miles in his hoodie, shorts and sneakers, as in the suit references. The current model is suit-only.
- **More poses.** Jump, landing and a "swing ping", from the references in `docs/refs/todo/`:

<p>
<img src="docs/refs/todo/jump.jpg" height="200" />
<img src="docs/refs/todo/landing.jpg" height="200" />
<img src="docs/refs/todo/swing-ping.jpg" height="200" />
</p>

- **Hide during full-screen apps** (videos, games).
- **Lower CPU use during moves.**

## <img src="https://api.iconify.design/lucide/heart.svg?color=%236e7681&width=22" /> Credits

- 3D model: ["Miles from Spider-Man: Across The Spider Verse"](https://sketchfab.com/3d-models/miles-from-spider-man-across-the-spider-verse-6585b5cd701d4b11a66618e20b7c8df7) by CVRxEarth, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Spider-Man and Miles Morales are characters owned by Marvel / Sony Pictures. This is an unofficial fan project, not affiliated with or endorsed by them.
- Reference images in `docs/refs/` belong to their respective owners and are included for design reference only.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%236e7681&width=22" /> License

The source code is licensed under ISC. See [LICENSE](LICENSE). The model, the characters and the reference images are not covered by it (see Credits).

# Node Canvas — a ComfyUI-shaped infinite canvas for DeepSeek Harness

A DSH client plugin: an infinite node canvas in the sidebar. Nodes, ports and workflows are
ComfyUI-shaped, but the runtime is our own Node executor — and a running ComfyUI can be used as a
remote execution backend when you need its node pack.

## What it does

- **Infinite canvas**: create nodes, wire ports, marquee/zoom/pan, groups, undo, minimap.
- **Node packs**: a pack is a folder with `pack.json` (node definitions) and `nodes/<Type>.mjs`
  (programs). A workflow stores types and widget values only — definitions and programs always
  come from the installed packs.
- **Workflows**: save / save as / export / rename / delete, plus a status pill that tells whether
  the canvas still equals its saved copy. A workflow opened from a backend's list lives on that
  backend: saving writes the backend's own file and keeps no local copy, so the two libraries
  never drift apart. Save as creates the new file on the backend and the canvas follows its name.
- **Extensions**: capability packages that enhance the plugin (workflow formats, node views,
  toolbar actions, panels, hover cards, execution backends). Drag a folder into the puzzle menu to
  register one; order them by dragging, top wins. See [extensions/README.md](extensions/README.md).
- **Extension settings**: the gear under the puzzle menu's plus opens a settings window with an
  index of extensions on the left and the selected form on the right. A package declares its
  fields in its own `extension.json` (values only the user knows, such as the ComfyUI folder and
  its Python); the canvas writes them into that package's `settings.json`. Path fields get a
  browse button (the canvas' own folder browser when the desktop app has no native picker), and
  a package may attach `validate` rules that the form checks before saving.

## Install

The plugin is linked into a DSH profile as a local package:

```json
// ~/.dsh/profiles/<profile>/package.json
{ "dependencies": { "@local/node-canvas": "link:D:/path/to/node-canvas" } }
```

Then enable the plugin row `include:node-canvas` in that profile.

## Configure

```bash
cp config.example.json config.json
```

| Key | Meaning |
|---|---|
| `sdCppRoot` | sd.cpp checkout (its `bin/sd-server.exe` and `models/` are used by the sd.cpp pack) |
| `sdCppPort` | port the plugin starts `sd-server` on |
| `outputDir` | folder the previews read finished images from |
| `workspaceRoot` | scratch root for per-run directories (empty = `.workspace/` beside the plugin) |
| `sdServerArgs` | extra flags for `sd-server`, e.g. `["--vae-tiling"]` |

The ComfyUI extension has its own [settings](extensions/comfyui/settings.example.json) (service
path, python, URL). Copy it to `extensions/comfyui/settings.json` when you use that backend.

## Layout

```
client.js      canvas UI (single bundle, no JSX)
index.js       host: packs, workflows, output files, extension routes
executor.js    generic executor: graph → programs, locks, per-run workspace
packs/         node packs
extensions/    capability packages (a ComfyUI format adapter + backend, a hover card)
workflows/     saved workflows (v2: types + values, no definitions)
locale/        plugin name/description shown by the harness
```

## Reference frame

The panel has exactly one coordinate system: the page rect. The canvas is an infinite plane
(`view.x`, `view.y`, `zoom`) of which the shell shows one region; nothing else stores a position.

The rules that keep it that way:

- **No measured size in state.** Anything that needs the canvas area calls `shellSize()` and uses
  the rectangle the shell has at that moment. The resize observer reports only a boolean crossing
  (too small for the overview) and keeps the overview's box in sync imperatively.
- **Derived geometry lives in CSS.** The library menu publishes `--nc-menu-top`, `-w` and `-split`
  on the page; the band under it and both drag handles are `calc()` of those, so a window resize
  never reaches JavaScript. A drag writes the variable directly and re-renders only on release.
- **Chrome that must not move cancels the transform it rides.** During the fullscreen slide the
  page translates by `pageShift`; the overview cancels it with the same value and the same
  transition, so it stays put on screen without a second reference frame.
- **The fullscreen sheet is measured against the viewport** when the panel is flush with the
  window's right and bottom edges (`width: 100%`, `height: calc(100vh - top)`), so dragging a
  window edge follows immediately instead of waiting for a new measurement.
- **The brand button is a window-state switch.** Its lit state is the measured distance from the
  canvas slot's left edge to the window (`< 32px` means the canvas owns the window), never the
  sheet's own state. Pressing it runs two steps in order: grow the sheet to fullscreen and then put
  the host sidebar away, or bring the sidebar back and only then shrink the sheet into the room it
  actually leaves. The second step waits for the sidebar's animation to settle, so the distance the
  sheet travels is always the one that exists at that moment.

## License

No license file yet — add one before publishing if you intend others to reuse it.

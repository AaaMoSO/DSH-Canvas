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
- **Extension settings**: the gear under the puzzle menu's plus opens a settings window. Any
  extension may add a section to it (`registerSettings`) for values only the user knows, such as
  the ComfyUI folder and its Python; the form is written to that extension's `settings.json`.

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

## License

No license file yet — add one before publishing if you intend others to reuse it.

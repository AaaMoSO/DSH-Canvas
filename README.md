# DSH Canvas — a ComfyUI-shaped infinite canvas for DeepSeek Harness

A DSH client plugin: an infinite node canvas in the sidebar. Nodes, ports and workflows are
ComfyUI-shaped, but the runtime is our own Node executor — and a running ComfyUI can be used as a
remote execution backend when you need its node pack.

## What it does

- **Infinite canvas**: create nodes, wire ports, marquee/zoom/pan, groups, undo, minimap.
- **Node packs**: the plugin ships empty — the Local library is whatever you put in `packs/`
  (see [Writing a node pack](#writing-a-node-pack)). A workflow stores types, widget values and
  each node's origin. A newly created executable node pins its program and control schema into the
  workflow; an older node is pinned once it is opened while its pack is still available.
- **Ownership**: every node records the pack that produced it — `origin`, written when the node
  is created and, for a file that predates the field, once when it is first opened. Values are
  `local:<pack>` or `remote:<pack>`. The canvas kind (local / remote / mixed) is the set of its
  nodes' origins and a node's definition comes from its own pack, so a type that two packs both
  declare is never a guess: a node whose pack is missing shows no shape instead of another pack's.
- **Workflows**: save / save as / export / rename / delete, plus a status pill that tells whether
  the canvas still equals its saved copy. Two things are kept apart: a document's **home** is the
  library that created it — fixed for its lifetime, never shown, and what decides where it is
  saved; what it is **made of** (local / remote / mixed) is read from the nodes' origins and is
  what the corner capsule reports. Moving a document between libraries is a rebuild plus a delete,
  never a reassignment. A workflow opened from a backend's list lives on that backend: saving
  writes the backend's own file and keeps no local copy, so the two libraries never drift apart.
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
| `sdCppRoot` | sd.cpp checkout; the sd.cpp node pack (installed under `packs/`) reads its `bin/sd-server.exe` and `models/` |
| `sdCppPort` | port the plugin starts `sd-server` on |
| `outputDir` | folder the previews read finished images from |
| `workspaceRoot` | scratch root for per-run directories (empty = `.workspace/` beside the plugin) |
| `sdServerArgs` | extra flags for `sd-server`, e.g. `["--vae-tiling"]` |

The ComfyUI extension has its own [settings](extensions/comfyui/settings.example.json) (service
path, python, URL). Copy it to `extensions/comfyui/settings.json` when you use that backend.

## Writing a node pack

`packs/` is yours. A pack is one directory in it:

```
packs/my-pack/
  pack.json           # what the nodes are
  nodes/AddText.mjs   # what they do, one file per type
```

`pack.json` — the shape mirrors ComfyUI's `/object_info`:

```json
{
  "name": "My pack",
  "nodes": [
    {
      "type": "AddText",
      "display_name": "Add text",
      "category": "text",
      "inputs": [
        { "name": "text", "type": "STRING", "widget": true, "default": "" }
      ],
      "outputs": [{ "name": "text", "type": "STRING" }]
    }
  ]
}
```

`nodes/AddText.mjs` — the returned array is the node's outputs, in order:

```js
export async function run(inputs, ctx) {
  return [{ text: String(inputs.text ?? '').toUpperCase() }]
}
```

- an input with `"widget": true` is drawn as a control instead of a socket: `"multiline": true`
  makes it a textarea, `"options": [...]` a dropdown, and `"folder"` (with the pack's
  `"modelsRoot"`) a file picker;
- a pack may set `"outputRoot"` and a node `"preview": { "type": "image", "prefixFrom": "…" }`
  to list and show the files that node writes;
- the library re-reads `packs/` every time its menu opens, so a pack you copy in works without a
  restart;
- `config.json` may also set `maxParallel` (default 1 for compatibility; 2–16 enables parallel
  independent branches): independent branches of a workflow run together, while a node marked
  `"concurrency": "exclusive"` still runs alone — across runs and within one;
- `config.json` may set `nodeTimeoutMs`: a node that runs longer fails its run with the node and
  the budget named; 0 or absent keeps it unlimited. JavaScript cannot be pre-empted in-process,
  so an exclusive resource stays held until the underlying program actually stops. Synchronous
  infinite loops still require restarting the Host.
- a node whose program is missing still draws, and only fails when it runs.

Extensions can contribute packs too — see [extensions/README.md](extensions/README.md).

## Layout

```
client.js      canvas UI (single bundle, no JSX)
index.js       host: packs, workflows, output files, extension routes
executor.js    generic executor: graph → programs, locks, per-run workspace
packs/         node packs you install (not tracked: the folder is yours)
extensions/    capability packages (a ComfyUI format adapter + backend, a hover card)
workflows/     saved workflows (v4: types, values, origins, pinned programs/schemas, home)
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

Known limitation: the canvas is fixed in the window, so moving the window (title bar, or dragging
its left/top edge) takes the canvas with it. Making the canvas stay put on screen instead needs the
window's real screen geometry, and the renderer only sees `screenX`/`screenY`, which the host does
not report reliably while an edge is being dragged. Two attempts are recorded in git: a fixed
window-space canvas with a `clip-path` (`window-canvas-attempt`) and a dual-corner compensation
driven by `screenX`. Both were reverted; the feature waits for the host to expose trustworthy
window bounds.
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

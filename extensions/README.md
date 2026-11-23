# 拓展包（extensions）

拓展是**能力层**增强，不是节点内容。节点和工作流由 `packs/` 提供，拓展只影响插件本身的行为
（导入导出格式、节点外观、面板、工具栏动作、宿主接口等）。删掉一个拓展不会让任何已有节点或
工作流失效。

## 目录结构

```
extensions/<id>/
  extension.json     { id, name, version?, description?, client?, host?, icon? }   ← description 会显示在悬停提示里
  icon.svg           可选：UI 上显示的图标（正方形，尺寸不限，界面里会等比缩小）
  client.mjs         可选：浏览器端能力，导出 setup(api)
  host.mjs           可选：宿主端能力，导出 setup(api)
  ...                其余文件随拓展分发（脚本、资源等）
```

`icon` 写相对路径（如 `"./icon.svg"`），支持 `svg / png / jpg / webp / gif`；省略则显示默认的拼图图标。
图标由宿主以图片类型提供，浏览器按方块等比缩放。

- 放在 `extensions/` 下的目录**默认启用**（内置拓展），删掉目录即关闭；
- 也可以在画布右上角的拼图菜单里登记插件目录之外的拓展（拖入或填路径），登记表在
  `extensions.json`。

## 客户端 API（client.mjs）

```js
export function setup(api) {
  api.registerWorkflowFormat({ id, name, parse(raw, ctx), serialize(graph, ctx) })
  api.registerNodeView({
    type, width?, height?,
    render({ node, React, setWidget, getWidget, notify, helpers }),
    onFiles?(paths, { node, setWidget, getWidget, notify })
  })
  api.registerNodeMenu({ label, when?(node), run(node, helpers) })
  api.registerToolbarAction({ id, title, icon?, label?, run(helpers) })
  api.registerPanel({ id, title, width?, render({ React, helpers, close, notify }) })
  api.registerExtensionHover({ render({ extension, React, iconUrl }) })
}
```

## 设置项（extension.json）

需要用户填写的东西（例如 ComfyUI 的安装目录、Python 路径）写在拓展自己的 `extension.json` 里，
画布只负责把它画出来：

```json
{
  "id": "example",
  "name": "Example",
  "settings": [
    {
      "key": "root", "type": "path", "pick": "directory",
      "label": { "en": "Folder", "zh": "目录" }, "hint": { "en": "…", "zh": "…" },
      "validate": { "required": true, "path": "directory" }
    },
    { "key": "exe", "type": "path", "pick": "file", "validate": { "path": "file" } },
    { "key": "url", "type": "text", "placeholder": "http://127.0.0.1:8188", "validate": { "required": true, "pattern": "^https?://" } },
    { "key": "auto", "type": "boolean", "default": true },
    { "key": "timeout", "type": "number", "default": 600000, "validate": { "min": 1000 } }
  ]
}
```

- `type` 取 `text / path / number / boolean / select`（`select` 用 `options: [{ value, label }]`）；
- `pick` 给 `path` 字段配一个「浏览…」按钮（`directory` 或 `file`）；宿主有原生选择框时用它，否则用画布内的文件浏览器；
- `validate` 支持 `required`、`pattern`（正则字符串）、`min` / `max`（数字）与 `path: "file" | "directory"`（保存前由宿主检查是否真实存在），不通过时该字段下方给出原因；
- `label` 与 `hint` 可以是一条字符串，也可以是 `{ en, zh }`，画布按当前语言取用；
- 只声明字段，不存值：保存时画布把值写成该拓展目录下的 `settings.json`（扁平值），并让
  `host.mjs` 重新加载，所以 `host.mjs` 里直接读这个文件即可。

`registerExtensionHover` 用来**替换拓展图标的原生悬停提示**：注册后画布不再显示 `title`，而是在图标
左侧留出的位置渲染你的卡片（`extension` 里带 `name / description / icon / present` 等字段）。
同类只取优先级最高的一份。

`helpers` 提供：`graph / selection / notify / pushHistory / updateGraph / tr / setWidget`。

工作流格式适配器还会收到：`nodeHeight(node)`、`presetOf(color)`、`presetByBody(bgcolor)`、
`widgetInputNames(node)`、`widgetNamesOf(node)`、`widgetValues(node)`。节点不再自带定义与程序，
所以适配器读写控件值时要经由这几个函数，而不是直接读节点上的数组。

## 生命周期

`setup(api)` 可以返回一个清理函数（或 `{ dispose() }`，两者也可返回 Promise）：画布卸载、
拓展重载、排序变化或拓展被移除时调用它。
定时器、子进程、事件监听都应该在那里关掉——**不要把清理留给模块级变量**。

清理最多等 3 秒（渲染侧 2 秒）：超时只停止调用方继续等待，并在日志里报告。JavaScript 无法
终止一个卡住的 Promise，所以清理里不要等待永远不会结束的东西。

由此带来一个必须知道的后果：**超时后旧清理仍可能在跑，而新版本已经 setup**。两者短时间内
会共用同一个目录、端口或全局监听器。契约不提供取消手段，所以清理要幂等、可重入，独占资源
（端口、子进程、文件锁）应在清理里主动释放，并容忍与新实例短暂并存。

`host.mjs` 的模块按文件 mtime 缓存；新版本导入前会先调用旧版本的清理函数，`settings.json` 变化同理。

`api.apiVersion` 是契约版本（当前 `1`）。通过它可以判断某个能力是否可用，而不是猜。

节点视图可以声明 `width` / `height` 请求更大的节点盒子。`onFiles(paths, context)` 接收一次
文件拖放已经转换好的宿主绝对路径；它不是 React 组件，不能使用 hook。

可执行节点被拖入画布时，程序源码和控件 schema 会固定在该节点上；之后 pack 更新不会把新控件
和旧程序拼在一起。固定后的程序从 `data:` URL 导入，没有目录可以解析，所以能否固定由**模块
说明符**决定：

- 允许：无 import；`node:` 内置模块（`import { readFile } from 'node:fs/promises'`、
  `require('node:fs')`）；`import.meta.url`；注释、字符串、正则与模板文本里出现的 import 字样；
- 不允许：相对/绝对路径、包名（`import 'lodash'`）、以及说明符不是字面量的动态 import
  （例如 `import(name)`）。

检测器是词法级的：它跳过注释、字符串、正则和模板文本，但会进入模板的表达式部分。程序不满足
上述条件时保留对 pack 的引用，创建时提示一次。

需要跟随 pack 改版的节点可以在节点菜单里选「从节点库刷新」：它会按当前定义**重建整个节点**
（端口、控件 schema、控件顺序、预览），保留自定义标题、位置、尺寸和模式，控件值按名称迁移；
新定义里不再存在的端口会被移除，指向它们的连线一并删除并在提示里给出数量。

## 执行上下文与进程隔离

`config.json` 的 `nodeTimeoutMs > 0` 且 `nodeIsolation: "auto"`（默认）时，节点程序在子进程里
执行：

- 输入与输出必须能 structured clone；
- 模块状态不会跨节点复用，模块顶层代码每次执行都会重新运行；
- `ctx.onRunEnd(release)` 只接受 `ctx.lock()` 返回的句柄（该租约本来就保留到运行结束）。
  其他清理函数无法跨进程保存，会被写进运行日志，而不是静默丢弃；
- 同步死循环可以被终止，因为宿主杀的是进程。

约定：

- 全部是**追加**，不替换核心行为；同类能力按加载顺序生效，先注册的先赢；
- 节点视图只负责节点控件下方的额外区域，不接管控件本身；
- `render` 抛错只会显示一行错误，不会影响画布。

## 执行后端与「源」

后端契约（`registerBackend`）：

```js
{
  id, name,
  prepare(),   // 可选：准备好节点形状；返回一个包，或一个包数组
  status(),    // 可选：{ ready, starting, startedAt, error }，面板重开后据此接着显示进度
  probe(),     // 可选：进程是否在跑（不会启动任何东西）
  start({ prompt, label }),   // 提交一次运行，返回 { id }
  poll(id),    // { status: 'queued'|'done'|'error'|'cancelled', images?, error? }
  cancel(id),  // 可选
  deactivate(),// 可选：关闭服务，返回 { stopped }
  writeWorkflow(name, workflow), listWorkflows(), readWorkflow(name),
  newWorkflow(),       // 可选：本源的「新建工作流」返回什么文档；声明了才有库底那个加号
  importWorkflow(file, ctx), // 可选：本源怎么读一个工作流文件；声明了才有库底那个导入虚线框
  menu: { items: [...] }     // 可选：本源自己画的菜单行，见下（与 registerSource 同一套）
}
```

每个后端同时是一个**源**，源决定节点库和工作流库显示谁的内容：

- 后端给的节点形状**只在服务运行期间有效**：服务一停就卸载，画布上引用这些节点的文档随之显示为「未定义」，
  下次启动再同步；
- `packs/` 里的包属于 `local`；
- 后端提供的包属于该后端（包上带 `source`，缺省取 `remote`）；
- 一个后端可以返回**多个包**——例如 ComfyUI 兼容层按 `python_module` 把上千个节点拆回它们原本的包，
  节点库就按这个结构分组，而不是一坨。

菜单里的「源」可以切换当前源；切换后节点库与工作流库都只列该源的内容。

后端之外，拓展还可以**自带一个源**（`registerSource`）——一个由它自己管理的工作流库，
比如内置的 `mixed`：

```js
api.registerSource({
  id, name,                    // 源的 id 同时是文档里的 home
  menu: {                      // 可选：这个源自己画的菜单条目；不声明就用画布默认的
    items: [{                  // 一行一个条目，id 对应画布内置的那一行
      id: 'nodes',             // 目前内核认 'nodes'（「节点库」这一行）
      count(ctx),              // 可选：源列表里报几个节点
      rows(ctx, picked),       // 可选：主菜单该行下面就地展开的行
      panel(ctx, picked),      // 可选：子菜单里该行对应的内容
    }],
  },
  importWorkflow(file, ctx),   // 可选：这个源怎么读一个工作流文件；声明了才有库底那个导入虚线框
  allowsMixed: true,           // 该源的文档允许混合各源节点（本地的限制对它不生效）
  runRequires: 'local',        // 逻辑归属为 local 才允许运行
  order,                       // 在源列表里的位置
  listWorkflows(),             // [{ name, bytes, mtime, counts, types }]，counts 是 origin 的计数
  readWorkflow(name),          // 文档 { home, graph }，或 null
  writeWorkflow(name, document),
  deleteWorkflow(name), renameWorkflow(from, to),
})
```

约定：

- **导入归源自己**：`importWorkflow({ name, text }, ctx)` 返回 `{ graph }` 就把这张图当成该源的未命名文档打开（保存时写进该源）；返回 `null` 就当没读出来。
  `ctx.parse(text)` **只认这个源自己声明的格式**（`registerWorkflowFormat` 里 `id` 与源 id 相同的那个适配器），外加画布自己的文档格式；别的拓展的格式在这里读不出来，所以不会互相污染。
  没声明导入的源，工作流库底部不会出现导入虚线框；本地由画布内置的读取器负责（同样只读画布自己的文档格式）；
- **菜单归声明它的那个源画**：声明了 `menu.items` 的源（注册源或同名的后端都行），主菜单对应那一行下面是它
  `rows()` 生成的行，子菜单是它 `panel()` 生成的行；没声明的源保持画布默认的行，一行都不会多；
  工作流那一行可以用 `ctx.workflowList() / workflowHints() / workflowSlots()` 把画布原本的列表拆开重拼，
  用 `ctx.isCurrent(name)` 判断哪个是画布正在打开的文档；
- `ctx` 给选行的料和拼行的件：`sources / packsOf(id) / readyOf(id) / sourceIcon(id, size) / tr /
  picked / pick(id)`，行用 `pickRow(id, { label, ready, note }) / packRow(pack) / packOpen(pack) /
  nodeRow(pack, def) / hint(text) / header(text)` 拼。节点行自带拖拽、悬停预览和展开状态，
  拓展不用碰画布内部；
- 文档的 `home`（事实归属）决定它存在哪里，逻辑归属（local / remote / mixed）由节点
  `origin` 现算，两者互不替代；
- 存储由拓展自己负责，卸载拓展即随它一起消失——内置的 `mixed` 就把文档写在
  `extensions/mixed/workflows/`。

**新建工作流也归源自己管**：本地库总有那个虚线加号；后端声明了 `newWorkflow()` 且服务可用时，
它的工作流库底部才出现同样的加号。确认后画布放上该函数返回的文档——此时它还没有名字，不会
自动保存、也不能运行；等到命名保存，文件写回声明它的那个源。

## 优先级


拼图菜单里的拓展方块可以上下拖动，**越靠上优先级越高**。加载顺序从低到高：所有拓展按从下到上
依次 `setup(api)`，收集到的能力表再反转，所以冲突时高优先级先命中。

- 拖完会立刻保存并重新读取拓展、重建能力表，画布随之更新；
- `setup(api)` 可能被**重复调用**（重排、重新加载），请保持幂等：不要在里面挂全局监听或
  定时器，除非先做去重；
- 改动拓展的**文件**不会自动生效（ESM 模块有缓存），刷新页面即可。

## 宿主 API（host.mjs）

```js
export function setup(api) {
  api.route('GET', '/info', async ({ query }) => ({ status: 200, body: { ok: true } }))
  api.route('POST', '/convert', async ({ body }) => ({ status: 200, body: { … } }))
}
```

- 路由挂在 `/node-canvas/ext/<id><path>`；
- 处理器返回 `{ status, body }`（或直接返回对象）；
- 模块按文件 mtime 缓存，改完下一次请求即生效。

## 内置示例：`comfyui`

- `client.mjs`：注册 ComfyUI 工作流格式（导入/导出）；
- `host.mjs`：`POST /node-canvas/ext/comfyui/convert` `{ dir }`，把 ComfyUI 自定义节点包
  转成 `pack.json` 返回；
- `tools/pack-from-python.mjs`：转换脚本本体，也可直接命令行使用。

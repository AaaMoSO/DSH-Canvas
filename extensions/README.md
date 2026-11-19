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
  api.registerNodeView({ type, render({ node, React, setWidget, notify, helpers }) })
  api.registerNodeMenu({ label, when?(node), run(node, helpers) })
  api.registerToolbarAction({ id, title, icon?, label?, run(helpers) })
  api.registerPanel({ id, title, width?, render({ React, helpers, close, notify }) })
  api.registerExtensionHover({ render({ extension, React, iconUrl }) })
  api.registerSettings({ id, title, fields: [ { key, type, label, placeholder?, hint?, default?, options? } ] })
}
```

`registerSettings` 在拼图菜单里 "+" 下方的**设置**窗口里加一节表单，用来填写只有用户才知道的东西
（例如 ComfyUI 的安装目录、Python 路径）。`type` 取 `text / path / number / boolean / select`；
`label` 与 `hint` 可以是字符串，也可以是 `{ en, zh }`，画布会按当前语言取用。保存时写入该拓展目录下的
`settings.json`（扁平值），并让拓展的 `host.mjs` 重新加载，因此 `host.mjs` 里直接读这个文件即可。

`registerExtensionHover` 用来**替换拓展图标的原生悬停提示**：注册后画布不再显示 `title`，而是在图标
左侧留出的位置渲染你的卡片（`extension` 里带 `name / description / icon / present` 等字段）。
同类只取优先级最高的一份。

`helpers` 提供：`graph / selection / notify / pushHistory / updateGraph / tr / setWidget`。

工作流格式适配器还会收到：`nodeHeight(node)`、`presetOf(color)`、`presetByBody(bgcolor)`、
`widgetInputNames(node)`、`widgetNamesOf(node)`、`widgetValues(node)`。节点不再自带定义与程序，
所以适配器读写控件值时要经由这几个函数，而不是直接读节点上的数组。

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
  writeWorkflow(name, workflow), listWorkflows(), readWorkflow(name)
}
```

每个后端同时是一个**源**，源决定节点库和工作流库显示谁的内容：

- `packs/` 里的包属于 `local`；
- 后端提供的包属于该后端（包上带 `source`，缺省取 `remote`）；
- 一个后端可以返回**多个包**——例如 ComfyUI 兼容层按 `python_module` 把上千个节点拆回它们原本的包，
  节点库就按这个结构分组，而不是一坨。

菜单里的「源」可以切换当前源；切换后节点库与工作流库都只列该源的内容。

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

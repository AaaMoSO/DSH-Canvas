# comfyui-sdcpp（转换生成）

本目录的 `pack.json` **不是手写的**，由插件自带工具从 ComfyUI 自定义节点包静态转换而来：

```
node node-canvas/extensions/comfyui/tools/pack-from-python.mjs \
  "ComfyUI/ComfyUI-aki-v3.2/ComfyUI/custom_nodes/comfyui-sdcpp" \
  "node-canvas/packs/comfyui-sdcpp/pack.json"
```

源包更新后重新执行上面这条命令即可；画布打开菜单时会重新读取，不需要重启。

## 转换做了什么

- 读 `__init__.py` 的 `NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS`；
- 在包里所有 `.py` 中找到对应 class，解析 `INPUT_TYPES()` 返回的字面量、`RETURN_TYPES` / `RETURN_NAMES`、`CATEGORY`；
- 解析模块级字符串常量（如 `SDCPP_TYPE = "SDCPP_MODEL"`），把 `(SDCPP_TYPE,)` 还原成 `SDCPP_MODEL` 插槽；
- 解析 `INPUT_TYPES()` 里的局部变量赋值：字面量列表 → 有候选项的下拉；函数调用（如 `model_files("vae")`）→ 候选未知的下拉。

## 已知限制

- **不执行 Python**：运行期才算得出来的候选列表拿不到，这类控件只有名字、没有选项；
- 动态生成的节点（`comfy_entrypoint()` 那套 V3 API）尚未支持，只覆盖旧式 `NODE_CLASS_MAPPINGS`；
- 包的 `web/` 前端扩展（本例是拖放上传 LoRA 的 JS）不会被带入，它属于 ComfyUI 前端运行时。

## 运行程序（nodes/）

`pack.json` 只描述"节点长什么样"，**执行**由本目录下的 `nodes/` 提供：一个类型一个文件，文件名就是类型名。

```
packs/comfyui-sdcpp/
  pack.json           定义：输入、输出、控件
  nodes/
    SDCppSeed.mjs
    SDCppCLIPTextEncode.mjs
    SDCppEmptyLatentImage.mjs
    SDCppVAELoader.mjs
```

程序约定（执行器只管调用与传值）：

```js
export async function run(inputs, ctx) {
  // inputs：已解析好的 { 输入名: 值 }，连线取的是上游返回数组的对应槽位
  // ctx：{ nodeId, runId, signal, log }
  return [输出0, 输出1]        // 槽位 = 下标
}
```

**程序属于节点，不属于包**：读取节点包时，宿主会把 `nodes/<Type>.mjs` 的源码附加到该节点定义上；客户端创建节点时把源码**复制进节点实例**（`node.program`），运行画布时随 prompt 一起提交。因此：

- 改包名、挪包目录、删掉整个包，已有节点照常运行；
- 执行器优先用节点自带的源码；只有节点没有自带源码时，才回退到按类型扫描 `packs/*/nodes/*.mjs` 与插件根的 `nodes/*.mjs`；
- 节点定义里也可以直接写 `"program": { "source": "…" }`，与文件等价。

**已实现**：`SDCppSeed`、`SDCppCLIPTextEncode`、`SDCppEmptyLatentImage`、`SDCppVAELoader`、`SDCppLoadModel`、`SDCppKSampler`、`SDCppVAEDecode`（`SaveImage` 在 `comfyui-core` 包里）。它们直接与本机 `sd-server.exe` 通信：

| 用途 | 请求 |
|---|---|
| 状态 / 启动 | `GET /sdcpp/v1/models/status`；未运行时按配置拉起 `bin\sd-server.exe` |
| 刷新目录 | `POST /sdcpp/v1/models/refresh`（recipe 不在目录里时自动重试一次） |
| 加载 | `POST /sdcpp/v1/models/load`（body: `{recipe, models}`） |
| 生成 | `POST /sdcpp/v1/img_gen` → 返回 `poll_url`；轮询 `GET <poll_url>` 直到 `completed/failed/cancelled` |

机器级参数放在 **`node-canvas/config.json`**（不属于节点，也不属于包）：

```json
{
  "sdCppRoot": "D:\\…\\sd.cpp",
  "sdCppPort": 8288,
  "outputDir": "D:\\…\\ComfyUI\\output"
}
```

**已知限制**：LoRA 只按名字/路径直传，不做 sd.cpp 的 fused-QKV 转换（转换需要 Python + safetensors + gguf）；需要转换的 LoRA 请先用 ComfyUI 那边的节点转好。

## 并发声明（options.json）

`pack.json` 由转换脚本生成，手工字段会被覆盖，所以并发声明放在同目录的 `options.json`：

```json
{
  "SDCppLoadModel": { "concurrency": "exclusive", "resource": "sd-server" },
  "SDCppKSampler":  { "concurrency": "exclusive", "resource": "sd-server" },
  "SDCppUpscale":   { "concurrency": "exclusive", "resource": "sd-server" }
}
```

- `exclusive`：从首次调用起**持锁到整次运行结束**，其它工作流在该资源上排队；`resource` 相同的节点共用一把锁（不写则用节点类型名）；
- `shared`（默认）：可被多条工作流同时调用，程序必须是纯函数——只读 `inputs`、只返回 `outputs`，不使用模块级可变状态；写文件时用 `ctx.workspace` 或 `ctx.runId` 做命名空间。

## 运行工作区（ctx.workspace）

每次运行会分配一个私有临时目录，路径通过 `ctx.workspace` 传给节点程序：

```
<插件>/.workspace/<runId>/          （可由 config.json 的 workspaceRoot 改位置）
```

- 运行期间可自由读写，**别的运行看不到**；
- 运行结束（成功、失败或被取消）后整个目录**自动删除**；
- 需要保留的产物应写到 `outputDir`（即 `SaveImage` 的行为），而不是工作区。





# ComfyUI 核心节点

只放 ComfyUI 自带、SDCpp 工作流会用到的核心节点定义。这些节点在 ComfyUI 里不是自定义包，但画布需要一个定义才能画出它们的控件。

## 已收录

| 类型 | 显示名 | 输入 | 输出 | 额外 |
|---|---|---|---|---|
| `SaveImage` | Save Image | `images`(IMAGE 插槽)、`filename_prefix`(STRING 控件，默认 `ComfyUI`) | `images`(IMAGE，原样透传) | 节点下半部显示成品图预览 |

## Save Image 的保存规则

对齐 ComfyUI `SaveImage` + `folder_paths.get_save_image_path()` 的行为：

- **文件名**：`<前缀>_<五位数计数>_.png`，计数接着目标目录里已有的最大编号往后排（按前缀匹配，忽略大小写）；
- **子目录**：前缀里带路径（如 `SD/foo`）会落到 `output/SD/`，目录自动创建；**禁止**写到输出目录之外（`../` 会被拒绝）；
- **占位符**：`%width%`、`%height%`、`%year%`、`%month%`、`%day%`、`%hour%`、`%minute%`、`%second%`，以及逐张替换的 `%batch_num%`；
- **透传**：与 ComfyUI 一致，节点把输入图原样作为 `images` 输出，便于继续串联；
- **不重编码**：sd.cpp 给的就是 PNG，直接原样写字节（不重新压缩，也不写 PNG 元数据）。

## 图片预览怎么来的

- 包级字段 `outputRoot` 指向 ComfyUI 的输出目录（本机为 `…\ComfyUI\output`）；
- 节点定义里的 `preview: { "type": "image", "prefixFrom": "filename_prefix" }` 说明预览读哪个目录、用哪个控件的值当前缀；
- 前缀带子目录时，预览会在对应子目录里列文件；前缀含 `%占位符%` 时无法静态匹配，改为列出该目录最新文件并由运行时间过滤；
- 预览**只显示最近一次运行产出的图片**（按文件 mtime 与运行开始时间比对），按原比例横向排开，几张就排几张；点任意一张打开原尺寸查看；
- 运行状态变化时会自动重新拉取列表。

## 扩展

直接往 `nodes` 数组追加定义即可，画布打开菜单时重新读盘，**不需要重启**。若新节点也要预览，给它加 `preview` 并确认包里有 `outputRoot`。

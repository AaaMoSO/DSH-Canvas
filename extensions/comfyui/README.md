# ComfyUI 兼容拓展

## 设置（settings.json）

```json
{
  "comfyuiUrl": "http://127.0.0.1:8188",
  "timeoutMs": 30000,
  "autostart": true,
  "comfyuiRoot": "<ComfyUI 目录，含 main.py>",
  "pythonExe": "<python.exe>",
  "comfyuiArgs": ["--listen", "127.0.0.1", "--port", "8188"],
  "startupTimeoutMs": 180000,
  "stopExternal": false
}
```

- 切换到 ComfyUI 后端时，拓展会先 `POST /service/start`（已在跑则跳过），再同步节点形状；
- 切回「本地」时调用 `POST /service/stop`，只结束**本插件启动的**进程；
  `stopExternal: true` 时还会按端口找 PID 关掉外部启动的实例；
- 启动日志写在拓展目录的 `comfyui-server.log`。

## 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/nodes` | object_info → 节点形状（60 秒缓存） |
| POST | `/run` | 提交 prompt，返回 promptId |
| GET | `/run/<id>` | 查询执行状态与产物 |
| POST | `/interrupt` | 中断当前任务 |
| POST | `/service/start` `/service/stop` | 启停 ComfyUI |
| GET | `/service/status` | 是否由本插件启动、是否可达 |
| POST | `/convert` | ComfyUI Python 节点包 → pack.json |
| POST | `/workflow/write` | 把编辑后的工作流写回 ComfyUI 的 `user/default/workflows/` |
| GET | `/workflow/list` | 列出 ComfyUI 里已有的工作流名 |

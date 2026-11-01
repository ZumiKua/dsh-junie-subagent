# @zumikua/dsh-junie-subagent

[English](README.md) | 中文

把一次性任务通过 Agent Client Protocol 交给 JetBrains Junie CLI 执行，并把
Junie 的最终答复作为子智能体结果返回。

## 前置条件

- DSH `>= 0.2.1-rc.2`；
- 已安装并登录 JetBrains Junie CLI。provider 按下列顺序查找：
  1. `JUNIE_PATH` 环境变量；
  2. 插件行的 `command` 配置；
  3. 托管安装的 `~/.local/share/junie/current` 指针 —— Windows 上是
     `<版本>/junie/junie.exe`，其它平台是 `<版本>/bin/junie`；
  4. `PATH` 上的 `junie.exe` / `junie`（Windows 上跳过 `.bat` shim）。

  全都找不到时，委派会带上尝试过的每个路径报错，设置页也会直接提示，而不是显示一个
  空的模型列表。

## 安装

在 DSH Web UI 的**插件**页里安装 `@zumikua/dsh-junie-subagent` 即可：插件管理器会一步完成
"安装包 + 选中 bundle"。bundle 的 patch 会插入一个 provider 和一个名为 `junie` 的
`dsh-tool-subagent` 实例。

安装完成后需要重启一次 DSH：浏览器半边（`client.js`）是在启动时进入页面模块表的。
之后打开**设置 → Junie**，选择模型和思考深度。

## 一次运行的时序

```
spawn <junie.exe> --acp=true --skip-update-check
  → initialize
  → session/new { cwd, mcpServers: [] }
  → session/set_config_option（model / effort / brave_mode，按配置下发）
  → session/prompt { prompt: [{ type: "text", text }] }
  ← session/update … agent_message_chunk 文本 …
  ← result { stopReason }
  → dispose（session/cancel、stdin EOF、terminate、等待退出）
```

每次运行独占一个进程和一个会话：子智能体 seam 对外部子级没有续接接口，因此一次运行
不会接受后续消息。

## 隔离边界

子进程通过 `ctx.subprocess` 启动，**不携带沙箱策略**，因此它以当前登录用户的身份运行、
拥有该用户的完整文件权限 —— 这也是 Junie 能把会话写进 `~/.junie` 的前提。约束来自
Junie 自己的权限模型：`brave_mode`、命令允许列表，以及
`session/request_permission`（由本 provider 按 `permission` 回答）。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `junie` | 在 `ctx.subagents` 上的名字 |
| `command` | 自动检测 | 显式指定启动器路径；路径不存在会报错，而不是静默回退 |
| `args` | `["--acp=true"]` | 额外参数；`--acp=true` 与 `--skip-update-check` 始终会补齐 |
| `model` | `mix.normal` | 设置页尚未保存任何值时的兜底模型 |
| `effort` | `high` | 设置页尚未保存任何值时的兜底思考深度 |
| `braveMode` | `brave-auto` | `brave-auto` / `on` / `off` |
| `permission` | `reject` | 自动回答 `session/request_permission`：默认拒绝，或选第一个允许项 |
| `timeoutMs` | `900000` | 单次运行的总时限 |
| `graceMs` | `3000` | 子进程回收宽限 |

## 模型选择

bundle 只注册一个 provider（`junie`）和一个面向模型的工具（`junie`）。模型与思考
深度在设置页选择、由宿主保存；上面的 `model` / `effort` 只是"尚未保存过"时的兜底。

工具层面的 `provider` / `model` / `reasoning_effort` 参数**不可用**：
`dsh-tool-subagent` 会用宿主的 LLM 目录（`llm.resolveCallConfig`）校验它们，而 Junie
的模型 id 并不是 LLM 路由 —— 官方 Codex、Claude Code 与 ACP provider 之所以不声明
`agentOptions` 能力，也是同一个原因。

## 设置页与存储

1. 设置页位于设置面板左侧的「Junie」分区，可以选择模型、思考深度，以及 Junie 的 brave mode（`auto` / `on` / `off`）；
2. 读写走宿主注册的同源路由 `GET/PUT /junie-subagent/config`，数据存放在
   `~/.dsh/junie-settings.json`；
3. 模型下拉列表来自 Junie 自己 ACP `session/new` 返回的 `configOptions`
   （分组渲染，缓存 10 分钟，不消耗额度）；
4. 思考深度的可选项取决于模型。保存时会用一个临时会话向 Junie 校验，不支持的组合
   返回 `400` 并提示该模型支持哪些档位，且不会改动界面上的选项列表；
5. 修改从下一次委派开始生效。插件不会弹窗，对权限请求一律自动拒绝：`brave-auto`（自动）放行安全操作、其余拒绝，`off`（保守）全部拒绝，`on`（放开）全部执行。

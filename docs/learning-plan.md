# OpenClaw Agent 学习计划

OpenClaw 本质上是一个 **多通道 AI Agent 网关**——将各种消息平台（Telegram、Discord、WhatsApp、Slack 等）与 AI 模型（默认 Anthropic Claude）连接起来，通过可扩展的插件系统支持自定义集成。

---

## 阶段一：整体架构鸟瞰

**目标：** 理解项目的宏观结构和核心概念

**核心阅读：**
- `package.json` — 项目元数据、依赖、命令
- `src/entry.ts` → `src/cli/run-main.ts` → `src/cli/program/build-program.ts` — CLI 启动链
- `src/config/types.ts` + `src/config/types.agents.ts` — 核心类型定义，理解 Agent、Channel、Gateway 等领域概念

**关键概念：**

| 概念 | 说明 |
|------|------|
| **Gateway** | 运行时服务器，管理所有通道连接和 Agent 执行 |
| **Agent** | AI 实体，有自己的配置、模型、工具、技能 |
| **Channel** | 消息渠道（Telegram、Discord 等），通过插件化架构统一接入 |
| **Session** | 一次对话的上下文，包含历史消息、工具调用记录 |
| **Routing** | 消息路由，决定一条入站消息发往哪个 Agent |

---

## 阶段二：消息流转全链路

**目标：** 理解一条用户消息从进入到回复的完整链路

**消息处理流程图：**

```
用户发消息 (Telegram/Discord/...)
    │
    ▼
Channel Plugin 接收入站消息
    │
    ▼
Route Resolution (路由解析: channel + peer → Agent)
    │
    ▼
Session Management (加载/创建对话 session)
    │
    ▼
State Machine (排队、去重)
    │
    ▼
Pi Embedded Runner (调用 AI 模型 + tool-use 循环)
    │
    ▼
Streaming Events → Block Reply Pipeline (分块发送)
    │
    ▼
Channel Outbound (格式化发送到目标通道)
    │
    ▼
用户收到回复
```

**核心阅读：**
1. `src/routing/resolve-route.ts` — 路由解析（优先级：peer > guild > channel > default）
2. `src/channels/session.ts` — 入站消息 session 记录
3. `src/channels/run-state-machine.ts` — 消息处理状态机
4. `src/auto-reply/reply/agent-runner.ts` — 顶层 Reply Agent 编排
5. `src/auto-reply/reply/agent-runner-execution.ts` — Turn 执行与 Fallback

---

## 阶段三：Agent 执行引擎（核心重点）

**目标：** 深入理解 AI 模型调用、tool-use 循环、streaming 的工作原理

### 3.1 Runner 体系

| Runner 类型 | 入口文件 | 用途 |
|------------|---------|------|
| Embedded Pi Runner | `src/agents/pi-embedded-runner/run.ts` | 主 runner，内嵌 API 调用 |
| CLI Runner | `src/agents/cli-runner.ts` | 通过外部 CLI 进程执行 |

### 3.2 Embedded Runner 核心调用链

```
runReplyAgent (编排层)
  → runAgentTurnWithFallback (fallback + 重试)
    → runEmbeddedPiAgent (主运行循环)
      → runEmbeddedAttempt (单次 LLM 调用)
        → createAgentSession (SDK: 创建 session)
        → session.prompt() (SDK: 发起 LLM 调用 + tool-use 循环)
```

**核心阅读：**
1. `src/agents/pi-embedded-runner/run.ts` — **主运行循环**（~1500行），包含：认证轮换、context overflow 处理、compaction 触发、overload backoff
2. `src/agents/pi-embedded-runner/run/attempt.ts` — **单次 Attempt**（~2000行），包含：session 初始化、工具集创建、stream 函数配置、prompt 执行
3. `src/agents/pi-embedded-subscribe.ts` — **Streaming 事件订阅**，处理文本 delta、thinking block、tool call 事件

### 3.3 关键机制

| 机制 | 文件 | 说明 |
|------|------|------|
| 模型解析 | `src/agents/pi-embedded-runner/model.ts` | 解析模型标识、查找 registry |
| 认证轮换 | `src/agents/model-auth.ts` + `src/agents/auth-profiles/` | 多 API Key 轮换策略 |
| 模型 Fallback | `src/agents/model-fallback.ts` | 模型故障时自动切换 |
| Extra Params | `src/agents/pi-embedded-runner/extra-params.ts` | 温度、cache retention 等 |
| 历史限制 | `src/agents/pi-embedded-runner/history.ts` | session 历史消息数量限制 |

---

## 阶段四：工具系统（Tool System）

**目标：** 理解 Agent 如何获得和使用工具

**核心阅读：**
1. `src/agents/pi-tools.ts` — **工具组装核心** `createOpenClawCodingTools()`，包含工具策略过滤
2. `src/agents/pi-embedded-runner/tool-split.ts` — 工具拆分（SDK 内置 vs 自定义）
3. 各工具实现（按兴趣选读）：

| 工具 | 文件 |
|------|------|
| Web 搜索/抓取 | `src/agents/tools/web-search.ts` / `web-fetch.ts` |
| 浏览器自动化 | `src/agents/tools/browser-tool.ts` |
| 消息发送 | `src/agents/tools/message-tool.ts` |
| 子 Agent 生成 | `src/agents/tools/sessions-spawn-tool.ts` |
| 记忆系统 | `src/agents/tools/memory-tool.ts` |
| 定时任务 | `src/agents/tools/cron-tool.ts` |
| 图像生成 | `src/agents/tools/image-tool.ts` |
| TTS | `src/agents/tools/tts-tool.ts` |

---

## 阶段五：系统提示词与上下文管理

**目标：** 理解 Agent 的"大脑"是如何被配置的

**核心阅读：**
1. `src/agents/system-prompt.ts` — **系统提示词构建**（~700行），章节包括：
   - 工具说明、安全约束、技能加载、记忆召回、授权发送者、沙箱信息、消息路由指引等
2. `src/agents/pi-embedded-runner/compact.ts` — **上下文压缩**（Compaction），当 token 接近上限时自动总结旧消息
3. `src/agents/pi-embedded-runner/system-prompt.ts` — 提示词覆盖机制

**系统提示词包含的章节：**

| 章节 | 内容 |
|------|------|
| Tooling | 可用工具列表及说明 |
| Tool Call Style | 工具调用风格指引 |
| Safety | 安全约束 |
| Skills | 可用技能（从 SKILL.md 加载） |
| Memory Recall | 记忆搜索指引 |
| Authorized Senders | 授权发送者 |
| Sandbox | 沙箱信息 |
| Runtime | 运行时信息行 |

---

## 阶段六：Gateway 服务器

**目标：** 理解运行时服务的启动和请求处理

**核心阅读：**
1. `src/gateway/server.impl.ts` — **主入口** `startGatewayServer()`，配置加载、插件初始化、通道启动、HTTP/WS 服务器创建
2. `src/gateway/server-http.ts` — HTTP 路由（Hooks、OpenAI 兼容 API、Slack webhook、静态文件）
3. `src/gateway/server-channels.ts` — Channel Manager，管理各通道生命周期
4. `src/gateway/server-chat.ts` — Agent 事件 → 消息发送处理

---

## 阶段七：通道与插件系统

**目标：** 理解多通道接入和扩展机制

**核心阅读：**
1. `src/channels/plugins/types.plugin.ts` — **ChannelPlugin 接口**（所有通道的统一抽象）
2. `src/channels/registry.ts` — 通道注册表
3. 选一个核心通道深入（推荐 `src/telegram/`，相对简洁）
4. `src/plugins/types.ts` — 插件定义接口
5. `src/plugins/discovery.ts` → `loader.ts` → `registry.ts` — 插件生命周期
6. `src/plugins/hooks.ts` — Hook 系统（`before-agent-start`、`after-tool-call` 等）

---

## 阶段八：辅助子系统（按兴趣选学）

| 子系统 | 目录 | 说明 |
|--------|------|------|
| 记忆系统 | `src/memory/` | 长期记忆搜索与存储 |
| 上下文引擎 | `src/context-engine/` | 智能上下文管理 |
| 媒体管道 | `src/media/` | 图片/音频/视频处理 |
| 浏览器自动化 | `src/browser/` | Playwright 驱动的浏览器控制 |
| Canvas Host | `src/canvas-host/` | 交互式 HTML 生成 |
| TTS | `src/tts/` | 文字转语音 |
| 定时任务 | `src/cron/` | Cron 调度 |
| ACP | `src/acp/` | Agent Communication Protocol |
| 配对系统 | `src/pairing/` | 设备配对 |

---

## 建议学习路线

```
第1周: 阶段一 + 阶段二 (架构鸟瞰 + 消息链路)
第2周: 阶段三 (Agent 执行引擎 — 最核心最复杂)
第3周: 阶段四 + 阶段五 (工具系统 + 提示词)
第4周: 阶段六 + 阶段七 (Gateway + 通道/插件)
第5周+: 阶段八 (按兴趣深入各子系统)
```

---

## 项目目录结构速查

| 目录/文件 | 用途 |
|---|---|
| `src/` | 核心源代码 |
| `src/agents/` | Agent 系统（Runner、工具、提示词、模型管理） |
| `src/agents/pi-embedded-runner/` | 核心 AI 执行引擎 |
| `src/agents/tools/` | Agent 可用工具实现 |
| `src/gateway/` | Gateway 服务器 |
| `src/channels/` | 通道抽象层 |
| `src/routing/` | 消息路由 |
| `src/config/` | 配置系统 |
| `src/plugins/` | 插件系统 |
| `src/auto-reply/` | 自动回复逻辑 |
| `src/cli/` | CLI 命令 |
| `extensions/` | 扩展插件（~40个，各通道独立包） |
| `apps/` | 原生应用（macOS、iOS、Android） |
| `docs/` | Mintlify 文档 |
| `ui/` | Web UI |
| `packages/` | 共享 workspace 包 |
| `scripts/` | 构建/发布脚本 |
| `skills/` | AI Agent 技能文件 |

---

## 核心依赖

| 包名 | 用途 |
|------|------|
| `@mariozechner/pi-ai` | 底层 AI API 客户端（流式调用） |
| `@mariozechner/pi-coding-agent` | Coding Agent 框架（SessionManager、内置工具、compaction） |
| `@mariozechner/pi-agent-core` | Agent 核心类型定义 |
| `commander` | CLI 框架 |
| `zod` | 配置 Schema 验证 |
| `jiti` | 运行时 TS 加载（插件系统） |

# OpenClaw Agent 任务拆解机制

## 核心思路

OpenClaw 的任务拆解不是一个独立的"规划引擎"，而是通过 **主 Agent + Sub-Agent 层级编排** 实现的。主 Agent 由 LLM 自主决定是否需要拆分任务，然后通过 `sessions_spawn` 工具创建子 Agent 来并行/串行执行子任务。

---

## 整体流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                     用户发送复杂任务                              │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   主 Agent (Main Agent)                          │
│                                                                 │
│  System Prompt 中包含:                                           │
│  ├── 工具列表: sessions_spawn / subagents / sessions_send       │
│  ├── Skills 列表: 按需加载 SKILL.md                              │
│  ├── Memory Recall: 检索历史记忆辅助决策                          │
│  └── Bootstrap 文件: AGENTS.md / SOUL.md 等项目上下文             │
│                                                                 │
│  LLM 自主判断:                                                   │
│  ├── 任务是否需要拆分?                                           │
│  ├── 是否需要并行执行?                                           │
│  ├── 选择哪个 agentId 来执行?                                    │
│  └── 是否需要调用 Skill?                                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         直接执行     调用 Skill    拆分为子任务
         (简单任务)   (匹配技能)    (复杂任务)
              │            │            │
              │            │            ▼
              │            │   ┌─────────────────────────┐
              │            │   │  sessions_spawn 工具     │
              │            │   │                         │
              │            │   │  参数:                   │
              │            │   │  ├── task: 子任务描述     │
              │            │   │  ├── label: 标签         │
              │            │   │  ├── agentId: 目标agent  │
              │            │   │  ├── model: 模型选择     │
              │            │   │  ├── thinking: 推理级别  │
              │            │   │  └── cleanup: 完成后处理  │
              │            │   └────────┬────────────────┘
              │            │            │
              │            │            ▼
              │            │   ┌─────────────────────────┐
              │            │   │  创建隔离 Session        │
              │            │   │  (独立 context window)   │
              │            │   │                         │
              │            │   │  注入 Subagent System    │
              │            │   │  Prompt:                 │
              │            │   │  ├── 角色: 子agent       │
              │            │   │  ├── 任务: task 描述     │
              │            │   │  ├── 规则: 专注/临时     │
              │            │   │  └── 是否可再生子agent    │
              │            │   └────────┬────────────────┘
              │            │            │
              │            │     ┌──────┴──────┐
              │            │     ▼             ▼
              │            │  Sub-Agent 1   Sub-Agent 2  ...
              │            │  (并行执行)    (并行执行)
              │            │     │             │
              │            │     ▼             ▼
              │            │  完成后自动      完成后自动
              │            │  announce 回     announce 回
              │            │  主 Agent        主 Agent
              │            │     │             │
              │            │     └──────┬──────┘
              │            │            ▼
              │            │   ┌─────────────────────────┐
              │            │   │  主 Agent 汇总结果       │
              │            │   │  综合各子任务输出         │
              │            │   │  生成最终回复             │
              │            │   └─────────────────────────┘
              │            │            │
              └────────────┴────────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │  回复用户                │
              └─────────────────────────┘
```

---

## Sub-Agent 层级架构

```
                    ┌──────────────────┐
                    │   Main Agent     │  depth = 0
                    │   (主 Agent)     │
                    └────────┬─────────┘
                             │ sessions_spawn
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ Sub-Agent  │  │ Sub-Agent  │  │ Sub-Agent  │  depth = 1
     │ (研究)     │  │ (编码)     │  │ (测试)     │
     └─────┬──────┘  └────────────┘  └────────────┘
           │ sessions_spawn (如果 maxSpawnDepth > 1)
     ┌─────┴──────┐
     ▼            ▼
┌─────────┐ ┌─────────┐
│ Leaf    │ │ Leaf    │  depth = 2
│ Worker  │ │ Worker  │  (不可再 spawn)
└─────────┘ └─────────┘

约束:
├── maxSpawnDepth: 最大嵌套深度 (默认 1, 即只允许一层子agent)
├── maxChildrenPerAgent: 每个 agent 最大并发子任务数 (默认 5)
└── depth >= maxSpawnDepth 时, spawn 被拒绝
```

---

## Sub-Agent 生命周期

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────────┐
│  Spawn   │────→│ Running  │────→│ Ended    │────→│ Announce     │
│  创建     │     │ 执行中    │     │ 已完成    │     │ 结果回报     │
└──────────┘     └──────────┘     └──────────┘     └──────┬───────┘
                      │                                    │
                      │ timeout / kill                     ▼
                      ▼                            ┌──────────────┐
                 ┌──────────┐                      │  Cleanup     │
                 │ Terminated│                     │  清理 session │
                 │ 被终止    │────────────────────→│  (delete/keep)│
                 └──────────┘                      └──────────────┘

SubagentRunRecord 字段:
├── runId: 唯一标识
├── childSessionKey: 子 session key
├── requesterSessionKey: 父 session key
├── task: 任务描述
├── label: 标签
├── model: 使用的模型
├── cleanup: "delete" | "keep"
├── createdAt / startedAt / endedAt: 时间戳
├── outcome: { status: "ok"|"error"|"timeout"|"unknown" }
└── suppressAnnounceReason: "steer-restart" | "killed"
```

---

## 结果回报机制 (Announce Flow)

```
Sub-Agent 完成任务
        │
        ▼
┌───────────────────────────────────────────────────┐
│  runSubagentAnnounceFlow()                        │
│                                                   │
│  1. 读取子 agent 最后一条 assistant 回复            │
│  2. 构建 announce 消息:                            │
│     "[System Message] Sub-agent completed: ..."   │
│     + 统计信息 (runtime / tokens)                  │
│  3. 判断父 agent 状态:                             │
│     ├── 父 agent 正在运行 → steer (注入消息)       │
│     ├── 父 agent 空闲 → 直接 callGateway 触发     │
│     └── 父 agent 忙碌 → enqueue (排队等待)         │
└───────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────┐
│  Queue 模式 (queueSettings.mode):                 │
│                                                   │
│  ├── "steer": 注入到正在运行的 LLM 调用中           │
│  ├── "steer-backlog": steer 失败则排队             │
│  ├── "followup": 排队等父 agent 空闲后触发          │
│  ├── "collect": 收集多个结果后一次性触发             │
│  └── "interrupt": 中断当前运行, 立即处理             │
└───────────────────────────────────────────────────┘
```

---

## 主 Agent 管理子任务的工具

### sessions_spawn — 创建子任务

```
sessions_spawn({
  task: "搜索项目中所有 TODO 注释并分类整理",
  label: "todo-scanner",
  agentId: "default",           // 可选: 指定 agent 配置
  model: "anthropic/claude-sonnet-4-20250514",  // 可选: 指定模型
  thinking: "high",             // 可选: 推理级别
  runTimeoutSeconds: 300,       // 可选: 超时时间
  cleanup: "delete"             // 完成后删除 session
})
```

### subagents — 监控/管理子任务

```
subagents({ action: "list" })           // 列出所有子 agent 及状态
subagents({ action: "steer", ... })     // 向运行中的子 agent 注入新指令
subagents({ action: "kill", ... })      // 终止子 agent
```

### sessions_send — 向子任务发消息

```
sessions_send({
  sessionKey: "agent:default:sub-xxx",
  message: "补充要求: 只关注 src/ 目录"
})
```

---

## Sub-Agent System Prompt 注入

子 Agent 启动时会被注入专门的 system prompt (`buildSubagentSystemPrompt`):

```
# Subagent Context

You are a **subagent** spawned by the main agent for a specific task.

## Your Role
- You were created to handle: <task description>
- Complete this task. That's your entire purpose.
- You are NOT the main agent. Don't try to be.

## Rules
1. Stay focused - Do your assigned task, nothing else
2. Complete the task - Your final message will be auto-reported to main agent
3. Don't initiate - No heartbeats, no proactive actions, no side quests
4. Be ephemeral - You may be terminated after task completion
5. Trust push-based completion - Don't busy-poll for status

## Sub-Agent Spawning (仅当 depth < maxSpawnDepth)
You CAN spawn your own sub-agents for parallel or complex work.
Coordinate their work and synthesize results before reporting back.

## What You DON'T Do
- NO user conversations
- NO external messages (unless explicitly tasked)
- NO cron jobs or persistent state
- NO pretending to be the main agent
```

---

## Skill 系统 — 另一种任务分解方式

除了 Sub-Agent, OpenClaw 还通过 Skill 系统实现特定领域的任务处理:

```
用户请求
    │
    ▼
主 Agent 扫描 <available_skills>
    │
    ├── 匹配到 Skill → 读取 SKILL.md → 按 Skill 指令执行
    │   例: /commit → 读取 prepare-pr/SKILL.md → 按流程提交
    │
    └── 无匹配 → 使用通用工具链处理
        (read/write/edit/exec/browser/...)
```

Skills 是声明式的 Markdown 文件, 定义了特定任务的执行流程, 相当于预定义的"任务模板"。

---

## 配置项

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 1,           // 最大嵌套深度 (1 = 只允许一层)
        maxChildrenPerAgent: 5,     // 每个 agent 最大并发子任务
      },
      // Sub-agent 使用的 prompt 模式
      // "full": 完整 system prompt
      // "minimal": 精简版 (仅 Tooling/Workspace/Runtime)
      // "none": 仅基本身份
    }
  }
}
```

---

## 关键源文件

| 文件 | 功能 |
|------|------|
| `src/agents/tools/sessions-spawn-tool.ts` | `sessions_spawn` 工具: 创建子 agent |
| `src/agents/tools/subagents-tool.ts` | `subagents` 工具: list/steer/kill |
| `src/agents/subagent-announce.ts` | 子 agent 完成后的结果回报 + system prompt 构建 |
| `src/agents/subagent-registry.ts` | 子 agent 运行记录管理 (内存 + 磁盘持久化) |
| `src/agents/subagent-depth.ts` | 嵌套深度计算 (防止无限递归) |
| `src/auto-reply/reply/commands-subagents.ts` | `/subagents` 命令处理 |
| `src/agents/system-prompt.ts` | 主 agent system prompt 构建 |
| `src/cron/isolated-agent/run.ts` | Cron 定时任务的隔离 agent 运行 |
| `src/agents/subagent-registry.store.ts` | 子 agent 注册表磁盘持久化 |

---

## 拆分子 Agent 的好处

### 1. 独立的 Context Window (最核心)

```
单 Agent 方式:
┌─────────────────────────────────────────────────────────────┐
│  主 Agent Context (200K tokens)                             │
│                                                             │
│  [任务1: 搜索代码] → 工具结果 30K tokens                    │
│  [任务2: 写测试]   → 工具结果 25K tokens                    │
│  [任务3: 查文档]   → 工具结果 20K tokens                    │
│  [任务4: 重构]     → 工具结果 40K tokens                    │
│                                                             │
│  → 总计 115K tokens 用于工具结果, 留给推理的空间只有 85K     │
│  → 触发 pruning/compaction, 可能丢失早期上下文              │
└─────────────────────────────────────────────────────────────┘

拆分方式:
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Sub-Agent 1     │  │ Sub-Agent 2     │  │ Sub-Agent 3     │
│ (200K tokens)   │  │ (200K tokens)   │  │ (200K tokens)   │
│                 │  │                 │  │                 │
│ 只装任务1的     │  │ 只装任务2的     │  │ 只装任务3的     │
│ 30K tokens      │  │ 25K tokens      │  │ 20K tokens      │
│                 │  │                 │  │                 │
│ 170K 用于推理   │  │ 175K 用于推理   │  │ 180K 用于推理   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                  ┌─────────────────┐
                  │ Main Agent       │
                  │ 只收到汇总结果     │
                  │ ~5K tokens       │
                  └─────────────────┘
```

每个子 Agent 有自己的 context window，互不干扰。复杂任务的工具调用结果不会挤占主 Agent 的空间，也不会互相污染。

### 2. 并行执行

多个子 Agent 可以同时运行（`maxChildrenPerAgent` 默认 5），而不是串行等待。

```
串行:
任务1 → 任务2 → 任务3 → 任务4  (总耗时 = sum)

并行:
     ┌───任务1───┐
     ├───任务2───┤
     ├───任务3───┤  (总耗时 ≈ max)
     └───任务4───┘
```

### 3. 故障隔离

子 Agent 挂了不影响主 Agent 和其他子 Agent。主 Agent 收到失败的 announce 后可以决定重试、跳过或换策略。

```
单 Agent 失败:
工具A 卡住/报错 → 整个对话受影响 → 需要重新开始

拆分方式:
Sub-Agent 2 失败
    │
    ▼
主 Agent: "任务2 失败了, 让我换个方式重试"
    │
    ▼
重新 spawn Sub-Agent 2 (其他子 Agent 不受影响)
```

### 4. 模型灵活性 — 成本控制

`sessions_spawn` 支持 `model` 参数，不同子任务可以用不同模型：

```
简单搜索任务 → 快速便宜模型 (如 gpt-4o-mini)
复杂推理任务 → 高端模型 (如 claude-opus-4)
代码生成     → 代码优化模型 (如 codex)
```

这样可以在保证质量的前提下优化成本。

### 5. 上下文污染隔离

子 Agent 的 system prompt 被注入严格约束（"Stay focused, do your assigned task"）。避免了长对话中前面任务的上下文干扰后面任务的判断。

```
无隔离的问题:
用户: "帮我写一个 Python 爬虫"
   ↓ [大量爬虫代码和调试对话]
用户: "现在帮我写一个 SQL 查询"
   ↓ 模型还在想爬虫的事, 可能写出奇怪的 SQL

有隔离:
爬虫任务 → Sub-Agent A → 完成后 cleanup
SQL 任务  → Sub-Agent B → 干净的 context
```

### 6. 结果压缩

子 Agent 完成后只回报精炼摘要给父 Agent（announce 机制），而不是把所有中间工具调用结果都塞回来。

```
不拆分:
工具调用结果 (100K tokens) → 全部塞进主 Agent context

拆分:
子 Agent 内部处理 100K tokens 工具结果
    │
    ▼
生成 2K tokens 的摘要 → 主 Agent 只接收这 2K
```

### 7. 职责分离

每个子 Agent 有明确的单一职责，主 Agent 专注于协调和决策。这符合软件工程中"单一职责原则"，在 Agent 编排中同样有效。

```
Main Agent:  理解用户意图 → 拆解任务 → 分配 → 汇总结果
Sub-Agent 1: 专注代码搜索
Sub-Agent 2: 专注测试生成
Sub-Agent 3: 专注文档查询
```

---

## 总结

OpenClaw 的任务拆解是 **LLM 驱动 + 工具辅助** 的模式:

1. LLM 自主决策是否拆分、如何拆分（没有硬编码的规划器）
2. 通过 `sessions_spawn` 创建隔离的子 Agent Session
3. 子 Agent 有独立的 context window, 专注单一任务
4. 完成后通过 announce 机制自动回报结果给父 Agent
5. 父 Agent 汇总所有子任务结果, 生成最终回复
6. 支持多层嵌套 (受 `maxSpawnDepth` 限制) 和并发控制 (`maxChildrenPerAgent`)

**核心价值**: 用空间换质量 —— 多个小而专注的 context window，比一个被塞满的大 window 效果好得多。

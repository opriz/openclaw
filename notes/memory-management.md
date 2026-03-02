# OpenClaw Agent 上下文记忆管理流程

## 架构概览

OpenClaw 的 agent 上下文记忆管理分为三层：
- **短期**: Context Window（模型当前窗口）
- **中期**: Session History（会话历史 *.jsonl）
- **长期**: Memory Files + Embedding（持久化记忆）

---

## 核心流程图

### 1. 请求处理与上下文构建

```
┌─────────────────────────────────────────────────────────────────────┐
│                     用户发送消息 (User Message)                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  构建 Context (发送给模型的全部内容)                    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 1. System Prompt (每次重建)                                  │    │
│  │    ├── 工具列表 + Schema                                     │    │
│  │    ├── Skills 列表 (元数据)                                   │    │
│  │    ├── 运行时信息 (时间/OS/模型)                               │    │
│  │    └── Bootstrap 文件注入 (Project Context)                   │    │
│  │        AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md          │    │
│  │        USER.md / HEARTBEAT.md / BOOTSTRAP.md                 │    │
│  │        (单文件上限 20K chars, 总上限 24K chars)                │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 2. 会话历史 (Session History)                                │    │
│  │    用户消息 + 助手消息 + 工具调用/结果                          │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 3. Memory Search 结果 (按需注入)                              │    │
│  │    agent 调用 memory_search 工具 → 语义检索 → 注入结果          │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
┌──────────────────┐ ┌─────────────────┐ ┌──────────────────────┐
│  Context Window   │ │  Session Pruning │ │  Context Window Guard│
│  Guard 检查       │ │  (cache-ttl模式) │ │  tokens < 16K → 阻止 │
│  tokens < 32K    │ │                 │ │  tokens < 32K → 警告 │
│  → 发出警告       │ │  仅裁剪旧的      │ └──────────────────────┘
└──────────────────┘ │  toolResult 消息  │
                     │  不改写磁盘历史    │
                     │                 │
                     │  软裁剪: 保留     │
                     │  head+tail 截断   │
                     │  硬清除: 替换为   │
                     │  placeholder     │
                     └─────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   发送给 LLM 模型    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   模型返回响应       │
                    │   追加到 Session     │
                    │   History (*.jsonl)  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  检查 token 使用量   │
                    │  接近上限?           │
                    └──────────┬──────────┘
                          是 ↙     ↘ 否
                         ▼           ▼
          ┌────────────────────┐   继续正常对话
          │  Memory Flush      │
          │  (预压缩记忆刷写)   │
          │                    │
          │  将重要信息写入      │
          │  memory/YYYY-MM-DD │
          │  .md 文件           │
          └────────┬───────────┘
                   ▼
          ┌────────────────────┐
          │  Compaction (压缩)  │
          │                    │
          │  摘要旧历史 →       │
          │  写入 transcript   │
          │  保留最近消息       │
          │  释放 context 空间  │
          └────────────────────┘
```

### 2. 长期记忆系统 (Memory System)

```
┌─────────────────────────────────────────────────────────────────┐
│                    长期记忆系统架构                               │
│                                                                 │
│  数据源                          存储层                          │
│  ┌──────────────┐               ┌─────────────────────────┐     │
│  │ MEMORY.md    │──┐            │  SQLite 数据库            │     │
│  │ memory/*.md  │  │  sync      │  ~/.openclaw/memory/     │     │
│  │ extraPaths   │──┼──────────→ │  ├── files (文件元数据)   │     │
│  │ sessions(可选)│──┘            │  ├── chunks (文本分块)    │     │
│  └──────────────┘    ┌────────→ │  │   400 tokens/chunk    │     │
│                      │          │  │   80 tokens overlap   │     │
│  同步触发:            │          │  ├── embeddings (向量)    │     │
│  • session 启动时     │          │  └── FTS5 全文索引        │     │
│  • search 调用时      │          └─────────────────────────┘     │
│  • 文件 watch 变更    │                    │                     │
│  • 定时间隔           │                    │ 查询                 │
│                      │                    ▼                     │
│  Embedding Provider: │          ┌─────────────────────────┐     │
│  OpenAI / Gemini /   │          │  Hybrid Search           │     │
│  Voyage / Local      │          │  向量权重 0.7 + 文本 0.3  │     │
│  (auto 自动选择)      │          │  minScore: 0.35          │     │
│                      │          │  maxResults: 6           │     │
│                      │          └────────────┬────────────┘     │
│                      │                       │                  │
│                      │                       ▼                  │
│                      │          ┌─────────────────────────┐     │
│                      │          │  memory_search 工具返回   │     │
│                      │          │  path + lines + snippet  │     │
│                      │          └────────────┬────────────┘     │
│                      │                       │                  │
│                      │                       ▼                  │
│                      │          ┌─────────────────────────┐     │
│                      │          │  memory_get 精确读取      │     │
│                      │          │  指定 path + from/lines  │     │
│                      │          └─────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 核心概念区分

| 概念 | 作用域 | 持久化 | 特点 |
|------|--------|--------|------|
| **Context** | 单次请求 | 否 | 发送给模型的全部内容，受 context window 限制 |
| **Memory** | 跨会话 | 是 | 磁盘文件 (Markdown)，可通过语义检索访问 |
| **Session History** | 单会话 | 是 (*.jsonl) | 完整对话记录，可被 compaction 压缩 |

---

## 控制机制

### 三级管理流程

```
Pruning (裁剪)     → Memory Flush (刷写)     → Compaction (压缩)
━━━━━━━━━━━━━━━━    ━━━━━━━━━━━━━━━━         ━━━━━━━━━━━━━━━
裁剪旧工具结果      压缩前保存重要记忆          摘要压缩历史
不改写磁盘          写入 memory/*.md           写入 transcript
transient           silent NO_REPLY           persistent
```

### 阈值配置

```json5
{
  agents: {
    defaults: {
      // Context Window 控制
      contextTokens: 200000,           // 软上限

      // Compaction (压缩)
      compaction: {
        reserveTokensFloor: 20000,     // 保留空间下限
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,   // 距离上限多少时触发 flush
        }
      },

      // Session Pruning (裁剪)
      contextPruning: {
        mode: "cache-ttl",              // off / cache-ttl
        ttl: "5m",                      // 超过 TTL 未调用才裁剪
        keepLastAssistants: 3,          // 保留最近 N 条 assistant 消息
        softTrimRatio: 0.3,             // 软裁剪比例
        hardClearRatio: 0.5,            // 硬裁剪比例
      },

      // Memory Search (记忆检索)
      memorySearch: {
        enabled: true,
        provider: "auto",               // openai / gemini / voyage / local
        query: {
          maxResults: 6,
          minScore: 0.35,
          hybrid: {
            enabled: true,
            vectorWeight: 0.7,          // 向量检索权重
            textWeight: 0.3,            // 全文检索权重
          }
        }
      }
    }
  }
}
```

---

## 文件布局

```
~/.openclaw/
├── agents/<agentId>/
│   ├── sessions/
│   │   ├── sessions.json          # Session 元数据 (sessionKey → entry)
│   │   └── <sessionId>.jsonl       # 会话历史记录
│   └── qmd/                        # QMD 后端 (可选)
│
├── memory/<agentId>.sqlite         # 记忆索引数据库
│
└── workspace/                      # Agent 工作区
    ├── MEMORY.md                   # 长期记忆 (仅主会话加载)
    ├── memory/
    │   └── YYYY-MM-DD.md           # 每日记忆日志
    ├── AGENTS.md                   # Bootstrap: Agent 定义
    ├── SOUL.md                     # Bootstrap: Agent 个性
    ├── TOOLS.md                    # Bootstrap: 工具文档
    ├── IDENTITY.md                 # Bootstrap: 身份设定
    ├── USER.md                     # Bootstrap: 用户偏好
    └── HEARTBEAT.md                # Bootstrap: 心跳检测
```

---

## 工具链

| 工具 | 用途 |
|------|------|
| `memory_search` | 语义搜索记忆文件，返回相关片段 |
| `memory_get` | 精确读取指定路径的内存文件内容 |
| `/context list` | 查看当前 context 组成和大小 |
| `/context detail` | 详细 breakdown (文件/工具/skills) |
| `/status` | 显示 session 状态和 token 使用情况 |
| `/compact` | 手动触发压缩，释放 context 空间 |

---

## 关键源文件

| 文件 | 功能 |
|------|------|
| `src/agents/context-window-guard.ts` | Context Window 检查和警告 |
| `src/agents/pi-extensions/context-pruning.ts` | Session Pruning 实现 |
| `src/auto-reply/reply/memory-flush.ts` | Pre-compaction Memory Flush |
| `src/agents/memory-search.ts` | 记忆搜索配置解析 |
| `src/agents/tools/memory-tool.ts` | memory_search/memory_get 工具 |
| `src/memory/memory-schema.ts` | SQLite 索引 Schema |
| `src/memory/sync-memory-files.ts` | 文件同步逻辑 |
| `src/memory/manager-sync-ops.ts` | 同步操作实现 |

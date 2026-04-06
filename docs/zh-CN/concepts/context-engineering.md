---
read_when:
  - 你想用学习者视角理解 OpenClaw 的上下文工程
  - 你在追查为什么某次回复这么耗 token
  - 你想区分 context、memory、compaction、pruning
summary: 学习指南：OpenClaw 如何把引导文件、历史、工具、记忆和维护回合组织成模型上下文
title: 上下文工程
---

# 上下文工程

在 OpenClaw 里，**上下文工程**指的是：在有限上下文窗口内，设计“这一回合究竟让模型看到什么”，从而让智能体保持可用、可控、可诊断、成本合理。

这不是一个单独模块，而是一组共同工作的设计：

- 系统提示词构建，
- bootstrap 文件注入，
- 会话历史管理，
- 工具 schema 和工具结果处理，
- 记忆召回，
- 压缩与修剪，
- 可选的 Context Engine 插件。

如果只记一句话，可以记住：

> OpenClaw 的上下文工程，本质上是在决定：**哪些信息现在进入模型窗口，哪些被总结，哪些写入持久记忆，哪些在回合之间静默维护。**

## 五层心智模型

一次运行开始时，最终送给模型的上下文通常由 5 层构成：

1. **运行时拥有的系统提示词**
   - OpenClaw 基础规则
   - 工具说明
   - Skills 列表
   - 运行时元数据
   - 工作区 / 环境提示
2. **项目上下文 / bootstrap 文件**
   - `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`，以及首次运行的 `BOOTSTRAP.md`
3. **会话 transcript**
   - 最近的用户 / 助手消息
   - 既往工具调用与工具结果
   - 压缩摘要
4. **动态组装层**
   - Context Engine 的 `assemble()` 结果
   - 可选的 `systemPromptAddition`
5. **维护回合产物**
   - 压缩前记忆刷新
   - compaction 摘要
   - pruning / truncation 的副作用

之所以要分层，是因为不同类型的信息适合放在不同地方：

| 信息类型 | 更合适的归宿 |
| --- | --- |
| 稳定的规则与操作边界 | 系统提示词 / bootstrap 文件 |
| 最近的对话现场 | 会话 transcript |
| 持久事实、偏好、决策 | `MEMORY.md` / `memory/YYYY-MM-DD.md` |
| 很大但一次性的输出 | 工具结果，随后交给压缩 / 修剪 |
| 检索或压缩策略 | Context Engine |

## Context 不是 Memory

这是最常见的误解来源：

- **Context** = 模型**此刻**看到的内容
- **Memory** = 可以**稍后再加载**的持久化内容

这意味着：

- 写进 `MEMORY.md`，并不等于每次运行模型都会自动看到它；
- 留在聊天历史里，也不等于它变成了耐久状态；
- compaction 可以保持连续性，但它仍然是有损压缩，不等于原始历史本身。

## 运行时主流程

OpenClaw 的嵌入式智能体路径大致是：

1. Gateway 网关接收请求。
2. 解析会话并放入队列通道。
3. 读取会话 transcript。
4. 按提供商规则清洗和校验历史。
5. 应用历史截断和工具配对修复。
6. 交给当前活动的 Context Engine 组装最终模型消息。
7. 运行模型与工具。
8. 持久化结果。
9. 执行回合后的维护逻辑，如 compaction、ingest、transcript hygiene。

重点在于：**OpenClaw 并不是把整个 transcript 原样塞给模型**，而是会持续重塑它。

## token 预算都花到哪里去了

上下文窗口并不只被聊天消息消耗。常见的大头包括：

- 系统提示词文本，
- 注入的 bootstrap 文件内容，
- 工具 schema，
- 最近的工具结果，
- 对话历史，
- 附件 / 转录，
- compaction 摘要。

这就是为什么 `/context detail` 很关键。它可以回答这些问题：

- “是不是系统提示词太大了？”
- “是不是工具 schema 在吃掉大部分窗口？”
- “是不是某个巨大工具结果把会话污染了？”
- “是不是 `TOOLS.md` 已经被截断？”

## 三个主要泄压阀

当上下文越来越大时，OpenClaw 主要靠 3 种机制减压。

### 1. Compaction

Compaction 会把旧 transcript 历史总结成一条持久摘要，同时保留最近若干回合不变。

适合场景：

- 你仍在同一个连续任务里，
- 但历史已经太长，
- 需要压缩而不是彻底丢掉上下文。

### 2. Session pruning

Pruning 会从**当前运行的内存提示词**里裁掉旧工具结果，但**不会**重写磁盘上的 transcript。

适合场景：

- 工具输出很大，
- 但你不想立即改写历史文件，
- 只是想减少本次 prompt 的膨胀。

### 3. Memory flush

当会话接近自动压缩时，OpenClaw 可以先跑一个静默维护回合，要求智能体把值得长期保留的内容写到 `memory/YYYY-MM-DD.md`。

适合场景：

- 你担心 compaction 之后细节会被压缩掉，
- 希望在压缩前先把持久状态落盘。

## Context Engine 的角色

当前活动的 Context Engine 是自定义上下文策略的插件点。

内置 `legacy` 引擎基本保留默认行为；插件引擎则可以实现更高级的能力，例如：

- 在组装前做自定义检索，
- 实现另一套 compaction 策略，
- 运行 transcript maintenance，
- 处理子智能体的上下文边界。

但要注意：Context Engine 仍然工作在更大的运行时框架里，它并不接管会话存储、队列、工具系统或提供商特定校验。

## 最新设计在优化什么

目前的 OpenClaw 上下文工程主要在优化这些目标：

- **运行安全性**
  - transcript 文件和 rewrite helper 仍由运行时掌控
- **可观察性**
  - `/status`、`/context`、`/usage`、会话元数据都能帮助排查
- **优雅降级**
  - compaction、pruning、tool-result truncation、overflow recovery 彼此配合
- **插件可扩展**
  - 通过 Context Engine slot 扩展，而不是重写整个 Gateway 网关
- **在丢失前先持久化**
  - 预压缩 memory flush 会先落 durable state

换句话说，OpenClaw 把上下文工程视为一个**运行时运营问题**，而不只是“把提示词写得漂亮一点”。

## 常见误区

### “把所有东西都塞进 AGENTS.md 就好了”

这在文件小、规则稳定时有效；但一旦 bootstrap 文件过大、频繁变化或被截断，就会变成问题。稳定规则适合放那里，大量动态数据通常不适合。

### “记忆检索和上下文组装是一回事”

它们相关，但不一样：

- memory 插件负责**找信息**，
- Context Engine 负责决定模型**真正看到什么**。

### “UI 上那个很大的数字就等于当前真实上下文”

某些使用量字段可能跨多次 API 调用累计。OpenClaw 会尽量在 session 元数据里保留更接近“当前上下文快照”的数值，用于展示和诊断。

### “compaction 之后什么都不会丢”

Compaction 保留的是连续性，不是逐字逐句的原始历史。

## 一个实用排查清单

当上下文表现不符合预期时，可以按这个顺序排查：

1. 执行 `/status` 和 `/context detail`。
2. 看 bootstrap 文件是否被截断。
3. 看是不是某个工具 schema 或工具结果异常大。
4. 看会话是否已经 compaction 过。
5. 看 memory flush 是否应该已经触发。
6. 确认当前活动的是哪个 Context Engine。
7. 如果在用插件，引擎是否真的正确实现了 compaction。

## 推荐阅读路径

建议按这个顺序阅读：

1. [上下文](/concepts/context)
2. [系统提示词](/concepts/system-prompt)
3. [智能体循环](/concepts/agent-loop)
4. [压缩](/concepts/compaction)
5. [会话修剪](/concepts/session-pruning)
6. [记忆](/concepts/memory)
7. [Context Engine](/concepts/context-engine)
8. [会话管理 + 压缩](/reference/session-management-compaction)

如果你接下来想看代码级别的映射，可以继续阅读[上下文工程运行时](/concepts/context-engineering-runtime)。

---
read_when:
  - 你想理解仓库里最新的 “dreaming” 设计
  - 你在寻找后台或静默推理行为对应的实现
  - 你想把 “dreaming” 这个说法映射到 OpenClaw 已落地的子系统
summary: 当前 OpenClaw 里 “dreaming” 的真实含义：由 memory flush、heartbeat、cron 和隔离后台运行组成的维护回合架构
title: Dreaming 系统
---

# Dreaming 系统

先说最关键的一点：

> **OpenClaw 当前并没有一个在核心代码里正式命名为 `dreaming` 或 `dreams` 的一级子系统。**

也就是说，你不会在核心运行时、配置 schema 或主文档里找到一个独立的 “dreaming 模块”。

因此，如果问题是“最新的 dreaming 系统设计是什么”，最准确的回答不是去虚构一个并不存在的模块，而是：

> 在当前 OpenClaw 里，所谓 “dreaming”，更接近于一组**静默或后台维护回合**的组合，而不是一个单独命名的功能。

## 当前最接近 dreaming 的实现组合

今天最接近 “dreaming” 的，是以下 4 类机制的组合：

1. **预压缩 memory flush**
   - 在 compaction 发生前，先跑一个静默智能体回合
   - 把持久状态写入 `memory/YYYY-MM-DD.md`
2. **heartbeat**
   - 周期性后台智能体回合
   - 可以选择轻上下文或隔离会话
3. **cron**
   - 显式定义的定时任务
4. **subagents / isolated sessions**
   - 与主对话线程分离的后台或并行运行

把这 4 种机制合在一起看，就是当前 OpenClaw 里最实际的 “dreaming” 故事。

## 当前设计“是什么”

当前设计是：

- **面向维护回合**的，而不是神秘的“自发做梦”
- **运行时驱动**的，而不是一个常驻独立守护进程
- **强调状态保全**的，尤其是在 compaction 边界之前
- **会话感知**的，明确控制后台回合看见哪一段上下文
- **默认静默**的，只在需要时才把结果显式投递给用户

## 当前设计“不是什么”

当前设计**不是**：

- 一个会长期自我改写系统提示词的隐藏自改进循环
- 一个独立的 “dream database”
- 一个脱离会话系统、永久后台运行的离线检索器
- 一个拥有单独调度器和单独存储层的自治反思引擎
- 一个可以无边界静默重写所有历史和配置的机制

这一点很重要：仓库里的确已经有真实的后台行为，但这些行为是**有边界、可观察、可配置**的。

## 设计重心：预压缩 memory flush

如果今天一定要在 OpenClaw 里选一个最像 “dreaming” 的功能，那它就是**预压缩 memory flush**。

它的目的非常务实：

1. 发现会话即将到达 compaction 边界；
2. 先启动一个静默维护回合；
3. 提醒智能体把值得长期保留的内容写成 durable notes；
4. 然后再允许 compaction 发生。

这是一种很工程化的 “做梦”：

- 先暂停，
- 反思“哪些东西值得跨压缩边界保留下来”，
- 再把它们写进持久记忆文件，
- 通常用户看不到这一步。

### 为什么这一步重要

如果没有 memory flush，compaction 虽然能保留连续性，但一些本该进入长期记忆的细节，仍然可能在压缩过程中丢失。

而 memory flush 提供了一种轻量级的反思能力：

- “在这次压缩发生前，哪些状态必须先落盘？”

## memory flush 的数据流

当前运行时的大致逻辑是：

1. 估算当前 prompt 大小与下一轮 projected token 数；
2. 比较这些值和：
   - context window
   - `reserveTokensFloor`
   - `softThresholdTokens`
3. 必要时还会通过 transcript 字节大小强制触发 flush；
4. 在以下情况跳过：
   - 工作区只读
   - 当前运行是 heartbeat
   - 当前后端是 CLI
5. 启动一个 `trigger: "memory"` 的静默 embedded run；
6. 将 `memoryFlushWritePath` 指向 `memory/YYYY-MM-DD.md`；
7. 把 flush 元数据写回 session state。

所以它更像是一个受控的维护循环，而不是“另一个梦境智能体”。

相关代码：

- `src/auto-reply/reply/memory-flush.ts`
- `src/auto-reply/reply/agent-runner-memory.ts`

## heartbeat：定时 dreaming

Heartbeat 是第二个最接近 dreaming 的组成部分。

它会周期性运行智能体回合，并且可以配置成：

- 通过 `lightContext` 降低上下文成本
- 通过 `isolatedSession` 与主会话隔离
- 通过 `HEARTBEAT_OK` 抑制无意义输出
- 在真的需要提醒时才向用户发出可见消息

因此 heartbeat 很像一种定时的 “dream cycle”：

- 定时唤醒，
- 查看一个边界明确的上下文，
- 判断有没有值得提醒或处理的事情，
- 要么发出简短提醒，要么静默结束。

相关代码：

- `src/infra/heartbeat-runner.ts`
- `src/auto-reply/heartbeat.ts`
- `docs/gateway/heartbeat.md`

## cron 和 subagents：更明确的梦境任务

Heartbeat 更像通用、周期性的后台检查；cron 和 subagents 则更偏向显式任务。

它们适合：

- 需要隔离 session ID 的后台运行，
- 有清晰触发条件的定时任务，
- 不希望污染主会话的并行工作，
- 边界清楚的长任务或维护任务。

这也说明了一点：成熟的 dreaming 系统往往不是一种机制，而是多种后台运行方式之上的调度策略。

OpenClaw 现在已经具备这些底座，只是还没有统一命名成一个核心概念。

## 为什么 OpenClaw 选择“维护回合”而不是单独的 dream 模块

当前设计明显偏向复用现有运行时能力，而不是再造一套平行系统：

- 复用同一套模型调用链路
- 复用同一套 session store
- 复用同一套 transcript 规则
- 复用同一套静默回复 token
- 复用同一套沙箱与工具策略

这样做的好处是：

- 隐藏路径更少，
- 调度逻辑不重复，
- 可观测性更强，
- 和 compaction / persistence 的耦合更安全。

代价则是概念上的：系统已经很强，但 “dreaming” 行为分散在多个现有能力里，而不是被打包成一个单独命名的子系统。

## 一个好用的心智模型

如果你要把当前架构讲给另一个工程师听，可以这样说：

### 正常回复模式

- 用户发消息
- 智能体在同一会话线程里回复

### 维护模式

- 运行时发现某个特殊条件或定时触发
- 智能体以一个边界明确的目标运行
- 输出通常会被抑制
- 重要状态会被持久化或总结

这个“维护模式”，就是当前 OpenClaw 里最接近 dreaming 的实际含义。

## 影响 dreaming 行为的关键配置

最相关的配置入口有这些。

### compaction memory flush

- `agents.defaults.compaction.memoryFlush.enabled`
- `agents.defaults.compaction.memoryFlush.softThresholdTokens`
- `agents.defaults.compaction.memoryFlush.forceFlushTranscriptBytes`
- `agents.defaults.compaction.memoryFlush.prompt`
- `agents.defaults.compaction.memoryFlush.systemPrompt`
- `agents.defaults.compaction.reserveTokensFloor`

### heartbeat

- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.prompt`
- `agents.defaults.heartbeat.activeHours`
- `agents.defaults.heartbeat.lightContext`
- `agents.defaults.heartbeat.isolatedSession`
- `agents.defaults.heartbeat.includeReasoning`
- `agents.defaults.heartbeat.target`

### 其他后台执行

- cron job 配置
- subagent 的默认值与并发限制

## 架构边界

当前设计对边界是非常谨慎的：

- **memory flush**
  - 在信息丢失前先做 durable state 持久化
- **compaction**
  - 负责压缩 transcript
- **pruning**
  - 负责减少运行时内存 prompt 负担
- **heartbeat**
  - 负责周期性后台检查
- **Context Engine**
  - 负责上下文组装，并可参与维护逻辑

这些能力彼此协作，但任何单独一个都不能完全等同于 “dreaming 系统”。

## 如果未来真的要做一个一等公民的 dreaming 层

从当前代码结构看，未来如果要正式引入一个命名明确的 dreaming 层，它大概率会封装这些能力：

- heartbeat 调度
- 隔离维护会话
- compaction 前的记忆提炼
- 检索驱动的总结
- transcript hygiene 钩子

也就是说，当前系统其实已经具备了一个未来 “dreaming 层” 的很强底座，只是仓库还没有把它统一包装成这个名字而已。

## 结论

因此，最新的 OpenClaw “dreaming” 设计最准确的描述是：

> **一种由 memory flush、heartbeat、cron 和隔离智能体运行共同构成的维护回合架构；它强调在 compaction 前先保存 durable state，并默认以静默方式执行。**

如果你想进一步理解这套设计在源码里的落点，可以继续阅读[上下文工程运行时](/concepts/context-engineering-runtime)。

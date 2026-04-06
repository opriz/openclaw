---
read_when:
  - 你想把上下文概念映射到源码实现
  - 你在排查 context overflow 或 compaction 行为
  - 你正在实现 Context Engine 插件
summary: 代码级走读：嵌入式 Pi runner 如何组装、压缩并维护上下文
title: 上下文工程运行时
---

# 上下文工程运行时

这篇文档把“学习型”的上下文概念映射到当前运行时代码。

如果说[上下文工程](/concepts/context-engineering)讲的是心智模型，那么这篇讲的就是：**这些设计在代码里分别落在哪些文件、以什么顺序执行。**

## 主路径

嵌入式运行的核心请求路径主要是：

1. `src/agents/pi-embedded-runner/run.ts`
2. `src/agents/pi-embedded-runner/run/attempt.ts`
3. `src/context-engine/types.ts`
4. 以及配套的 compaction / maintenance 辅助文件

可以粗略理解为：

- `run.ts`
  - 负责队列、模型解析、认证、上下文窗口 guard、overflow recovery
- `run/attempt.ts`
  - 负责单次 attempt 生命周期：会话加载、历史整形、prompt 组装、执行、回合后收尾
- `src/context-engine/*`
  - 定义插件契约和默认行为

## 1. 运行一开始就带着上下文预算

在真正发 prompt 之前，`run.ts` 会先解析有效的上下文窗口，并叠加 OpenClaw 自己的限制：

- 提供商 / 模型原生 context window
- `agents.defaults.contextTokens` 的覆盖或上限
- 过小窗口的 warning 和 hard minimum block

相关文件：

- `src/agents/context-window-guard.ts`
- `src/agents/pi-embedded-runner/run.ts`

为什么这一步重要？因为后续所有 compaction、overflow 判断，都是基于这个“有效预算”做的。

## 2. 活动 Context Engine 只解析一次

`run.ts` 会在整个运行开始时初始化插件，并且只解析一次当前活动引擎：

- `ensureContextEnginesInitialized()`
- `resolveContextEngine(config)`

之后即使有重试，也复用同一个引擎实例，而不是每次都重新注册 / 重新连接。

相关文件：

- `src/context-engine/index.ts`
- `src/context-engine/registry.ts`
- `src/agents/pi-embedded-runner/run.ts`

## 3. 在 prompt 组装前，可能先做 bootstrap 和 maintenance

在 `run/attempt.ts` 里，如果会话文件已经存在，运行时可能会先做两件事：

1. 调用 `contextEngine.bootstrap(...)`
2. 调用 `runContextEngineMaintenance(..., reason: "bootstrap")`

这是一个很重要的最新设计点：`maintain()` 不只是回合后的钩子，它也可以在下一次 prompt 构建前先清理或规范化现有 transcript。

相关文件：

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/context-engine-maintenance.ts`

## 4. 先做内置 transcript 整形，再交给 `assemble()`

在插件获得组装权之前，OpenClaw 总会先做一轮运行时内建整形：

1. sanitize transcript history
2. 执行提供商特定校验
3. 必要时限制 direct message 历史
4. 修复 tool_use / tool_result 配对

然后才调用：

```ts
contextEngine.assemble({
  sessionId,
  sessionKey,
  messages,
  tokenBudget,
  model,
  prompt,
})
```

这意味着 Context Engine 拿到的通常不是原始、脏乱的 JSONL 历史，而是已经被规范化过的一份消息集合。

相关文件：

- `src/agents/pi-embedded-runner/run/attempt.ts`

## 5. `assemble()` 不只是改消息，还能改 prompt framing

`assemble()` 的两个关键产物是：

- `messages`
  - 最终送给模型的消息序列
- `systemPromptAddition`
  - 前置到运行时系统提示词前的额外文本

第二点很容易被忽略。它允许插件在不改工作区文件、也不接管整个系统提示词构建器的前提下，动态注入召回 / 检索 / 当前上下文相关提示。

相关文件：

- `src/context-engine/types.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

## 6. overflow recovery 仍然由运行时掌控

即便做完组装，提供商仍可能返回 context overflow。此时由 `run.ts` 负责恢复循环。

当前顺序大致是：

1. 识别疑似 overflow
2. 判断本次 attempt 内是否已经自动 compaction 过
3. 如果还没有，调用 `contextEngine.compact(...)`
4. 如果 compaction 成功，再执行一次 `reason: "compaction"` 的 maintenance
5. 重试 prompt
6. 若 compaction 仍不足，再尝试截断 oversized tool results
7. 最终再决定是否向用户报 context overflow

这体现了系统边界：

- **引擎**决定 compaction 策略；
- **运行时**决定何时需要 overflow recovery、最多重试多少次。

相关文件：

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/compact.ts`
- `src/agents/pi-embedded-runner/tool-result-truncation.ts`

## 7. 回合成功后，优先使用 `afterTurn()`

一次成功回合结束后，`run/attempt.ts` 会优先调用：

1. `contextEngine.afterTurn(...)`

如果没有实现 `afterTurn()`，则回退为：

2. `contextEngine.ingestBatch(...)`
3. 否则逐条 `contextEngine.ingest(...)`

这个设计很关键：

- 想自己掌控回合后状态机的引擎，可以实现 `afterTurn()`；
- 更简单的引擎则可以只依赖 batch 或逐条 ingest。

相关文件：

- `src/agents/pi-embedded-runner/run/attempt.ts`

## 8. `maintain()` 是 transcript hygiene 层

如果回合后收尾成功，运行时接着会调用 `runContextEngineMaintenance()`，并带上 `reason: "turn"`。

`maintain()` 适合做的事情包括：

- 缩小过大的消息，
- 选择性重写 transcript 条目，
- 在持久化完成后做规范化清理。

运行时会额外注入一个 helper：

- `rewriteTranscriptEntries(request)`

它由以下文件实现：

- `src/agents/pi-embedded-runner/context-engine-maintenance.ts`
- `src/agents/pi-embedded-runner/transcript-rewrite.ts`

这里最重要的安全性质是：引擎**不会**直接去改 transcript 文件，而是通过运行时提供的 branch-and-reappend 机制发起安全重写请求。

## 9. memory flush 是最接近“静默反思”的内建维护回合

从上下文工程角度看，最重要的内建维护回合是**预压缩 memory flush**。

它的设计是：

1. 估计会话是否接近 compaction 阈值
2. 需要时读取 transcript 大小和最近 usage 快照
3. 若工作区只读、当前是 heartbeat，或后端是 CLI，则跳过
4. 发起一个 `trigger: "memory"` 的静默 embedded run
5. 把 durable notes 写入 `memory/YYYY-MM-DD.md`
6. 在 session state 中记录 flush 元数据

相关文件：

- `src/auto-reply/reply/memory-flush.ts`
- `src/auto-reply/reply/agent-runner-memory.ts`

这也是为什么当前的 OpenClaw 上下文设计更像“运行时维护系统”，而不只是提示词拼接器：它会在压缩前主动把值得保留的状态落盘。

## 10. heartbeat 是并行的维护路径

Heartbeat 不属于 Context Engine 本身，但它会直接影响后台维护回合到底看见多少上下文。

最关键的两个选项是：

- `lightContext`
  - 让 heartbeat 的 bootstrap 上下文更轻
- `isolatedSession`
  - 让 heartbeat 在一个全新会话里运行，避免拖入主 transcript

相关文件：

- `src/infra/heartbeat-runner.ts`
- `src/config/types.agent-defaults.ts`

## 11. 面向用户的上下文数值来自 session state

Gateway 网关会在会话元数据里保存与 token 相关的字段，例如：

- `inputTokens`
- `outputTokens`
- `totalTokens`
- `contextTokens`

这点很重要，因为 UI 不应该靠前端自己解析 JSONL 去“修正”真实上下文大小。运行时已经在努力维护一个更接近当前 prompt 快照的 session 数值，用于诊断和展示。

相关代码和文档：

- `src/agents/pi-embedded-runner/run.ts`
- `ui/src/ui/views/chat.test.ts`
- `docs/concepts/session.md`

## 文件地图

如果你想以最短路径读源码，优先看这些文件：

- `src/context-engine/types.ts`
  - 接口与生命周期契约
- `src/context-engine/index.ts`
  - 对外导出、legacy 引擎、运行时委托 helper
- `src/agents/pi-embedded-runner/run.ts`
  - 运行准入、模型解析、overflow recovery
- `src/agents/pi-embedded-runner/run/attempt.ts`
  - transcript 整形、组装、执行、回合后钩子
- `src/agents/pi-embedded-runner/context-engine-maintenance.ts`
  - 运行时维护桥接
- `src/agents/pi-embedded-runner/transcript-rewrite.ts`
  - 安全的 branch-and-reappend transcript rewrite
- `src/auto-reply/reply/memory-flush.ts`
  - memory flush 阈值与提示词
- `src/auto-reply/reply/agent-runner-memory.ts`
  - 静默 memory 回合编排
- `src/infra/heartbeat-runner.ts`
  - 定时维护运行

## 接下来读什么

如果你还没看架构总览，先回到[上下文工程](/concepts/context-engineering)。

如果你想把这些后台维护回合理解成更接近“dreaming”的设计，可以继续看 [Dreaming 系统](/concepts/dreaming-system)。

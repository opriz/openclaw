# OpenClaw 上下文管理学习笔记（learning）

## 1. 先给结论：OpenClaw 的上下文管理是“分层 + 可插拔”

我把它理解成 4 层：

1. **会话历史层（Session Transcript）**  
   真实消息保存在 session 文件里，运行前会做清洗和修复。
2. **上下文组装层（Context Assembly）**  
   由 `context-engine` 插件接口统一抽象，默认是 `legacy`。
3. **运行期减压层（Pruning / Guard / Compaction）**  
   包括工具结果裁剪、TTL 剪枝、溢出恢复压缩。
4. **长期记忆层（Memory Search + Memory Flush）**  
   通过 `memory_search` / `memory_get` 与 `memory/*.md`、`MEMORY.md` 形成持久记忆闭环。

---

## 2. 主执行链路（从 run 到 prompt）

### 2.1 入口：先解析 context engine，再复用

- `src/agents/pi-embedded-runner/run.ts`
  - 每次 run loop 开始会 `ensureContextEnginesInitialized()`。
  - 通过 `resolveContextEngine(config)` 解析当前激活引擎。
  - 同一次 run 的重试会复用同一个 context engine 实例（避免重复初始化成本）。

### 2.2 attempt 阶段：先清洗历史，再给引擎 assemble

- `src/agents/pi-embedded-runner/run/attempt.ts`
  - 打开 `SessionManager` 后，会先跑历史修复和安全清洗。
  - 关键链路：
    1. `sanitizeSessionHistory(...)`（清理坏格式、坏工具配对、特殊 provider 兼容）
       - 在 `src/agents/pi-embedded-runner/google.ts`
    2. `limitHistoryTurns(...)`（按 sessionKey 对 DM/group/channel 限制最近 user turn）
       - 在 `src/agents/pi-embedded-runner/history.ts`
    3. 若配置了 context engine，则调用 `contextEngine.assemble(...)`
       - 可以返回新消息数组
       - 也可以返回 `systemPromptAddition`，并被 prepend 到系统提示词

---

## 3. Context Engine 机制（真正的“可插拔上下文管理”）

### 3.1 接口定义

- `src/context-engine/types.ts`
  - 必选：`ingest` / `assemble` / `compact`
  - 可选：`bootstrap` / `maintain` / `ingestBatch` / `afterTurn` / `dispose` 等
  - `maintain` 能拿到 `rewriteTranscriptEntries` runtime helper（由 runtime 注入）

### 3.2 注册与解析

- `src/context-engine/registry.ts`
  - 默认 slot：`contextEngine = "legacy"`（见 `src/plugins/slots.ts`）
  - 支持插件注册，并有 owner 防护，避免非可信 owner 覆盖核心引擎
  - registry 用 `Symbol.for(...)` 放在 `globalThis`，解决多 bundle chunk 可见性问题

### 3.3 默认 legacy 引擎做了什么

- `src/context-engine/legacy.ts`
  - `ingest`: no-op（会话持久化由 SessionManager 负责）
  - `assemble`: 透传消息（清洗/裁剪链路在 attempt 里）
  - `compact`: 调 `delegateCompactionToRuntime(...)` 委托到内建压缩

---

## 4. 运行期“防爆”三件套

## 4.1 Tool Result Context Guard（预防工具输出把窗口撑爆）

- `src/agents/pi-embedded-runner/tool-result-context-guard.ts`
  - 通过 hook `agent.transformContext` 对消息做 in-place 处理
  - 关键预算（字符估算）：
    - 总输入预算约为 `contextWindow * 0.75`
    - 单条 toolResult 预算约为 `contextWindow * 0.5`（用工具结果专用估算）
    - 高水位 `0.9`，超了直接抛 `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE`
  - 这会触发上层已有 overflow recovery 流程，而不是等 provider 硬报错

### 4.2 Context Pruning（cache-ttl 模式）

- 入口：`src/agents/pi-embedded-runner/extensions.ts`
  - 只有 `agents.defaults.contextPruning.mode === "cache-ttl"` 且 provider eligible 才启用
- 事件处理：`src/agents/pi-extensions/context-pruning/extension.ts`
  - 在 context event 上执行 `pruneContextMessages(...)`
  - TTL 未到不剪；TTL 到了才剪
- 算法：`src/agents/pi-extensions/context-pruning/pruner.ts`
  - 只处理 `toolResult`，不会改 user/assistant
  - 先 soft trim（head/tail 保留）
  - 达到 hard clear 条件再用 placeholder 清空
  - **只影响本次发给模型的上下文，不改磁盘 transcript**

### 4.3 Overflow Recovery + Compaction

- `src/agents/pi-embedded-runner/run.ts`
  - 检测到 context overflow 后会优先尝试 `contextEngine.compact(force=true, compactionTarget="budget")`
  - 若压缩无效，再走 oversized tool result 截断兜底
  - 成功压缩后继续重试原请求

---

## 5. 压缩（Compaction）和维护（Maintain）

### 5.1 自动/手动压缩统一走 contextEngine.compact

- 自动溢出恢复：`src/agents/pi-embedded-runner/run.ts`
- 手动 `/compact`：`src/agents/pi-embedded-runner/compact.ts`
  - 先计算 token budget，再调用 `contextEngine.compact(...)`
  - 如果引擎宣称 `ownsCompaction=true`，会额外保证 hook side effects 一致触发

### 5.2 maintain 是“压缩后和回合后的整理钩子”

- `src/agents/pi-embedded-runner/context-engine-maintenance.ts`
  - 在 `bootstrap` / `turn` / `compaction` 后按需调用 `contextEngine.maintain(...)`
  - runtime 会提供 transcript rewrite helper，避免引擎直接依赖底层 DAG 细节

---

## 6. 长期记忆是如何接入上下文的

### 6.1 系统提示词层：强制记忆召回习惯

- `src/agents/system-prompt.ts`
  - 若可用 memory 工具，会注入 `Memory Recall` 指令：
    - 先 `memory_search`
    - 再 `memory_get`
    - 用最小必要片段回答

### 6.2 工具层：memory_search / memory_get

- `src/agents/tools/memory-tool.ts`
  - `memory_search`: 语义检索 `MEMORY.md + memory/*.md`（可带 citations）
  - `memory_get`: 定点拉取片段，控制注入体积

### 6.3 索引层：MemoryIndexManager

- `src/memory/manager.ts`
  - 支持 hybrid 检索（向量 + FTS）
  - session start / search 时可触发增量 sync
  - provider 不可用时可降级到 FTS-only（前提 FTS 可用）

### 6.4 预压缩记忆刷写（Memory Flush）

- 判定：`src/auto-reply/reply/agent-runner-memory.ts`
  - 接近阈值时触发 memory flush（阈值与 context window、reserve floor、soft threshold 相关）
- 策略：`src/auto-reply/reply/memory-flush.ts`
  - 默认写 `memory/YYYY-MM-DD.md`
  - 强制 append-only、安全提示和 `NO_REPLY` 语义
  - 每个 compaction 周期只 flush 一次，避免重复刷写

---

## 7. 我理解的设计取舍

1. **引擎接口稳定，运行时策略可插拔**  
   `context-engine` 把 assemble/compact/afterTurn 从业务链路中抽离，便于替换算法。

2. **“清洗 + 裁剪 + 压缩”分工清晰**  
   - 清洗：格式正确性/跨 provider 兼容
   - 裁剪：减少无价值工具噪音
   - 压缩：真正释放窗口并持久化摘要

3. **短期上下文与长期记忆是耦合但分层的**  
   memory 工具不直接替代会话历史；它是“检索式补充”，由系统提示词和工具策略引导使用。

4. **异常处理偏保守**  
   看到大量 fallback、兼容分支和日志诊断，目标是“宁可降级也不中断对话”。

---

## 8. 后续可继续深挖的点

1. `compact.runtime` 的摘要质量策略与 token 收敛策略
2. `ownsCompaction=true` 插件在高并发/多 session 下的稳定性
3. memory hybrid 的召回质量与注入长度预算联动
4. pruning 与 provider cache 命中率（成本）之间的真实收益曲线


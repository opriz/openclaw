# 核心循环结构

## 类比：多渠道智能客服中心

- **前台（Gateway Loop）**：永远开着门，等消息进来
- **调度员（消息路由）**：把来消息分配给 Agent
- **坐席（Agent Loop）**：和用户对话，需要时调用工具，直到问题解决
- **通话过程（LLM Tool-Use Loop）**：每次对话内部的"问答-执行-回答"循环

---

## 整体结构图

```
外部渠道 (WhatsApp / Telegram / Discord / ...)
          │  消息进来
          ▼
┌─────────────────────────────┐
│  Gateway 进程级循环          │  src/cli/gateway-cli/run-loop.ts
│  while(true) 守护进程        │  ← 永不退出，收到 SIGUSR1 重启
└──────────┬──────────────────┘
           │
           ▼
    Channel Monitors
    (各渠道独立监听)
           │  onMessage()
           ▼
  getReplyFromConfig              src/auto-reply/reply/get-reply.ts
           │
           ▼
    runReplyAgent                 src/auto-reply/reply/agent-runner.ts
           │
           ▼
┌──────────────────────────────────┐
│  外层重试循环                     │  src/agents/pi-embedded-runner/run.ts
│  while(true) 最多 32~160 次       │
│  ├─ auth profile 轮转             │
│  ├─ context overflow → compaction │
│  ├─ rate limit → 退避等待         │
│  └─ runEmbeddedAttempt() ────────┼──────┐
└──────────────────────────────────┘      │
                                          ▼
                           ┌──────────────────────────────┐
                           │  LLM Tool-Use 内层循环         │  run/attempt.ts
                           │  (由 pi-coding-agent 管理)     │
                           │                               │
                           │  用户消息                      │
                           │     ↓                         │
                           │  LLM 推理 ──→ end_turn? ──YES─┼→ 返回
                           │     │                  NO     │
                           │     ↓                         │
                           │  tool_call (读文件/搜索/...)   │
                           │     ↓                         │
                           │  执行工具                      │
                           │     ↓                         │
                           │  结果塞回 LLM ─────────────────┘
                           └──────────────────────────────┘
```

---

## 逐层分析

### 第一层：Gateway 进程循环

**文件：`src/cli/gateway-cli/run-loop.ts`**，函数 `runGatewayLoop`（L28）

这是个**永久 `while(true)`**，本身几乎不做事：

- 启动 HTTP/WebSocket 服务器
- 挂起（await 一个 Promise）
- 收到 `SIGUSR1` → resolve → 下一圈重启服务器
- `SIGTERM`/`SIGINT` → 优雅关闭（drain 所有 active runs，再 exit）

### 第二层：外层重试循环

**文件：`src/agents/pi-embedded-runner/run.ts`**，函数 `runEmbeddedPiAgent`（L254）

重试上限常量：

```ts
const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;
```

这层 `while(true)` 负责所有**容错与降级**：

| 遇到的问题              | 处理方式                                 |
| ----------------------- | ---------------------------------------- |
| context 超出 token 上限 | 触发 compaction（压缩历史）后 `continue` |
| auth 失败 / key 无效    | 轮换到下一个 auth profile 后 `continue`  |
| rate limit / overload   | 指数退避等待后 `continue`                |
| 正常完成                | `break` 退出循环                         |
| 超过最大重试次数        | 返回 `retry_limit` 错误                  |

### 第三层：LLM Tool-Use 内层循环

**文件：`src/agents/pi-embedded-runner/run/attempt.ts`**，函数 `runEmbeddedAttempt`（L746）

通过 `activeSession.prompt()` 触发（来自 `@mariozechner/pi-coding-agent`），内部是标准 Agentic Loop：

```
用户消息 → LLM 推理 → tool_call? → 执行工具 → 结果喂回 LLM → 重复
                          ↓ 无 tool_call
                        end_turn → 返回结果
```

---

## 两条触发路径

```
渠道消息触发:
  Channel Monitor → getReplyFromConfig → runReplyAgent
                                              ↓
CLI 直接触发:                           runEmbeddedPiAgent
  agentCommand → agentCommandInternal   ↗
```

两条路最终都汇聚到 `runEmbeddedPiAgent`（`src/agents/pi-embedded-runner/run.ts`）。

---

## 并发控制：双层队列

```ts
// src/agents/pi-embedded-runner/run.ts L273
return enqueueSession(() =>
  enqueueGlobal(async () => {
```

- **Session 级队列**：同一 session 的消息串行执行（不会并发回复同一人）
- **全局队列**：跨 session 的全局并发上限

不同用户的消息可以并发处理，但同一用户的多条消息会排队。`await runEmbeddedPiAgent(...)` 可能在队列中等待，而不是立即执行。

---

## 关键文件速查

| 文件                                           | 关键函数                           | 作用                                   |
| ---------------------------------------------- | ---------------------------------- | -------------------------------------- |
| `src/cli/gateway-cli/run-loop.ts`              | `runGatewayLoop` (L28)             | Gateway 进程级永久循环                 |
| `src/agents/pi-embedded-runner/run.ts`         | `runEmbeddedPiAgent` (L254)        | 外层重试循环（auth/overflow/fallback） |
| `src/agents/pi-embedded-runner/run/attempt.ts` | `runEmbeddedAttempt` (L746)        | 单次 LLM 调用（含 tool-use loop）      |
| `src/auto-reply/reply/agent-runner.ts`         | `runReplyAgent` (L63)              | 渠道消息触发的 Agent 入口              |
| `src/commands/agent.ts`                        | `agentCommandInternal` (L678)      | CLI 触发的 Agent 入口                  |
| `src/process/command-queue.ts`                 | `enqueueSession` / `enqueueGlobal` | 双层并发队列                           |

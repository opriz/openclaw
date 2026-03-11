# run.ts 文件结构与运行流程

面向「没写过 TypeScript」的读者：用结构图 + 文字说明这个文件在干什么、怎么跑完一次 agent。

---

## 1. 文件在项目里的位置

```
src/agents/
├── pi-embedded-runner.ts          ← 入口：只做 re-export
└── pi-embedded-runner/
    ├── run.ts                     ← 本文件：一次「跑 agent」的调度与重试
    ├── run/
    │   ├── attempt.ts             ← 单次尝试：真正调 Pi SDK 跑一轮对话
    │   ├── params.ts              ← 参数类型
    │   ├── payloads.ts             ← 把结果打成返回给上层的 payload
    │   └── ...
    ├── model.ts, history.ts, ...  ← 其他辅助
    └── ...
```

**一句话**：`run.ts` 负责「排队 → 准备环境 → 在重试循环里反复调用 `runEmbeddedAttempt`，直到成功或放弃」。

---

## 2. run.ts 内部结构（从上到下）

```
┌─────────────────────────────────────────────────────────────────┐
│  头部：import（从 Pi SDK、OpenClaw 其他模块拉依赖）                │
└─────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────┐
│  类型与小型工具函数（仅本文件用）                                   │
│  • ApiKeyInfo, CopilotTokenState                                 │
│  • scrubAnthropicRefusalMagic()  洗掉 Anthropic 测试用魔法串      │
│  • createCompactionDiagId()      生成压缩诊断 ID                   │
│  • resolveMaxRunRetryIterations() 根据 profile 数量算最大重试次数   │
│  • resolveActiveErrorContext()   从上次结果里取错误上下文          │
│  • buildErrorAgentMeta()         构造错误时的 meta                 │
└─────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────┐
│  唯一对外导出：runEmbeddedPiAgent(params)                         │
│  → 返回 Promise<EmbeddedPiRunResult>                              │
└─────────────────────────────────────────────────────────────────┘
```

也就是说：**这个文件主要就是一个大函数 `runEmbeddedPiAgent`**，前面都是给它用的类型和工具。

---

## 3. 运行流程总览（从被调用到返回）

```
调用方
  │
  ▼
runEmbeddedPiAgent(params)
  │
  ├─ 1. 排队（两层）
  │      enqueueSession(() => enqueueGlobal(async () => { ... }))
  │      • 先占「本会话」的槽位（同一会话同时只跑一个）
  │      • 再占「全局」的槽位（全进程并发数有限）
  │
  ▼
  ├─ 2. 进入 async 回调后的「准备阶段」（只做一次）
  │      • 解析 workspace、加载插件、确定 provider/model
  │      • 执行 hooks：before_model_resolve、before_agent_start
  │      • resolveModel() → 拿到 model、authStorage、modelRegistry
  │      • 检查 context window、auth profiles、Copilot token 等
  │      • 初始化 contextEngine，进入 try { while(true) { ... } }
  │
  ▼
  ├─ 3. 重试循环 while (true)
  │      │
  │      ├─ 3.1 超重试上限？ → 直接 return 错误结果，结束
  │      │
  │      ├─ 3.2 runLoopIterations++，创建 workspace 目录，处理 prompt
  │      │
  │      ├─ 3.3 调用 runEmbeddedAttempt(...)  ← 真正跑 Pi 的一轮
  │      │         （内部：读 session、调 Pi SDK、流式输出、工具调用等）
  │      │
  │      ├─ 3.4 根据 attempt 结果分支：
  │      │      • context overflow → 做压缩/截断 tool result，成功则 continue
  │      │      • promptError → 鉴权/角色顺序/图片大小/failover/换 profile/降 thinking
  │      │      • assistant 错误（auth/限流/计费/超时）→ 换 profile 或 throw FailoverError
  │      │      • 成功 → 拼 payloads、写 meta、return 正常结果
  │      │
  │      └─ 未 return 则 continue，进入下一轮循环
  │
  └─ 4. finally：释放 contextEngine、停 Copilot 刷新、恢复 cwd
  │
  ▼
返回 EmbeddedPiRunResult（payloads + meta + 若干可选字段）
```

---

## 4. 和「Pi」的关系（谁在真正调 SDK）

- **`run.ts`**：不直接调 Pi 的 `AgentSession`。只做：
  - 排队、环境与鉴权准备、重试/换 profile/压缩/错误处理，
  - 在循环里反复调用 **`runEmbeddedAttempt()`**。
- **`run/attempt.ts`**：这里才会：
  - 用 Pi 的 `createAgentSession`、`SessionManager` 等，
  - 读 session 文件、组消息、调 `streamSimple` 等，
  - 跑完「一轮」对话（可能包含多轮 tool-use），把结果塞回 `run.ts`。

所以：**「从 Pi 引用的」= 在 `attempt.ts`（及别处）里 `from "@mariozechner/pi-xxx"` 的那些类型和函数**；`run.ts` 主要是「调度 + 重试 + 错误与资源管理」。

---

## 5. 一张图串起来

```
                    runEmbeddedPiAgent(params)
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
   enqueueSession      enqueueGlobal         async () => {
   (会话排队)            (全局排队)               │
         │                    │                    │
         └────────────────────┴────────────────────┘
                              │
              准备：workspace / model / auth / contextEngine
                              │
         ┌────────────────────▼────────────────────┐
         │  while (true) 重试循环                   │
         │  ┌──────────────────────────────────┐  │
         │  │ 超限? → return 错误                │  │
         │  │ attempt = runEmbeddedAttempt(...) │  │  ← Pi SDK 在这里被调用
         │  │ overflow? → compaction/truncate   │  │
         │  │ 错误? → 换 profile / 降 thinking   │  │
         │  │ 成功? → build payloads, return    │  │
         │  └──────────────────────────────────┘  │
         └─────────────────────────────────────────┘
                              │
                    finally: 释放资源
                              │
                              ▼
                    EmbeddedPiRunResult
```

---

## 6. 小结（不写 TS 也能记住的几点）

1. **run.ts 只导出一个函数**：`runEmbeddedPiAgent`，前面都是类型和辅助函数。
2. **先排队再干活**：先会话队、再全局队，然后才进 async 里的准备 + 重试循环。
3. **真正跑 Pi 的是 attempt**：`runEmbeddedAttempt()` 在 `run/attempt.ts`，那里才用 Pi 的 session/stream/tools。
4. **循环在干两件事**：要么根据错误类型做补救（换 profile、压缩、降 thinking）并 `continue`，要么成功/放弃时 `return` 结果。
5. **区分「Pi 来的」**：看 import 路径是否带 `@mariozechner/pi-`；`run.ts` 里大多是 OpenClaw 自己的逻辑和从本仓库其他文件 import 的依赖。

若想继续往下追「单次对话里具体怎么调 LLM、怎么执行工具」，可以看 `run/attempt.ts` 和仓库里的 `notes/core-loop.md`。

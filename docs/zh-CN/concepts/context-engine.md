---
read_when:
  - 你想理解 OpenClaw 如何组装模型上下文
  - 你在 `legacy` 引擎和插件引擎之间切换
  - 你正在开发 Context Engine 插件
summary: Context Engine：可插拔的上下文组装、压缩、维护与子智能体生命周期
title: Context Engine
---

# Context Engine

**Context Engine** 决定 OpenClaw 在每次运行里如何构建模型上下文。
它负责选择哪些消息进入模型窗口、如何压缩旧历史，以及如何在回合之间维护上下文相关状态。

OpenClaw 内置了一个 `legacy` 引擎。插件也可以注册替代引擎，接管当前激活的上下文生命周期。

## 快速开始

查看当前启用的是哪个引擎：

```bash
openclaw doctor
# 或直接查看配置：
cat ~/.openclaw/openclaw.json | jq '.plugins.slots.contextEngine'
```

### 安装 Context Engine 插件

Context Engine 插件和其他 OpenClaw 插件一样安装。先安装，再在 slot 中选择它：

```bash
# 从 npm 安装
openclaw plugins install @martian-engineering/lossless-claw

# 或从本地路径安装（开发时）
openclaw plugins install -l ./my-context-engine
```

然后在配置中启用插件，并把它选为当前活动引擎：

```json5
// openclaw.json
{
  plugins: {
    slots: {
      contextEngine: "lossless-claw", // 必须和插件注册的 engine id 一致
    },
    entries: {
      "lossless-claw": {
        enabled: true,
        // 插件自己的配置写在这里
      },
    },
  },
}
```

安装并配置后，重启 Gateway 网关。

若要切回内置引擎，将 `contextEngine` 设为 `"legacy"`（或直接删掉该键，默认就是 `"legacy"`）。

## 它是如何工作的

在嵌入式 OpenClaw 运行里，Context Engine 最多会参与 5 个生命周期点：

1. **Bootstrap**
   - 可选的会话初始化。
   - 可用于导入旧历史、预热自有存储、建立索引。
2. **Assemble**
   - 在每次模型调用前执行。
   - 返回最终送给模型的消息序列，以及可选的 `systemPromptAddition`。
3. **Compact**
   - 当上下文窗口已满、用户执行 `/compact`，或溢出恢复需要压缩时执行。
4. **After turn / ingest**
   - 成功回合之后，优先调用 `afterTurn()`。
   - 如果没有 `afterTurn()`，运行时会回退到 `ingestBatch()` 或逐条 `ingest()`。
5. **Maintain**
   - 在 bootstrap、压缩、成功回合之后执行可选的维护逻辑。
   - 适合做 transcript hygiene、选择性重写历史、后处理清理等工作。

### 运行时真正的顺序

嵌入式 Pi runner 的大体顺序是：

1. 读取并清洗会话 transcript。
2. 执行内置校验、截断和工具配对修复。
3. 调用 `contextEngine.assemble(...)`。
4. 运行模型。
5. 如有需要，调用 `contextEngine.compact(...)`。
6. 回合成功后：
   - 优先执行 `afterTurn(...)`；
   - 否则回退到 `ingestBatch(...)` / `ingest(...)`。
7. 若实现了 `maintain(...)`，再执行维护逻辑。

所以 Context Engine 并不会替代全部运行时逻辑。队列、会话文件、工具 schema、提供商特定校验、会话修剪等仍由运行时负责。

### 子智能体生命周期

目前 OpenClaw 实际调用的子智能体生命周期钩子是：

- **`onSubagentEnded`**
  - 当子会话完成、被 sweep、被释放或被删除时做清理。

`prepareSubagentSpawn` 也存在于接口里，但目前还不是主要的学习入口。

### system prompt 增量

`assemble()` 可以返回 `systemPromptAddition`。OpenClaw 会把它前置到运行时系统提示词前面。

这允许引擎：

- 注入动态召回提示，
- 添加检索指令，
- 加入当前上下文相关的额外规则，

而不用去改工作区文件或替换整个系统提示词构建器。

## `legacy` 引擎

内置的 `legacy` 引擎基本保留了 OpenClaw 的默认行为：

- **Bootstrap**：空操作。
- **Assemble**：透传；仍由运行时的 sanitize -> validate -> limit 流水线处理上下文。
- **Compact**：委托给 OpenClaw 内置的摘要压缩。
- **After turn / ingest**：空操作。
- **Maintain**：空操作。

`legacy` 不会注册额外工具，也不会提供 `systemPromptAddition`。

当 `plugins.slots.contextEngine` 未设置，或显式设为 `"legacy"` 时，就会自动使用它。

## 插件引擎

插件可以通过 API 注册一个 Context Engine：

```ts
export default function register(api) {
  api.registerContextEngine("my-engine", () => ({
    info: {
      id: "my-engine",
      name: "My Context Engine",
      ownsCompaction: true,
    },

    async ingest({ sessionId, message, isHeartbeat }) {
      // 把消息写入你自己的存储
      return { ingested: true };
    },

    async assemble({ sessionId, messages, tokenBudget }) {
      return {
        messages: buildContext(messages, tokenBudget),
        estimatedTokens: countTokens(messages),
        systemPromptAddition: "Use history-aware retrieval before answering.",
      };
    },

    async compact({ sessionId, force }) {
      return { ok: true, compacted: true };
    },

    async maintain({ runtimeContext }) {
      await runtimeContext?.rewriteTranscriptEntries?.({
        replacements: [],
      });
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
    },
  }));
}
```

然后在配置中启用：

```json5
{
  plugins: {
    slots: {
      contextEngine: "my-engine",
    },
    entries: {
      "my-engine": {
        enabled: true,
      },
    },
  },
}
```

## `ContextEngine` 接口

必选成员：

| 成员 | 类型 | 作用 |
| --- | --- | --- |
| `info` | 属性 | 引擎 id、名称、版本，以及是否接管 compaction |
| `ingest(params)` | 方法 | 存储单条消息 |
| `assemble(params)` | 方法 | 为一次模型运行构建上下文 |
| `compact(params)` | 方法 | 对上下文做压缩 / 缩减 |

`assemble` 返回：

- `messages`：最终发送给模型的消息顺序。
- `estimatedTokens`：引擎估算的总 token 数；OpenClaw 用它做压缩阈值判断和诊断展示。
- `systemPromptAddition`（可选）：前置到系统提示词前的额外文本。

可选成员：

| 成员 | 类型 | 作用 |
| --- | --- | --- |
| `bootstrap(params)` | 方法 | 在运行前为会话文件初始化引擎状态 |
| `maintain(params)` | 方法 | 在 bootstrap、压缩或成功回合之后执行维护 |
| `ingestBatch(params)` | 方法 | 批量摄取一个完整回合 |
| `afterTurn(params)` | 方法 | 回合后的生命周期逻辑；若实现，运行时优先调用它 |
| `prepareSubagentSpawn(params)` | 方法 | 为子会话准备引擎侧状态 |
| `onSubagentEnded(params)` | 方法 | 子智能体结束后的清理 |
| `dispose()` | 方法 | Gateway 网关关闭或插件重载时释放资源 |

### transcript rewrite 支持

`maintain()` 和 `afterTurn()` 可以拿到一个运行时上下文对象，其中最重要的帮助器是：

- `rewriteTranscriptEntries(request)`

它是一个**由运行时拥有**的安全重写接口，用来在当前活动分支上重写 transcript 条目。

设计边界是：

- **引擎**决定“哪些内容可以安全重写”；
- **运行时**决定“如何更新 JSONL / session DAG”。

这样插件就不必直接依赖 Pi 内部实现，也能做高级 transcript hygiene。

## `ownsCompaction`

`ownsCompaction` 决定 Pi 内置的回合内自动压缩是否保持启用：

- `true`
  - 引擎接管 compaction。
  - OpenClaw 会关闭该运行中的 Pi 内置自动压缩。
  - `/compact`、溢出恢复压缩、以及任何主动压缩，都由引擎自己的 `compact()` 负责。
- `false` 或未设置
  - Pi 的内置自动压缩仍可能在运行中发生。
  - 但当前活动引擎的 `compact()` 仍然会用于 `/compact` 和溢出恢复。

`ownsCompaction: false` **不表示** OpenClaw 会自动回退到 legacy 的 compaction 路径。

因此有两种有效模式：

- **Owning mode**
  - 自己实现 compaction，并设置 `ownsCompaction: true`。
- **Delegating mode**
  - 设置 `ownsCompaction: false`，
  - 在 `compact()` 里调用 `openclaw/plugin-sdk/core` 的 `delegateCompactionToRuntime(...)`，
  - 复用 OpenClaw 内置压缩逻辑。

对于一个处于活动状态、但 `ownsCompaction` 为 false 的引擎来说，`compact()` 做成空实现是危险的，因为这会破坏正常的 `/compact` 和溢出恢复路径。

## 配置参考

```json5
{
  plugins: {
    slots: {
      // 选择当前活动的 Context Engine，默认是 "legacy"
      contextEngine: "legacy",
    },
  },
}
```

这个 slot 在运行时是独占的：每一次运行或压缩操作都只会解析出一个活动引擎。
其他 `kind: "context-engine"` 插件即使被启用，也只是加载注册代码；真正被调用的是 `plugins.slots.contextEngine` 选中的那个引擎 id。

## 与压缩、记忆、修剪的关系

- **压缩**
  - 是 Context Engine 的职责之一。
  - legacy 引擎委托给 OpenClaw 内置摘要压缩。
  - 插件引擎可以实现 DAG 摘要、检索驱动压缩等策略。
- **记忆插件**
  - `plugins.slots.memory` 和 Context Engine 是分开的。
  - 记忆插件负责 search / retrieval，Context Engine 决定模型实际看见什么。
- **会话修剪**
  - 无论活动的是哪个 Context Engine，session pruning 仍会运行。
  - 它主要修剪的是运行时内存中的旧工具结果，而不是替代 compaction。

## 使用建议

- 用 `openclaw doctor` 确认引擎是否正确加载。
- 切换引擎后，已有会话仍保留原有 transcript 历史；新引擎接管后续运行。
- 如果插件引擎注册失败，或配置中的引擎 id 无法解析，OpenClaw **不会自动回退**，运行会失败，直到你修好插件或切回 `"legacy"`。
- 本地开发时，可用 `openclaw plugins install -l ./my-engine` 直接链接本地目录。

另请参阅：[上下文](/concepts/context)、[压缩](/concepts/compaction)、[智能体循环](/concepts/agent-loop)、[插件](/tools/plugin)、[插件清单](/plugins/manifest)。

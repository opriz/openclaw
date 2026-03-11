# PR #40008：kimi-coding 工具格式修复

https://github.com/openclaw/openclaw/pull/40008

## 问题描述

2026.3.7 引入的 `createKimiCodingAnthropicToolSchemaWrapper`（commit 909f26a26）把
`kimi-coding` 的 `anthropicToolSchemaMode` 设成了 `"openai-functions"`，导致发给
`api.kimi.com/coding/` 的工具定义被转成 OpenAI 格式。

但 Kimi Coding 端点原生支持 Anthropic 工具格式，收到 OpenAI 格式时会降级：
不返回结构化 `tool_use` block，而是把工具调用以 XML 文本输出在 response body 里。
OpenClaw 无法解析 XML 文本形式的工具调用，工具永远不会被执行。

| 工具格式         | 工具定义结构                                           | Kimi 响应                  |
| ---------------- | ------------------------------------------------------ | -------------------------- |
| Anthropic native | `{ name, description, input_schema }`                  | 结构化 `tool_use` block ✅ |
| OpenAI format    | `{ type: "function", function: { name, parameters } }` | XML 纯文本 ❌              |

## 问题在链路中的位置

```
attempt.ts
    │
    ├─ L1080  resolveTranscriptPolicy()
    │         → 读 PROVIDER_CAPABILITIES["kimi-coding"]
    │         → anthropicToolSchemaMode: "openai-functions"（错误配置）
    │
    ├─ L1150  createOpenClawCodingTools()   构建工具集（Anthropic 格式）
    │
    ├─ L1179  createAgentSession({ tools: builtInTools })
    │
    └─ stream wrapper 组装
           │
           ▼
    anthropic-stream-wrappers.ts:67
    requiresOpenAiCompatibleAnthropicToolPayload("kimi-coding")
           │  → true（因为 anthropicToolSchemaMode === "openai-functions"）
           ▼
    createAnthropicToolPayloadCompatibilityWrapper() 被激活
           │  每次 HTTP 请求前把工具定义格式转换：
           │  { name, description, input_schema }
           │        ↓
           │  { type: "function", function: { name, parameters } }
           ▼
    HTTP 请求发到 api.kimi.com/coding/
           │
           ▼  ← 问题在这里
    Kimi 收到 OpenAI 格式 → 降级输出 XML 文本
           ▼
    subscribeEmbeddedPiSession
    → 只收到 text_delta，没有 tool_execution 事件
    → 工具永远不被执行
```

## 修复

```typescript
// 修复前（provider-capabilities.ts）
"kimi-coding": {
  anthropicToolSchemaMode: "openai-functions",   // ← 错误
  anthropicToolChoiceMode: "openai-string-modes", // ← 错误
  preserveAnthropicThinkingSignatures: false,
}

// 修复后
"kimi-coding": {
  preserveAnthropicThinkingSignatures: false,    // 只保留这一行
}
```

## 两个配置的原本意义

这两个配置是配套的，针对**用 Anthropic API 路径做代理、但底层是 OpenAI 模型**的 provider。

### `anthropicToolSchemaMode: "openai-functions"`

把工具定义从 Anthropic 格式转成 OpenAI functions 格式：

```
Anthropic 格式（pi-ai 默认产出）：
{ name: "bash", description: "...", input_schema: { type: "object", properties: {...} } }

转换后（OpenAI functions 格式）：
{ type: "function", function: { name: "bash", description: "...", parameters: {...} } }
```

### `anthropicToolChoiceMode: "openai-string-modes"`

把 `tool_choice` 从 Anthropic 对象格式转成 OpenAI 字符串格式：

```
Anthropic 格式：{ type: "auto" } / { type: "required" } / { type: "tool", name: "bash" }
转换后：        "auto"           / "required"             / { type: "function", function: { name: "bash" } }
```

Kimi 的错误在于：它的 `/coding/` 端点**原生实现了 Anthropic 协议**，不是 OpenAI 代理层，
不需要这层转换。把它当成"OpenAI 代理"对待，反而触发了降级。

---

## 为什么降级输出是 XML 格式

Kimi 收到 OpenAI 格式的工具定义后，没能识别出这是工具列表，但它仍然"知道"应该调用工具。
于是用训练时学到的 XML 格式把工具调用意图写出来：

```xml
<function_calls>
<invoke name="bash">
<parameter name="command">ls -la</parameter>
</invoke>
</function_calls>
```

**XML 格式的历史来源**：Anthropic 在推出原生 `tool_use` block（2024 年初）之前，
官方文档教用户在 system prompt 里描述工具，让模型用 XML 格式输出调用意图再手动解析。
这个模式被写进了大量早期 Claude 训练数据，后来很多基于 Claude 蒸馏或参考其数据训练的模型
（包括 Kimi）都学到了这个行为。

**两种工具调用的本质区别**：

|                 | 原生 `tool_use` block               | XML 文本             |
| --------------- | ----------------------------------- | -------------------- |
| 层级            | 协议层（SSE 事件）                  | 模型层（生成文本）   |
| 来源            | `content_block.type === "tool_use"` | `text_delta`         |
| OpenClaw 能解析 | ✅                                  | ❌（当普通文本处理） |
| 用户看到        | 工具被执行，返回结果                | 一段 XML 文本输出    |

---

## 关键结论

`PROVIDER_CAPABILITIES` 里的 `anthropicToolSchemaMode` 字段直接控制
`anthropic-stream-wrappers.ts` 里的 wrapper 是否在每次 HTTP 请求前改写工具定义格式。
配错这个字段会导致工具调用在 LLM 侧静默失败（降级为 XML 文本），
且在 OpenClaw 侧没有任何报错——只是工具永远不执行。

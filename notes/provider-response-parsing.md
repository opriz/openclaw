# LLM 响应解析：多厂商适配架构

## 1. 核心设计思路

OpenClaw 用**分层 wrapper 链 + 统一事件流**的方式处理不同厂商的响应：

```
各厂商原始响应（HTTP SSE / WebSocket / NDJSON）
          │
          ▼
    厂商 stream 实现（Anthropic / OpenAI WS / Ollama）
          │  把厂商格式转换为统一 AssistantMessage
          ▼
    stream wrapper 链（修复各厂商 quirks）
          │  trim tool names / decode html entities / inject headers...
          ▼
    @mariozechner/pi-coding-agent 内部事件系统
          │  发出 message_start / message_update / message_end / tool_* 事件
          ▼
    subscribeEmbeddedPiSession（OpenClaw 订阅层）
          │  处理文本流 / 工具调用 / 生命周期
          ▼
    onBlockReply / onToolResult / onAgentEvent（输出到 UI/消息通道）
```

---

## 2. 统一消息格式：AssistantMessage

所有厂商的响应最终都转换成这个结构（`src/agents/stream-message-shared.ts`）：

```typescript
type AssistantMessage = {
  role: "assistant";
  content: (TextContent | ToolCall)[];
  stopReason: "stop" | "toolUse" | "error" | "length";
  api: string; // "anthropic-messages" | "openai-responses" | "ollama" ...
  provider: string; // "anthropic" | "openai" | "ollama" | "xai" ...
  model: string;
  usage: Usage;
  errorMessage?: string;
};

type TextContent = { type: "text"; text: string };
type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
```

所有不同厂商的流都通过 `buildAssistantMessage()` 转换成这个格式。

---

## 3. 三大 Stream 实现

### 3.1 Anthropic HTTP SSE（`streamSimple`）

- 来自 `@mariozechner/pi-ai`，处理 Anthropic 官方 SSE 事件
- OpenClaw 在外层加 wrapper 注入 beta 头、缓存控制等
- 内部已完整处理 `content_block_start/delta/stop`、`message_delta` 等原生事件

```
Anthropic SSE 事件
  content_block_start → 开始一个 text 或 tool_use block
  content_block_delta → 增量内容（text_delta / input_json_delta）
  content_block_stop  → block 结束
  message_delta       → stop_reason / usage
      ↓
  buildAssistantMessage() → AssistantMessage
```

### 3.2 OpenAI WebSocket（`src/agents/openai-ws-stream.ts`）

- 用于 OpenAI Realtime API，通过 WebSocket 长连接
- 每个 session 维护一个 WS 连接（`getOrCreateWsSession`）
- 消息转换：pi-ai 格式 → OpenAI ContentPart[] → 响应 → AssistantMessage

```typescript
// 请求时：pi-ai 格式 → OpenAI 格式
function contentToOpenAIParts(content): ContentPart[] {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  // 处理 image、tool_result 等多部分内容
}

// 响应时：OpenAI 格式 → AssistantMessage
buildAssistantMessage({
  content: [{ type: "text", text: accumulated }],
  stopReason: finish_reason === "tool_calls" ? "toolUse" : "stop",
  ...
});
```

### 3.3 Ollama 原生 NDJSON（`src/agents/ollama-stream.ts`）

- 调用 Ollama `/api/chat`，响应是 NDJSON（每行一个 JSON）
- 特殊处理：工具调用可能在中间 chunk 而非最终 chunk 里

```typescript
// 逐行解析 NDJSON
for await (const chunk of parseNdjsonStream(reader)) {
  if (chunk.message?.content) accumulatedContent += chunk.message.content;
  if (chunk.message?.tool_calls) accumulatedToolCalls.push(...);
}

// 构建统一格式
buildAssistantMessage({
  content: [
    { type: "text", text: accumulatedContent },
    ...accumulatedToolCalls.map(tc => ({
      type: "toolCall",
      id: `ollama_call_${randomUUID()}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
  ],
  stopReason: accumulatedToolCalls.length > 0 ? "toolUse" : "stop",
});
```

注意：用 `parseJsonPreservingUnsafeIntegers()` 防止 JS 数字精度丢失。

---

## 4. Stream Wrapper 链（修复各厂商 Quirks）

wrapper 是函数包装器，形如 `(baseStreamFn) => newStreamFn`，可以任意叠加。

### 4.1 `wrapStreamFnTrimToolCallNames`

**问题**：某些代理（如通过代理转发的 Anthropic）返回的工具名称带多余空格。

**修复**：拦截 stream 的每个 chunk 和最终 result，对 tool call name 做 `.trim()`。

```typescript
function normalizeToolCallNameForDispatch(rawName, allowedToolNames) {
  const trimmed = rawName.trim();
  return trimmed.length > 0 ? trimmed : rawName;
}
// 应用于 message.content 中所有 type==="toolCall" 的 name 字段
```

### 4.2 `wrapStreamFnDecodeXaiToolCallArguments`

**问题**：xAI/Grok 在工具参数里返回 HTML 实体编码的 JSON（`&quot;` `&amp;` 等）。

**修复**：递归遍历 tool call arguments，解码 HTML 实体。

```typescript
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}
// 递归应用到 tool call 的 arguments 对象
export function decodeHtmlEntitiesInObject(obj: unknown): unknown { ... }
```

### 4.3 Anthropic Wrappers（`anthropic-stream-wrappers.ts`）

| Wrapper                                          | 作用                                             |
| ------------------------------------------------ | ------------------------------------------------ |
| `createAnthropicBetaHeadersWrapper`              | 注入 beta 头（如 `fine-grained-tool-streaming`） |
| `createAnthropicToolPayloadCompatibilityWrapper` | 处理某些代理对 Anthropic 工具格式的转换需求      |
| `createBedrockNoCacheWrapper`                    | 禁用 AWS Bedrock 的缓存控制                      |

### 4.4 OpenAI Wrappers（`openai-stream-wrappers.ts`）

| Wrapper                                         | 作用                                     |
| ----------------------------------------------- | ---------------------------------------- |
| `createOpenAIResponsesContextManagementWrapper` | 启用 responses store / 服务端 compaction |
| `createOpenAIServiceTierWrapper`                | 注入 service_tier 参数                   |
| `createOpenAIDefaultTransportWrapper`           | 设置 WebSocket 暖启动                    |

### 4.5 代理模式 Wrappers（`proxy-stream-wrappers.ts`）

| Wrapper                              | 作用                                          |
| ------------------------------------ | --------------------------------------------- |
| `createOpenRouterWrapper`            | 添加 OpenRouter 头，规范化推理努力级别        |
| `createOpenRouterSystemCacheWrapper` | 为 Anthropic 模型上的 system 消息添加缓存控制 |
| `createKilocodeWrapper`              | 注入 Kilocode 应用头                          |

### 4.6 Moonshot 思考 Wrapper（`moonshot-stream-wrappers.ts`）

```typescript
// 注入或覆盖思考配置，处理 Moonshot 不支持某些 tool_choice 的问题
createMoonshotThinkingWrapper(baseStreamFn, thinkingType?: "enabled" | "disabled")
```

---

## 5. 订阅层事件处理（`subscribeEmbeddedPiSession`）

### 5.1 事件类型

`@mariozechner/pi-coding-agent` 内部发出 9 种事件：

```
message_start          → LLM 开始生成回复
message_update         → 流式增量（text_delta / thinking_delta）
message_end            → 消息生成完成
tool_execution_start   → 开始执行工具
tool_execution_update  → 工具执行中
tool_execution_end     → 工具执行完成
agent_start            → agent 生命周期：启动
auto_compaction_start  → 内存压缩开始
auto_compaction_end    → 内存压缩完成
agent_end              → agent 生命周期：结束
```

### 5.2 文本事件处理（message_update）

```
message_update 事件
    │
    ├─ assistantMessageEvent.type === "thinking_delta"
    │      → 收集到 reasoning 缓冲区
    │      → 调用 onReasoningStream
    │
    ├─ assistantMessageEvent.type === "text_delta"
    │      → stripBlockTags()（去除 <think>/<final> 等 XML 标签）
    │      → stripDowngradedToolCallText()（移除降级工具调用标记）
    │      → 推送增量到 onPartialReply / onAgentEvent
    │
    └─ assistantMessageEvent.type === "text_end"
           → 处理某些 provider 重复发送完整内容的情况（只取增量）
```

### 5.3 消息结束处理（message_end）

```
message_end 事件
    │
    ├─ promoteThinkingTagsToBlocks()   → XML 标签 → 结构化 thinking blocks
    ├─ stripBlockTags()                → 剥离 thinking 块，保留最终输出
    ├─ 发送最终 block reply
    └─ 记录 usage 统计
```

### 5.4 工具调用处理（tool*execution*\*）

```
tool_execution_start
    → 记录工具名称和参数

tool_execution_end
    → 解析工具结果
    → 调用 onToolResult
    → 抽取 metadata（用于 toolMetas 统计）
    → 调用 onAgentEvent(stream: "tool_result")
```

---

## 6. 完整调用链

```
activeSession.prompt(effectivePrompt)
        │
        ▼
  streamFn 链（wrapper 堆栈，从外到内执行）
  ┌─────────────────────────────────┐
  │ wrapStreamFnTrimToolCallNames   │  修复工具名空格
  │ wrapStreamFnDecodeXai...        │  修复 xAI HTML 实体
  │ createAnthropicBetaHeaders...   │  注入 beta 头
  │ createOpenRouter...             │  代理头
  │ ...其他 wrappers                │
  │   ↓                             │
  │   baseStreamFn                  │  实际发 HTTP/WS 请求
  │   (streamSimple / ollama / ws)  │
  └─────────────────────────────────┘
        │
        ▼ 返回 AssistantMessage（统一格式）
        │
  @mariozechner/pi-coding-agent 内部
  → 发出 message_start / message_update / message_end / tool_* 事件
        │
        ▼
  subscribeEmbeddedPiSession（OpenClaw 订阅层）
  ├─ handleMessageStart  → 重置状态
  ├─ handleMessageUpdate → 增量文本/思考 → onPartialReply
  ├─ handleMessageEnd    → 最终文本 → onBlockReply
  ├─ handleToolExecution → 工具结果 → onToolResult
  └─ handleLifecycle     → agent_start/end → onAgentEvent
        │
        ▼
  输出到消息通道（Telegram/Discord/SMS...）
```

---

## 7. 关键文件路径

| 文件                                                         | 职责                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| `src/agents/stream-message-shared.ts`                        | 统一 AssistantMessage 格式和 buildAssistantMessage() |
| `src/agents/ollama-stream.ts`                                | Ollama NDJSON 流实现                                 |
| `src/agents/openai-ws-stream.ts`                             | OpenAI WebSocket 流实现                              |
| `src/agents/pi-embedded-runner/run/attempt.ts`               | wrapper 链组装（L1228~1290）                         |
| `src/agents/pi-embedded-runner/anthropic-stream-wrappers.ts` | Anthropic 特定 wrappers                              |
| `src/agents/pi-embedded-runner/openai-stream-wrappers.ts`    | OpenAI 特定 wrappers                                 |
| `src/agents/pi-embedded-runner/proxy-stream-wrappers.ts`     | 代理模式 wrappers                                    |
| `src/agents/pi-embedded-runner/moonshot-stream-wrappers.ts`  | Moonshot 思考 wrapper                                |
| `src/agents/pi-embedded-subscribe.ts`                        | 订阅协调器                                           |
| `src/agents/pi-embedded-subscribe.handlers.ts`               | 事件路由器                                           |
| `src/agents/pi-embedded-subscribe.handlers.messages.ts`      | text/thinking 处理                                   |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts`         | 工具执行处理                                         |
| `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts`     | 生命周期处理                                         |

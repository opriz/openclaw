# prompt() 序列化调用链

## 问题

`activeSession.prompt("你好")` 只传了一个字符串，发给 LLM 的却是完整的多轮对话 HTTP payload。序列化在哪里做的？

---

## 完整调用链

```
activeSession.prompt("你好")
│  pi-coding-agent: AgentSession.prompt()
│  把字符串包成 messages 数组 + 历史消息
│
▼ this.agent.prompt(messages)
│  pi-agent-core: Agent.prompt()
│  合并新消息 + 历史，传给 agentLoop
│
▼ agentLoop → streamAssistantResponse()
│  调用 config.convertToLlm(messages)
│
▼ convertToLlm()
│  pi-coding-agent: messages.js
│  把内部消息类型（bashExecution/custom/compactionSummary 等）
│  全部映射成 { role: "user"/"assistant", content: [...] }
│
▼ streamFn(model, llmContext, options)
   pi-ai: providers/anthropic.js
   buildParams() → convertMessages()
   真正的 HTTP payload 序列化
```

---

## 各层职责

### 层 1：AgentSession.prompt()（pi-coding-agent/core/agent-session.js:578）

把字符串包成内部 `AgentMessage` 格式，附加历史：

```javascript
const messages = [];
messages.push({
  role: "user",
  content: [{ type: "text", text: expandedText }],
  timestamp: Date.now(),
});
// pendingNextTurnMessages（extension 注入的上下文）也在这里追加
await this.agent.prompt(messages);
```

### 层 2：Agent.\_runLoop()（pi-agent-core/agent.js）

组装 `context` 传给 agentLoop：

```javascript
const context = {
  systemPrompt: this._state.systemPrompt, // 完整 system prompt
  messages: this._state.messages.slice(), // 全量历史（含新消息）
  tools: this._state.tools,
};
agentLoop(messages, context, config, signal, this.streamFn);
```

### 层 3：convertToLlm()（pi-coding-agent/core/messages.js:75）

把内部消息类型映射成 LLM 可接受的格式：

| 内部类型            | 转换结果                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `user`              | 原样保留                                                                                      |
| `assistant`         | 原样保留                                                                                      |
| `toolResult`        | 原样保留                                                                                      |
| `bashExecution`     | `{ role: "user", content: [{ type: "text", text: <格式化文本> }] }`                           |
| `custom`            | `{ role: "user", content: ... }`                                                              |
| `compactionSummary` | `{ role: "user", content: [{ type: "text", text: "<summary>...</summary>" }] }`               |
| `branchSummary`     | `{ role: "user", content: [{ type: "text", text: "<branch_summary>...</branch_summary>" }] }` |

### 层 4：convertMessages()（pi-ai/providers/anthropic.js:536）

把统一内部格式转成 Anthropic Messages API 格式，这是真正的 HTTP payload 序列化：

| 内部格式                         | Anthropic API 格式                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `user` text                      | `{ role: "user", content: [{ type: "text", text }] }`                                  |
| `user` image                     | `{ type: "image", source: { type: "base64", media_type, data } }`                      |
| `assistant` text                 | `{ role: "assistant", content: [{ type: "text", text }] }`                             |
| `assistant` toolCall             | `{ type: "tool_use", id, name, input: {...} }`                                         |
| `assistant` thinking             | `{ type: "thinking", thinking, signature }`                                            |
| `assistant` thinking（redacted） | `{ type: "redacted_thinking", data: thinkingSignature }`                               |
| `toolResult`                     | `{ role: "user", content: [{ type: "tool_result", tool_use_id, content, is_error }] }` |

---

## 最终 HTTP payload

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 16000,
  "stream": true,
  "system": [
    {
      "type": "text",
      "text": "<完整 system prompt>",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    { "role": "user",      "content": [{ "type": "text", "text": "上一轮问题" }] },
    { "role": "assistant", "content": [{ "type": "text", "text": "上一轮回答" }] },
    {
      "role": "user",
      "content": [{ "type": "text", "text": "你好", "cache_control": { "type": "ephemeral" } }]
    }
  ],
  "tools": [...]
}
```

**注意**：最后一条 user message 自动加 `cache_control`（prompt caching），缓存整个对话历史。

---

## 关键文件

| 文件                                                                        | 职责                         |
| --------------------------------------------------------------------------- | ---------------------------- |
| `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js:578` | 字符串 → AgentMessage        |
| `node_modules/@mariozechner/pi-agent-core/dist/agent.js:215`                | 组装 context，启动 agentLoop |
| `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js:141`           | 调用 convertToLlm            |
| `node_modules/@mariozechner/pi-coding-agent/dist/core/messages.js:75`       | 内部类型 → LLM 格式          |
| `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js:536`          | 最终 HTTP payload 序列化     |

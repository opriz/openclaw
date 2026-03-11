# OpenClaw vs pi-sdk 分工

## 结论

**pi-sdk 是 agent 的内核，OpenClaw 是让内核在多租户、多 channel、生产环境下稳定运行的外壳。**

---

## 分层架构

```
┌─────────────────────────────────────────────────────┐
│                   OpenClaw 层                        │
│                                                     │
│  • Session 管理（创建/复用/过期/写锁/修复）           │
│  • 工具集构建（bash/文件/消息发送/子agent spawn）     │
│  • System prompt 组装（skills/bootstrap/runtime）   │
│  • 上下文压缩策略（compaction/pruning/history limit）│
│  • Auth 管理（多 profile/轮换/cooldown）             │
│  • 错误处理（failover/retry/rate limit 分类）        │
│  • 多 channel 适配（Telegram/Discord/SMS...）        │
│  • Stream wrapper（修复各厂商 quirks）               │
│  • Hooks（before_prompt/agent_end/llm_input...）    │
│  • 子 agent 注册表（spawn/lifecycle/announce）       │
│                                                     │
│  runEmbeddedAttempt() ← OpenClaw 的核心              │
└──────────────────┬──────────────────────────────────┘
                   │ createAgentSession / agent.prompt()
                   ▼
┌─────────────────────────────────────────────────────┐
│              @mariozechner/pi-* 层                   │
│                                                     │
│  • Agent loop（prompt → LLM → tool call → 循环）    │
│  • 消息历史维护（AgentMessage[]）                    │
│  • Tool 执行调度（call → result → 回注）             │
│  • 自动 compaction 触发（超 context window 时）      │
│  • 流式事件系统（message_start/update/end/tool_*）  │
│  • HTTP payload 序列化（convertToLlm/convertMessages）│
│  • SessionManager（.jsonl 读写）                    │
│                                                     │
└──────────────────┬──────────────────────────────────┘
                   │ streamFn(model, context, options)
                   ▼
┌─────────────────────────────────────────────────────┐
│              @mariozechner/pi-ai 层                  │
│                                                     │
│  • 各厂商 HTTP/WS 实现（Anthropic/OpenAI/Google...） │
│  • SSE/NDJSON 解析                                  │
│  • 响应 → AssistantMessage 统一格式                  │
└─────────────────────────────────────────────────────┘
```

---

## OpenClaw 的工作量并不比 pi-sdk 少

pi-sdk 做的是"一次干净的 LLM 调用"，OpenClaw 做的是让这个调用在生产环境里可靠运行：

| pi-sdk 做的      | OpenClaw 在外层补充的                                |
| ---------------- | ---------------------------------------------------- |
| 触发 compaction  | 决定何时触发、超时怎么办、失败怎么重试               |
| 执行工具         | 决定哪些工具可用、sandbox 隔离、tool result 大小限制 |
| 维护一个 session | 管理跨 channel 的数千个 session、过期、并发写锁      |
| 调一次 LLM       | 处理 auth 轮换、rate limit、failover 到备用模型      |

---

## 相关笔记

- `attempt.md` — runEmbeddedAttempt() 结构详解
- `prompt-serialization.md` — prompt() 序列化调用链
- `session.md` — session 生命周期
- `provider-response-parsing.md` — 多厂商响应解析

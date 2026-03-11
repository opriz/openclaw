# attempt.ts 结构详解

文件路径：`src/agents/pi-embedded-runner/run/attempt.ts`（约 2100 行）

这是 OpenClaw agent 执行一次 LLM 调用的核心实现，`runEmbeddedAttempt()` 是真正"跑一次"的地方。

---

## 整体结构

```
attempt.ts
├── imports（~135 行）
├── 辅助函数（~600 行）
│   ├── isOllamaCompatProvider / resolveOllamaCompatNumCtxEnabled / ...
│   ├── normalizeToolCallNameForDispatch / normalizeToolCallIdsInMessage
│   ├── wrapStreamFnTrimToolCallNames / wrapStreamFnDecodeXaiToolCallArguments
│   ├── resolvePromptBuildHookResult
│   ├── composeSystemPromptWithHookContext
│   ├── resolvePromptModeForSession / resolveAttemptFsWorkspaceOnly
│   ├── prependSystemPromptAddition
│   └── buildAfterTurnRuntimeContext
└── runEmbeddedAttempt()（746 ~ 2096 行）
    ├── Phase 0: 初始化（746~774）
    ├── Phase 1: 环境准备（775~898）
    ├── Phase 2: System Prompt 构建（900~1058）
    ├── Phase 3: Session 初始化（1060~1200）
    ├── Phase 4: Stream 配置（1228~1290）
    ├── Phase 5: 订阅 + 执行（1510~1792）
    ├── Phase 6: 后处理（1793~1984）
    └── Phase 7: 清理 + 返回（1985~2096）
```

---

## runEmbeddedAttempt() 各阶段详解

### Phase 0：初始化（L746~774）

```typescript
const resolvedWorkspace = resolveUserPath(params.workspaceDir);
const runAbortController = new AbortController();
ensureGlobalUndiciStreamTimeouts();
await fs.mkdir(resolvedWorkspace, { recursive: true });
const sandbox = await resolveSandboxContext(...);
const effectiveWorkspace = sandbox?.enabled ? sandbox.workspaceDir : resolvedWorkspace;
process.chdir(effectiveWorkspace);
```

- 创建 workspace 目录
- 解析 sandbox（Docker/隔离环境）
- 把 cwd 切换到 effectiveWorkspace（sandbox 内或原始目录）

---

### Phase 1：环境准备（L775~898）

**Skills（技能插件）**

```typescript
const { skillEntries } = resolveEmbeddedRunSkillEntries(...);
restoreSkillEnv = applySkillEnvOverrides({ skills: skillEntries, config });
const skillsPrompt = resolveSkillsPromptForRun(...);
```

**Bootstrap 文件（上下文注入）**

```typescript
const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun(...);
const bootstrapAnalysis = analyzeBootstrapBudget(...);
const bootstrapPromptWarning = buildBootstrapPromptWarning(...);
```

Bootstrap 文件是启动时注入到 system prompt 的文件（如 AGENTS.md、CLAUDE.md），有 token 预算限制。

**Tools（工具集）**

```typescript
const tools = params.disableTools ? [] : createOpenClawCodingTools({
  agentId, exec, sandbox, messageProvider, sessionKey, ...
});
const allowedToolNames = collectAllowedToolNames({ tools, clientTools });
```

这里决定 agent 这次 run 能用哪些工具（bash、文件读写、消息发送等）。

---

### Phase 2：System Prompt 构建（L900~1058）

```typescript
const appendPrompt = buildEmbeddedSystemPrompt({
  workspaceDir, defaultThinkLevel, skillsPrompt, docsPath,
  runtimeInfo, sandboxInfo, tools, contextFiles, ...
});
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
let systemPromptText = systemPromptOverride();
```

System prompt 包含：

- 运行时信息（OS、shell、model、channel）
- Skills 提示
- Bootstrap 文件内容
- 工具提示（message tool hints）
- Sandbox 信息
- 用户时区

---

### Phase 3：Session 初始化（L1060~1200）

```typescript
const sessionLock = await acquireSessionWriteLock({ sessionFile, maxHoldMs });
await repairSessionFileIfNeeded({ sessionFile });
sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), ...);
await prepareSessionManagerForRun({ sessionManager, sessionFile, hadSessionFile, ... });

const settingsManager = createPreparedEmbeddedPiSettingsManager(...);
applyPiAutoCompactionGuard({ settingsManager, contextEngineInfo });

({ session } = await createAgentSession({
  cwd, agentDir, authStorage, modelRegistry, model,
  thinkingLevel, tools: builtInTools, customTools, sessionManager, settingsManager,
}));
```

关键点：

- **写锁**：同一 session 同时只能有一个 run 在写
- **SessionManager**：管理对话历史的持久化（.jsonl 文件）
- **createAgentSession**：来自 `@mariozechner/pi-coding-agent`，这是底层 agent 框架的入口

---

### Phase 4：Stream 配置（L1228~1290）

```typescript
// 根据 provider 选择不同的 stream 实现
if (params.model.api === "ollama") {
  activeSession.agent.streamFn = createConfiguredOllamaStreamFn(...);
} else if (params.model.api === "openai-responses" && params.provider === "openai") {
  activeSession.agent.streamFn = createOpenAIWebSocketStreamFn(...);
} else {
  activeSession.agent.streamFn = streamSimple;  // 默认 Anthropic HTTP stream
}
applyExtraParamsToAgent(activeSession.agent, ...);
```

不同 provider 用不同的 stream 实现：

- Anthropic：`streamSimple`（HTTP SSE）
- OpenAI：WebSocket stream
- Ollama：原生 `/api/chat`

---

### Phase 5：订阅 + 执行（L1510~1792）

```typescript
// 5a. 订阅流式事件
const subscription = subscribeEmbeddedPiSession({
  session: activeSession, runId,
  onBlockReply, onPartialReply, onToolResult, onAgentEvent, ...
});

// 5b. 注册到全局 run 注册表（支持 steer/abort）
setActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);

// 5c. 设置超时
const abortTimer = setTimeout(() => abortRun(true), params.timeoutMs);

// 5d. 运行 before_prompt_build hooks
const hookResult = await resolvePromptBuildHookResult({ prompt, messages, hookRunner, ... });

// 5e. 发送给 LLM（核心一行）
await abortable(activeSession.prompt(effectivePrompt));
```

`activeSession.prompt()` 是真正触发 LLM 调用的地方。
调用后 `subscribeEmbeddedPiSession` 的回调会持续收到流式事件。

---

### Phase 6：后处理（L1793~1984）

```typescript
// 等待 compaction 完成（如果触发了自动压缩）
await waitForCompactionRetryWithAggregateTimeout({ waitForCompactionRetry, abortable, ... });

// 追加 cache-TTL 时间戳（用于 context pruning）
appendCacheTtlTimestamp(sessionManager, { timestamp, provider, modelId });

// Context engine afterTurn（向量检索等后处理）
await params.contextEngine.afterTurn({ sessionId, sessionFile, messages, ... });

// 触发 agent_end hooks（fire-and-forget）
hookRunner.runAgentEnd({ messages, success, error, durationMs }, hookCtx);

// 触发 llm_output hooks
hookRunner.runLlmOutput({ assistantTexts, lastAssistant, usage }, hookCtx);
```

---

### Phase 7：清理 + 返回（L1985~2096）

```typescript
// finally 块：无论成功/失败都执行
unsubscribe();                              // 取消订阅
clearActiveEmbeddedRun(sessionId, ...);    // 从全局注册表移除
await flushPendingToolResultsAfterIdle(...)// 等待 agent idle 后 flush 未完成的 tool results
session?.dispose();                        // 释放 session 资源
releaseWsSession(params.sessionId);        // 释放 WebSocket session
await sessionLock.release();              // 释放写锁
restoreSkillEnv?.();                       // 恢复 skill 环境变量
process.chdir(prevCwd);                    // 恢复 cwd

return {
  aborted, timedOut, timedOutDuringCompaction,
  promptError, sessionIdUsed,
  messagesSnapshot, assistantTexts, toolMetas,
  lastAssistant, lastToolError,
  didSendViaMessagingTool, messagingToolSentTexts,
  attemptUsage, compactionCount,
  clientToolCall,
};
```

---

## 完整执行时序图

```
runEmbeddedAttempt()
│
├─ [Phase 0] 创建 workspace, 解析 sandbox, chdir
│
├─ [Phase 1] 加载 skills → 加载 bootstrap 文件 → 创建 tools
│
├─ [Phase 2] 构建 system prompt（含 skills/bootstrap/runtime info）
│
├─ [Phase 3] 获取写锁 → 修复 session 文件 → 打开 SessionManager
│            → createAgentSession（底层 agent 框架初始化）
│
├─ [Phase 4] 配置 streamFn（Anthropic/OpenAI WS/Ollama）
│            → applyExtraParams（provider 特定参数）
│
├─ [Phase 5] subscribeEmbeddedPiSession（注册流式事件回调）
│            → setActiveEmbeddedRun（注册到全局，支持外部 abort/steer）
│            → 设置超时 timer
│            → before_prompt_build hooks
│            → activeSession.prompt(effectivePrompt)  ◄── LLM 调用
│                 │
│                 └─ 流式返回 → subscribeEmbeddedPiSession 处理每个事件
│                      ├─ text delta → onPartialReply / onBlockReply
│                      ├─ tool_use → 执行工具 → tool result 回注
│                      └─ message_stop → 结束
│
├─ [Phase 6] 等待 compaction → context engine afterTurn
│            → agent_end hooks → llm_output hooks
│
└─ [Phase 7] finally: unsubscribe → dispose → 释放锁 → 返回结果
```

---

## 关键设计点

| 设计                               | 实现                                         | 目的                                 |
| ---------------------------------- | -------------------------------------------- | ------------------------------------ |
| 写锁                               | `acquireSessionWriteLock`                    | 防止同一 session 并发写入            |
| AbortController                    | `runAbortController`                         | 支持超时和外部中止                   |
| Compaction 等待                    | `waitForCompactionRetryWithAggregateTimeout` | 保证压缩完成后再返回                 |
| `setActiveEmbeddedRun`             | 全局注册表                                   | 支持外部通过 sessionId steer/abort   |
| `flushPendingToolResultsAfterIdle` | 等 agent idle                                | 防止 tool result 丢失（#8643）       |
| `restoreSkillEnv`                  | finally 块                                   | 保证 skill 环境变量在 run 结束后恢复 |
| `process.chdir`                    | try/finally                                  | 保证 cwd 恢复，防止污染其他 run      |

---

## 与外部模块的边界

```
attempt.ts
  ├─ 调用 @mariozechner/pi-coding-agent → createAgentSession, SessionManager
  ├─ 调用 @mariozechner/pi-ai → streamSimple
  ├─ 调用 pi-embedded-subscribe.ts → subscribeEmbeddedPiSession（处理流式事件）
  ├─ 调用 pi-tools.ts → createOpenClawCodingTools（构建工具集）
  └─ 调用 system-prompt.ts → buildEmbeddedSystemPrompt（构建 system prompt）
```

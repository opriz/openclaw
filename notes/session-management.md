# OpenClaw 会话管理实现框架

## 1. 核心架构与分层

OpenClaw 的会话管理系统采用多层架构设计：

```
src/config/sessions/     - 核心会话存储和元数据管理
src/channels/            - 从入站消息记录会话
src/auto-reply/reply/    - 会话状态更新和生命周期
src/agents/              - Agent 特定的会话处理和持久化
src/acp/                 - Agent Control Protocol 会话管理
src/infra/outbound/      - 出站路由和会话绑定
src/wizard/              - 交互式会话工作流
```

## 2. 会话类型与作用域

### 2.1 会话条目结构 (SessionEntry)

位于 `src/config/sessions/types.ts`，包含以下核心字段：

**身份标识**

- `sessionId`: UUID 唯一标识符
- `sessionKey`: 规范化的会话键（小写+trim）

**元数据**

- `label`: 会话标签
- `displayName`: 显示名称
- `chatType`: 聊天类型（direct/group/channel）
- `subject`: 主题

**消息投递**

- `lastChannel`: 最后使用的频道
- `lastTo`: 最后的接收者
- `lastAccountId`: 最后的账户 ID
- `lastThreadId`: 最后的线程 ID
- `deliveryContext`: 投递上下文

**来源信息**

- `origin`: 入站元数据对象（provider, surface, from/to, accountId, threadId）

**运行时状态**

- `acp`: ACP 元数据
- `model`: 模型名称
- `modelProvider`: 模型提供商
- `thinkingLevel`: 思考级别
- `verboseLevel`: 详细程度
- `execHost`: 执行主机
- `ttsAuto`: 自动语音合成

**上下文**

- `skillsSnapshot`: 技能快照
- `systemPromptReport`: 系统提示报告
- `authProfileOverride`: 认证配置覆盖

**层级关系**

- `spawnedBy`: 父会话 ID
- `spawnedWorkspaceDir`: 生成的工作空间目录
- `spawnDepth`: 生成深度
- `subagentRole`: 子 Agent 角色

**生命周期**

- `updatedAt`: 更新时间戳
- `sessionFile`: 会话记录文件路径
- `abortedLastRun`: 上次运行是否中止
- `abortCutoffMessageSid`: 中止截止消息 ID

**工作空间**

- `cwd`: Agent 执行的当前工作目录

### 2.2 会话作用域 (SessionScope)

位于 `src/config/sessions/types.ts`：

- **per-sender**: 每个用户/发送者拥有独立会话（默认）
- **global**: 所有用户共享单一"全局"会话

## 3. 持久化与存储

### 3.1 会话存储文件

**位置**: `~/.openclaw/agents/{agentId}/sessions/sessions.json`

**格式**: JSON 键值存储，映射会话键到 SessionEntry 对象

**结构**:

```typescript
Record<string, SessionEntry>;
```

**示例键**:

- `@default:main` - 主会话
- `@default:telegram:direct:123456` - Telegram 直接消息
- `@default:discord:thread:channel#456` - Discord 线程

**实现**: `src/config/sessions/store.ts`

### 3.2 会话记录存储

**位置**: `~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl`

**格式**: JSONL (JSON Lines) - 每行一条消息

**内容**: 来自 pi-coding-agent SessionManager 的消息交换记录

**版本**: 使用 `@mariozechner/pi-coding-agent` 的 `CURRENT_SESSION_VERSION`

**实现**: `src/config/sessions/transcript.ts`

### 3.3 文件系统布局

```
~/.openclaw/
├── agents/
│   ├── {agentId}/
│   │   └── sessions/
│   │       ├── sessions.json                # 主存储
│   │       ├── {sessionId-1}.jsonl          # 会话记录
│   │       ├── {sessionId-1}.jsonl.lock     # 写锁
│   │       ├── {sessionId-2}.jsonl
│   │       └── archived/                    # 归档目录
│   │           ├── deleted/
│   │           └── reset/
│   └── {agentId-2}/
│       └── sessions/
```

## 4. 会话生命周期

### 4.1 创建阶段

**入站记录**: `recordInboundSession()` (`src/channels/session.ts`)

- 当从任何频道接收到消息时触发
- 规范化会话键: `trim().toLowerCase()`
- 如果缺失则创建条目: `createIfMissing: true`

**键生成**: 会话键是频道特定的：

- 主会话: `agent:main` 或 `@{agentId}:main`
- 直接私信: `agent:telegram:direct:{peerId}`
- 群组: `agent:discord:group:{groupId}:topic:{topicId}`
- 线程: `agent:{channel}:thread:{threadId}`

### 4.2 元数据记录

`src/config/sessions/metadata.ts`:

```typescript
deriveSessionOrigin(ctx) → SessionOrigin
deriveSessionMetaPatch(ctx) → Partial<SessionEntry>
```

记录内容：

- 消息发送者/接收者上下文
- 频道/提供商信息
- 聊天类型（direct/group/channel）
- 线程/对话元数据
- 对话标签

### 4.3 运行时状态更新

- **模型/提供商**: 通过 `setSessionRuntimeModel()` 设置，已规范化
- **使用情况**: Token 计数更新 `(inputTokens, outputTokens, totalTokens, totalTokensFresh)`
- **标志**: `fastMode`, `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
- **发送策略**: `sendPolicy` (allow/deny), `queueMode` (steer/followup/collect/interrupt)
- **最后路由**: 通过 `updateLastRoute()` 在投递到频道时更新

### 4.4 文件/记录关联

`src/config/sessions/session-file.ts`:

**解析**: `resolveSessionTranscriptFile()`

- 从 sessionId 派生路径
- 在存储条目中持久化 `sessionFile` 字段
- 回退到 `resolveSessionTranscriptPath(agentId, threadId)`

**头部创建**: `ensureSessionHeader()`

- 创建带会话元数据头的空 JSONL
- 格式: `{ type: "session", version, id, timestamp, cwd }`

**投递时追加**: `appendAssistantMessageToSessionTranscript()`

- 将助手响应镜像到记录
- 使用 SessionManager 进行持久化

### 4.5 清理与归档

**修剪** (`src/config/sessions/store-maintenance.ts`)

- 默认: 超过 60 分钟不活动的会话被修剪
- 可配置: `pruneAfterMs`, `maxEntries`
- 删除前归档到 `archived/{reason}/`

**轮换**: 会话存储文件超过 20MB 时轮换（可配置）

**磁盘预算**: 强制执行所有会话的总记录存储限制

## 5. 会话写锁

### 5.1 文件级并发控制

`src/agents/session-write-lock.ts`:

```typescript
acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;        // 默认 10s
  staleMs?: number;          // 默认 30m
  maxHoldMs?: number;        // 默认 5m
  allowReentrant?: boolean;  // 默认 true
})
```

**锁机制**:

- 在会话记录旁创建 `.jsonl.lock` 文件
- 存储锁载荷: `{ pid, createdAt (ISO), starttime (进程启动时钟滴答) }`
- PID 回收检测: 验证进程是否仍在相同 starttime 运行
- 可重入: 同一进程可多次获取（引用计数）

**过期锁检测**:

- 死 PID: 进程不再运行
- 回收 PID: 操作系统将 PID 重新分配给不同进程
- 基于年龄: 锁超过 `staleMs`（默认 30 分钟）
- 回退: 基于 mtime 的过期检查

**看门狗清理**:

- 后台看门狗每 60 秒运行一次
- 强制释放持有超过 5 分钟的锁
- SIGINT/SIGTERM 上的优雅关闭处理程序

### 5.2 存储级并发控制

`src/config/sessions/store.ts`:

```typescript
withSessionStoreLock(storePath: string, fn: () => Promise<T>) → Promise<T>
updateSessionStore(storePath, mutator: (store) => {}) → 锁定的变更
```

**模式**:

- 队列锁: 等待锁的任务按存储路径序列化
- 每平台原子性:
  - Unix: 直接原子重命名（临时文件 → 目标）
  - Windows: 重试循环（5 次尝试，50ms 退避）以提高重命名可靠性
- 锁持有: 获取 + 加载（无缓存）+ 变更 + 保存 + 释放

## 6. 会话存储操作

### 6.1 加载

`src/config/sessions/store.ts`:

```typescript
loadSessionStore(storePath, opts?: { skipCache?: boolean })
```

- **缓存**: 45 秒 TTL（可通过 `OPENCLAW_SESSION_CACHE_TTL_MS` 配置）
- **读取重试**: Windows 获得 3 次尝试以处理写入中观察
- **原子一致性**: 原子写入确保读取器永远不会看到部分/损坏状态

### 6.2 更新

`src/config/sessions/store.ts`:

```typescript
updateSessionStore<T>(storePath, (store) => mutator(store));
updateSessionStoreEntry(storePath, sessionKey, (entry) => patch);
```

- **锁定变更**: 所有读/写在锁周边内
- **新鲜加载**: 始终在锁内重新读取以避免覆盖并发写入者
- **合并策略**: `mergeSessionEntry()` vs `mergeSessionEntryPreserveActivity()`
  - 标准: 将 `updatedAt` 更新为 max(existing, patch, now)
  - 保留: 保持现有 `updatedAt`，除非来自新鲜上下文

### 6.3 规范化

```typescript
normalizeSessionRuntimeModelFields()    // 清理空模型/提供商
normalizeSessionEntryDelivery()         // 合并投递字段
normalizeStoreSessionKey(key: string)   // toLowerCase() + trim()
```

## 7. 会话键解析

### 7.1 键结构

`src/routing/session-key.js`:

- **模式**: `{agentId}:{scope}:{...rest}` 或简化形式
- **主会话**: `@{agentId}:main`（或通过 `session.mainKey` 配置）
- **全局**: 当 `session.scope === "global"` 时使用单一键 `"global"`
- **频道特定**: `@{agentId}:{channel}:{chatType}:{id}`

### 7.2 键规范化

`src/config/sessions/store.ts`:

- 所有键规范化为小写 + 修剪
- 遗留支持: 不区分大小写的多键冲突解决（按 updatedAt 选择最新）
- 别名: "main" 解析为 agent 特定的主键

## 8. 会话-Agent 集成

### 8.1 PI Agent 集成

`src/agents/pi-embedded-runner/`:

- **SessionManager**: 来自 `@mariozechner/pi-coding-agent` 库
- **持久化**: `sessionFile` 路径由 SessionManager 打开/管理
- **头部规范化**: `prepareSessionManagerForRun()` 确保正确的头部状态
- **缓存**: `prewarmSessionFile()` 用于操作系统页面缓存优化

### 8.2 ACP 会话

`src/acp/session.ts`:

```typescript
type AcpSession = {
  sessionId: SessionId;
  sessionKey: string;
  cwd: string; // 工作目录
  createdAt: number;
  lastTouchedAt: number;
  abortController: AbortController | null;
  activeRunId: string | null;
};
```

- **内存存储**: `createInMemorySessionStore()` 带可配置限制（默认 5000 会话）
- **生命周期**: Create → setActiveRun → clearActiveRun → 空闲时驱逐
- **TTL**: 24 小时空闲驱逐（可配置）
- **回收**: 在新创建之前按需清理空闲会话

### 8.3 CLI 会话集成

`src/agents/cli-session.ts`:

- 每提供商会话 ID 映射: `cliSessionIds: Record<string, string>`
- 检索: `getCliSessionId(entry, provider)`
- 存储: `setCliSessionId(entry, provider, sessionId)`

## 9. 会话定位与路由

### 9.1 目标解析

`src/config/sessions/targets.ts`:

```typescript
type SessionStoreTarget = {
  agentId: string;
  storePath: string;
};

resolveSessionStoreTargets(params: SessionStoreSelectionOptions)
```

- **发现**: 扫描 agent 目录查找 `sessions.json` 文件
- **验证**: 确保存储路径在 agents 根目录内（防止突破）
- **去重**: 删除跨 agents 的重复存储路径

### 9.2 出站路由

`src/infra/outbound/outbound-session.ts`:

- **路由构建**: 从解析的对等方 + 频道构建 `buildAgentSessionKey()`
- **线程键**: `resolveThreadSessionKeys()` 用于线程对话
- **绑定**: 会话路由持久化以启用未来投递

## 10. 会话投递上下文

### 10.1 投递信息

`src/config/sessions/delivery-info.ts`:

- **最后路由**: 持久化的 `lastChannel`, `lastTo`, `lastAccountId`, `lastThreadId`
- **上下文合并**: `mergeDeliveryContext()` 组合多个来源
- **线程解析**: `parseSessionThreadInfo()` 提取线程元数据

### 10.2 出站会话条目

`src/infra/outbound/outbound-session.ts`:

```typescript
ensureOutboundSessionEntry(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  agentId: string;
  target: string;
  delivery: DeliveryContext;
})
```

- 为出站投递创建/更新会话条目
- 记录投递元数据（频道、接收者、线程）
- 用于为未来入站建立会话-频道绑定

## 11. 会话维护与管理

### 11.1 维护模式

`src/config/sessions/store-maintenance.ts`:

- **warn**: 检查并记录违规而不强制执行
- **enforce**: 主动修剪/限制会话

### 11.2 配置

```typescript
pruneAfterMs: number;           // 默认 1 小时
maxEntries: number;             // 默认 50000
rotateBytes: number;            // 默认 20MB
resetArchiveRetentionMs?: number; // 保留重置归档
```

### 11.3 归档策略

- 删除的记录归档到 `~/.openclaw/agents/{agentId}/sessions/archived/{reason}/`
- `reason`: "deleted"（通过修剪）或 "reset"（通过会话重置）
- 清理: 保留期后删除旧归档

## 12. 会话状态与守卫

### 12.1 工具结果持久化

`src/agents/session-tool-result-guard.ts`:

- 包装工具执行以将结果持久化到会话
- 防止重放时重复执行
- 通过 `idempotencyKey` 实现幂等性

### 12.2 中止处理

`src/config/sessions/types.ts`:

- **停止截止**: `abortCutoffMessageSid` + `abortCutoffTimestamp`
- **最后中止**: `abortedLastRun` 标志
- 用于在重放时跳过停止前排队的消息

## 13. 会话记录修复

### 13.1 修复机制

`src/agents/session-transcript-repair.ts`:

- 验证并修复记录格式问题
- 清理孤立/不完整的消息条目
- 处理附件/媒体不匹配

## 14. 会话配置

### 14.1 配置结构

`src/config/types.openclaw.ts`:

```typescript
session?: {
  scope?: SessionScope;              // "per-sender" (默认) | "global"
  mainKey?: string;                  // 自定义主会话键
  store?: string;                    // 自定义存储路径
}
```

### 14.2 多 Agent 支持

- 每个 agent 都有单独的 `~/.openclaw/agents/{agentId}/sessions/sessions.json`
- 默认 agent: `@default`
- Agent 解析: 来自配置、环境或会话键前缀

## 15. 会话内存与缓存

### 15.1 会话存储缓存

`src/config/sessions/store-cache.ts`:

- **TTL**: 45 秒（可配置）
- **失效**: 基于文件 mtime/size
- **键**: `${storePath}::metadata`
- **绕过**: `skipCache: true` 用于新鲜读取

### 15.2 SessionManager 缓存

`src/agents/pi-embedded-runner/session-manager-cache.ts`:

- **基于 WeakMap**: 跟踪最后访问的 sessionFiles
- **页面预热**: `prewarmSessionFile()` 触发操作系统页面缓存
- **TTL**: 45 秒

### 15.3 运行时注册表

`src/agents/pi-extensions/session-manager-runtime-registry.ts`:

- **模式**: 由 SessionManager 对象标识键控的会话作用域存储
- **用例**: 将运行时状态（模型别名等）绑定到 agent 会话

## 16. 会话标签与显示

### 16.1 会话命名

`src/agents/session-slug.ts`:

- **自动生成**: 来自形容词 + 名词的两词短语
- **回退**: 如果冲突则使用三词或随机后缀
- **最大长度**: 64 字符 (`src/sessions/session-label.ts`)

### 16.2 显示名称解析

`src/config/sessions/metadata.ts`:

- 群组显示: 组合 provider、subject、space、groupId
- 回退: 使用会话键或自动生成的短语

## 17. 关键文件参考

| 路径                                                     | 用途                          |
| -------------------------------------------------------- | ----------------------------- |
| `src/config/sessions/types.ts`                           | 核心 SessionEntry、类型、合并 |
| `src/config/sessions/store.ts`                           | 加载/保存/更新、锁定、原子性  |
| `src/config/sessions/transcript.ts`                      | 记录文件解析/追加             |
| `src/config/sessions/metadata.ts`                        | 派生来源、群组元数据          |
| `src/config/sessions/paths.ts`                           | 解析存储/记录路径             |
| `src/config/sessions/targets.ts`                         | 多 agent 存储发现             |
| `src/config/sessions/main-session.ts`                    | 主会话键解析                  |
| `src/channels/session.ts`                                | 入站记录                      |
| `src/auto-reply/reply/session.ts`                        | 会话特定消息处理              |
| `src/auto-reply/reply/session-delivery.ts`               | 最后路由跟踪                  |
| `src/agents/session-write-lock.ts`                       | 带 PID 检测的文件级锁定       |
| `src/agents/session-slug.ts`                             | 会话标签生成                  |
| `src/agents/cli-session.ts`                              | CLI 提供商会话映射            |
| `src/acp/session.ts`                                     | ACP 内存会话管理              |
| `src/infra/outbound/outbound-session.ts`                 | 路由构建和绑定                |
| `src/agents/pi-embedded-runner/session-manager-init.ts`  | PI agent 初始化               |
| `src/agents/pi-embedded-runner/session-manager-cache.ts` | SessionManager 缓存           |

## 18. 并发与安全模式

### 18.1 并发控制策略

- **写锁**: 文件级（`.lock` 文件）+ 存储级（基于队列）
- **PID 验证**: 即使 PID 回收也能检测过期锁
- **原子写入**: 临时文件 + 重命名以防止损坏
- **可重入**: 同一进程可多次获取锁
- **超时**: 每操作可配置（默认 10s 锁获取，5m 最大持有）
- **优雅关闭**: 信号处理程序释放锁，看门狗清理孤立锁

### 18.2 安全保证

- 防止 PID 回收导致的虚假锁验证
- 防止并发写入导致的数据损坏
- 防止死锁（超时机制）
- 防止资源泄漏（看门狗清理）

## 19. 集成点

### 19.1 频道集成

- 通过 `recordInboundSession()` 记录入站
- 通过 `recordSessionMetaFromInbound()` 记录会话元数据

### 19.2 Agent 集成

- 管理 PI 会话
- 存储记录
- 跟踪运行时状态

### 19.3 路由集成

- 从对等方+频道构建会话键
- 启用回复路由

### 19.4 ACP 集成

- 单独的内存会话存储
- 生命周期管理

### 19.5 网关集成

- 心跳
- 状态
- 后台维护操作

## 20. 设计原则

### 20.1 强一致性

- 原子写入操作
- 锁定机制确保并发安全
- 无部分/损坏状态

### 20.2 高效缓存

- 多层缓存策略
- TTL 基于失效
- 操作系统页面缓存优化

### 20.3 清晰分离

- 元数据存储（sessions.json）
- 记录存储（.jsonl 文件）
- 运行时状态（内存）

### 20.4 可扩展性

- 多 agent 支持
- 可配置限制和超时
- 归档和修剪策略

## 21. 总结

OpenClaw 的会话管理系统提供了一个健壮、高效、可扩展的框架，用于管理多 agent、多频道环境中的对话会话。通过强一致性保证、高效缓存和清晰的架构分离，系统能够处理复杂的会话场景，同时保持数据完整性和性能。

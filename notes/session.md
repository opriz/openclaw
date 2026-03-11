# Session 概念详解

## 1. 从用户视角理解 Session

Session 是 OpenClaw 用来维持"对话上下文"的单元。用户视角上：

- **一个 session = 一段连续的对话历史**
- 用户发消息 → agent 回复 → 下次再发消息，agent 还记得之前说了什么 → 这就是同一个 session
- 当 session 过期或用户手动 `/new`，agent 就"忘掉"之前的内容，开始新对话

---

## 2. 两个核心概念：sessionKey vs sessionId

|            | sessionKey                                             | sessionId                                          |
| ---------- | ------------------------------------------------------ | -------------------------------------------------- |
| **本质**   | 路由桶（routing bucket）                               | 具体的对话记录 UUID                                |
| **格式**   | 可读字符串，如 `agent:main:telegram:direct:1234567890` | UUID v4，如 `550e8400-e29b-41d4-a716-446655440000` |
| **作用**   | 决定"这条消息属于哪个会话"                             | 指向实际的 `.jsonl` 历史文件                       |
| **稳定性** | 稳定，不随 session 重置而变                            | 每次重置生成新 UUID                                |
| **关系**   | 一个 sessionKey 可对应多个历史 sessionId               | 一个 sessionId 对应一个 `.jsonl` 文件              |

**类比：**

- sessionKey = 信箱地址（固定不变，邮件都投到这里）
- sessionId = 当前这叠信件（可以扔掉换一叠新的）

---

## 3. sessionKey 是怎么生成的

由消息来源 + 配置共同决定，核心逻辑在 `src/routing/session-key.ts`：

```
消息来源：channel(telegram) + chatType(direct) + senderId(1234567890)
配置：dmScope = per-channel-peer
        ↓
sessionKey = "agent:main:telegram:direct:1234567890"
```

**dmScope 配置的影响（重要！）：**

| dmScope                    | DM 的 sessionKey                                  | 含义                             |
| -------------------------- | ------------------------------------------------- | -------------------------------- |
| `main`（默认）             | `agent:main:main`                                 | 所有用户共享同一上下文 ⚠️ 不安全 |
| `per-channel-peer`         | `agent:main:telegram:direct:<userId>`             | 每个用户独立上下文 ✓             |
| `per-account-channel-peer` | `agent:main:telegram:<accountId>:direct:<userId>` | 多账号时每账号隔离 ✓             |

群组消息始终按群 ID 隔离，不受 dmScope 影响。

---

## 4. Session 生命周期

### 4.1 创建时机

以下情况会创建新 sessionId（生成新 UUID）：

1. **首次消息**：sessions.json 里找不到对应 sessionKey
2. **Session 过期**（freshness 评估失败）：
   - Daily reset：`updatedAt` 早于当日 4:00 AM（可配置）
   - Idle reset：超过配置的空闲时间（如 120 分钟）
3. **用户手动重置**：发送 `/new` 或 `/reset` 命令
4. **Cron/Webhook 任务**：每次都强制新建（`forceNew=true`）

### 4.2 复用时机

同一 sessionKey + session 未过期（fresh=true）+ 没有手动重置 → 复用已有 sessionId，agent 保持记忆。

### 4.3 Freshness 评估逻辑

```typescript
// src/config/sessions/reset.ts
fresh =
  updatedAt > dailyResetAt && // 今日 4:00 AM 之后有活动
  now < updatedAt + idleMinutes * 60_000; // 未超过空闲时间
```

两个条件都满足才算 fresh，任一不满足则创建新 sessionId。

### 4.4 完整生命周期图

```
用户发消息
    │
    ▼
根据 channel + sender + dmScope 推导 sessionKey
    │
    ▼
查找 sessions.json 中的 sessionKey
    │
    ├─ 不存在 ──────────────────────────────┐
    │                                       │
    └─ 存在 → 评估 freshness               │
         │                                  │
         ├─ fresh=true → 复用 sessionId    │
         │                                  │
         └─ fresh=false ──────────────────►├─ 生成新 UUID 作为 sessionId
                                            │
                                            ▼
                                    打开/创建 .jsonl 文件
                                            │
                                            ▼
                                    运行 agent（写入对话记录）
                                            │
                                            ▼
                                    更新 sessions.json 中的 updatedAt
                                            │
                                            ▼
                                    执行 maintenance（清理旧数据）
```

---

## 5. Session 的存储结构

```
~/.openclaw/agents/
├── main/                              # 默认 agent
│   └── sessions/
│       ├── sessions.json              # 元数据索引（sessionKey → SessionEntry）
│       ├── <uuid1>.jsonl              # 对话历史 1
│       ├── <uuid2>.jsonl              # 对话历史 2
│       └── archived/                 # 归档的旧历史
│           └── <uuid3>.jsonl
├── codex/                             # 子 agent
│   └── sessions/
│       └── sessions.json
```

### sessions.json 结构

```json
{
  "agent:main:telegram:direct:1234567890": {
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "updatedAt": 1710331200000,
    "sessionFile": "550e8400-e29b-41d4-a716-446655440000.jsonl",
    "chatType": "direct",
    "model": "claude-3-5-sonnet-20241022",
    ...
  }
}
```

### .jsonl 文件结构（对话历史）

```jsonl
{"type":"session","id":"550e8400...","cwd":"/workspace","timestamp":1710331200000}
{"type":"message","role":"user","content":[{"type":"text","text":"你好"}]}
{"type":"message","role":"assistant","content":[{"type":"text","text":"你好！有什么可以帮你的？"}]}
```

- Append-only（只追加，不修改）
- 每行一个 JSON 对象

---

## 6. Session 回收机制

每次更新 sessions.json 时自动触发 maintenance，清理顺序：

1. **Prune stale**：删除超过 `pruneAfter`（默认 30 天）未活跃的条目
2. **Cap count**：超过 `maxEntries`（默认 500）时删除最旧的
3. **Archive transcripts**：被删除条目的 `.jsonl` 移入 `archived/`
4. **Purge old archives**：超过 `resetArchiveRetention` 的归档直接删除
5. **Rotate sessions.json**：文件超过 `rotateBytes`（默认 10MB）时轮转
6. **Enforce disk budget**：若设置了 `maxDiskBytes`，从最旧开始删除

代码位置：`src/config/sessions/store.ts`、`src/config/sessions/store-maintenance.ts`

---

## 7. 关键代码位置

| 功能              | 文件                                 |
| ----------------- | ------------------------------------ |
| SessionEntry 类型 | `src/config/sessions/types.ts`       |
| sessionKey 构建   | `src/routing/session-key.ts`         |
| 存储路径解析      | `src/config/sessions/paths.ts`       |
| 新建/复用决策     | `src/cron/isolated-agent/session.ts` |
| Freshness 评估    | `src/config/sessions/reset.ts`       |
| 存储读写 + 清理   | `src/config/sessions/store.ts`       |

---

## 8. 常见场景

**场景 A：用户第一次在 Telegram 发消息**
→ sessions.json 无记录 → 生成新 UUID → 创建 .jsonl → 开始对话

**场景 B：用户隔天再发消息（daily reset 触发）**
→ updatedAt < 今日 4:00 AM → fresh=false → 生成新 UUID → 旧 .jsonl 归档 → 新对话

**场景 C：用户发 `/new`**
→ 强制生成新 UUID → 旧 .jsonl 保留 → agent "忘掉"之前内容

**场景 D：用户连续对话（未过期）**
→ sessionKey 命中 → fresh=true → 复用 sessionId → 复用 .jsonl → agent 记得之前内容

**场景 E：Cron 定时任务触发**
→ forceNew=true → 每次都是新 sessionId → 不与用户对话共享上下文

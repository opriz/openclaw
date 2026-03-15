# Claude Agent SDK、LangChain 与 LangGraph 对比

## 1. 三者是什么

|              | Claude Agent SDK                             | LangChain                         | LangGraph                             |
| ------------ | -------------------------------------------- | --------------------------------- | ------------------------------------- |
| **出品方**   | Anthropic                                    | LangChain Inc.                    | LangChain（同生态）                   |
| **定位**     | 把 Claude Code 做成库：自带工具 + Agent 循环 | 组件库：LLM、Tool、Memory、RAG 等 | 在 LangChain 之上的**图编排引擎**     |
| **编排方式** | 单 Agent + 内置 ReAct 式 tool loop，线性执行 | 链式 pipeline：A → B → C          | 图：节点 + 边，支持**循环、条件分支** |
| **模型**     | 绑定 Claude                                  | 模型无关（可接多种 LLM）          | 模型无关，常用 LangChain 的 LLM 封装  |

---

## 2. Claude Agent SDK（原 Claude Code SDK）

- **做什么**：用代码调起「和 Claude Code 同款」的 Agent——内置读文件、写文件、编辑、Bash、Grep、Glob、Web 搜索等，**不需要自己实现 tool 执行循环**。
- **特点**：
  - 内置工具开箱即用：Read / Write / Edit / Bash / Glob / Grep / WebSearch / WebFetch / AskUserQuestion 等
  - 自带 **Session**（多轮、resume）、**Hooks**（PreToolUse / PostToolUse 等）、**Permissions**（白名单/审批）
  - **Subagents**：主 Agent 可调子 Agent 做专门任务
  - **MCP**：可接 Playwright、数据库等外部 MCP 服务
- **适用**：代码/开发类 Agent、CI、生产自动化；**不提供**多节点图、条件分支、自定义状态图。
- **安装**：Python `pip install claude-agent-sdk`，TypeScript `npm install @anthropic-ai/claude-agent-sdk`。
- **文档**：<https://docs.anthropic.com/en/docs/claude-code/sdk>

---

## 3. LangChain

- **做什么**：提供构建 LLM 应用所需的**组件**：LLM 封装、Tool 定义、Memory、Document Loaders、Retrievers、Chains 等。
- **特点**：
  - 流程是**链式、顺序**的：一步的输出作为下一步的输入。
  - 单次调用、无内置「断点续跑」；状态简单。
  - `AgentExecutor` 已弃用，新 Agent 推荐用 `create_react_agent()` 或 LangGraph。
- **适用**：线性流程、RAG、简单多步 pipeline、快速原型。

---

## 4. LangGraph

- **做什么**：在 LangChain 之上加一层**图编排**：用 `StateGraph` 定义节点和边，支持**循环、条件分支、持久化状态**。
- **特点**：
  - **状态**：图有统一 State，可接 **Checkpointer**（如 SQLite/Postgres/Redis），实现断点续跑、回放。
  - **Human-in-the-loop**：用 `interrupt_before` 等在指定节点暂停，等人确认再继续。
  - 节点里可以再包一个「子 Agent」（例如 ReAct loop），形成**图编排 + 节点内 Agent** 的两层结构。
- **适用**：多 Agent 协作、需要重试/分支/人工审核的复杂工作流、要「时间旅行」调试的 Agent。
- **关系**：LangChain 是工具箱，LangGraph 是编排引擎（见 `notes/agent-frameworks.md`）。

---

## 5. 对比小结

| 维度                | Claude Agent SDK              | LangChain                | LangGraph                        |
| ------------------- | ----------------------------- | ------------------------ | -------------------------------- |
| **流程形状**        | 单 Agent 线性 + 内置 loop     | 链式 A→B→C               | 图：分支、循环、多节点           |
| **内置工具**        | ✅ 读写/编辑/Bash/Grep/Web 等 | ❌ 需自己或社区定义      | ❌ 用 LangChain 或自建           |
| **状态/会话**       | Session（多轮、resume）       | 单次、简单               | Checkpoint 持久化、可回放        |
| **多 Agent/子任务** | Subagents                     | 链式组合                 | 图上多节点，每节点可为一 Agent   |
| **人机协作**        | AskUserQuestion、Permissions  | 需自己实现               | `interrupt_before` 等声明式      |
| **模型**            | 仅 Claude                     | 任意                     | 任意                             |
| **更适合**          | 代码/开发 Agent、CI、自动化   | RAG、简单 pipeline、原型 | 复杂工作流、多 Agent、需可靠状态 |

---

## 6. 怎么选（一句话）

- **想快速做「能读代码、改代码、跑命令」的 Claude Agent** → 用 **Claude Agent SDK**，少写 loop 和工具实现。
- **做 RAG、简单链式 pipeline 或接各种 LLM** → 用 **LangChain**。
- **做复杂流程、多步决策、人工审核、断点续跑** → 用 **LangGraph**（底层仍可用 LangChain 的 LLM/Tools/Memory）。

---

## 7. 与 OpenClaw 的对照

构建 Agent 的难点不在「写出循环」，而在**不确定性**里做**可靠的工程**——context 管理、工具设计、错误恢复、长任务不漂移、可观测可调试。详见 `notes/agent-frameworks.md`。

- OpenClaw 把「外层编排 + 内层 ReAct loop」合在一起，用代码里的 `if/else` + `continue` 表达；LangGraph 把编排层显式化为图。本质相同，显式程度不同。

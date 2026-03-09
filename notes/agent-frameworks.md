# Agent 框架：LangChain、LangGraph 与构建难点

## LangChain vs LangGraph

### 关系

LangGraph 建立在 LangChain 之上，不是替代关系：

```
LangGraph（编排引擎）
    └── 依赖 LangChain 的基础组件
           ├── LLM wrappers
           ├── Tool 定义
           ├── Memory / Checkpointer
           └── Document loaders / Retrievers
```

**LangChain 是工具箱，LangGraph 是编排引擎。**

### 各自适合的场景

|                       | LangChain               | LangGraph                         |
| --------------------- | ----------------------- | --------------------------------- |
| **适合**              | 线性流程、RAG、快速原型 | 循环重试、多 Agent 协作、条件分支 |
| **状态管理**          | 简单，单次调用          | 持久化 checkpoint，支持断点续跑   |
| **流程可视化**        | 黑盒                    | 显式图结构，可渲染                |
| **human-in-the-loop** | 难做                    | 声明式 `interrupt_before`         |

---

## LangGraph 典型场景：代码审查 Agent

### 流程图

```
           START（接收 PR）
                │
     ┌──────────▼──────────┐
     │      并行节点        │
     ├─────────────────────┤
     │  安全扫描 Agent      │──────┐
     │  质量检查 Agent      │──────┤
     │  依赖分析 Agent      │──────┘
     └─────────────────────┘
                │ 汇总
                ▼
        ┌──────────────┐
        │  综合评估节点  │
        │  判断严重程度  │
        └──────┬───────┘
               │
      ┌────────▼────────┐
      │    条件分支      │
      └─┬─────────────┬─┘
        │ 严重问题      │ 无问题
        ▼              ▼
  ┌──────────┐   ┌──────────┐
  │ 等人确认  │   │ 自动评论  │
  └────┬─────┘   └────┬─────┘
       └──────┬────────┘
              ▼
         发布 PR 评论
```

### 代码骨架

```python
from langgraph.graph import StateGraph
from langgraph.checkpoint.sqlite import SqliteSaver

class ReviewState(TypedDict):
    pr_diff: str
    security_issues: list
    severity: str        # "critical" | "ok"
    final_comment: str

def security_scan_node(state: ReviewState):
    # 节点内部是一个子 Agent（ReAct Loop）
    agent = create_react_agent(llm, tools=[run_semgrep, check_secrets])
    result = agent.invoke({"messages": [HumanMessage(state["pr_diff"])]})
    return {"security_issues": result["output"]}

def route_by_severity(state: ReviewState):
    return "human_review" if state["severity"] == "critical" else "auto_comment"

workflow = StateGraph(ReviewState)
workflow.add_node("security_scan", security_scan_node)
workflow.add_conditional_edges("evaluate", route_by_severity)

# 持久化 + 人工审核暂停点
checkpointer = SqliteSaver.from_conn_string("reviews.db")
app = workflow.compile(
    checkpointer=checkpointer,
    interrupt_before=["human_review"]  # 到这里自动暂停等确认
)
```

---

## 子 Agent 内部：嵌套的两层循环

LangGraph 节点内部的子 Agent 就是标准的 **ReAct Loop**，和 OpenClaw 的 `activeSession.prompt()` 是同一个模式：

```
LangGraph 图（编排层）
  └── 节点 = 子 Agent（执行层）
        └── 子 Agent 内部 = 标准 Tool-Use Loop
              ↓
        输入（来自图的 State）
              ↓
        LLM 推理 → 有 tool_call？
              ├─ YES → 执行工具 → 结果塞回 LLM → 继续
              └─ NO（end_turn）→ 输出（写回图的 State）
```

### 与 OpenClaw 对比

OpenClaw 把两层合在了一起：

- 外层 `while(true)` ≈ LangGraph 图的编排（隐式的、线性的）
- `activeSession.prompt()` ≈ 子 Agent 的 ReAct Loop

LangGraph 把编排层显式化为图，OpenClaw 把编排逻辑直接写在代码里（`if/else` + `continue`）。**本质相同，显式程度不同。**

---

## 构建 Agent 的真正难点

看起来核心循环就那几行代码，难点在"跑得好"，不在"写出来"。

### 1. 上下文窗口管理

历史消息越堆越长，最终超出 token 上限。压缩（compaction）要保留什么、丢弃什么是难题。OpenClaw 专门有 compaction 机制处理 `contextOverflowError`，参数需要大量调优。

### 2. 工具设计

工具接口设计直接决定 Agent 能不能用好它。粒度太粗 LLM 不知道何时调；太细 LLM 选择困难。返回结构化数据比自由文本好得多。需要大量实际测试找到正确的抽象边界。

### 3. 错误处理和恢复

LLM 调用了不存在的工具、参数格式错误、工具返回意外结果——Agent 看到错误后的行为难以预测。错误信息要不要喂回 LLM？喂什么格式？重试多少次算失败？这些都是踩坑后调出来的参数（OpenClaw：32~160 次）。

### 4. 不确定性和可靠性

普通代码 `f(x)` 永远返回同样结果。Agent 同样的输入可能走完全不同的路径：

- 难以写确定性单测
- 难以调试（为什么这次走了这条路？）
- 难以保证 SLA

### 5. 多步推理漂移

任务越长，LLM 越容易"忘记"最初的目标，开始做无关的事或绕回做已完成的步骤。这就是为什么 system prompt 工程很重要——不只是告诉 LLM 能做什么，还要帮助它在长任务中保持方向感。

### 6. 速度和成本

每次工具调用都要等 LLM 推理，延迟叠加很快。20 步任务 × 每步 3 秒 = 1 分钟。需要在以下维度权衡：

- 并行调用工具 vs. LLM 能否正确处理并行结果
- 便宜小模型 vs. 推理能力不够走弯路
- 压缩历史减少 token vs. 丢失关键信息

---

## 一句话总结

> 构建 Agent 的难点不是"写出循环"，是在**不确定性**里做**可靠的工程**——context 管理、工具设计、错误恢复、长任务不漂移、可观测可调试。把玩具 demo 变成生产可用的系统，中间隔着无数个边界情况。

---
summary: "Learning guide: how OpenClaw turns bootstrap files, history, tools, memory, and maintenance into model context"
read_when:
  - You want a learner-friendly map of OpenClaw context engineering
  - You are tracing why a turn costs so many tokens
  - You want to understand context vs memory vs compaction vs pruning
title: "Context Engineering"
---

# Context Engineering

In OpenClaw, **context engineering** means shaping what the model sees on each
run so that the agent stays useful, affordable, and stable under a finite
context window.

This is not one isolated subsystem. It is the combined design of:

- system prompt construction,
- bootstrap file injection,
- session history management,
- tool schemas and tool-result handling,
- memory recall,
- compaction and pruning,
- optional context-engine plugins.

If you remember only one sentence, use this:

> Context engineering in OpenClaw is the discipline of deciding **what enters
> the model window now, what is summarized, what is stored elsewhere, and what
> is silently maintained between turns**.

## The five-layer mental model

When a run starts, the final prompt is built from several layers:

1. **Runtime-owned system prompt**
   - OpenClaw instructions
   - tooling section
   - skills list
   - runtime metadata
   - workspace path and environment hints
2. **Project context / bootstrap files**
   - `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`,
     `HEARTBEAT.md`, and first-run `BOOTSTRAP.md`
3. **Session transcript**
   - recent user / assistant messages
   - prior tool calls and tool results
   - compaction summaries
4. **Dynamic recall / assembly**
   - context-engine `assemble()` results
   - optional `systemPromptAddition`
5. **Maintenance outputs**
   - pre-compaction memory flush
   - compaction summaries
   - pruning / truncation side effects

Each layer exists because a different class of information behaves differently:

| Kind of information | Best home |
| --- | --- |
| Stable operating rules | System prompt / bootstrap files |
| Recent conversation state | Session transcript |
| Durable notes and preferences | `MEMORY.md` / `memory/YYYY-MM-DD.md` |
| Large one-off outputs | Tool results, then compaction / pruning |
| Retrieval / summarization policy | Context engine |

## Context is not memory

This distinction is the root of most confusion:

- **Context** = what the model sees **right now**
- **Memory** = durable files or indexes that can be loaded **later**

That means:

- writing to `MEMORY.md` does not automatically mean the model sees it on every
  run,
- keeping something in chat history does not make it durable,
- compaction protects continuity, but it is still a lossy reduction compared to
  raw history.

## The runtime pipeline

At a high level, OpenClaw's embedded agent path is:

1. Accept the request at the Gateway.
2. Resolve session and queue lane.
3. Load the session transcript.
4. Sanitize and validate history for the current provider.
5. Apply history limits and tool-pair repair.
6. Let the active context engine assemble final model messages.
7. Run the model and tools.
8. Persist results.
9. Run after-turn maintenance such as compaction, ingest, or transcript hygiene.

The important idea is that **OpenClaw does not just dump the whole transcript
into the model**. The runtime actively reshapes it.

## Where the token budget goes

The context window is consumed by more than chat messages. The big contributors
usually are:

- system prompt text,
- injected bootstrap file contents,
- tool schemas,
- recent tool results,
- conversation history,
- attachments / transcripts,
- compaction summaries.

This is why `/context detail` is important. It helps answer questions like:

- “Is the system prompt huge?”
- “Are tool schemas dominating?”
- “Did one giant tool result poison the session?”
- “Is `TOOLS.md` getting truncated?”

## The three pressure valves

When context grows, OpenClaw has three main pressure valves.

### 1. Compaction

Compaction summarizes older transcript history into a durable summary entry while
keeping recent turns intact.

Use compaction when the conversation is still one coherent thread and you want
to preserve continuity.

### 2. Session pruning

Pruning removes old tool results from the **in-memory prompt** for a run without
rewriting the transcript on disk.

Use pruning to reduce prompt bloat from large tool outputs, especially under
providers with prompt caching behavior.

### 3. Memory flush

When the session is near auto-compaction, OpenClaw can run a silent maintenance
turn that asks the agent to write durable notes to `memory/YYYY-MM-DD.md`.

Use memory flush to avoid losing important state before compaction compresses the
chat history.

## The role of the context engine

The active context engine is the plug point for custom context policy.

The built-in `legacy` engine mostly preserves the runtime defaults. Plugin
engines can do more advanced work:

- custom retrieval before assembly,
- alternative compaction strategies,
- transcript maintenance,
- custom subagent cleanup behavior.

But a context engine still lives inside the larger runtime. It does not replace
session storage, queueing, tools, or provider-specific transcript validation.

## What the latest design optimizes for

The current OpenClaw design tends to optimize for:

- **operational safety** — runtime still owns session files and rewrite helpers
- **inspectability** — `/status`, `/context`, `/usage`, and session metadata
- **graceful degradation** — compaction, pruning, truncation, overflow recovery
- **plugin extensibility** — context engine slots without replacing the whole
  Gateway
- **durable state before loss** — pre-compaction memory flush

In other words, OpenClaw treats context engineering as a runtime operations
problem, not just a prompt-writing trick.

## Common mistakes

### “Just put everything in AGENTS.md”

This works until bootstrap files get large, expensive, or truncated. Stable
rules belong there; large changing data usually does not.

### “Memory search and context assembly are the same”

They are related but different:

- memory plugins help **find** information,
- context engines decide what the model **actually sees**.

### “If the UI shows a huge number, that is the true current context”

Some usage fields are cumulative across multiple API calls in a turn. OpenClaw
tries to preserve a better snapshot of current context size in the session store
for user-facing diagnostics.

### “Compaction means nothing is lost”

Compaction preserves continuity, not exact verbatim history.

## A practical debugging checklist

When context behavior feels wrong:

1. Run `/status` and `/context detail`.
2. Check whether bootstrap files were truncated.
3. Look for huge tool schemas or tool results.
4. Check whether compaction has already happened.
5. Check whether memory flush should have run.
6. Confirm which context engine is active.
7. If using plugins, verify whether the engine owns compaction.

## Recommended reading path

Read these in order:

1. [Context](/concepts/context)
2. [System Prompt](/concepts/system-prompt)
3. [Agent Loop](/concepts/agent-loop)
4. [Compaction](/concepts/compaction)
5. [Session Pruning](/concepts/session-pruning)
6. [Memory](/concepts/memory)
7. [Context Engine](/concepts/context-engine)
8. [Session Management + Compaction](/reference/session-management-compaction)

If you want the code-level map next, continue with
[Context Engineering Runtime](/concepts/context-engineering-runtime).

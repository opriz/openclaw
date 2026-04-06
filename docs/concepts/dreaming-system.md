---
summary: "What 'dreaming' currently means in OpenClaw: maintenance turns built from memory flush, heartbeat, cron, and isolated background runs"
read_when:
  - You want to understand the latest “dreaming” design in this repository
  - You are looking for background or silent reasoning behavior
  - You want to map 'dreaming' to implemented OpenClaw subsystems
title: "Dreaming System"
---

# Dreaming System

The first important fact is blunt:

> **OpenClaw does not currently ship a first-class core subsystem literally
> named `dreaming` or `dreams`.**

There is no dedicated runtime module, config block, or core docs section with
that exact name.

So if you ask “what is the latest dreaming system design?”, the best accurate
answer is:

> In current OpenClaw, “dreaming” is best understood as a **family of silent or
> background maintenance turns**, not a single named feature.

## The nearest implemented design

Today, the closest equivalent is a composition of four subsystems:

1. **Pre-compaction memory flush**
   - silent agent turn before context compaction
   - writes durable notes to `memory/YYYY-MM-DD.md`
2. **Heartbeat**
   - scheduled background agent turns
   - can run with light or isolated context
3. **Cron**
   - scheduled work with explicit jobs and routing
4. **Subagents / isolated sessions**
   - separate runs that can think or work outside the main conversation thread

Together, these form the practical “dreaming” story in the current codebase.

## What the current design is

The current design is:

- **maintenance-oriented**, not mystical
- **runtime-driven**, not a separate always-on daemon
- **state-preserving**, especially near compaction boundaries
- **session-aware**, with explicit control over which transcript a background
  run sees
- **silent by default** when a background turn is informational rather than
  user-facing

## What the current design is not

The current design is **not**:

- a hidden self-improvement loop that permanently rewrites the agent prompt
- a separate “dream database”
- an always-running offline retriever independent of sessions
- a dedicated autonomous reflection engine with its own scheduler and storage
- a blanket permission for the model to silently rewrite everything

This distinction matters because the repository does include real background
behavior, but it is deliberately bounded and inspectable.

## The center of gravity: pre-compaction memory flush

If one feature most deserves the label “dreaming” today, it is the
**pre-compaction memory flush**.

Its purpose is simple:

1. watch for a session getting near compaction,
2. run a silent maintenance turn,
3. ask the agent to store durable notes,
4. let compaction happen afterward without losing the most important state.

This is a very practical form of “dreaming”:

- the agent pauses before losing context,
- extracts durable state,
- writes it into memory files,
- usually says nothing to the user.

### Why this matters

Without this step, compaction can preserve continuity but still lose details
that should have become durable notes.

With memory flush, OpenClaw gets a lightweight form of reflection:

- “What should survive this compression boundary?”

## The memory-flush data flow

The runtime behavior is:

1. estimate current prompt usage and projected next-turn usage
2. compare against:
   - context window
   - `reserveTokensFloor`
   - `softThresholdTokens`
3. optionally force a flush by transcript byte size
4. skip when:
   - workspace is read-only
   - the run is a heartbeat
   - the backend is CLI-based
5. launch a silent embedded agent run with `trigger: "memory"`
6. set `memoryFlushWritePath` to `memory/YYYY-MM-DD.md`
7. append flush metadata into session state

This is why the design feels like a bounded maintenance loop rather than a
free-floating “dream agent”.

Relevant code:

- `src/auto-reply/reply/memory-flush.ts`
- `src/auto-reply/reply/agent-runner-memory.ts`

## Heartbeat as scheduled dreaming

Heartbeat provides the second major piece of the picture.

It runs periodic agent turns and can be configured to be:

- **cheap** via `lightContext`
- **isolated** via `isolatedSession`
- **silent** via `HEARTBEAT_OK` suppression rules
- **visible** when alerts need to be delivered

This makes heartbeat the closest thing to a scheduled “dream cycle”:

- wake up,
- inspect a bounded context,
- decide whether anything matters,
- either emit a small alert or quietly do nothing.

Relevant code:

- `src/infra/heartbeat-runner.ts`
- `src/auto-reply/heartbeat.ts`
- `docs/gateway/heartbeat.md`

## Cron and subagents as deliberate dream jobs

Heartbeat is periodic and general-purpose. Cron and subagents are more explicit.

Use them when you want:

- isolated runs with their own session IDs,
- scheduled tasks with clear triggers,
- parallel work that should not pollute the main session,
- bounded long-running maintenance behaviors.

This matters because a mature dreaming system is usually not one mechanism; it
is a scheduling strategy over multiple kinds of background runs.

OpenClaw already has those pieces, just not under one core label.

## Why OpenClaw uses maintenance turns instead of a separate dream module

The current design strongly prefers reuse of existing runtime machinery:

- same model stack
- same session store
- same transcript rules
- same delivery suppression tokens
- same sandbox and tool policy

This has several benefits:

- fewer hidden code paths
- less duplicated scheduling logic
- easier observability
- safer interaction with compaction and persistence

The tradeoff is conceptual: the system is powerful, but the “dreaming” behavior
is distributed across existing features rather than packaged as one named
subsystem.

## A useful mental model

If you want to explain the current architecture to another engineer, use this:

### Normal reply mode

- user sends a message
- agent replies in the same conversational thread

### Maintenance mode

- runtime notices a special condition or schedule
- agent runs with a bounded purpose
- output is often suppressed
- important state is persisted or summarized

That maintenance mode is the current practical meaning of dreaming in OpenClaw.

## Current configuration knobs that shape “dreaming”

The most relevant config surfaces are:

### Compaction memory flush

- `agents.defaults.compaction.memoryFlush.enabled`
- `agents.defaults.compaction.memoryFlush.softThresholdTokens`
- `agents.defaults.compaction.memoryFlush.forceFlushTranscriptBytes`
- `agents.defaults.compaction.memoryFlush.prompt`
- `agents.defaults.compaction.memoryFlush.systemPrompt`
- `agents.defaults.compaction.reserveTokensFloor`

### Heartbeat

- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.prompt`
- `agents.defaults.heartbeat.activeHours`
- `agents.defaults.heartbeat.lightContext`
- `agents.defaults.heartbeat.isolatedSession`
- `agents.defaults.heartbeat.includeReasoning`
- `agents.defaults.heartbeat.target`

### Other background execution

- cron job configuration
- subagent defaults and limits

## Architectural boundaries

The latest design is careful about boundaries:

- **memory flush** persists durable notes before loss
- **compaction** reduces transcript size
- **pruning** trims in-memory prompt baggage
- **heartbeat** performs scheduled background checks
- **context engines** decide context assembly and can run maintenance

Those pieces complement each other, but none of them alone is “the dreaming
system”.

## If you wanted a future first-class dreaming layer

The current code suggests what a future named dreaming layer would probably wrap:

- heartbeat scheduling
- isolated maintenance sessions
- pre-compaction memory extraction
- retrieval-backed summarization
- transcript hygiene hooks

In that sense, the present system is already a strong substrate for future
“dreaming” features even though the repository does not name it that way yet.

## Bottom line

The latest OpenClaw “dreaming” design is best described as:

> **a maintenance-turn architecture composed of memory flush, heartbeat, cron,
> and isolated agent runs, with durable state capture before compaction and
> optional silent execution by default.**

If you want to understand the runtime mechanics behind that design, also read
[Context Engineering Runtime](/concepts/context-engineering-runtime).

---
summary: "Code-level walkthrough of how the embedded Pi runner assembles, compacts, and maintains context"
read_when:
  - You want to map context concepts to source files
  - You are debugging context overflow or compaction behavior
  - You are implementing a context engine plugin
title: "Context Engineering Runtime"
---

# Context Engineering Runtime

This page maps the learner-facing context concepts to the current runtime code.

If [Context Engineering](/concepts/context-engineering) explains the mental
model, this page explains **where that model lives in code**.

## The main path

The core request path for embedded runs is:

1. `src/agents/pi-embedded-runner/run.ts`
2. `src/agents/pi-embedded-runner/run/attempt.ts`
3. `src/context-engine/types.ts`
4. supporting compaction / maintenance helpers

At the highest level:

- `run.ts` owns queueing, model resolution, auth, context-window guards, and
  overflow recovery.
- `run/attempt.ts` owns the single attempt lifecycle: session loading, history
  shaping, prompt assembly, execution, and post-turn finalization.
- `src/context-engine/*` defines the plugin contract and default behavior.

## 1. The run is admitted under a context budget

Before a prompt is sent, `run.ts` resolves the effective model context window and
applies OpenClaw's own caps:

- provider / model context window
- `agents.defaults.contextTokens` override or cap
- low-window warning and hard minimum checks

Relevant code:

- `src/agents/context-window-guard.ts`
- `src/agents/pi-embedded-runner/run.ts`

This matters because every later compaction or overflow decision depends on the
same effective token budget.

## 2. The active context engine is resolved once

`run.ts` initializes runtime plugins and resolves the active context engine once
for the whole run:

- `ensureContextEnginesInitialized()`
- `resolveContextEngine(config)`

That resolved engine is reused across retries. This keeps retries from
re-registering or reconnecting the engine repeatedly.

Relevant code:

- `src/context-engine/index.ts`
- `src/context-engine/registry.ts`
- `src/agents/pi-embedded-runner/run.ts`

## 3. Bootstrap and maintenance can run before prompt assembly

Inside `run/attempt.ts`, when a session file already exists, the runtime may do
two pre-run things:

1. call `contextEngine.bootstrap(...)`
2. call `runContextEngineMaintenance(..., reason: "bootstrap")`

This is an important recent design detail: maintenance is not only a post-turn
hook. It can also clean up or normalize an existing transcript before the next
prompt is built.

Relevant code:

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/context-engine-maintenance.ts`

## 4. Built-in transcript shaping happens before custom assembly

OpenClaw always performs a runtime pipeline before a plugin gets the final
assembly hook:

1. sanitize transcript history
2. run provider-specific validation
3. limit direct-message history if needed
4. repair tool-use / tool-result pairing after truncation

Only after that does the runtime call:

```ts
contextEngine.assemble({
  sessionId,
  sessionKey,
  messages,
  tokenBudget,
  model,
  prompt,
})
```

This means the context engine receives already-normalized history, not raw JSONL
garbage.

Relevant code:

- `src/agents/pi-embedded-runner/run/attempt.ts`

## 5. `assemble()` can change both messages and prompt framing

`assemble()` has two high-value outputs:

- `messages` — the final ordered model context
- `systemPromptAddition` — extra text prepended to the runtime system prompt

The second part is easy to overlook. It lets an engine inject dynamic guidance
without editing workspace files or replacing the main system prompt builder.

Relevant code:

- `src/context-engine/types.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

## 6. Overflow recovery is a runtime responsibility

If the provider still reports context overflow, `run.ts` owns the recovery loop.

The current order is roughly:

1. detect likely overflow
2. decide whether attempt-level auto-compaction already happened
3. if not, call `contextEngine.compact(...)`
4. if compaction succeeds, run maintenance with `reason: "compaction"`
5. retry the prompt
6. if compaction is not enough, try truncating oversized tool results
7. finally surface a context overflow error

This is one of the most important boundaries in the system:

- the **engine** defines compaction behavior,
- the **runtime** decides when overflow recovery is needed and how many times to
  retry.

Relevant code:

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/compact.ts`
- `src/agents/pi-embedded-runner/tool-result-truncation.ts`

## 7. Post-turn finalization prefers `afterTurn()`

After a successful turn, `run/attempt.ts` prefers:

1. `contextEngine.afterTurn(...)`

If that hook is not implemented, it falls back to:

2. `contextEngine.ingestBatch(...)`
3. otherwise per-message `contextEngine.ingest(...)`

This is another subtle but important design point:

- engines with a full post-turn state machine can use `afterTurn()`,
- simpler engines can rely on batch or per-message ingest.

Relevant code:

- `src/agents/pi-embedded-runner/run/attempt.ts`

## 8. `maintain()` is the transcript hygiene layer

If finalization succeeds, the runtime then calls `runContextEngineMaintenance()`
with `reason: "turn"`.

`maintain()` is where an engine can do transcript cleanup such as:

- shrinking oversized messages,
- rewriting selected entries,
- normalizing stored content after successful persistence.

The runtime injects a helper:

- `rewriteTranscriptEntries(request)`

That helper is implemented by:

- `src/agents/pi-embedded-runner/context-engine-maintenance.ts`
- `src/agents/pi-embedded-runner/transcript-rewrite.ts`

The key safety property is that engines do **not** mutate the transcript file
directly. They request a branch-and-reappend rewrite through the runtime.

## 9. Memory flush is the nearest built-in “silent reflection” loop

The most relevant built-in maintenance turn for context engineering is the
pre-compaction memory flush.

Its design is:

1. estimate whether the next turn is near the compaction threshold
2. optionally read transcript size and recent usage from disk
3. skip when the workspace is read-only, the run is a heartbeat, or a CLI
   backend is active
4. run a silent embedded agent turn with `trigger: "memory"`
5. write durable notes to `memory/YYYY-MM-DD.md`
6. record flush metadata in session state

Relevant code:

- `src/auto-reply/reply/memory-flush.ts`
- `src/auto-reply/reply/agent-runner-memory.ts`

This is one reason the current OpenClaw context design feels operational rather
than purely prompt-based: it actively saves durable state before compression.

## 10. Heartbeat is a parallel maintenance path

Heartbeat is not a context engine feature, but it affects practical context
design because it controls how much prior history a periodic maintenance turn
sees.

Two options matter most:

- `lightContext` — keep heartbeat bootstrap context small
- `isolatedSession` — run heartbeats in a fresh session to avoid dragging in the
  main transcript

Relevant code:

- `src/infra/heartbeat-runner.ts`
- `src/config/types.agent-defaults.ts`

## 11. User-facing context numbers come from session state

The Gateway stores token-related session metadata such as:

- `inputTokens`
- `outputTokens`
- `totalTokens`
- `contextTokens`

This matters because the UI should not reconstruct “true” context size by
parsing JSONL on the client. The runtime already works to preserve a more useful
snapshot of current prompt size in session metadata.

Relevant code and docs:

- `src/agents/pi-embedded-runner/run.ts`
- `ui/src/ui/views/chat.test.ts`
- `docs/concepts/session.md`

## File map

Here is the shortest useful file map for code reading:

- `src/context-engine/types.ts`
  - interface and lifecycle contract
- `src/context-engine/index.ts`
  - public exports, legacy engine, runtime delegation helper
- `src/agents/pi-embedded-runner/run.ts`
  - run admission, model resolution, overflow recovery
- `src/agents/pi-embedded-runner/run/attempt.ts`
  - transcript shaping, assembly, execution, post-turn hooks
- `src/agents/pi-embedded-runner/context-engine-maintenance.ts`
  - runtime-owned maintenance bridge
- `src/agents/pi-embedded-runner/transcript-rewrite.ts`
  - safe branch-and-reappend transcript rewrites
- `src/auto-reply/reply/memory-flush.ts`
  - memory flush thresholds and prompts
- `src/auto-reply/reply/agent-runner-memory.ts`
  - orchestration for silent memory turns
- `src/infra/heartbeat-runner.ts`
  - scheduled maintenance runs

## What to read next

If you want the architectural overview, go back to
[Context Engineering](/concepts/context-engineering).

If you want the maintenance-turn interpretation of the current background design,
continue with [Dreaming System](/concepts/dreaming-system).

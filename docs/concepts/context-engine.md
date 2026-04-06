---
summary: "Context engine: pluggable context assembly, compaction, maintenance, and subagent lifecycle"
read_when:
  - You want to understand how OpenClaw assembles model context
  - You are switching between the legacy engine and a plugin engine
  - You are building a context engine plugin
title: "Context Engine"
---

# Context Engine

A **context engine** controls how OpenClaw builds model context for each run.
It decides which messages to include, how older history is compacted, and how
context-related state is maintained across turns.

OpenClaw ships with a built-in `legacy` engine. Plugins can register
alternative engines that replace the active context-engine lifecycle.

## Quick start

Check which engine is active:

```bash
openclaw doctor
# or inspect config directly:
cat ~/.openclaw/openclaw.json | jq '.plugins.slots.contextEngine'
```

### Installing a context engine plugin

Context engine plugins are installed like any other OpenClaw plugin. Install
first, then select the engine in the slot:

```bash
# Install from npm
openclaw plugins install @martian-engineering/lossless-claw

# Or install from a local path (for development)
openclaw plugins install -l ./my-context-engine
```

Then enable the plugin and select it as the active engine in your config:

```json5
// openclaw.json
{
  plugins: {
    slots: {
      contextEngine: "lossless-claw", // must match the plugin's registered engine id
    },
    entries: {
      "lossless-claw": {
        enabled: true,
        // Plugin-specific config goes here (see the plugin's docs)
      },
    },
  },
}
```

Restart the gateway after installing and configuring.

To switch back to the built-in engine, set `contextEngine` to `"legacy"` (or
remove the key entirely — `"legacy"` is the default).

## How it works

During an embedded OpenClaw run, the context engine can participate at up to
five lifecycle points:

1. **Bootstrap** — optional initialization for an existing session file.
   Engines can import prior history or warm up their own state.
2. **Assemble** — called before each model run. The engine returns an ordered
   set of messages (and an optional `systemPromptAddition`) that fit within the
   token budget.
3. **Compact** — called when the context window is full, when the user runs
   `/compact`, or when overflow recovery needs compaction.
4. **After turn / ingest** — after a successful turn, the engine can either:
   - run `afterTurn()` and own post-turn finalization itself, or
   - let the runtime fall back to `ingestBatch()` / `ingest()` for the newly
     added messages.
5. **Maintain** — optional transcript maintenance after bootstrap, compaction,
   and successful turns. This is where an engine can safely request transcript
   rewrites or other hygiene work.

### What the runtime actually does

At a high level, the embedded Pi runner follows this order:

1. Load and sanitize the session transcript.
2. Run the runtime's built-in validation / truncation / tool-pair repair.
3. Call `contextEngine.assemble(...)`.
4. Run the model.
5. If compaction happened or was needed, call `contextEngine.compact(...)`.
6. After a successful turn:
   - prefer `afterTurn(...)` if implemented,
   - otherwise fall back to `ingestBatch(...)` or per-message `ingest(...)`.
7. Run `maintain(...)` if implemented.

That means a context engine does **not** replace every runtime behavior. The
runtime still owns queueing, session files, model execution, tool schemas,
overflow detection, and session pruning.

### Subagent lifecycle

OpenClaw currently invokes one subagent lifecycle hook:

- **`onSubagentEnded`** — cleanup after a child session completes, is swept, is
  released, or is deleted.

The `prepareSubagentSpawn` hook exists in the interface for future / partial
integration, but it is not part of the main learner-facing workflow today.

### System prompt addition

The `assemble` method can return a `systemPromptAddition` string. OpenClaw
prepends this to the runtime system prompt for the run. This lets engines inject
dynamic recall guidance, retrieval instructions, or context-aware hints without
requiring static workspace files.

## The legacy engine

The built-in `legacy` engine preserves OpenClaw's default behavior:

- **Bootstrap**: no-op.
- **Assemble**: pass-through; the runtime's sanitize -> validate -> limit
  pipeline still builds the prompt history.
- **Compact**: delegates to the built-in summarization compaction.
- **After turn / ingest**: no-op.
- **Maintain**: no-op.

The legacy engine does not register tools or provide a `systemPromptAddition`.

When no `plugins.slots.contextEngine` is set (or it is set to `"legacy"`), this
engine is used automatically.

## Plugin engines

A plugin can register a context engine using the plugin API:

```ts
export default function register(api) {
  api.registerContextEngine("my-engine", () => ({
    info: {
      id: "my-engine",
      name: "My Context Engine",
      ownsCompaction: true,
    },

    async ingest({ sessionId, message, isHeartbeat }) {
      // Store the message in your data store
      return { ingested: true };
    },

    async assemble({ sessionId, messages, tokenBudget }) {
      // Return messages that fit the budget
      return {
        messages: buildContext(messages, tokenBudget),
        estimatedTokens: countTokens(messages),
        systemPromptAddition: "Use history-aware retrieval before answering.",
      };
    },

    async compact({ sessionId, force }) {
      // Summarize older context
      return { ok: true, compacted: true };
    },

    async maintain({ runtimeContext }) {
      // Optional transcript cleanup after successful work
      await runtimeContext?.rewriteTranscriptEntries?.({
        replacements: [],
      });
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
    },
  }));
}
```

Then enable it in config:

```json5
{
  plugins: {
    slots: {
      contextEngine: "my-engine",
    },
    entries: {
      "my-engine": {
        enabled: true,
      },
    },
  },
}
```

## The `ContextEngine` interface

Required members:

| Member             | Kind     | Purpose                                                  |
| ------------------ | -------- | -------------------------------------------------------- |
| `info`             | Property | Engine id, name, version, and whether it owns compaction |
| `ingest(params)`   | Method   | Store a single message                                   |
| `assemble(params)` | Method   | Build context for a model run                            |
| `compact(params)`  | Method   | Summarize or reduce context                              |

`assemble` returns:

- `messages` — the ordered messages to send to the model.
- `estimatedTokens` — the engine's estimate of total tokens in the assembled
  context. OpenClaw uses this for compaction thresholds and diagnostics.
- `systemPromptAddition` (optional) — prepended to the system prompt.

Optional members:

| Member                         | Kind   | Purpose |
| ------------------------------ | ------ | ------- |
| `bootstrap(params)`            | Method | Initialize engine state for a session file before the run proceeds. |
| `maintain(params)`             | Method | Run transcript maintenance after bootstrap, compaction, or a successful turn. |
| `ingestBatch(params)`          | Method | Ingest a completed turn as a batch. |
| `afterTurn(params)`            | Method | Post-run lifecycle work; if present, the runtime prefers this over the ingest fallback path. |
| `prepareSubagentSpawn(params)` | Method | Prepare engine-owned state for a child session. |
| `onSubagentEnded(params)`      | Method | Clean up after a subagent ends. |
| `dispose()`                    | Method | Release resources during gateway shutdown or plugin reload. |

### Transcript rewrite support

`maintain()` and `afterTurn()` can receive a runtime context object. The most
important helper there is:

- `rewriteTranscriptEntries(request)` — a runtime-owned helper that safely
  rewrites message entries on the active transcript branch.

This split is deliberate:

- the **engine** decides _what_ is safe to rewrite,
- the **runtime** decides _how_ the JSONL / session DAG is updated.

This avoids plugins reaching into Pi internals directly while still enabling
advanced transcript hygiene.

## `ownsCompaction`

`ownsCompaction` controls whether Pi's built-in in-attempt auto-compaction stays
enabled for the run:

- `true` — the engine owns compaction behavior. OpenClaw disables Pi's built-in
  auto-compaction for that run, and the engine's `compact()` implementation is
  responsible for `/compact`, overflow-recovery compaction, and any proactive
  compaction it wants to do in `afterTurn()`.
- `false` or unset — Pi's built-in auto-compaction may still run during prompt
  execution, but the active engine's `compact()` method is still called for
  `/compact` and overflow recovery.

`ownsCompaction: false` does **not** mean OpenClaw automatically falls back to
the legacy engine's compaction path.

That means there are two valid plugin patterns:

- **Owning mode** — implement your own compaction algorithm and set
  `ownsCompaction: true`.
- **Delegating mode** — set `ownsCompaction: false` and have `compact()` call
  `delegateCompactionToRuntime(...)` from `openclaw/plugin-sdk/core` to reuse
  OpenClaw's built-in compaction behavior.

A no-op `compact()` is unsafe for an active non-owning engine because it
disables the normal `/compact` and overflow-recovery compaction path for that
engine slot.

## Configuration reference

```json5
{
  plugins: {
    slots: {
      // Select the active context engine. Default: "legacy".
      // Set to a plugin id to use a plugin engine.
      contextEngine: "legacy",
    },
  },
}
```

The slot is exclusive at run time: only one registered context engine is
resolved for a given run or compaction operation. Other enabled
`kind: "context-engine"` plugins can still load and run their registration
code; `plugins.slots.contextEngine` only selects which registered engine id
OpenClaw resolves when it needs a context engine.

## Relationship to compaction, memory, and pruning

- **Compaction** is one responsibility of the context engine. The legacy engine
  delegates to OpenClaw's built-in summarization. Plugin engines can implement
  other strategies such as DAG summaries or retrieval-backed compaction.
- **Memory plugins** (`plugins.slots.memory`) are separate from context engines.
  Memory plugins provide search / retrieval; context engines control what the
  model sees.
- **Session pruning** still runs regardless of which context engine is active.
  Pruning trims old tool results from the in-memory prompt for a run; it does
  not replace compaction.

## Tips

- Use `openclaw doctor` to verify your engine is loading correctly.
- If you switch engines, existing sessions keep their current transcript
  history; the new engine takes over for future runs.
- Engine errors are surfaced in diagnostics. If a plugin engine fails to
  register or the selected engine id cannot be resolved, OpenClaw does not fall
  back automatically; runs fail until you fix the plugin or switch
  `plugins.slots.contextEngine` back to `"legacy"`.
- For development, use `openclaw plugins install -l ./my-engine` to link a
  local plugin directory without copying.

See also: [Context](/concepts/context), [Compaction](/concepts/compaction),
[Agent Loop](/concepts/agent-loop), [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest).

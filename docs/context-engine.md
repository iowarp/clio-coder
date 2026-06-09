# Context Engine

Clio Coder incorporates a sophisticated Context Engine to manage context windows, track token usage, execute progressive compaction, and prime the workspace environment.

The source of truth for the context domain lives in `src/domains/context/`, `src/domains/session/context-accounting.ts`, `src/domains/session/context-ledger.ts`, and `src/domains/session/compaction/`.

---

## Context Window Resolution

The Context Engine resolves three distinct context-window metrics for each configured target endpoint. The details are defined in the `ContextWindowDetails` contract in `src/domains/providers/runtime-resolution.ts`.

| Metric | Purpose | Derivation / Provenance |
| --- | --- | --- |
| **Declared** | Static catalog knowledge | Deduced from the live model hint, the knowledge base, the model catalog, or the default capabilities. |
| **Desired** | Ideal workspace size | Clio requests a recommended minimum of 128,000 tokens for local-native runtimes. Other runtimes default to their declared context window. |
| **Effective** | Actual operating ceiling | Resolved from live endpoint probe, loaded context length, endpoint capability overrides, or model-specific knowledge. |

### Source Provenance Labels

The resolution engine assigns a source label to the `contextWindowSource` field indicating how the effective window was determined:
- `loaded`: Retrieved directly from the active runtime model config (exclusive to LM Studio).
- `probe`: Discovered through the network API probe.
- `endpoint-override`: Configured explicitly by the user in `settings.yaml`.
- `model-hint`: Reported live by the model via hints.
- `catalog`: Discovered from static catalog knowledge.
- `local-native-default`: Sourced from the local-native minimum floor.
- `descriptor-default`: Inherited from the runtime descriptor defaults.

### Warnings and Re-resolution

If a connected local-native target offers an effective context window of less than 128,000 tokens, the engine issues a diagnostic warning. This warning alerts the operator that the current budget is below the recommendation for complex coding tasks.

When a live model reports a loaded context window that differs from the statically assumed size, the engine triggers a model-hint re-resolution. This re-resolution guarantees that the effective context window is accurately down-sized, preventing delayed auto-compaction and preventing request overflows.

---

## Per-Model Probe Capabilities

The tool registry and chat loops consume model capabilities. The capabilities are resolved dynamically on a per-model basis. The contract is declared as `probeModelCapabilities` in `src/domains/providers/contract.ts`.

The endpoint status stores a pre-merged endpoint-level capability set. The model picker and the thinking controls reconstruct the exact capability stack for the selected model. This reconstruction uses the model-specific knowledge base, live probe data, and user overrides.

### LM Studio Probing

The LM Studio client in `src/domains/providers/runtimes/local-native/lmstudio-native.ts` executes custom model probing. It queries both the `api/v1/models` and `api/v0/models` HTTP endpoints. It extracts model metadata such as the loaded context length, maximum context length, vision support, and tool-use capabilities. This metadata is stored as a keyed map of per-model capability sets.

---

## Token Accounting

Clio Coder implements a unified token accounting framework in `src/domains/session/context-accounting.ts`. This framework uses a fast character-based estimator.

### The Characters-to-Tokens Family

Because calling a model-specific tokenizer for every TUI tick is computationally expensive, the engine relies on a unified estimator family. This family assumes a ratio of four characters per token:

- `ceilChars(chars)`: Returns `Math.ceil(chars / 4)`.
- `blockChars(block)`: Estimates token counts for diverse payload shapes including raw text, images, and tool-call arguments.
- `estimateAgentMessageTokens(message)`: Computes the token overhead for message envelopes by adding sixteen tokens to the character-based payload estimate.
- `estimateAgentContextBreakdown(input)`: Generates a categorized breakdown covering the system prompt, conversation messages, pending user input, and tool schemas.

### Consumers of the Estimator

The character-to-token estimator family is consumed throughout the codebase to ensure consistent telemetry:
- **Output Budget:** Used in `src/engine/apis/output-budget.ts` to compute remaining context budgets.
- **Compaction:** Used in `src/domains/session/compaction/tokens.ts` to measure progressive compaction effectiveness.
- **Prompt Compiler:** Used in `src/domains/prompts/compiler.ts` to construct optimal prompt segment allocations.

---

## Per-Turn Context Snapshots

To prevent token drift and to provide precise TUI visuals, Clio Coder captures a context snapshot during each conversation turn.

### Capture and Reconciliation

At the beginning of each assistant query, `captureContextSnapshot` records the exact token breakdown across prompt segments. It groups these segments into ledger categories.

Once the model responds with the final chunk, the actual usage is reconciled using `reconcileSnapshot`. This reconciliation folds the exact, provider-reported input and output tokens back into the ledger. Any discrepancy between estimated and measured usage is proportionally distributed to the Messages category, ensuring the total matches the provider invoice.

### Slim Persistence Contract

The captured snapshots are persisted to a per-session JSONL file located at `<sessionDir>/context-snapshots.jsonl`.

To avoid quadratic disk growth over long sessions, the persistence contract implements a slim snapshot mechanism. The heavy textual fields (such as system prompts, conversation histories, and tool schemas) are stripped before writing to disk. The file stores only the token counts, metadata, signatures, and hashes required for accounting audits.

---

## Graduated Context Compaction

When context pressure rises, the compaction coordinator triggers graduated, multi-stage compaction in `src/domains/session/compaction/`. This compaction runs on the hot path before submitting requests to the model.

### Compaction Stages

Compaction advances through five graduated stages based on context window pressure:

1. **`warning`** (Threshold: `0.70`): Emits a visual warning in the TUI without modifying the message history.
2. **`mask_observations`** (Threshold: `0.80`): Replaces earlier tool outputs with a brief, 160-character preview marker.
3. **`prune_observations`** (Threshold: `0.85`): Removes tool outputs entirely from the history.
4. **`mask_dialogue`** (Threshold: `0.90`): Masks earlier user turns and assistant responses. The very first user turn is kept as an anchor.
5. **`llm_summary`** (Threshold: `0.99`): Summarizes the earliest parts of the conversation using a helper model.

### Compaction Flow and Guards

The compaction execution flow is integrated into `src/interactive/chat-loop.ts`. It includes several critical safety guards:

- **Pre-Submit Check:** Verifies context pressure before sending requests. It executes progressive compaction if thresholds are crossed.
- **Preflight Overflow Guard:** Blocks oversized requests before committing the user's input to the session. If the compiled prompt exceeds the effective window, the turn is rejected, allowing the user to edit their message or clear the history.
- **Post-Tool Continuation Guard:** Evaluates context pressure after tool executions, ensuring that subsequent cycles do not overflow.
- **Overflow Retry:** If a request fails with a provider-reported context overflow, the engine automatically attempts to compact the history and retries the request once.

---

## Bus Events

The Context Engine publishes lifecycle transitions as typed payloads over the central event bus in `src/core/bus-events.ts`.

### Warning and Pruned Payloads

- `ContextWarning`: Emitted on transition boundaries. Window-resolution warnings carry `warning: string | null`; pressure warnings carry the crossed `stage`, `pressure`, `trigger`, and timestamp.
- `ContextPruned`: Published after a compaction stage reclaims tokens. It contains detailed telemetry regarding the stage reached, tokens before, tokens after, trigger, snapshot IDs, and the number of entries masked or pruned.

### Notification Handling

The TUI handler in `src/interactive/index.ts` subscribes to these channels. It translates events into user-facing status indicators and warnings, updating the TUI in real time.

---

## Visualization

Clio Coder provides high-fidelity visualization surfaces so operators can monitor their context footprint.

### The /context-view Overlay

The `/context-view` overlay renders a detailed, categorized breakdown of the context ledger in `src/interactive/context-overlay.ts`. The interface features an event-driven refresh. When a streaming response is active, the overlay uses a one-second fallback tick to animate streaming growth.

### The Context Ledger and Meter

The ledger in `src/domains/session/context-ledger.ts` aggregates segment-level data into eleven standard categories:
- `system`: Core identity, contract, and safety prompts.
- `tools`: Tool definitions.
- `agents`: The built-in agent fleet.
- `skills`: Discovered capabilities.
- `memory`: Memory retrieval fragments.
- `project`: CLIO.md workspace context.
- `messages`: Conversation history.
- `pending`: Unsubmitted user text.
- `reserve`: Headroom held for progressive compaction.
- `free`: Unallocated window space.
- `streaming`: Live response tokens.

The TUI footer in `src/interactive/footer/` features a compact context meter. This widget displays a proportional bar chart of the ledger, keeping context pressure visible during active tasks.

---

## Context Priming

Context priming allows operators to ground Clio Coder in their specific repository conventions.

### CLIO.md Specifications

The CLIO.md file is a versioned markdown document that primes the agent with project details. The parser and serializer in `src/domains/context/clio-md.ts` enforce the following boundaries:
- **Project Name:** At most 80 characters.
- **Identity Paragraph:** At most 600 characters.
- **Conventions:** At most six bullet points.
- **Hard Invariants:** At most three numbered rules.
- **Fingerprint Footer:** A comment containing a JSON metadata block.

### Context Wiki Lifecycle

The context wiki lifecycle in `src/domains/context/bootstrap.ts` and `src/tools/codewiki/` automates workspace analysis:
- **`clio context-init`**: Scans the workspace, builds `.clio/codewiki.json` (Version 2 format), and generates a tailored `CLIO.md` file.
- **Incremental Updates:** The codewiki parser parses TypeScript exports, imports, and file kinds. When files change, the wiki is updated incrementally, ensuring that prompt contexts are grounded in current, real-world repository layouts.

# Prompt Envelope and Tool Delivery

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard with a token pressure calculator, visual tool schema diagrams, and a registry simulator is located at [docs/html/tools_blueprint.html](html/tools_blueprint.html) (Version: 0.2.1). You can open it in a browser to inspect prompt compiler inputs and tool call execution results in real-time.

Clio Coder separates what the model is told from what the runtime is allowed to execute. The prompt compiler builds a hashed prompt envelope, the engine delivers provider tool schemas, and the registry remains the execution gate.

Source of truth: `src/domains/prompts/compiler.ts`, `src/interactive/chat-loop.ts`, `src/tools/registry.ts`, `src/engine/worker-tools.ts`, and `src/domains/modes/matrix.ts`.

---

## Prompt envelope

The prompt compiler returns both legacy full text and structured delivery pieces:

| Field | Purpose |
| --- | --- |
| `text` | Full rendered prompt retained for compatibility and reproducibility. |
| `systemPrompt` | Provider-facing prompt made from stable static and session-level content. |
| `dynamicPromptFragments` | Turn-level user-role context messages injected before the real user request. |
| `renderedPromptHash` | SHA-256 over the full rendered text. |
| `staticShellHash` | Hash over stable identity, mode, and safety content. |
| `sessionShellHash` | Hash over the provider-facing session shell. |
| `dynamicHash` | Hash over dynamic turn fragments. |
| `promptEnvelope` | Versioned summary of prompt parts, hashes, token estimates, and inclusion flags. |

Prompt tiers:

| Tier | Meaning | Examples |
| --- | --- | --- |
| `static-shell` | Stable harness identity and mode/safety instructions. | identity, mode, safety. |
| `session-shell` | Stable while target/tool/runtime context stays compatible. | runtime block, tool contract, retrieval hints, stable agent/skills catalog. |
| `dynamic-turn` | Changes turn-to-turn. | memory, project context, session notes, agent fleet deltas. |

Envelope parts:

```text
pinnedHarness | pinnedRuntime | pinnedToolContract | sessionContext | turnContext | retrievalHints
```

---

## Send policies

The chat loop records a prompt send policy in the runtime block:

| Policy | When used |
| --- | --- |
| `no-tools-fallback` | Target cannot call tools. The tool contract tells the model to answer without repository inspection. |
| `prefix-cache-deterministic` | `llamacpp` target with tools; designed to cooperate with deterministic prompt-prefix caching. |
| `reduced-repeated-envelope` | Other tool-capable runtimes. Reuses the session shell when `sessionShellHash` has not changed. |

When the session shell hash is reused, the chat loop avoids resetting the runtime system prompt and sends only dynamic prompt fragments plus the submitted user turn.

---

## Dynamic turn fragments

Dynamic fragments are internally marked user-role messages with:

```ts
{
  kind: "dynamic-turn-context",
  fragmentId: string,
  contentHash: string
}
```

They are not user commands. They carry scoped context such as memory, current project context, and session summaries immediately before the actual user request.

---

## Tool contract

The prompt compiler emits a `# Tool Contract` block. It describes whether the current target can call tools and reminds the model that schemas are delivered by the provider layer.

This contract is guidance only. The actual tool surface comes from:

1. the mode matrix in `src/domains/modes/matrix.ts`;
2. provider/runtime capability resolution in `src/domains/providers/**`;
3. tool schema conversion in `src/engine/worker-tools.ts`;
4. registry admission in `src/tools/registry.ts`;
5. safety policy and dispatch admission checks.

Tool schemas are sent to the provider as structured schemas, not as markdown instructions. The model may request a tool call only when the provider supports tool calling and Clio sends that schema.

---

## Registry enforcement

Every tool invocation enters `src/tools/registry.ts`. The registry checks:

| Gate | Source |
| --- | --- |
| Registration | Tool name exists in the registry. |
| Visibility | Tool is visible in the current mode. |
| Classification | Requested action class matches the tool and arguments. |
| Safety | Damage-control rules, Bash policy, project path policy, and protected artifacts. |
| Middleware | `before_tool` / `after_tool` hooks and structured effects. |
| Dispatch | Worker scope and requested action classes fit inside the orchestrator scope. |

Prompt text cannot bypass these gates.

---

## Prompt diagnostics and receipts

The interactive chat loop records prompt diagnostics with run state:

- rendered prompt hash and envelope hashes;
- whether the system prompt was reused;
- tool schema signature and estimated schema tokens;
- prompt envelope segment ids, tiers, hashes, and token estimates.

These diagnostics help debug local-model behavior and audit which prompt sections were visible during a turn. Dispatch runs and external worker paths also write receipts and run-ledger entries so evidence tools can later reconstruct what happened.

---

## Documentation guidance

When documenting prompt/tool behavior, distinguish:

- **prompt guidance**: what the model is told;
- **provider schema delivery**: which tool schemas are sent;
- **registry enforcement**: what can actually run;
- **safety policy**: whether the call is allowed, parked, or blocked;
- **receipts/evidence**: what persisted after the run.

Do not imply that prompt text alone enforces safety. In Clio, enforcement lives in the mode matrix, registry, safety policy engine, and worker dispatch admission.

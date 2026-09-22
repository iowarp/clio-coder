# Source ownership and change impact

Resolve these paths from the Clio repository root, not the installed skill's
base directory. Read only the row relevant to the current task. Paths identify
owners; inspect callers and current schemas before assuming behavior.

| Surface | Start here | Follow through |
| --- | --- | --- |
| Context and compaction | `src/interactive/turn-context.ts`, `src/domains/session/compaction/`, context accounting | `src/entry/orchestrator.ts`, model-session replay, session entries and tree, context UI |
| Memory | `src/domains/memory/`, `src/domains/middleware/memory-intervention.ts` | Lifecycle binding, prompt selection, provenance/promotion, usage and memory UI |
| Prompt and skill loading | `src/domains/prompts/`, `src/domains/resources/skills/`, `src/tools/context/` | Turn constraints, autonomy, package readiness, skill checkpoints, headless/worker binding |
| Tool behavior | `src/tools/`, `src/core/tool-names.ts` | Registry/admission, observation budget, declared action/scope, result disposition and replay |
| Session persistence | `src/domains/session/`, `src/engine/session.ts` | Append/flush/checkpoint, active path, fork/archive/export, cancellation and resume |
| Providers and workers | `src/domains/providers/`, `src/domains/dispatch/`, `src/worker/` | Engine adapters, route identity, endpoint capacity, usage, result evidence and receipt |
| TUI and GUI | `src/interactive/`, `apps/clio-coder-gui/` | Typed events, ACP boundary, narrow layouts, cancellation, capability limits |
| Curated resources | `library/`, `scripts/pin-skills.ts`, `scripts/pin-library.ts` | Manifest metadata, body and reference bytes, generated registries and peer marketplace |

## Lifecycle changes deserve explicit state transitions

Identify the authority tuple: session, active branch, initiating turn, target/
model where relevant, source revision, and runtime cancellation generation.
State what happens at each await and when a late result loses authority. Keep
usage attributed even if its content can no longer be applied.

For persistence, identify the commit barrier and recovery source. Distinguish an
accepted append, bytes visible to a reader, a flushed transcript, and persisted
tree/meta. Consider a crash between them and avoid repeating external effects
whose outcome is uncertain.

For tool loops, preserve call/result pairing and operate at a settled boundary.
Do not replace replay from inside a still-executing tool or use a synthetic user
message to grant authority to internal continuation. For compaction, budget the
complete request and preserve raw history for exact recall. For memory, filter
applicability before ranking and distinguish successful commits from pre-stage
notifications.

## Repository operations

Use the user's active branch/worktree plan. A task branch is local by default;
canonical `main`, remote writes, release tags, and publication follow explicit
maintainer intent and `CONTRIBUTING.md`. An instruction already authorizing a
specific action is not a reason to ask the same permission again.

When work is delegated, use the native dispatch/recipe contract actually exposed
by the runtime. Preserve isolated work for review when the orchestrator owns
integration; do not assume automatic worktree application is disabled. If a
worker needs shell validation, inspect how its write scope changes its tool
surface before assigning a command it cannot run. Report blocked capabilities
instead of bypassing the scope through another tool.

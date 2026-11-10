# Source ownership and change impact

Resolve these paths from the Clio repository root, not the installed skill's
base directory. Read only the row relevant to the current task. Paths identify
owners; inspect callers and current schemas before assuming behavior.

| Surface | Start here | Follow through |
| --- | --- | --- |
| Context and compaction | `src/session-control/turn-context.ts`, `src/domains/session/compaction/` | `src/entry/orchestrator.ts` bindings, replay, session entries, context UI |
| Memory | `src/domains/memory/`, `src/domains/middleware/memory-intervention.ts` | Lifecycle binding, prompt selection, promotion, memory UI |
| Prompts | `src/domains/prompts/fragments/**`, `src/domains/prompts/compiler.ts`, `src/domains/prompts/extension.ts` | Three tiers: attended, headless, worker. A fragment needs `id`, `version: 1`, `description` and must be selected by id in `compiler.ts`, or it never renders |
| Skills and library | `library/`, `src/domains/resources/skills/`, `scripts/pin-skills.ts`, `scripts/pin-library.ts` | Manifest version, pins, registries |
| Agent recipes | `src/domains/agents/builtins/*.md`, `src/domains/agents/recipe-schema.ts` | Bound skills need `context` in tools; `docs/guide/built-in-agents.md` |
| Tools | `src/tools/`, `src/core/tool-names.ts` | `TOOL_PLANES` in `src/tools/policy.ts` and a matching case in `src/domains/safety/action-classifier.ts` (a mismatch fails at boot), `TOOL_PLACEMENT` in `src/tools/surface.ts`, metadata in `src/tools/builtin-tool-catalog.ts`, a row in `src/tools/presentation.ts`, registration in `src/tools/core-bootstrap.ts` or `src/tools/bootstrap.ts`; heavy implementations through `src/tools/lazy-tool.ts` |
| Settings key | the field on its type, `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` in `src/core/defaults.ts` | `issues.unknownKeys` list and a parse branch in `validateSettings` in `src/core/config.ts` (without the branch the key is silently ignored), `SETTINGS_FIELD_NAMES` in `src/core/settings-fields.ts`, effect timing in `src/domains/config/classify.ts` (unlisted means restart), label in `src/core/settings-controls.ts`, placement in `src/core/settings-areas.ts`, inventory row in `docs/guide/configuration-and-targets.md` |
| Environment variable | read as `process.env.CLIO_CODER_X` | row in `docs/guide/environment-variables.md` |
| State file | writer under the state root | entry in `docs/architecture/artifact-placement.md` |
| CLI subcommand | lazy row in `COMMAND_HANDLERS` in `src/cli/index.ts` | help text, `docs/guide/commands-and-modes.md` when the brief includes docs |
| Slash command | `src/session-control/slash-commands.ts` (an entry needs `name`, `description`, `group`, `rank`, `acp`, `kinds`, `handle`) | `src/interactive/slash-autocomplete.ts`, retired names table |
| Session persistence | `src/domains/session/`, `src/engine/session.ts` | Append, flush, checkpoint, fork, resume |
| Providers and workers | `src/domains/providers/`, `src/domains/dispatch/`, `src/worker/` | Engine adapters, route identity, capacity, receipts. Worker stdout is NDJSON only |
| TUI | `src/interactive/` (colors only from `src/interactive/theme/`) | Typed events from `src/session-control/`, never the reverse |
| GUI | `apps/clio-coder-gui/` | Root types reach it only through `server/clio/wire-shims.ts`; regenerate `contracts/openapi.json` after a contract change |
| Composition root | `src/entry/orchestrator.ts` | Wiring only (rule15); new logic lives in a domain |

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

---
title: "Clio Coder GUI Client"
summary: "The browser frontend for Clio Coder: a React SPA with React Router, TanStack Query, and pure decision modules for composer, approval, tool presentation, and Markdown rendering. The client separates pure policy (tested under node:test) from declarative components, and communicates with a local ACP server through a typed HTTP contract."
sources:
  - "apps/clio-coder-gui/client/main.tsx"
  - "apps/clio-coder-gui/client/chat/tool-presentation.ts"
  - "apps/clio-coder-gui/client/chat/composer-model.ts"
  - "apps/clio-coder-gui/client/chat/approval-model.ts"
  - "apps/clio-coder-gui/client/chat/diff-model.ts"
  - "apps/clio-coder-gui/client/render/Markdown.tsx"
  - "apps/clio-coder-gui/client/pages/sessions.tsx"
  - "apps/clio-coder-gui/client/pages/settings-controls.tsx"
  - "apps/clio-coder-gui/client/api/client.ts"
  - "apps/clio-coder-gui/contracts/routes.ts"
symbols:
  - "presentTool"
  - "DraftStore"
  - "submitIntent"
  - "deriveApprovalTimings"
  - "gatedPreview"
  - "parseDiff"
  - "diffPanel"
  - "MarkdownContent"
  - "createClient"
tests:
  - "apps/clio-coder-gui/tests/chat-tools.test.ts"
  - "apps/clio-coder-gui/tests/chat-composer.test.ts"
  - "apps/clio-coder-gui/tests/chat-approval.test.ts"
invariants:
  - "All tool-presentation, diff, approval, and composer decisions live in pure modules with no React, CSS, or API client imports, so node:test can exercise every branch."
  - "The canonical Clio tool name (`item.title`) keys the tool card, not the lossy five-value ACP `toolKind` hint; the kind hint is only a fallback for MCP and dynamic tools."
  - "No model-authored prose reaches the approval card. Every sentence is either fixed copy or a value the agent already classified and bounded upstream."
  - "A rejected or failed tool call is distinguished from a refused one by the producer's own sentence (`NOT_APPROVED_NOTE`), never by a bare `failed` status alone."
  - "The GUI client is built with Vite and served by the local ACP server; it never imports from `node:http` or spawns processes itself (see `apps/clio-coder-gui/tests/boundaries.test.ts`)."
validate:
  - "pnpm run check:gui && pnpm run test:gui"
---

# Clio Coder GUI Client

The Clio Coder GUI client is a single-page application built with React, React Router, and TanStack Query. It renders a live conversation with the Clio Coder engine over a local HTTP/ACP contract, displaying tool calls as rich cards, streaming Markdown with syntax highlighting and Mermaid diagrams, and an approval workflow for permission-gated operations.

The architectural rule that shapes every module is this: **the app has no DOM test environment**, so every decision that could be wrong lives in a pure function or a plain observable store, tested under `node:test`. Components (`*.tsx`) stay declarative and call into the pure modules. The CLAUDE.md change recipe states this explicitly: "GUI decision logic: a pure `*-model.ts` with no React, CSS or API client, tested under `node:test`."

## Entry point and composition

The entry point is `apps/clio-coder-gui/client/main.tsx`. It creates a `QueryClient` with `retry: false` and error reporting through `reportProblem`, then builds a `createBrowserRouter` with lazy-loaded route modules. The app shell (`App` in `apps/clio-coder-gui/client/app.tsx`) manages connection state, sidebar collapse, the command palette, and the help dialog. It subscribes to the server's event stream via `subscribe(client, queries, setConnection)` from `apps/clio-coder-gui/client/api/events.ts`.

The router defines these top-level routes. Pages are lazy-loaded except for `Home`:

- `/` — `Home`
- `/sessions` — `Workspaces` (list of recent project folders)
- `/workspaces/:workspaceId/sessions` — `Sessions` (conversations in a workspace)
- `/sessions/:id` — `Session` (the chat transcript)
- `/evidence`, `/evidence/:id` — `EvidencePage`, `EvidenceDetail`
- `/usage`, `/library`, `/system`, `/system/interop`, `/fleet`, `/fleet/:id`, `/fleet/dispatches/:id`
- `/settings`, `/settings/targets`, `/settings/routing`, `/settings/effective`, `/settings/why`
- `/traces`, `/traces/:runId`, `/toolchain`, `/docs/*`

The API client (`createClient` in `apps/clio-coder-gui/client/api/client.ts`) wraps `fetch` with Bearer token auth, `Idempotency-Key` headers for non-GET routes, clock adoption from the `Date` response header, and `ApiProblem` error mapping. Route definitions in `apps/clio-coder-gui/contracts/routes.ts` use TypeBox schemas and are typed end-to-end: `client.call<R extends Route>(route, input)` returns `Output<R>`.

## Tool presentation taxonomy

The module `apps/clio-coder-gui/client/chat/tool-presentation.ts` converts one `TimelineItem` into a `ToolPresentation` — the data a tool card component needs to render. The central function is `presentTool(item, options)`.

**Keying on the canonical name.** The `item.title` field carries the canonical Clio tool name (set by `src/engine/acp/server.ts`). The five-value ACP `item.toolKind` is a lossy UI hint — `git`, `dispatch`, and `steer` all become `"other"`; `read`, `ls`, `context`, and `monitor` all become `"read"`. The taxonomy in `KINDS` maps canonical names to a `chip` and `body`:

| Tool | Chip | Body |
|------|------|------|
| `read` | `read` | `file` |
| `ls` | `list` | `file` |
| `edit`, `write`, `artifact` | `edit`/`write`/`edit` | `diff` |
| `bash`, `run_script`, `verify`, `safe_exec`, `git` | `bash`/`run`/`git` | `terminal` |
| `grep`, `find`, `code_nav` | `grep`/`find`/`nav` | `matches` |
| `web_fetch` | `fetch` | `fetch` |
| `dispatch` | `dispatch` | `dispatch` |
| `ask_user`, `decide` | `ask` | `ask` |

An unknown tool falls back to `KIND_HINT` (the ACP kind hint) and then to a generic JSON body.

**Wire unwrapping.** `readWire` handles three real shapes: `{result, isError}` from the ACP server, `{content: [...]}` when the GUI supervisor substitutes for a terminal frame with no `rawOutput`, and `{truncated: true, snippet}` for records over 32 KiB. The `operatorText` function reads the operator-facing copy from `details.resultDisposition.presentation.content`, which Clio Coder keeps separate from the model-facing context text (src/tools/result-disposition.ts). When no operator copy exists, `stripResultEnvelope` removes the `[tool-result <mode>]` header and metadata trailer from the model-facing text.

**Live output.** `applyPartialFrame` replaces the previous snapshot rather than appending — a progress frame carries the tool's whole output so far, so appending would duplicate every byte when two frames land close together. The `outputPane` function derives `running` from `status` alone (`isSettledStatus` checks for `"completed"`, `"failed"`, `"cancelled"`). The presence of `partialOutput` says the call is RUNNING, never that it finished.

**Status and refusal distinction.** `notApproved` checks whether the result text includes `NOT_APPROVED_NOTE` (`"was not approved"`), which separates a denied call from a broken one. `stoppedRun` checks whether a `dispatch` call's run was stopped by the operator or with its turn, accepting both `"canceled"` and `"cancelled"` spellings. A refused call reads "Not approved" in the neutral tone with a dash, never as a failure.

## Composer and submit policy

`apps/clio-coder-gui/client/chat/composer-model.ts` holds all composer decisions as pure functions and a `DraftStore` class.

**DraftStore.** The draft is held outside the component tree so that streamed timeline deltas do not re-render the textarea. Each draft carries a `text`, a `mode` (`"next-slot"` or `"end-of-turn"`), and an `Idempotency-Key` minted via `crypto.randomUUID()`. The key survives typing and retries; editing after a send has begun mints a new key so changed text cannot claim the earlier request's result. `acknowledge(sent)` clears the draft only when the submitted text matches exactly; if the operator typed new text while the request was in flight, only the submitted prefix is removed and the remainder gets a new key. Drafts are persisted to `sessionStorage` per session, capped at `MAX_DRAFT_STORES = 32`.

**Submit intent.** `submitIntent(draft, situation)` returns a discriminated union:

- `{ kind: "prompt", text, idempotencyKey }` — idle open session, text within `PROMPT_TEXT_MAX_CHARACTERS` (32,000).
- `{ kind: "steer", text, mode, idempotencyKey }` — running turn with steering capability; text bounded by `STEER_TEXT_MAX_BYTES` (16,384).
- `{ kind: "blocked", reason }` — the previous send is on the wire, the session is not open, the text is empty or too long, or steering is unavailable.

`submitLabel` names what the send will actually do: "Send", "Send now", or "Queue for after".

**Steering affordances.** `steeringAffordances` projects `AgentCapabilities` onto four controls: `steer`, `interrupt`, `queue`, and `dispatch`. An engine that announced nothing yields `NO_STEERING`, and the composer hides the steering control rather than letting the operator press something that would return 409.

**Queue projection.** `projectQueue` reads `GET /queue`'s two flat arrays (`steer` and `followUp`) and gives each entry a stable key, position, and the sentence that says when it will be read. `restoredDraft` puts drained queue texts back into the draft, deduplicated and capped at `PROMPT_TEXT_MAX_CHARACTERS`.

## Session controls

`RoutePicker.tsx` uses `route-picker-model.ts` to distinguish conversation routing from saved defaults. A conversation selection calls the engine's session configuration methods; changing saved defaults patches settings. The route chip displays the target, model, and thinking level reported by Clio.

The composer accepts images and text-file attachments when the engine advertises the corresponding prompt capabilities. `attachments-model.ts` checks count, size, format, and text encoding before submission; image processing fits the browser payload, and the agent validates images again. Attachments submit with an idle prompt, rather than a steering message.

`HandoffPanel.tsx` presents the extracted document for editing and explicit commit. `FleetRunPanel.tsx` presents a named contract's preview and requires approval before run. `AsidePanel.tsx` offers side questions and candidate drafts. Session controls also expose branch navigation, task and decision boards, context accounting and recovery, and usage through the advertised ACP methods. The GUI displays domain outcomes and enables actions according to reported capabilities.

## Approval model

`apps/clio-coder-gui/client/chat/approval-model.ts` keeps every permission-card decision out of the component.

**Escalation as a state.** `deriveApprovalTimings` computes `escalated` from the permission's own timestamps (`escalateAt`, `expiresAt`) rather than waiting for a `permission.escalated` delta. The server's declared windows are 45 seconds to escalation and a 600-second budget (`ESCALATION_SECONDS`, `BUDGET_SECONDS`). A server that already said `escalated` wins even when this clock disagrees.

**Three answers.** `approvalActions(permission)` returns:
- `reject` (always) — denies this one request, the turn continues.
- `reject-and-stop` (only when `canStopTurn` is true) — denies this request and every other parked request from this turn, and cancels the turn.
- `allow-once` (always, drawn last as `primary`) — allows this one call.

The `CARD_EYEBROW` reads "APPROVAL NEEDED · ONE USE" because there is deliberately no allow-always on the wire. `SAFETY_POSTURE` describes a parked permission request: "Nothing runs until you answer. The GUI never answers for you."

**Agent classification.** The agent classified the call before it asked. `decisionChips` labels the tier, action class, and affected scope from the agent's own `PermissionDecisionFacts`. Without these facts a client would re-derive a tier from a tool name, which would be a second and worse classifier. `decisionTone` maps the agent's three semantic tokens (`accent`, `action`, `warning`) to status tones.

**Gated preview.** `gatedPreview(call)` projects the tool's `rawInput` into a reviewable body. `COMMAND_TOOLS` (bash, run_script, verify, safe_exec, git) show their command; `EDIT_TOOLS` (edit, artifact) show proposed replacements; `write` shows proposed contents; `web_fetch` shows the host and path (never a query string); `dispatch` shows the agent and task preview. All text passes through `clampText`, which strips control codes and bounds lines and characters. An unrecognised tool degrades to a readable `none` rather than an empty body.

## Diff model

`apps/clio-coder-gui/client/chat/diff-model.ts` parses two diff formats and decides what the diff panel shows.

**The clio format.** The engine's `generateDiffString()` in `src/tools/edit-diff.ts` emits a line-numbered review format: a marker column (`+`, `-`, or space), a right-aligned line number padded to the file's widest number, one space, then the text. An elided run of unchanged lines is a row whose number column is blank and whose text is `...`. There are no `@@` hunk headers. `parseDiff` detects this via `isClioFormat` (at least one numbered row and no `@@` headers).

**The unified format.** MCP and dynamic tools may put a genuine unified diff in `details.diff`. `parseUnifiedRows` handles `@@` hunk headers, `---`/`+++` file headers, and the `\ No newline at end of file` marker.

**Truncation.** Two independent producers can truncate the diff:
1. The engine at `MAX_DIFF_BYTES = 32768`, appending `CLIO_TRUNCATION_MARKER`.
2. The ACP wire at `ACP_MAX_RAW_DIFF_BYTES = 28672`, appending `ACP_TRUNCATION_MARKER`.

The wire cap is tighter, so in practice the wire marker is what an operator sees. `stripTruncation` identifies which producer cut the string and returns a note naming the cap.

**Provenance.** `diffPanel` decides what the panel shows based on the call's lifecycle:
- `applied` — the result carries a `details.diff` from the engine.
- `proposed` — the call has not completed and `synthesizeProposedDiff` builds a reviewable block from the tool's arguments.
- `rejected` — the call was refused (`NOT_APPROVED_NOTE` in the result text).
- `unverified` — the call was cancelled or failed without a refusal.
- `skipped` — the file exceeded 1 MiB and the engine skipped the diff.
- `unchanged` — the engine reported success with an empty diff.
- `absent` — no diff available.

## Markdown rendering

`apps/clio-coder-gui/client/render/Markdown.tsx` renders Clio Coder's Markdown from `marked` tokens. Every node is created by React from token data, so nothing the model writes is interpreted as HTML. The single exception is the Mermaid figure, which inserts SVG that strict Mermaid produced and DOMPurify sanitized.

**Streaming.** `MarkdownContent` uses an `IncrementalMarkdown` lexer from `apps/clio-coder-gui/client/render/markdown-model.ts`. While streaming, settled blocks keep their token identity and only the tail after the last safe block boundary is re-lexed each frame. `settledBoundary` finds a blank line outside any fenced code block that is followed by a line starting a new block. When `complete` becomes true, the whole source is lexed once canonically.

**Code blocks.** `CodeBlock` uses `highlightCode` from `apps/clio-coder-gui/client/render/highlight.ts` for syntax highlighting, but only when the block is settled, near the viewport, the grammar is known, and the code is under `HIGHLIGHT_MAX_CHARS` (60,000). A streaming tail shows a blinking cursor and defers highlighting.

**Mermaid.** `MermaidBlock` waits for the turn to settle and the block to be near the viewport before calling `renderMermaid` from `apps/clio-coder-gui/client/render/mermaid.ts`. The diagram source is bounded by `MERMAID_MAX_SOURCE_BYTES` (16 KiB) and `MERMAID_MAX_LINES` (400). The rendered SVG is sanitized by DOMPurify before DOM import.

**Links.** Only `http:`, `https:`, and `mailto:` protocols are live. Relative paths render as text. Internal document links (`/docs/...`) route through the React Router via `onNavigate` rather than causing a full page load.

## Session view

`apps/clio-coder-gui/client/pages/sessions.tsx` contains three exported components: `Workspaces`, `Sessions`, and `Session`.

**Workspaces** lists recent project folders and offers a `ProjectOpenForm` to open a new one. It reads `routes.workspaces` via `useQuery`.

**Sessions** shows conversations for a workspace: open ones (live) and earlier ones (from history). It uses `routes.sessionHistory` for saved conversations and filters them against `routes.sessions` for open ones. The `open` mutation calls either `routes.loadSession` or `routes.newSession`, then navigates to `/sessions/:id`.

**Session** (`SessionView`) is the main chat view. It:
- Reads the session snapshot via `routes.session`, passing through `sessionBuffer(id)` which applies streamed deltas to the snapshot.
- Reads capabilities via `routes.sessionCapabilities` (stale time infinite).
- Reads session settings via `routes.sessionSettings` (enabled only when the session is open and `settings.get_safe` is true).
- Uses `groupTurns` from `apps/clio-coder-gui/client/chat/turns.ts` to group timeline items into turns.
- Renders `ChatTurnView` for each turn, `ApprovalBanner` for pending permissions, `FleetStrip` for dispatched workers, and `Composer` at the bottom.
- Uses `useSecond(running)` to tick a shared clock only while something is live, reading the server-adopted clock from `apps/clio-coder-gui/client/api/clock.ts` so elapsed figures cannot disagree with the server by the connection's clock offset.

## Settings controls

`apps/clio-coder-gui/client/pages/settings-controls.tsx` renders the settings controls page. `SettingsControlsView` reads `routes.settingsControls` and renders one `ControlRow` per setting. Each `ControlRow` supports:
- Model select with a target's catalog (`ModelSelect`).
- Open choice field (select + free-text) for settings like target paths.
- Standard select or text input with draft tracking.
- Confirmation checkbox for destructive settings.
- Save/revert buttons that PATCH via `routes.writeSetting`.

The model catalog integration reads `routes.targetsList` and can probe targets via `routes.targetsProbe`, showing the number of models the target reported and a "Check again" button.

## Key invariants and testing strategy

The client's testing strategy follows the CLAUDE.md recipe: "GUI decision logic: a pure `*-model.ts` with no React, CSS or API client, tested under `node:test`." This means:

- `chat-tools.test.ts` exercises `parseDiff`, `presentTool`, `applyPartialFrame`, `readWire`, `stripResultEnvelope`, `parseMatches`, `formatBytes`, `failureExcerpt`, `toolOpensAtMount`, `describeTool`, and `formatLocation` with real tool payloads.
- `chat-composer.test.ts` exercises `DraftStore`, `steeringAffordances`, `submitIntent`, `composerKeyAction`, `projectQueue`, `queueSummary`, `restoredDraft`, `messageActionOffers`, `noticeForError`, `noticeForRefusal`, `turnOutcome`, `usageSummary`, and `usageTitle`.
- `chat-approval.test.ts` exercises `deriveApprovalTimings`, `approvalActions`, `decisionChips`, `decisionRows`, `decisionTone`, `safetyFacts`, `accessSentence`, `formatLocations`, `isAwaitingAnswer`, `gatedPreview`, `clampText`, `bannerEyebrow`, `waitedSentence`, `resolutionSummary`, and fleet facts.

The boundaries test (`apps/clio-coder-gui/tests/boundaries.test.ts`) enforces that the client never imports from `node:http` or spawns processes — network and process access is restricted to `apps/clio-coder-gui/server/local-server.ts` and `apps/clio-coder-gui/server/process-policy.ts`.

## Things to watch when editing

- **The canonical tool name wins.** If you add a new tool, add it to `KINDS` in `tool-presentation.ts` keyed on the canonical name. The ACP `toolKind` hint is only a fallback for MCP and dynamic tools. Adding a tool that maps to the wrong `toolKind` will misclassify it.
- **The `NOT_APPROVED_NOTE` sentence is load-bearing.** A refused tool call arrives as `status: "failed"` with the message ending in `"was not approved"`. Matching this exact sentence is what separates a denial from a tool fault. Changing the engine's refusal wording without updating `NOT_APPROVED_NOTE` will make refusals look like failures.
- **`applyPartialFrame` replaces, not appends.** If you change the ACP wire to send incremental deltas instead of cumulative snapshots, you must update `applyPartialFrame` accordingly. The current contract is that each frame carries the tool's whole output so far.
- **The 32 KiB wire cap is enforced by the supervisor.** The `rawOutput` may arrive as `{truncated: true, snippet}` when the record exceeds 32 KiB. `readWire` handles this shape, but `presentTool` only knows about it through `wire.rawTruncated`.
- **Escalation is derived from the clock, not from the delta.** The approval card computes `escalated` from `escalateAt` and `nowMs`. If the server sends a `permission.escalated` delta before the client's clock reaches `escalateAt`, the card still shows the correct state because `deriveApprovalTimings` checks `permission.status === "escalated"` first.
- **The diff format is not a unified diff.** A parser written against unified-diff syntax reads every clio-format row as context and reports zero additions. The `isClioFormat` check distinguishes the two.
- **The composer's idempotency key must survive typing.** The key is minted once per draft and reused on retry. If you change the key minting strategy, make sure `acknowledge` still clears the draft only when the text matches exactly.
- **Vite failures break the CLI build.** The CLAUDE.md notes: "A Vite failure in the GUI fails the whole CLI build, because tsup runs the GUI build in `onSuccess`." GUI changes require `pnpm run check:gui` and `pnpm run test:gui`.

## Extension seams

- **New tool kind:** Add an entry to `KINDS` in `tool-presentation.ts` and a corresponding `VERBS` entry. Add a `headlineFor` case for the tool's specific input fields.
- **New steering mode:** Add it to `KNOWN_MODES` in `composer-model.ts` and a `MODE_COPY` entry. Update `steeringAffordances` to filter it.
- **New permission action:** Add it to the action array in `approvalActions` in `approval-model.ts`, with the appropriate `variant` and `keybinding`.
- **New diff format:** Extend `parseDiff` in `diff-model.ts` to detect and parse the new format before falling back to `unparsed`.
- **New Markdown element:** Add a case in the `InlineToken` or `Block` switch in `Markdown.tsx`. The token comes from `marked`, so the shape is fixed by the library.

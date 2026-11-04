---
title: "Browser client"
summary: "The React single-page client of the Clio Coder GUI: its route table, query and error policy, the chat composer's submit decision and draft store, tool-call presentation, the settings controls view, the machines registration flow, the setup wizard steps, and the Markdown rendering boundary. Read this to find where a browser view or client rule lives."
sources:
  - "apps/clio-coder-gui/client/main.tsx"
  - "apps/clio-coder-gui/client/chat/composer-model.ts"
  - "apps/clio-coder-gui/client/chat/Composer.tsx"
  - "apps/clio-coder-gui/client/chat/tool-presentation.ts"
  - "apps/clio-coder-gui/client/pages/settings-controls.tsx"
  - "apps/clio-coder-gui/client/pages/machines.tsx"
  - "apps/clio-coder-gui/client/wizard/steps.tsx"
  - "apps/clio-coder-gui/client/render/Markdown.tsx"
  - "apps/clio-coder-gui/server/http/routes-machines.ts"
symbols:
  - "submitIntent"
  - "DraftStore"
  - "draftStore"
  - "presentTool"
  - "SettingsControlsView"
  - "MachinesPage"
  - "MachinesDraft"
  - "machinesDraft"
  - "AddMachine"
  - "StepProps"
  - "MarkdownContent"
tests:
  - "apps/clio-coder-gui/tests/chat-composer.test.ts"
  - "apps/clio-coder-gui/tests/chat-tools.test.ts"
invariants:
  - "A composer send while a turn is running becomes a steer only when the agent announced steering and the draft is not blocked by size or a pending send; otherwise submitIntent returns a blocked intent with a reason."
  - "An edit after a send attempt mints a new idempotency key, so changed text cannot reuse the earlier request's result."
  - "A cleared draft is a new message with a new key."
  - "Prompt text over the character limit or steer text over the byte limit is blocked before the request is sent."
  - "A running tool with partial output is presented as not settled; partialOutput alone never marks a tool call as finished."
  - "A tool card's headline is one bounded line and never a JSON object, and a web_fetch headline omits the URL query string."
validate:
  - "pnpm run test:file apps/clio-coder-gui/tests/chat-composer.test.ts"
  - "pnpm run test:file apps/clio-coder-gui/tests/chat-tools.test.ts"
---

# Browser client

The browser client is the React application under `apps/clio-coder-gui/client`. A reader needs this page to find which file owns a given browser view, how the client routes and reports errors, where the chat composer decides whether a send becomes a prompt, a steer, a shell line, or a refusal, how a tool call is turned into a card, and how the machines registration request reaches the server.

## What the client does

`apps/clio-coder-gui/client/main.tsx` builds the whole client. It creates an API client, configures a TanStack `QueryClient`, and declares a `createBrowserRouter` route table. Each route is either a lazily imported page or a fixed element. The `App` shell wraps every route, and the file renders `RouterProvider` under a `QueryClientProvider` into the `root` element.

The route table maps paths to page modules. Examples: `/sessions` and `/sessions/:id` to the mission-control and session pages, `/machines` to `MachinesPage`, `/fleet` and `/fleet/:id` to fleet pages, `/settings/*` to the settings pages, and `/` to `Home`. `/setup` has `element: null` because the app shell draws the setup wizard full window.

## Query and error policy

`apps/clio-coder-gui/client/main.tsx` sets global defaults: `retry: false` and `staleTime: 5_000`. Two cache hooks decide what is reported to the user:

- `QueryCache.onError` skips reporting when a query has no observers, when the query's `meta.errorSurface` is `"inline"`, when a `session-history` read returns `unsupported`, and when a first `session` read returns `not_found`. Every other failure goes to `reportProblem`.
- `MutationCache.onError` reports a failure to `reportProblem` unless the mutation's `meta.errorSurface` is `"inline"`.

`RouteError` is the router's error element. It logs the error to the console and shows a reload prompt.

## The composer submit decision

`apps/clio-coder-gui/client/chat/composer-model.ts` holds the composer's policy as pure functions and a plain store. `submitIntent(draft, situation)` is the single decision point. It returns one of four `SubmitIntent` kinds: `prompt`, `steer`, `shell`, or `blocked` with a reason. The branch order is:

1. If `situation.sending` is true, the result is blocked ("The previous send is still on the wire.").
2. If `sessionControl` is set, the result is blocked with the control message.
3. If `sessionState` is not `"open"`, the result is blocked with the state-specific text from `CLOSED_SESSION_REASON`.
4. Empty trimmed text is blocked.
5. If `situation.shell` is set and the text starts with `!`, `shellLine` parses it. Empty commands, multi-line commands, and a running turn are blocked. The command is then size-checked against `STEER_TEXT_MAX_BYTES`.
6. If `turnRunning` is true, the result is a `steer` only when `steering.steer` is true and `steeringUnavailable` is not `"checking"` or `"failed"`. The mode is the draft's mode if the engine announced it, otherwise the first announced mode. Text over `STEER_TEXT_MAX_BYTES` is blocked.
7. Otherwise the result is a `prompt`, checked against `PROMPT_TEXT_MAX_CHARACTERS` (characters) and four times that in bytes.

`apps/clio-coder-gui/client/chat/Composer.tsx` calls `submitIntent` on every render with a situation built from the session state, `turnRunning`, `send.isPending`, the steering affordances, and `capabilities.data?.shell`. It calls `submitIntent` again at `apps/clio-coder-gui/client/chat/Composer.tsx:696` for the send path. `submitLabel` derives the button text from the same intent, so the label states what Enter will do.

`steeringAffordances` converts an `AgentCapabilities` value into `SteeringAffordances`. It returns `NO_STEERING` when the agent announced nothing, and filters the announced modes to the two the client knows.

## Draft store and idempotency

`DraftStore` holds one `Draft` (`text`, `mode`, `key`) outside the component tree, so streamed updates do not re-render the textarea. Key rules, all in `apps/clio-coder-gui/client/chat/composer-model.ts`:

- `write` and `chooseMode` mint a new key only when the current key was already submitted. Otherwise the key is kept, so an unchanged retry reuses it.
- `markSubmitted` records the submitted key only if it still matches the current draft.
- `acknowledge` clears the draft only when the text and mode still match what was sent. If the operator typed more, only the new suffix is kept, under a new key.
- `refuse` clears the submitted marker and mints a new key, because a definite refusal kept no message and the same text may be sent as a new request.
- `clear` resets the draft and mints a new key.

`draftStore(id)` keeps up to `MAX_DRAFT_STORES` (32) stores in an LRU map. It restores each one from `sessionStorage` using the `clio-coder-draft:` key prefix and the `clio-coder-draft-index` list. `persistDraft` runs on every change. It removes the entry when the text is empty and trims the index to the cap. A saved key is accepted only if it matches `^[!-~]{1,128}$`.

Test coverage in `apps/clio-coder-gui/tests/chat-composer.test.ts` includes `an idle open session sends a prompt carrying the draft's key`, which asserts `submitIntent(draft(), situation())` returns `{ kind: "prompt", text: "explain this repository", idempotencyKey: "key-1" }`. Another case asserts that a running turn steers in the mode the operator chose. A third asserts that an engine announcing an unknown mode `"sideways"` gets only `["next-slot"]`. The same file contains a test that a build with `main: false` offers no steer. `apps/clio-coder-gui/tests/settings-drafts.test.ts` covers the settings-side draft model and is not part of this composer path.

## Tool-call presentation

`apps/clio-coder-gui/client/chat/tool-presentation.ts` is a pure taxonomy, written so `node:test` can reach every decision. Its file header states that the app has no DOM test environment and that `apps/clio-coder-gui/client/chat/tool-cards.tsx` is a switch over the result. `presentTool(item, options)` takes a `TimelineItem` and returns a `ToolPresentation`: a chip, a verb, a digest, a headline, a `body` kind (`diff`, `terminal`, `matches`, `file`, `fetch`, `dispatch`, `ask`, `json`, or `chain`), status fields (`settled`, `failed`, `ended`), facts, a note, locations, an `OutputPane`, and optional diff and match data.

Dispatch is keyed on the canonical tool name, not the ACP kind hint. The header comment notes that `item.title` carries the canonical name and `item.toolKind` is a lossy five-value hint. `presentTool` resolves the name from a gateway call when one is present (`readGateway`), else from `item.title`, and selects the body from a `KINDS` table, falling back to `KIND_HINT[item.toolKind]` and then to a `json` body. A `chain` body is chosen when the gateway call carries steps.

The switch on `kind.body` fills facts and notes from the wire details: a `diff` body delegates to `diffPanel`, a `matches` body parses rows with `parseMatches`, and a `dispatch` body reads `runId` and the agent or recipe name. After the switch, an oversized raw record adds a truncation note, and a running call past `LONG_RUNNING_TOOL_SECONDS` (30) gains a "still running" fact when the caller supplies `nowMs` and `startedAtMs`.

Settled state is read from the item status, and `failed` is `item.status === "failed"` or `isError`. The output pane takes its text from `partialOutput` while running and from the final result once settled. The `OutputPane.source` value is `"partial"`, `"final"`, or `"none"`, and the file header says `source` is never a completion signal.

Test coverage in `apps/clio-coder-gui/tests/chat-tools.test.ts` includes:

- `partialOutput never means the call finished`: a `status: "in_progress"` item with `partialOutput: "compiling…\n"` yields `settled === false`, `output.running === true`, and `output.source === "partial"`.
- `the canonical tool name keys the card, not the lossy ACP kind hint`: a `git` title with `toolKind: "other"` and `rawInput: { op: "status" }` yields chip `git`, body `terminal`, and headline `git status`. An `ls` title with `toolKind: "read"` yields chip `list` and body `file`.
- `an unknown tool falls back to the kind hint and keeps the JSON body`: `mcp__acme__lookup` yields body `json`.
- `a web_fetch headline is the host and path, and an unparseable URL is shown raw`: `https://example.org/a/b?token=secret` yields headline `example.org/a/b`, with the query string absent, and `not a url` is shown unchanged.
- `a call past the long-running threshold says so without being expanded`: `nowMs: 100_000, startedAtMs: 55_000` adds a `still running` fact with value `45s`, and `startedAtMs: 95_000` adds none.
- `a call that was not approved says so on its row instead of echoing the refusal`, and `a delegation whose run was stopped reads Stopped with a dash, not Failed`, which pin the `ended` and `failed` distinctions.

`apps/clio-coder-gui/tests/chat-tools.test.ts` also imports `apps/clio-coder-gui/client/chat/diff-model.ts` and `apps/clio-coder-gui/client/chat/tool-presentation.ts` helpers, and its diff cases exercise the `diffPanel` path. The diff format itself is owned by `apps/clio-coder-gui/client/chat/diff-model.ts`, which this page does not trace.

## Settings controls view

`apps/clio-coder-gui/client/pages/settings-controls.tsx` exports `SettingsControlsView({ client, workspaceId, compact, scope })`. It reads the `settings-controls` report through `routes.settingsControls` with `meta.errorSurface: "inline"`, so an error is shown in the view rather than as a global toast. It keeps unsaved edits in a draft store (`useSettingsDrafts`) and drops a draft entry once the server value equals it.

Discovery state lives in the URL query (`section` and `q` search parameters) when the view is not `compact`, and in local state when it is. In `compact` mode the view shows one selected control at a time; `scope` limits which controls are listed. The view filters controls by section or by the search text, and a `showDrafts` mode lists only unsaved edits.

Model settings are the one place a second query is involved. `MODEL_TARGET_PATHS` maps a model control to a target control. The `targets` inventory is read only when a model control is on screen, and `catalogFor` turns the selected target into a `ModelCatalog` with a note: it reports when the target is automatic, when the list is being read, when the target is not a configured connection, and when the list is truncated at 200 models. The "Check … again" button starts `routes.targetsProbe`, and `useOperation` follows that operation; a successful result is written back into the `targets` query.

Saving goes through `save(body)`, which calls `routes.writeSetting` with the workspace ID and body (`path`, `value`, optional `confirmed` and `expectedValue`). On success it sets the `settings-controls` query data from the response and invalidates `workspace-settings`, `config-graph`, `targets`, and `routing`.

The view's reference points are read from source only. No focused test for `SettingsControlsView` was located in `apps/clio-coder-gui/tests` by a search for the component name; the claims above rest on the source read.

## The machines page and registration request

`apps/clio-coder-gui/client/pages/machines.tsx` exports `MachinesPage({ client })`. Its registration form, `AddMachine`, collects a machine ID (maximum 64 characters) and an SSH host or alias (maximum 253), with optional SSH user, port (1 to 65535), maximum workers (required, 1 to 1024), and labels. The form caption states that adding a machine does not connect to it.

Editor state lives in a `WeakMap` keyed by the client: `machineDrafts` and `machinesDraft(client)` create a store of `MachinesDraft` (`draft`, `adding`, `request`, `sending`, `error`). Because the store is keyed by the client rather than the component, it survives route remounts. The page reads it with `useSyncExternalStore`.

The submit path is:

1. `AddMachine`'s form `onSubmit` validates the draft and calls `onAdd` with the resulting machine record.
2. The page's `useMutation` (`errorSurface: "inline"`, so the global toast is skipped) first calls `routes.meta` to read the current server epoch. If the epoch differs from the one recorded on the request, it throws a restart error and does not send.
3. It then calls `routes.machineMutation` with `params.id` set to the workspace ID, the request body, and the request's idempotency key.
4. On acceptance, the returned `operationId` is stored on the request. The page then polls `routes.operation` every 1000 ms until the status is `succeeded`, `failed`, or `cancelled`. Polling stops when the epoch has changed.
5. When the operation settles, the page invalidates the `machines` query. On a successful `add`, it clears the draft and invalidates `workspace-settings`, `settings-controls`, and `config-graph`.

On the server, `apps/clio-coder-gui/server/http/routes-machines.ts` registers `routes.machines` (a list for `params.id`) and `routes.machineMutation`. The mutation handler forwards `params.id`, `body`, and `idempotencyKey(context)` to `service().mutate` and returns `{ operationId }`. When no `MachinesService` is passed in, `service()` throws an `AppProblem` with the code `unsupported` and the message "Machine management is not enabled on this host." The route registration uses the shared `register` helper from `apps/clio-coder-gui/server/http/validate.ts`. The service implementation is in `apps/clio-coder-gui/server/services/machines.ts`, which this page does not trace further.

Test coverage for this flow was not found. A search for the names `routes.machineMutation`, `routes-machines`, and `MachinesService` across the test files under `apps/clio-coder-gui/tests` returned no match. The claims above therefore rest on source reads only.

## The setup wizard steps

`apps/clio-coder-gui/client/wizard/steps.tsx` renders the setup wizard as one component per step kind. Each exported step (for example `CategoryStep`, `ProviderStep`, `SignInStep`, `CredentialKeyStep`, `TextStep`, and `DetectedStep`) receives `StepProps<Of<kind>>`: the `view` for that kind, a `busy` flag, the CLI's `problem` string, and a `send(answer)` callback. The answer values are built by helpers in `apps/clio-coder-gui/client/wizard/wizard-model.ts`, such as `selectAnswer` and `textAnswer`; the answer transitions those helpers feed are not traced on this page.

The file's `Step` wrapper renders the `h1` title, the lede, the children, and an actions row. `useStepFocus` moves focus to the element with `data-autofocus`, or to the heading if there is none. `arrowNavigation` moves focus between enabled `[data-tile]` buttons with the arrow keys, Home, and End. No focused wizard test was located.

## Markdown rendering boundary

`apps/clio-coder-gui/client/render/Markdown.tsx` renders model output from `marked` tokens into React nodes. Its file header states that every node is created by React from token data, so model text is not interpreted as HTML. `MarkdownContent` takes `source`, a `complete` flag, and an optional `deferDiagrams` flag. While a response streams, it uses `IncrementalMarkdown` so settled blocks keep their identity and only the tail is re-lexed. Once `complete` holds and the displayed source equals the source, it runs a single `lexMarkdown` parse and drops the incremental state.

Raw HTML is not passed through. The two places that insert markup are sanitized. Mermaid output goes through `renderMermaid` in `apps/clio-coder-gui/client/render/mermaid.ts`, which runs DOMPurify with `SANITIZE_CONFIG` before the SVG is inserted. `apps/clio-coder-gui/client/render/MathContent.tsx` also calls `DOMPurify.sanitize` with `SANITIZE_CONFIG`. `apps/clio-coder-gui/client/render/Markdown.tsx` restricts inline images to base64 raster data URIs (`png`, `jpeg`, `gif`, `webp`) and excludes SVG, because an SVG can carry script. Images are capped at `INLINE_IMAGE_MAX_CHARS`.

Visibility-gated rendering of code and diagrams uses `useNearViewport`, which shares one `IntersectionObserver` per root margin, defaulting to `600px`.

No focused test for the Markdown boundary was located.

## Things to watch when editing

- `submitIntent` is the only place the send policy is decided. The composer, its label, and its shell hint all read the same intent, so a change to a branch changes the button text and the send path together.
- The steering branch depends on the agent's announced capabilities. Changing the mode list or the `steer` flag changes what the composer offers, and the tests above pin the current filtering.
- Idempotency keys are part of the draft state. A change that reuses a key after an edit would let changed text claim an earlier result, which `DraftStore` is written to prevent.
- Tool-call cards are keyed on `item.title`. Adding a tool whose canonical name differs from its ACP kind needs an entry in `KINDS` or the fallback path will show it as JSON.
- The machine registration request is sent with the epoch read at send time. Removing the `routes.meta` call before `machineMutation` would remove the restart check that the mutation performs.
- `apps/clio-coder-gui/client/main.tsx` error filtering is user-visible. A route or mutation with `meta.errorSurface` set to `"inline"` suppresses the global toast for that query or mutation.
- Markdown output must stay on React text nodes. Any new sink that inserts HTML must sanitize with `SANITIZE_CONFIG` the way `mermaid.ts` and `apps/clio-coder-gui/client/render/MathContent.tsx` do.

## Related pages

- [Apps clio coder gui tests](tests.md)
- [Apps clio coder gui server](server.md)
- [Apps clio coder gui contracts](contracts.md)
- [Interactive](../../interactive.md)

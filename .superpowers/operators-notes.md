# Editor operator implementation notes

Status: reconciled with the `v0.4.1` implementation after commits `70768075`,
`401c58a6`, and `313775c9`. These are implementation notes for the parallel
operator-family work, not a proposal for a second parser or autocomplete
provider.

## 1. Audited behavior of `!` and `!!`

Both forms are editor-line operators parsed by
`src/interactive/editor-bash.ts:parseEditorBashCommand` and admitted by
`src/interactive/editor-submit.ts:createEditorSubmitController`. They execute
`/bin/bash -c <command>` in the interactive working directory, stream combined
stdout/stderr snapshots into a foldable transcript block, time out after five
minutes, and stop after the 16 MiB capture safety ceiling. Escape cancels the
one active editor Bash process.

The exact context behavior is:

| Draft | Session/transcript behavior | Model behavior |
| --- | --- | --- |
| `! command` | Persists a `bashExecution` entry and remains visible on replay. | `buildReplayAgentMessagesFromTurns` projects the command and output into a user-role Bash context message. This is tool-like context, but not a synthesized native tool-call/tool-result pair. Compaction can summarize it and the context meter charges it. |
| `!! command` | Persists the same entry with `excludeFromContext: true`; it streams live, remains visible on replay, and is marked `not sent to model`. | Produces no replay model message, is omitted from branch/compaction serialization, and estimates as zero context tokens. Neither command nor output crosses either model-input path. |

The starting implementation was only partly correct for `!!`. Direct replay
already honored `excludeFromContext`, and the row was already viewport-visible,
but `serializeConversation` still included the command and output in a later
compaction prompt. The context estimator also charged the row. Commit
`70768075` closed both indirect leaks and changed the UI wording from the vague
`excluded from context` to the honest `not sent to model` marker.

`!!` is deliberately durable rather than ephemeral. “Not sent to model” does
not mean “not stored”: the full `bashExecution` entry is retained so the human
can inspect the result after resume. This differs from the proposed ephemeral
doubled-sigil convention in `operators-spec.md` and should remain an explicit
compatibility decision.

### Firing and paste rules now enforced

`parseEditorBashCommand` returns `null` for an empty command, any draft
containing `\n` or `\r`, and any draft carrying
`PASTED_EDITOR_OPERATOR_GUARD`. Therefore `!` and `!!` fire only for non-empty,
single-line drafts.

`src/interactive/clio-editor.ts:ClioEditor.handleInput` notices the bracketed
paste close sequence (`ESC [ 201 ~`). If the resulting draft starts with `!`,
the editor applies the invisible one-shot guard immediately before handing the
draft to Pi's submit callback. Both `submitEditorText` and `admitCapturedText`
test the guarded spelling, then remove the guard before ordinary prompt
routing, history, or persistence. Consequences:

- a pasted one-line `! command` is literal prompt text;
- a pasted one-line `!! command` is literal prompt text;
- a multiline paste beginning with either form is literal prompt text;
- the invisible guard is never persisted or sent to a model;
- deleting the pasted leading `!` clears the provenance state, allowing a
  subsequently typed operator to opt in normally;
- programmatic `ClioEditor.setText` also clears the one-shot state.

The urgent operator decision is authoritative here: bracketed paste never arms
an executable operator. `operators-spec.md` rev 2 currently describes an
empty-draft/single-line-paste exception; that exception must be removed when
the future family registry reconciles with this implementation.

## 2. Current submission and context extension points

There is no generic prefix registry on this branch. A future operator family
should centralize these seams; until that lands, these are all of the places a
new executable prefix must account for.

### Parse and admission

1. `src/interactive/editor-bash.ts:parseEditorBashCommand` is the existing
   prefix parser. It owns the distinction between `!` and `!!`, non-empty
   operand validation, single-line enforcement, and pasted-draft rejection.
2. `src/interactive/editor-submit.ts:submitEditorText` is the interactive
   dispatch boundary. Current priority is Bash operator, active-run steer
   mention, slash command, then ordinary prompt/command dispatch.
3. `src/interactive/editor-submit.ts:admitCapturedText` is the queued/captured
   submission boundary. It must use the same parser and ordering as the direct
   path; otherwise boot-queued input acquires different operator semantics.
4. `src/interactive/editor-submit.ts:runEditorBash` is the execution owner. It
   applies streaming/admission guards, ensures a session, appends the live
   block, runs the process, persists the entry, and refreshes model context.
5. `src/interactive/interactive-presentation.ts:willEnterSteerActiveWork`
   consults `parseEditorBashCommand` so a command is not misclassified as text
   that will steer active work. A central registry should expose one
   `isOperatorSubmission` query for this consumer rather than duplicating
   prefix knowledge.
6. `src/interactive/clio-editor.ts:ClioEditor.handleInput` is the only place
   with bracketed-paste provenance. A replacement registry must receive that
   provenance or a pre-parsed inert/typed classification; re-parsing the final
   string alone reintroduces the paste execution defect.

Recommended registry boundary: parse once at the submit edge into a tagged
operator admission containing its operand, context policy, and input
provenance. Both direct and captured submission paths should dispatch that
same result. Preserve the current rule that a pasted operator-looking draft is
unwrapped only after operator admission has been refused.

### Model-context inclusion and exclusion

`excludeFromContext` is currently an optional property of
`BashExecutionEntry` in `src/domains/session/entries.ts`; it is not a universal
session-entry policy automatically honored by every projection. A new entry
kind or context-private operator must wire every boundary explicitly:

1. **Producer:** set the policy when constructing the session entry, as
   `src/interactive/editor-bash.ts:bashExecutionEntryInput` does.
2. **Live refresh/resume:**
   `src/interactive/session-transcript.ts:refreshChatContextFromSession` calls
   `buildModelReplayAgentMessagesFromTurns`, which reaches
   `src/interactive/chat-renderer.ts:buildReplayAgentMessagesFromTurns`.
   The `bashExecution` switch arm must not append `bashContextText` for excluded
   entries.
3. **Compaction input:**
   `src/domains/session/compaction/branch-summary.ts:serializeConversation`
   must skip a private entry before adding either its operand or product to the
   summarizer prompt. Protecting only replay is insufficient.
4. **Context accounting:**
   `src/domains/session/compaction/tokens.ts:estimateBashExecution` must return
   zero for content that cannot become provider input, so the UI does not imply
   that the model can see private bytes.
5. **Schema/fold:** add or validate the entry field in
   `src/domains/session/entries.ts` and ensure all session projections preserve
   it. Exclusion should not suppress transcript replay unless the operator is
   intentionally ephemeral.

For a new generic operator policy, prefer a named model-visibility value over
scattered booleans, but keep the projections exhaustive. A UI marker is a
claim, not an enforcement mechanism.

### Transcript and viewport rendering

The live rendering hook is
`src/interactive/chat-panel.ts:ChatPanel.appendReplayBlock`. The Bash path in
`editor-submit.ts:runEditorBash` supplies:

- a mutable `BashTranscriptExecution` captured by the renderer closure;
- an `isLive` callback;
- fold policy and per-block fold override callbacks;
- `requestRender` calls for throttled process updates and settlement.

`src/interactive/renderers/tool-execution.ts:renderBashTranscriptExecution`
is shared by live execution and replay. It accepts `excludeFromContext` and
renders `not sent to model` in running, settled, folded, and expanded states.
It composes the existing Bash presentation policy from
`toolPresentationPolicy`, `policyRunningToolFold`, `policyToolFold`, and
`resolveFold`; new command-like operators should reuse that fold plumbing.

Persisted replay is handled by the `bashExecution` arm in
`src/interactive/chat-renderer.ts:rehydrateChatPanelFromTurns`, through
`renderBashExecutionEntry`, back into the same Bash renderer. A new durable
entry kind needs both its live block and a replay switch arm. An intentionally
ephemeral doubled operator should instead own a transient viewport block and
must not append a session entry; do not simulate ephemerality by persisting a
row and merely hiding it on replay.

At composition boundaries, append through the supplied chat-panel facade so
the render mutation stays serialized. For example,
`src/interactive/interactive-application.ts` wraps editor-command output in
`chatRenderer.mutate(..., "editor-command-output")`, and
`interactive-presentation.ts` does the equivalent for command output.

## 3. `@` reference completion and expansion

The upgraded picker is a source on the one grammar-aware provider introduced
by `5586f2d7`; it is not a parallel completion path.

### Provider registration

`src/interactive/slash-autocomplete.ts:ClioAutocompleteProvider` remains the
sole Clio provider installed by
`src/interactive/interactive-presentation.ts:editor.setAutocompleteProvider`.
Its `triggerCharacters` contains `/` and `@`.

For inline references, `fileReferenceContext` finds an active unquoted or
quoted `@` token at the cursor. `ClioAutocompleteProvider.getSuggestions`
then calls the injected `FileReferenceCompletionSource`, maps directories to
`open-submenu` items and files to value items, and attaches the exact
replacement range. `applyCompletion` performs the edit, including closing
quotes, suffix replacement, cursor placement inside a quoted directory, and
space insertion after a selected file. `shouldTriggerFileCompletion` routes
`@` through this branch. `CombinedAutocompleteProvider` remains only as the
fallback for ordinary non-`@` filesystem token completion.

The runtime source is created by
`src/interactive/file-reference-completion.ts:createFileReferenceCompletionSource`
and can be replaced through
`createSlashCommandAutocompleteProvider({ fileReferenceSource })` in tests or
future composition.

### Picker semantics

- Bare `@` lists the workspace's immediate top-level files and directories.
- A query with no slash fuzzily searches every visible workspace path using
  the existing engine's `fuzzyFilter`.
- A real directory prefix lists only its immediate children. Directory items
  are submenus; Tab or Enter accepts the directory, and `ClioEditor` reopens
  the same provider so Up/Down continues in the child tree.
- `./` preserves its spelling while using the workspace tree. Explicit
  `../`, `~/`, and absolute prefixes enumerate the addressed filesystem
  directory.
- Ordering is stable by bucket: Git-tracked directories, Git-tracked files,
  untracked directories, untracked files; fuzzy ranking applies within each
  bucket.
- The authoritative visible workspace inventory comes from
  `enumerateWorkspaceFilesAsync`; provenance comes from
  `git ls-files --cached`. The combined snapshot is cached for two seconds and
  suggestions are capped at 40 rows.
- Every file row includes provenance, size, and the first meaningful sanitized
  content line (or a binary/unavailable marker). Directory rows include
  provenance, descendant count where known, and the navigation hint.
- Paths containing whitespace, quotes, or backslashes are emitted as quoted
  references. `src/core/file-references.ts:inlineFileReferences` is the shared
  sync/async scanner that consumes those quoted/escaped spellings at submit,
  so completion output and actual context expansion agree.

The engine currently selects one row per acceptance. Cheap multi-attach is
available by inserting repeated `@...` references in the draft. There is no
checkbox multi-select state: adding one inside the source would fork selection
state away from the engine and make keyboard/edit invalidation unreliable. If
the completion engine later gains first-class multi-selection, the file source
can expose it without changing discovery, ordering, preview, or expansion.

### Adding a completable operator prefix

Do this on `ClioAutocompleteProvider`, not by installing another provider:

1. Add the prefix to `triggerCharacters`.
2. Add a cursor-aware context parser beside `slashContext` and
   `fileReferenceContext`; enforce the operator's line/provenance grammar there.
3. Define a source returning the existing completion-value shape, then inject
   it through `SlashAutocompleteOptions` as `fileReferenceSource` is today.
4. Map source rows to the existing completion item kinds, replacement ranges,
   `appendSpace`, `effectDescription`, and `submenu` metadata.
5. Keep edits in `applyCompletion` so acceptance behaves identically for Tab,
   Enter, quoting, and cursor movement.

For slash-command argument vocabularies, use the existing named-slot path
instead: add the slot to `COMPLETION_SLOT_NAMES` in `slash-spec.ts`, map the
grammar position in `COMPLETION_SLOT_MANIFEST`, and supply it through
`CompletionSources`. A future `#` board-task vocabulary should follow that
source contract even if its prefix context is non-slash.

## 4. Minimum checklist for a future operator family

- One registry parses input provenance and syntax once for both direct and
  captured submissions.
- Every executable operator is single-line unless its grammar explicitly and
  safely defines continuation; bracketed paste never creates executable
  provenance.
- Steer prediction and actual dispatch query the same registry.
- Completion is another source/context on `ClioAutocompleteProvider`.
- Durable products define an entry schema, producer, live renderer, replay
  renderer, model projection, compaction projection, and token estimate.
- Private products have negative tests at all three model boundaries: direct
  replay, compaction serialization, and context accounting.
- Every private viewport block says `not sent to model`; ephemeral and durable
  storage behavior are described separately.
- Regression tests cover typed single-line input, pasted single-line input,
  pasted multiline input, ordinary multiline drafts, cancellation, replay,
  compaction, folded/expanded rendering, and autocomplete replacement under
  the cursor.

# Dependency patches

## Pi TUI 1.5.2: why the patch remains

`@earendil-works__pi-tui@1.5.2.patch` is the sole Pi dependency patch, applied
by pnpm's exact `patchedDependencies` entry.
**pi-ai and pi-agent-core are unpatched.** The
[Anthropic thread idle limit](#pi-ai-152-anthropic-thread-idle-limit) lives in Clio's engine.
The pi-tui patch has nineteen hunks in ten `dist/` files and applies to the
published, unmodified 1.5.2 package. It carries the semantic edit and search
operations that stock 1.5.2 keeps private, the regular-screen render memo, the
kept-rows hook that lets that memo skip rows Clio vouches for and the
selection-text hook through which fullscreen copy rejoins wrapped prose.
Everything else earlier
revisions patched is now stock Pi or an engine module, as
[recorded below](#what-was-removed). The table lists every
hunk; `grep -c '^@@' patches/@earendil-works__pi-tui@1.5.2.patch` must equal the
hunk total.

| Hunks | Patched API | Required behavior | Why stock 1.5.2 is insufficient |
| --- | --- | --- | --- |
| 2: `components/editor.d.ts`, `components/editor.js` | `Editor.applyEdit` | Invoke undo and the six delete operations (character and word deletion in both directions, and deletion to line start and end) directly after Clio resolves a semantic keyboard action, without passing through submission or a second keybinding lookup. | The edit operations are private and `handleInput` interprets bytes against configurable bindings. `setText` alone does not express the same undo, cursor and kill-ring semantics. |
| 2: `components/input.d.ts`, `components/input.js` | `Input.applyEdit` | The same operations plus `clear`, which keeps undo and kill-ring behavior. | The same private operations on `Input`. |
| 2: `alt-screen-search.d.ts`, `alt-screen-search.js` | `AltScreenSearchComponent.applyEdit("undo")` | Undo the whole search query and notify the query listener. | The overlay's `Input` is private, and so is the `undo` it would need, so a router cannot undo a query. |
| 2: `tui-alt-screen.d.ts`, `tui-alt-screen.js` | `TuiAltScreen.isSearchFocused` and `undoSearchQuery`; `scrollToPrompt`, `toggleSearch`, `closeSearch` and `navigateSearch` made public | Clio's input router sends Escape, undo, prompt navigation and match navigation to the current owner, including the native search overlay. | Search focus and these methods are private. The public viewport scroll methods cannot query or manipulate search ownership or its undo history, and `getScreenLines()` exposes painted rows, not search state. |
| 2: `tui-alt-screen.d.ts`, `tui-alt-screen.js` | `TuiAltScreen.selectionText` (protected hook; stock join by default) | `getActiveSelectionText` hands each selected source row and its selected columns to `selectionText`, whose default joins the rows exactly as stock 1.5.2 does. Clio's `InstrumentedTuiAltScreen` overrides it (`src/engine/selection-text.ts`): a row the chat panel marked as a wrapped continuation joins the row above with one space, and the turn glyph and the 2-cell gutter are left out, so a dragged paragraph copies as one line (#453). Each mark names the decoration cells after it, so fenced code also copies without its block indent and its `↪` wrap marks, and prompt and action rows without their bar or glyph. | `getActiveSelectionText` is private and joins every painted row with a newline, and the copy reaches the clipboard through it, so neither `copySelection` nor a subclass could rebuild the text from the rows it read. |
| 5: `tui-main-screen.js` | `TuiMainScreen` reset memo and Kitty image-row scans | A regular-screen frame reuses the reset output of every row whose raw string is unchanged, rewriting the memo in place and recording which rows are image rows, and the Kitty image scans (`collectKittyImageIds`, `expandChangedRangeForKittyImages`) visit only those rows. `resetRenderState` drops the memo. The memo's `applyLineResets` replaces the stock method, so it also removes stray cursor markers from a row before normalizing it, as stock 1.5.2 does. | Stock 1.0.0 normalizes every transcript row and scans all rows for image headers on every regular-screen frame, so the cost grows with the transcript. Measured [below](#measured-cost-of-the-render-memo): a 22.9k-row transcript costs 5.90 ms per keystroke frame stock against 0.62 ms patched. The scans are private methods, so no subclass can replace them. |
| 1: `tui-main-screen.js` | `TuiMainScreen.doRender` OSC 133 strip | Run the marker strip only on a row that starts with `\x1b]133;`, so a frame makes no regex call for any other row. The pattern is anchored at the row start, so the output is unchanged. | Stock 1.5.2 calls `replace` with the anchored pattern on every row of every frame, which cost 3.25 ms of a frame while a 500 KB reply streamed (#428). The call sits inside `doRender`, so no subclass can skip it. |
| 3: `tui-main-screen.d.ts`, `tui-main-screen.js` | `TuiMainScreen.keptRenderedRows` (protected hook, 0 by default) and `keptLeadingRows` | A subclass may report how many leading rendered rows are the very strings of the last frame's. `doRender` clamps that count to rows outside both frames' viewports, at an unchanged size and with no overlay, then takes those rows as the last frame stripped, reset and resolved them: the OSC 133 strip rewrites its own array in place from the first row not kept, `applyLineResets` copies the kept rows' output and image flags, and the diff loop starts below them. Clio's `InstrumentedTuiMainScreen` answers from the root's count (`src/interactive/kept-rows.ts`). | The strip, the reset memo's compare and the diff loop each visited every row of a 500 KB transcript on every frame although only the last rows change, and they sit inside `doRender`. A keystroke frame at reply-500k went from 1.19 ms to 0.13 ms p50 ([measured below](#measured-cost-of-the-kept-rows-hook)). |

The semantic operations call Pi's existing editing and search implementation;
they do not replace it. Consumers are the terminal lease, input router, editor
and overlays under `src/interactive/`, through `src/engine/tui.ts`.

Clio also retains its own locked YAML credential storage and OAuth refresh lifecycle
for 0.6.0. Provider login and refresh flows delegate to Pi through Clio's OAuth
registry; `CredentialStore` and `Models.getAuth` adoption was reverted. This
auth boundary is Clio application code and adds no dependency patch.

## What was removed

The patch carried 26 hunks before the Pi 1.0 adoption series and carries
nineteen now: thirteen kept from then, and the OSC 133 prefix check, the three
kept-rows hunks and the two selection-text hunks added since.
The thirteen removed hunks fall into five groups.

| Removed | Replaced by | Cost and evidence |
| --- | --- | --- |
| `wrapTextWithAnsi` whitespace tokens (2 hunks in `dist/utils.js`) | Stock Pi 1.5.2 | None. `wrapTextWithAnsi("\x1b[1mhello\x1b[22m world", 5)` yields `hello` and `world` on the unmodified 1.5.2 package, and so does the foreground color form. |
| `setApplicationInputPolicy` and its dispatch block (5 hunks in `dist/tui.d.ts` and `dist/tui.js`) | `src/engine/application-input-tui.ts`, a subclass pair that registers one gate through the public `addInputListener` | No operator-visible change. A policy returning `{ data: "" }` no longer drops the input before every listener, and stock `TuiAltScreen` instances (the fleet watch and follow views) no longer drop key releases before their listeners, which compare exact bytes releases never equal. |
| `lexMarkdownBlocks` export (4 hunks in the Markdown and index files) | Stock `Markdown` for assistant text in `src/interactive/chat-panel.ts` (one per finished segment; a streaming segment renders its settled head and open tail apart, #428), with Clio's theme, a `highlightCode` hook and a `transform` hook for table fit and Mermaid | The visible changes are listed in [the Pi boundary table](../docs/architecture/pi-boundary.md). |
| `Container.render` exact-size copy (1 hunk) | Stock Pi | A smaller regular-screen cost, measured below. |
| Unchanged-row skip in `TuiMainScreen` (1 hunk) | Stock Pi | More bytes written per streamed frame, measured below. |

### Measured cost of the render memo

Every figure comes from a scratch probe that drives Clio's real chat panel over
a fake terminal (Node 24, 120x40, medians of five interleaved runs on a shared
host whose one-minute load average ranged from 3.6 to 18 across the probes). It
times in-process JavaScript only and excludes terminal and kernel write cost, so
compare ratios, not absolute milliseconds.

- Reset memo and image-row scans (kept), regular screen, 22.9k-row transcript,
  measured with the hunks temporarily removed: keystroke frame 0.62 to 5.90 ms, streamed-token frame 1.13 to 6.01 ms,
  garbage per frame 231 KB to 4.6 MB, and 0 to about 25 scavenges per 300
  frames. At 2.2k rows the same frames cost 0.13 to 0.61 ms and 0.33 to 0.72 ms.
  An earlier probe at about 40,000 rows measured about 16 ms per frame, the
  length of Pi's own minimum render interval. Fullscreen is within noise.
- Exact-size copy (removed), 22.9k rows: keystroke frame 0.65 to 1.04 ms, streamed-token
  frame 0.90 to 1.35 ms, garbage per frame 231 to 954 KB, and two scavenges per
  300 frames. Fullscreen is within noise.
- Unchanged-row skip (removed), 22.9k rows: bytes written per streamed-token frame go from
  237 to 1,769, and frame time is unchanged within noise.

The regular screen is Clio's default mode (`src/core/defaults.ts`), so dropping
the memo would put a 6 to 10 ms frame on the default path for very long
transcripts against 0.6 to 1.1 ms with it (9.5x to 16.8x for keystrokes across
the probes, which ran under different host load), which is why those five hunks
stay.
Pi's own coding agent defaults to fullscreen, where the alternate screen
virtualizes the transcript, and its large-transcript benchmarks cover only that
mode. The two removed hunks cost at most 1.5x frame time or extra bytes written
and were dropped. `git log` on the patch file finds the commits that removed
hunks. The memo stays until Pi ships the change upstream (draft 0003).

Since 1.2.0, stock `TuiMainScreen.doRender` passes every rendered row through
`resolveFakeCursors` (an `includes` scan and a new array) before compositing,
so the memo keys on resolved rows and stays correct. That stock step is not
memoized and grows with the transcript: a copy of the 1.4.0 function over
synthetic 138-character styled rows cost 0.07 ms per frame at 2.2k rows,
0.80 ms at 22.9k and 1.37 ms at 40k (Node 24, load average 0.5). The patch
leaves it stock for the 1.4.0 upgrade; memoizing it is a separate decision.

Since 1.5.0, stock `doRender` also passes every row through an OSC 133 strip (a regex
replace and a new array) before compositing. A frame probe over 22.9k synthetic
styled rows with one row changing per frame, patched on both versions, took a
median of 1.0 to 1.1 ms on 1.4.0 and 1.6 to 1.7 ms on 1.5.0 (Node 24, two runs
each). That new step is the likely cause, though it was not profiled, and the
memo stays in effect. The patch has since narrowed that step to rows that start
with the marker, which is the OSC 133 row in the table above.

### The 1.5.2 rebase

Pi 1.5.1 and 1.5.2 changed six pi-tui files, and two of them carry hunks:
`components/editor.js` (paste marker renumbering) and `tui-alt-screen.js` (Kitty
image draw order). Neither change touches the patched lines, and
`tui-main-screen.js` is byte-identical in the published 1.5.0 and 1.5.2
packages. Fifteen hunks carried over unchanged and no hunk was dropped, because
1.5.2 makes none of the patched seams public.

Two hunks in `tui-main-screen.js` changed. Stock 1.5.2 `TuiBase.applyLineResets`
removes every cursor marker from a row before normalizing it, so that an
internal marker never reaches the terminal (upstream #9441). The reset memo
replaces that method on the regular screen, so the memo hunk now makes the same
`replaceAll(CURSOR_MARKER, "")` call on each row it normalizes, and the import
hunk brings `CURSOR_MARKER` in from `./tui.js`. Without that edit the patch
still applied cleanly and silently kept the 1.5.0 behavior on Clio's default
screen. A row is stripped once and then reused from the memo. The frame cost
figures above were not measured again on 1.5.2.

## Alternatives considered

- **Use stock input listeners and keybindings:** adopted for application-first
  routing. `ApplicationInputTuiAltScreen` and `ApplicationInputTuiMainScreen`
  in `src/engine/application-input-tui.ts` register one gate through the public
  `addInputListener` ahead of every other listener. `TuiAltScreen` registers its
  viewport shortcuts from its own constructor through that virtual method, so
  the override runs first inside `super()` and the application policy sees a key
  before viewport bindings can consume it. The gate consumes key releases and
  hands everything else to one replaceable policy; Pi's listener loop honors the
  policy's `consume` and `data` results, and bracketed paste stays literal
  because stock `isKeyRelease` is false for it. Gate state lives in a module
  `WeakMap` because an ES2022 class field would reset when `super()` returns.
  The design depends on stock `TuiAltScreen` keeping that registration public,
  which the policy-first ordering tests in
  `tests/extended/keyboard-routing.test.ts` and the installed-package keyboard
  check in `tests/smoke/installed-package.test.ts` pin. Removing every
  overlapping viewport binding was rejected because it also disables native
  behavior that Clio deliberately retains.
- **Synthesize control-key sequences:** goes through another configurable
  binding lookup. A deletion or undo action can become submission or a
  different action under user bindings; this fails the semantic-action contract.
- **Subclass or access private fields for the edit and search seams:**
  TypeScript privacy bypasses would bind Clio to undocumented widget state and
  still would not supply a supported way to invoke the private operations. A
  forked editor/search implementation would own considerably more code and lose
  upstream behavior fixes.
- **Move the render memo into an engine subclass:** rejected. The Kitty
  image-row scans are private methods, so a subclass cannot replace them. In an earlier probe a
  stock regular-screen frame cost 9.8 to 10.4 ms at 22.9k rows in the same interleaved probe, a protected
  `applyLineResets` override alone cost 4.8 to 5.1 ms, and the full memo cost
  0.6 to 1.1 ms. Making fullscreen the default as Pi's coding agent does would
  avoid the cost but is a product decision, not a dependency patch.
- **Replace Pi's keyboard/editing/search stack:** technically possible, but
  duplicates working SDK functionality. The patch exposes the small missing
  seams and leaves editing, layout, undo, selection and rendering in Pi.
- **Contribute the seams upstream:** preferred removal path. No upstream issue,
  pull request or acceptance is recorded in this repository; this document does
  not claim one exists. Source drafts against tag `v1.0.0` (commit
  `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`) exist for the semantic edit and
  search operations, the styled-whitespace wrapping fix and the render reset
  memo. They live in the maintainer's gitignored `.mine/pi-upstream/`, pass
  `git apply --check` on that tag, and add no upstream tests; Pi's own
  typecheck and test suite were not run against them. None is submitted or
  accepted. Equivalent official APIs may have different names.

### Measured cost of the kept-rows hook

`scripts/bench-tui.ts` (regular screen, 120x40, 400 turns plus the reply, 120 frames, Node 24.20, medians of five
repeats per run, two runs interleaved against the patch without the hook on a shared 24-core host at a one-minute load
average of 17 to 22) gives these p50 frame times, before then after, one pair per run:

| Workload | Streamed-token frame | Keystroke frame (`--echo`) |
| --- | --- | --- |
| reply-500k | 2.90 and 4.00 ms to 0.91 and 0.72 ms | 1.94 and 1.95 ms to 0.087 and 0.080 ms |
| reply-100k | 0.78 and 0.65 ms to 0.27 and 0.15 ms | 0.51 and 0.46 ms to 0.031 and 0.034 ms |

Bytes written per frame are unchanged (128 streamed, 151 keystroke), and `--verify` finds 0 mismatching frames for every
workload in both modes. A keystroke frame no longer grows with the transcript. A streamed-token frame still does,
because three layers of Clio's chat panel each copy the reply's rows into a new array per frame (the settled split, the
gutter and the panel's tail), which the panel's promise never to mutate a returned array requires.

## Pi AI 1.5.2: Anthropic thread idle limit

This is an engine adaptation, not a dependency patch.
`src/engine/apis/anthropic-response.ts` uses Pi's public `onPayload`, `fetch`
and session-cleanup hooks, so npm and from-source installs run the same guard
against stock pi-ai. The earlier three-hunk pnpm patch was removed because it
did not reach npm consumers.

Measured with `claude-haiku-5-5` on `anthropic-max` on 2026-11-10:
with long retention and keepalive off, idle gaps of 240 s and 285 s continued,
while 300 s and 330 s returned HTTP 404 `thread_not_found`. The 330 s failure
also occurred at short retention and with keepalive on. Continuations 111 s
apart still worked 7 min 24 s after creation. Stock Pi retries in full as a
new thread, costing a rejected round trip of 150 to 700 ms.

Clio records each successful threaded reply's id and monotonic time. Beyond
270 s it replaces an attempted continuation with a new thread before fetch.
It restores only `messages`, `system` and `tools` from the final payload,
preserving the SDK's other serialized fields and headers, including its beta
header. The `thread` field stays last, and any content-length header is removed
so fetch computes it again. A wall-clock delta additionally detects suspend
on hosts whose monotonic clock stops; a backward clock adjustment cannot
extend a thread's lifetime. The 30 s margin is conservative policy for both
Anthropic runtimes, not a measured API-key lifetime. A needless create costs
a full upload without deliberately changing the cacheable prefix.

Pi consumes the old continuation state before sending and records the new
reply normally. Clio never clears unrelated session resources or changes
Pi's `"off"` state. Keepalive and prewarm requests have `disableContinuation`
set and neither consume nor refresh the reply stamp. The stamp map is capped
at 10,000 sessions; an unknown or mismatched reply id also starts fresh.
Retries retain their restart decision. If the payload shape no longer permits
a complete reconstruction, Clio records `anthropic_thread_restart_skipped`
and leaves recovery to Pi; a restart records `anthropic_thread_restart`.

`tests/contracts/anthropic-thread-idle.test.ts` drives Clio's real stream
adapter with injected SSE and controlled monotonic and wall clocks. It checks
wire behavior, including equivalence to Pi's own new-thread request.
Remove the guard when stock Pi ages threads itself. Do not bundle pi-ai and
pi-agent-core solely for this fix: that would broaden dependency/license
vendoring and split the runtime-plugin `pi-ai/compat` registry from its
installed package unless the bridge were redesigned.

## Distribution, verification and removal

The build bundles the patched pi-tui JavaScript. npm consumers do not need pnpm
to reapply that patch; the pinned dependency also supplies native helper assets.
The Anthropic idle guard ships as Clio engine code and needs no pi-ai patch.
`NOTICE` and `dist/assets/tui-notices/` preserve the relevant licenses.

On each Pi upgrade, check stock APIs and dry-run the patch against the published
package, then regenerate `docs/pi-surface.json`. Routine `pnpm lint` does not
compare the installed declarations with that snapshot; `pnpm run pi:surface-diff`
does. Run
`pnpm test:maintenance` (keyboard routing and drafts: deletion under submit
overrides, search ownership and navigation, editor undo, and policy-first
ordering through the gate), `tests/contracts/tui-view-ergonomics.test.ts`
(whole-query undo and the Unicode kill ring on `Input.applyEdit`), and the
installed-package test, which drives the bundled executable. These cover the
semantic edit and search hunks and the gate. No Clio test pins the render memo;
`node --import tsx scripts/bench-tui.ts --workload reply-500k --mode regular --verify` (add `--echo` for keystroke
frames) checks the kept-rows hook against a fresh render of the same frames and must report 0 mismatches;
to check a rebase or a removal, rerun a probe that drives
Clio's chat panel over a fake terminal on a transcript of about 22.9k rows and
compare frame time and garbage per frame with the figures above. Patch applicability or a
successful installation alone is not behavioral verification.

Remove each patch seam when stock Pi offers equivalent semantics and Clio's
consumers use that public API. Remove the patched dependency entry only
when those tests pass against the unmodified package. Until then this is a
Clio-maintained compatibility patch, with no claim of upstream support.

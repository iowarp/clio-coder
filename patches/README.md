# Dependency patches

## Pi TUI 1.0.0: why the patch remains

`@earendil-works__pi-tui@1.0.0.patch` is the sole Pi dependency patch, applied
by pnpm's exact `patchedDependencies` entry. **pi-agent-core and pi-ai are
unpatched.** The patch has fifteen hunks in ten `dist/` files and applies to the
published, unmodified 1.0.0 package. It carries the semantic edit and search
operations that stock 1.0.0 keeps private, a wrapping fix for styled
whitespace and the regular-screen render memo. Everything else earlier
revisions patched is now stock Pi or an engine module, as
[recorded below](#what-was-removed). The table lists every
hunk; `grep -c '^@@' patches/@earendil-works__pi-tui@1.0.0.patch` must equal the
hunk total.

| Hunks | Patched API | Required behavior | Why stock 1.0.0 is insufficient |
| --- | --- | --- | --- |
| 2: `components/editor.d.ts`, `components/editor.js` | `Editor.applyEdit` | Invoke undo and the six delete operations (character and word deletion in both directions, and deletion to line start and end) directly after Clio resolves a semantic keyboard action, without passing through submission or a second keybinding lookup. | The edit operations are private and `handleInput` interprets bytes against configurable bindings. `setText` alone does not express the same undo, cursor and kill-ring semantics. |
| 2: `components/input.d.ts`, `components/input.js` | `Input.applyEdit` | The same operations plus `clear`, which keeps undo and kill-ring behavior. | The same private operations on `Input`. |
| 2: `alt-screen-search.d.ts`, `alt-screen-search.js` | `AltScreenSearchComponent.applyEdit("undo")` | Undo the whole search query and notify the query listener. | The overlay's `Input` is private, and so is the `undo` it would need, so a router cannot undo a query. |
| 2: `tui-alt-screen.d.ts`, `tui-alt-screen.js` | `TuiAltScreen.isSearchFocused` and `undoSearchQuery`; `scrollToPrompt`, `toggleSearch`, `closeSearch` and `navigateSearch` made public | Clio's input router sends Escape, undo, prompt navigation and match navigation to the current owner, including the native search overlay. | Search focus and these methods are private. The public viewport scroll methods cannot query or manipulate search ownership or its undo history, and `getScreenLines()` exposes painted rows, not search state. |
| 2: `utils.js` | `wrapTextWithAnsi` whitespace tokens | A whitespace token that carries the closing codes of the styled word before it is judged by its visible text, its codes apply before it is dropped at a wrap, and no style-only row is flushed. | A styled word that exactly fills a row stranded the following space on a row of its own: `wrapTextWithAnsi("\x1b[1mhello\x1b[22m world", 5)` yields `hello`, an empty row and `world` on stock, and `hello` and `world` patched. Foreground color codes behave the same. Stock Markdown and Text wrap through this function and have no option. |
| 5: `tui-main-screen.js` | `TuiMainScreen` reset memo and Kitty image-row scans | A regular-screen frame reuses the reset output of every row whose raw string is unchanged, rewriting the memo in place and recording which rows are image rows, and the Kitty image scans (`collectKittyImageIds`, `expandChangedRangeForKittyImages`) visit only those rows. `resetRenderState` drops the memo. | Stock 1.0.0 normalizes every transcript row and scans all rows for image headers on every regular-screen frame, so the cost grows with the transcript. Measured [below](#measured-cost-of-the-render-memo): a 22.9k-row transcript costs 5.90 ms per keystroke frame stock against 0.62 ms patched. The scans are private methods, so no subclass can replace them. |

The semantic operations call Pi's existing editing and search implementation;
they do not replace it. Consumers are the terminal lease, input router, editor
and overlays under `src/interactive/`, through `src/engine/tui.ts`.

## What was removed

The patch carried 26 hunks before the Pi 1.0 adoption series and carries
fifteen now. The eleven removed hunks fall into four groups.

| Removed | Replaced by | Cost and evidence |
| --- | --- | --- |
| `setApplicationInputPolicy` and its dispatch block (5 hunks in `dist/tui.d.ts` and `dist/tui.js`) | `src/engine/application-input-tui.ts`, a subclass pair that registers one gate through the public `addInputListener` | No operator-visible change. A policy returning `{ data: "" }` no longer drops the input before every listener, and stock `TuiAltScreen` instances (the fleet watch and follow views) no longer drop key releases before their listeners, which compare exact bytes releases never equal. |
| `lexMarkdownBlocks` export (4 hunks in the Markdown and index files) | One stock `Markdown` per assistant text segment in `src/interactive/chat-panel.ts`, with Clio's theme, a `highlightCode` hook and a `transform` hook for table fit and Mermaid | The visible changes are listed in [the Pi boundary table](../docs/architecture/pi-boundary.md). |
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

## Distribution, verification and removal

The build bundles the patched JavaScript. npm consumers do not need pnpm to
reapply a patch; the pinned dependency also supplies native helper assets.
`NOTICE` and `dist/assets/tui-notices/` preserve the relevant licenses.

On each Pi upgrade, check stock APIs and dry-run the patch against the published
package, then regenerate `docs/pi-surface.json`. `pnpm lint` checks the consumed
API snapshot even when the dependency version has not changed. Run
`pnpm test:maintenance` (keyboard routing and drafts: deletion under submit
overrides, search ownership and navigation, editor undo, and policy-first
ordering through the gate), `tests/contracts/tui-view-ergonomics.test.ts`
(whole-query undo and the Unicode kill ring on `Input.applyEdit`), and the
installed-package test, which drives the bundled executable. These cover the
semantic edit and search hunks and the gate. No Clio test pins the wrapping
hunks, so reproduce the `wrapTextWithAnsi` case in the table against the
unmodified package before rebasing or removing them. No Clio test pins the
render memo either; to check a rebase or a removal, rerun a probe that drives
Clio's chat panel over a fake terminal on a transcript of about 22.9k rows and
compare frame time and garbage per frame with the figures above. Patch applicability or a
successful installation alone is not behavioral verification.

Remove each patch seam when stock Pi offers equivalent semantics and Clio's
consumers use that public API. Remove the final patched dependency entry only
when those tests pass against the unmodified package. Until then this is a
Clio-maintained compatibility patch, with no claim of upstream support.

# Dependency patches

## Pi TUI 0.86.1: why the patch remains

`@earendil-works__pi-tui@0.86.1.patch` is the sole Pi dependency patch, applied
by pnpm's exact `patchedDependencies` entry. **pi-agent-core and pi-ai are
unpatched.** The patch was checked against the published, unmodified 0.86.1
package; that release does not provide these public APIs. The previous 0.85.1
patch still applies without changes to its implementation.

| Added API | Required behavior | Why stock 0.86.1 is insufficient |
| --- | --- | --- |
| `TuiBase.setApplicationInputPolicy` | Clio's single keyboard owner runs before viewport shortcuts and focused widgets. Key releases are ignored; bracketed-paste contents remain literal data. The returned disposer removes only its own policy. | Public `addInputListener` appends to a listener set. The alternate-screen viewport installs its listener during construction, so later application listeners cannot consume conflicting keys first. There is no public prepend/priority option. |
| `Editor.applyEdit` and `Input.applyEdit` | Invoke undo and deletion directly after Clio resolves a semantic keyboard action, without passing through submission or a second keybinding lookup. Input clear retains undo and kill-ring behavior. | The underlying edit operations are private and `handleInput` interprets bytes against configurable bindings. `setText` / `setValue` alone do not express the same undo, cursor and kill-ring semantics. |
| Search focus, query undo, prompt navigation, and search navigation methods | Clio can route Escape, undo, history, and navigation to the current owner, including the native search overlay, and keep overlay focus/rendering correct. | Search focus and these navigation methods are private; the public viewport scroll methods cannot query or manipulate search ownership or its undo history. |

The semantic operations call Pi's existing editing and search implementation;
they do not replace it. Consumers are the terminal lease, input router,
editor and overlays under `src/interactive/`, through `src/engine/tui.ts`.

## Alternatives considered

- **Use stock input listeners and keybindings:** public and preferable once Pi
  exposes application-first priority, but currently viewport bindings can
  consume a key before Clio applies modal ownership or cancellation policy.
  Removing every overlapping viewport binding also disables native behavior
  that Clio deliberately retains.
- **Synthesize control-key sequences:** goes through another configurable
  binding lookup. A deletion or undo action can become submission or a
  different action under user bindings; this fails the semantic-action contract.
- **Subclass or access private fields:** TypeScript privacy bypasses would bind
  Clio to undocumented widget state and still would not supply a supported
  pre-viewport dispatch hook. A forked editor/search implementation would own
  considerably more code and lose upstream behavior fixes.
- **Replace Pi's keyboard/editing/search stack:** technically possible, but
  duplicates working SDK functionality. The patch exposes the small missing
  seams and leaves editing, layout, undo, selection and rendering in Pi.
- **Contribute the seams upstream:** preferred removal path. No upstream issue,
  pull request or acceptance is recorded in this repository; this document
  does not claim one exists. Equivalent official APIs may have different names.

## Distribution, verification and removal

The build bundles the patched JavaScript. npm consumers do not need pnpm to
reapply a patch; the pinned dependency also supplies native helper assets.
`NOTICE` and `dist/assets/tui-notices/` preserve the relevant licenses.

On each Pi upgrade, check stock APIs and dry-run the patch against the published
package, then regenerate `docs/pi-surface.json`. `pnpm lint` checks the consumed
API snapshot even when the dependency version has not changed. Run
`pnpm test:maintenance`, the TUI contract tests, and installed-package tests;
these cover application-first routing, release and paste handling, modal
Escape, search ownership, editor/input undo, configured bindings, and the
bundled executable. Patch applicability or a successful installation alone is
not behavioral verification.

Remove each patch seam when stock Pi offers equivalent semantics and Clio's
consumers use that public API. Remove the final patched dependency entry only
when those tests pass against the unmodified package. Until then this is a
Clio-maintained compatibility patch, with no claim of upstream support.

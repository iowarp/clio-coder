<!-- Thank you for the pull request. Keep it focused: split unrelated docs, runtime, CLI and TUI work. -->
<!-- Open it against the current version branch named in CONTRIBUTING.md, not main. -->

## Summary

<!-- What problem does this solve, and how. One short paragraph. -->

## User-facing change

<!-- Behavior a user or agent would notice. Write "none" if internal-only. -->

## Verification

- [ ] `pnpm run typecheck` and `pnpm run lint` pass.
- [ ] Focused `pnpm run test:file -- <test>` runs cover the changed behavior, and `pnpm run test` passes.
- [ ] No exploratory probes left under `scripts/` or `tests/`.
- [ ] No `// biome-ignore`, `ts-ignore`, or `any` added without a linked tracking issue.

## Architecture invariants

The boundary checker in `pnpm run lint` enforces these. Confirm none are violated:

- [ ] **Engine boundary.** Only `src/engine/**` imports `@earendil-works/pi-*`, type imports included.
- [ ] **Worker isolation.** `src/worker/**` does not import `src/domains/**` except the declared provider seams.
- [ ] **Domain independence.** No `src/domains/<x>/**` imports another domain's `extension.ts`.

If an invariant is intentionally relaxed, link the design note that authorized it.

## Voice

- [ ] No dash used to splice a clause into a sentence, in code, docs, comments or commit messages. Hyphens in compound words and table separators are fine.
- [ ] No emoji.

## Changelog

<!-- One line per user-visible change, or "no changelog entry needed" with the reason. -->

## Related

<!-- Issues, design notes, prior PRs. -->

<!-- Keep this PR focused. Split unrelated docs, runtime, CLI, and TUI work. -->

## Summary

<!-- What problem does this solve, and how. One short paragraph. -->

## User-facing change

<!-- Behavior a user or agent would notice. Write "none" if internal-only. -->

## Verification

- [ ] `npm run ci` is green locally.
- [ ] New or changed behavior has a test under `tests/`.
- [ ] No exploratory probes left under `scripts/` or `tests/`. One-off probes go to `/tmp/` and get deleted.
- [ ] No `// biome-ignore`, `ts-ignore`, or `any` added without a linked tracking issue.

## Architecture invariants

The boundary checker enforces these. Confirm none are violated:

- [ ] **Engine boundary.** Only `src/engine/**` value-imports `@mariozechner/pi-*`.
- [ ] **Worker isolation.** `src/worker/**` does not import `src/domains/**` except `src/domains/providers`.
- [ ] **Domain independence.** No `src/domains/<x>/**` imports another domain's `extension.ts`. Cross-domain traffic flows through `SafeEventBus`.

If any invariant is intentionally relaxed, link the design note that authorized it.

## Voice

- [ ] No em-dash clause separators in code, docs, comments, or commit messages. Hyphens in compound words and table separators are fine.
- [ ] No emojis.

## Changelog

<!-- One line per user-visible change, or "no changelog entry needed" with reason. -->

## Related

<!-- Issues, plans under docs/.superpowers/, prior PRs. -->

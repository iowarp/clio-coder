# Private Changelog

## 2026-05-03

- feat(selfdev): Added `clio_introspect` with live views for identity, domains, tools, prompt fragments, harness state, and recent git activity.
- feat(selfdev): Replaced the static self-development prompt supplement with dev-only prompt fragments and dynamic live state and memory fragments.
- feat(selfdev): Added per-checkout development memory with `clio_remember`, `clio_recall`, and prompt autoloading from `.clio/dev-memory.jsonl`.
- feat(selfdev): Propagated self-development invariants and private tools into dispatched workers.
- feat(selfdev): Added structured restart metadata to guarded tool results.
- feat(selfdev): Added the passive selfdev footer and the Alt+D diff overlay.
- refactor(selfdev): Moved the private development surface under `src/selfdev`.
- build(selfdev): Excluded `src/selfdev` from public bundles unless `CLIO_BUILD_PRIVATE=1` is set.

# Private Changelog

## 2026-05-03

- feat(selfdev): Added `clio_introspect` with live views for identity, domains, tools, prompt fragments, harness state, and recent git activity.
- feat(selfdev): Replaced the static self-development prompt supplement with dev-only prompt fragments and dynamic live state and memory fragments.
- feat(selfdev): Added per-checkout development memory with `clio_remember`, `clio_recall`, and prompt autoloading from `.clio/dev-memory.jsonl`.
- fix(selfdev): Added dev-memory recall metadata, truncation markers, locked appends, torn-line repair, and a private prune tool for JSONL hygiene.
- feat(selfdev): Propagated self-development invariants and private tools into dispatched workers.
- feat(selfdev): Added structured restart metadata to guarded tool results.
- fix(selfdev): Blocked source write/edit tools and worker dispatch while the harness is restart-required, with a private explicit stale-write override.
- fix(selfdev): Moved private self-development tool-name literals out of public core constants so default dist bundles do not expose private tool names.
- test(selfdev): Added hot-reload behavior chaos coverage that proves registered tool behavior changes after reload.
- feat(selfdev): Added the passive selfdev footer and the Alt+D diff overlay.
- refactor(selfdev): Moved the private development surface under `src/selfdev`.
- build(selfdev): Excluded `src/selfdev` from public bundles unless `CLIO_BUILD_PRIVATE=1` is set.
